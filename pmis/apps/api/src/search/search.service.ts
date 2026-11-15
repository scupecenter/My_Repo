import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { problems } from '../common/problem';
import { oneParam, type Query } from '../common/query';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';
import { matchRanges } from './search-text';

export const SEARCH_TYPES = ['sites', 'registers', 'documents', 'meetings', 'people', 'contractors'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchHit {
  id: string;
  title: string;
  subtitle: string | null;
  region_id: number | null;
  href: string;
  match_ranges: [number, number][];
}
export interface SearchGroup {
  type: SearchType;
  total: number;
  truncated: boolean;
  items: SearchHit[];
}

const siteIdsSchema = z.object({ ids: z.array(z.string().max(40)).min(1).max(500) }).strict();

/** LIKE pattern for a normalised term: the wildcards of the term are escaped, the search is a substring match. */
const likeAll = (norm: string): string => `%${norm.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** A row of one group's query: `total` is the count of every visible match (window count), the rest is the hit. */
interface Row {
  id: string;
  title: string | null;
  subtitle: string | null;
  region_id: number | null;
  href?: string;
  total: number;
}

/**
 * Global search (plan F4, contract 0.15.17). Read only. Each group checks its own module and regions with the database resolvers
 * (the same as the list screens) and row-level security still applies beneath. A group the caller cannot read is left out, never 403.
 */
@Injectable()
export class SearchService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  async search(auth: AuthContext, q: Query): Promise<{ q: string; groups: SearchGroup[] }> {
    const text = (oneParam(q, 'q') ?? '').trim();
    if (text.length < 2 || text.length > 100) {
      throw problems.validation([{ path: '/q', code: 'invalid', message: 'q is 2 to 100 characters.' }]);
    }
    const limit = Number(oneParam(q, 'limit') ?? '5');
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      throw problems.validation([{ path: '/limit', code: 'invalid', message: 'limit is 1 to 10.' }]);
    }
    const types = this.typeList(q);
    const [norm] = await this.db.tx.$queryRaw<{ n: string }[]>`SELECT search_norm(${text}) AS n`;
    const groups: SearchGroup[] = [];
    if (!norm?.n) return { q: text, groups };
    const pattern = likeAll(norm.n);
    for (const type of types) {
      const rows = await this.rowsFor(auth, type, pattern, limit);
      if (rows === null) continue; // the caller cannot read this group
      const total = rows[0]?.total ?? 0;
      groups.push({
        type,
        total,
        truncated: total > rows.length,
        items: rows.map((r) => {
          const title = r.title ?? '';
          return {
            id: r.id,
            title,
            subtitle: r.subtitle,
            region_id: r.region_id,
            href: r.href ?? '/',
            match_ranges: matchRanges(title, text),
          };
        }),
      });
    }
    return { q: text, groups };
  }

  /** Many Site IDs at once: the sites found (in the caller's reach) and the IDs not found, in input order. */
  async lookupSiteIds(auth: AuthContext, body: unknown): Promise<{ found: unknown[]; not_found: string[] }> {
    void auth;
    const input = parse(siteIdsSchema, body);
    const tokens: string[] = [];
    for (const raw of input.ids) {
      const t = raw.trim();
      if (t && !tokens.some((x) => x.toUpperCase() === t.toUpperCase())) tokens.push(t);
    }
    const keys = tokens.map((t) => t.toUpperCase());
    const regions = await this.access.regions('sites', 'view');
    const reach = regions === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${regions}::int[])`;
    const rows = regions !== null && regions.length === 0 ? [] : await this.db.tx.$queryRaw<
      { id: string; site_code: string; name: string; region_id: number }[]
    >(Prisma.sql`SELECT s.id::text AS id, s.site_code, s.name, s.region_id FROM sites s
      WHERE s.is_active AND upper(s.site_code) = ANY(${keys}::text[]) ${reach}`);
    const bySite = new Map(rows.map((r) => [r.site_code.toUpperCase(), r]));
    const found = tokens.filter((t) => bySite.has(t.toUpperCase())).map((t) => {
      const r = bySite.get(t.toUpperCase())!;
      return { id: r.id, site_code: r.site_code, name: r.name, region_id: r.region_id, href: `/sites/${r.id}` };
    });
    const not_found = tokens.filter((t) => !bySite.has(t.toUpperCase()));
    return { found, not_found };
  }

  private typeList(q: Query): SearchType[] {
    const raw = q['types'];
    const values = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
      .flatMap((v) => String(v).split(','))
      .map((v) => v.trim())
      .filter(Boolean);
    if (values.length === 0) return [...SEARCH_TYPES];
    const bad = values.find((v) => !(SEARCH_TYPES as readonly string[]).includes(v));
    if (bad) throw problems.validation([{ path: '/types', code: 'invalid', message: 'Unknown search group.' }]);
    return [...new Set(values)] as SearchType[];
  }

  /** The rows of one group, or null when the caller may not read it. */
  private async rowsFor(auth: AuthContext, type: SearchType, pattern: string, limit: number): Promise<Row[] | null> {
    const tx = this.db.tx;
    if (type === 'sites') {
      const regions = await this.access.regions('sites', 'view');
      if (regions !== null && regions.length === 0) return null;
      const reach = regions === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${regions}::int[])`;
      return tx.$queryRaw<Row[]>(Prisma.sql`SELECT s.id::text AS id, s.site_code || ' - ' || s.name || coalesce(' - ' || nullif(s.name_ar, ''), '') AS title, NULL::text AS subtitle, s.region_id,
          concat('/sites/', s.id::text) AS href, (COUNT(*) OVER())::int AS total
        FROM sites s WHERE s.is_active AND s.search_text LIKE ${pattern} ${reach}
        ORDER BY s.site_code LIMIT ${limit}`);
    }
    if (type === 'registers') {
      const defs = await tx.$queryRaw<{ register_key: string; module_key: string }[]>(
        Prisma.sql`SELECT register_key, module_key FROM register_definitions WHERE is_active`);
      const clauses: Prisma.Sql[] = [];
      for (const d of defs) {
        const regions = await this.access.regions(d.module_key, 'view');
        if (regions !== null && regions.length === 0) continue;
        clauses.push(regions === null
          ? Prisma.sql`r.register_key = ${d.register_key}`
          : Prisma.sql`(r.register_key = ${d.register_key} AND (r.is_global OR r.region_id = ANY(${regions}::int[])))`);
      }
      if (clauses.length === 0) return null;
      return tx.$queryRaw<Row[]>(Prisma.sql`SELECT r.id::text AS id,
          coalesce(nullif(r.data ->> 'title', ''), nullif(r.data ->> 'name', ''), r.record_type, rd.name_en) AS title,
          rd.name_en AS subtitle, r.region_id, '/registers/' || r.register_key AS href, (COUNT(*) OVER())::int AS total
        FROM register_records r JOIN register_definitions rd ON rd.register_key = r.register_key
        WHERE r.is_current AND r.voided_at IS NULL AND r.search_text LIKE ${pattern} AND (${Prisma.join(clauses, ' OR ')})
        ORDER BY title LIMIT ${limit}`);
    }
    if (type === 'documents') {
      const regions = await this.access.regions('sites', 'view');
      if (regions !== null && regions.length === 0) return null;
      const reach = regions === null ? Prisma.empty : Prisma.sql`AND s.region_id = ANY(${regions}::int[])`;
      return tx.$queryRaw<Row[]>(Prisma.sql`SELECT f.id::text AS id, f.original_name AS title, s.site_code AS subtitle, s.region_id,
          concat('/sites/', s.id::text) AS href, (COUNT(*) OVER())::int AS total
        FROM document_files f JOIN document_slots sl ON sl.id = f.slot_id JOIN sites s ON s.id = sl.site_id
        WHERE f.is_current AND s.is_active AND f.search_text LIKE ${pattern} ${reach}
        ORDER BY f.original_name LIMIT ${limit}`);
    }
    if (type === 'meetings') {
      const regions = await this.access.regions('meetings', 'view');
      if (regions !== null && regions.length === 0) return null;
      const reach = regions === null ? Prisma.empty : Prisma.sql`AND (m.is_global OR m.region_id = ANY(${regions}::int[]))`;
      return tx.$queryRaw<Row[]>(Prisma.sql`SELECT m.id::text AS id, m.title, to_char(m.meeting_date, 'YYYY-MM-DD') AS subtitle,
          m.region_id, '/registers/meetings' AS href, (COUNT(*) OVER())::int AS total
        FROM meetings m WHERE m.search_text LIKE ${pattern} ${reach}
        ORDER BY m.meeting_date DESC LIMIT ${limit}`);
    }
    if (type === 'people') {
      if (!(await this.access.hasGrant(auth, 'admin.users', 'view'))) return null;
      return tx.$queryRaw<Row[]>(Prisma.sql`SELECT u.id::text AS id, u.display_name AS title, u.email AS subtitle, NULL::int AS region_id,
          concat('/admin/users/', u.id::text) AS href, (COUNT(*) OVER())::int AS total
        FROM users u WHERE u.deleted_at IS NULL AND u.purged_at IS NULL AND u.search_text LIKE ${pattern}
        ORDER BY u.display_name LIMIT ${limit}`);
    }
    // contractors
    if (!(await this.access.hasGrant(auth, 'contractors', 'view'))) return null;
    return tx.$queryRaw<Row[]>(Prisma.sql`SELECT e.id::text AS id, e.name AS title, e.type::text AS subtitle, NULL::int AS region_id,
        '/registers/contractors' AS href, (COUNT(*) OVER())::int AS total
      FROM external_parties e WHERE e.is_active AND e.search_text LIKE ${pattern}
      ORDER BY e.name LIMIT ${limit}`);
  }
}
