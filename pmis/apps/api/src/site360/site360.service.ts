import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { ProblemException } from '../common/problem';
import { parse } from '../common/zod';
import { AccessService } from '../access/access.service';
import { DbService } from '../db/db.service';
import { buildMenu, buildSite360, SITE360_MOVABLE, type Site360ColumnRow, type Site360Menu, type Site360MenuItem } from './site360-sections';

const setSchema = z.object({
  sections: z.array(z.enum(SITE360_MOVABLE)).min(1).max(7),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export interface Site360ColumnDto extends Site360ColumnRow {
  is_phase_gate: boolean;
}

/** SITE 360 menus (contract 0.15.21, F15). The column metadata is the one source; no second store. */
@Injectable()
export class Site360Service {
  constructor(private readonly db: DbService, private readonly stepUp: StepUpService, private readonly access: AccessService) {}

  async sections(): Promise<{ items: Site360MenuItem[]; can_move: boolean }> {
    const rows = await this.db.tx.$queryRaw<Site360ColumnRow[]>`
      SELECT ord, letter, group_top, group_mid, header, site360_sections AS sections
      FROM master_columns WHERE is_active ORDER BY ord`;
    const admin = await this.db.tx.$queryRaw<{ ok: boolean }[]>`
      SELECT coalesce(app_actor_is_admin('admin.settings', 'edit'), false) AS ok`;
    return { items: buildSite360(rows), can_move: admin[0]?.ok ?? false };
  }

  /** Replaces the set of menus of one column (owner decision 2026-11-15: a column may be in several menus). */
  async setSections(auth: AuthContext, rawOrd: unknown, raw: unknown): Promise<Site360ColumnDto> {
    const ord = Number(rawOrd);
    if (!Number.isInteger(ord) || ord < 1 || ord > 187) {
      throw new ProblemException(422, 'validation_failed', { detail: 'The column order must be 1 to 187.', errors: [{ path: '/ord', code: 'invalid' }] });
    }
    const b = parse(setSchema, raw);
    await this.stepUp.require(auth);
    await this.db.tx.$queryRaw(Prisma.sql`
      SELECT site360_set_sections(${ord}::integer, ${b.sections}::text[], ${b.reason}::text) AS j`);
    const rows = await this.db.tx.$queryRaw<Site360ColumnRow[]>`
      SELECT ord, letter, group_top, group_mid, header, site360_sections AS sections FROM master_columns WHERE ord = ${ord}`;
    const r = rows[0]!;
    return { ...r, is_phase_gate: r.group_top === 'Phase Gate' };
  }

  /**
   * GET /site360/{menu}/rows (contract 0.15.21, F15, migration 0104): one page of a menu's rows. Visibility (B3), the filters, the sort and the
   * paging are in SQL; the values come from the set-based view site360_master_values in one query for the page (no per-site path).
   */
  async rows(auth: AuthContext, rawMenu: string, q: Record<string, unknown>): Promise<Site360RowsDto> {
    if (!(SITE360_MENU_KEYS as readonly string[]).includes(rawMenu)) {
      throw new ProblemException(422, 'validation_failed', { detail: 'Unknown SITE 360 menu.', errors: [{ path: '/menu', code: 'invalid' }] });
    }
    const menu = rawMenu as Site360Menu;
    const regs = await this.access.requireRegions('sites', 'view');
    const offset = intParam(q, 'offset', 0, 1_000_000, 0);
    const limit = intParam(q, 'limit', 1, 200, 50);
    const dir = oneOf(q, 'dir', ['asc', 'desc'], 'asc');
    const sortKey = oneString(q, 'sort') ?? 'site_code';

    const colRows = await this.db.tx.$queryRaw<Site360ColumnRow[]>`
      SELECT ord, letter, group_top, group_mid, header, site360_sections AS sections FROM master_columns WHERE is_active ORDER BY ord`;
    const menuItem = buildMenu(menu, colRows);
    const menuOrds = menuItem.columns.map((c) => c.ord);

    const sortField = SORT_FIELDS[sortKey];
    const ordSort = /^ord:([0-9]{1,3})$/.exec(sortKey);
    if (!sortField && !(ordSort && menuOrds.includes(Number(ordSort[1])))) {
      throw new ProblemException(422, 'validation_failed', { detail: 'Unknown sort for this menu.', errors: [{ path: '/sort', code: 'invalid' }] });
    }
    const sortSql = ordSort
      ? Prisma.sql`sv.value`
      : Prisma.raw(sortField!);
    const sortJoin = ordSort
      ? Prisma.sql`LEFT JOIN LATERAL (SELECT v.value FROM site360_master_values v WHERE v.site_id = s.id AND v.ord = ${Number(ordSort[1])}) sv ON true`
      : Prisma.empty;

    const where: Prisma.Sql[] = [Prisma.sql`s.is_active`];
    if (regs !== null) where.push(Prisma.sql`s.region_id = ANY(${regs}::int[])`);
    const base = Prisma.sql`${Prisma.join(where, ' AND ')}`;
    const filters: Prisma.Sql[] = [];
    const codes = csvParam(q, 'site_code', 200);
    if (codes.length) filters.push(Prisma.sql`s.site_code = ANY(${codes}::text[])`);
    const regionIds = csvParam(q, 'region_id', 7).map((x) => {
      if (!/^[1-7]$/.test(x)) throw new ProblemException(422, 'validation_failed', { detail: 'region_id is 1 to 7.', errors: [{ path: '/region_id', code: 'invalid' }] });
      return Number(x);
    });
    if (regionIds.length) filters.push(Prisma.sql`s.region_id = ANY(${regionIds}::int[])`);
    const subRegions = csvParam(q, 'sub_region', 50);
    if (subRegions.length) filters.push(Prisma.sql`s.sub_region = ANY(${subRegions}::text[])`);
    const phases = csvParam(q, 'phase', 50);
    if (phases.length) filters.push(Prisma.sql`s.project_phase = ANY(${phases}::text[])`);
    const batches = csvParam(q, 'batch', 50);
    if (batches.length) filters.push(Prisma.sql`s.delivery_batch = ANY(${batches}::text[])`);
    const scenarios = csvParam(q, 'scenario', 5);
    if (scenarios.length) filters.push(Prisma.sql`s.delivery_scenario::text = ANY(${scenarios}::text[])`);
    const models = csvParam(q, 'delivery_model', 20);
    if (models.length) filters.push(Prisma.sql`s.cw_delivery_model = ANY(${models}::text[])`);
    const statuses = csvParam(q, 'status', 5);
    if (statuses.length) filters.push(Prisma.sql`s.overall_status::text = ANY(${statuses}::text[])`);
    const milestones = csvParam(q, 'milestone', 50);
    if (milestones.length) filters.push(Prisma.sql`s.current_milestone = ANY(${milestones}::text[])`);
    const all = filters.length ? Prisma.sql`${base} AND ${Prisma.join(filters, ' AND ')}` : base;

    const counts = await this.db.tx.$queryRaw<{ total: number; filtered: number }[]>(Prisma.sql`
      SELECT (SELECT count(*)::int FROM sites s WHERE ${base}) AS total,
             (SELECT count(*)::int FROM sites s WHERE ${all}) AS filtered`);
    const page = await this.db.tx.$queryRaw<{ id: string; site_code: string }[]>(Prisma.sql`
      SELECT s.id::text AS id, s.site_code FROM sites s JOIN regions r ON r.id = s.region_id ${sortJoin}
      WHERE ${all}
      ORDER BY ${sortSql} ${Prisma.raw(dir === 'desc' ? 'DESC' : 'ASC')} NULLS LAST, s.site_code COLLATE "C"
      LIMIT ${limit} OFFSET ${offset}`);

    const values = new Map<string, Record<string, string | null>>();
    if (page.length) {
      const ids = page.map((r) => r.id);
      const vals = await this.db.tx.$queryRaw<{ site_id: string; ord: number; value: string | null }[]>(Prisma.sql`
        SELECT v.site_id::text AS site_id, v.ord, v.value FROM site360_master_values v
        WHERE v.site_id = ANY(${ids}::uuid[]) AND v.ord = ANY(${menuOrds}::int[])`);
      for (const id of ids) values.set(id, {});
      for (const v of vals) values.get(v.site_id)![String(v.ord)] = v.value;
    }
    const c = counts[0] ?? { total: 0, filtered: 0 };
    return {
      menu: menuItem,
      total: c.total,
      filtered: c.filtered,
      offset,
      limit,
      rows: page.map((r, i) => {
        const v = values.get(r.id) ?? {};
        const row_values: Record<string, string | null> = {};
        for (const ord of menuOrds) row_values[String(ord)] = v[String(ord)] ?? null;
        return { site_id: r.id, site_code: r.site_code, row_no: offset + i + 1, values: row_values };
      }),
    };
  }
}

const SITE360_MENU_KEYS = ['master', 'design_acq', 'sow', 'cw', 'te', 'hoto', 'dismantle', 'om'] as const;

/** Sort keys of the site fields (the join of the region is in the query). */
const SORT_FIELDS: Record<string, string> = {
  site_code: 's.site_code COLLATE "C"',
  name: 's.name',
  region: 'r.name_en',
  status: 's.overall_status::text',
  milestone: 's.current_milestone',
  phase: 's.project_phase',
};

export interface Site360RowsDto {
  menu: Site360MenuItem;
  total: number;
  filtered: number;
  offset: number;
  limit: number;
  rows: { site_id: string; site_code: string; row_no: number; values: Record<string, string | null> }[];
}

function oneString(q: Record<string, unknown>, key: string): string | undefined {
  const v = q[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new ProblemException(422, 'validation_failed', { detail: `${key} takes one value.`, errors: [{ path: `/${key}`, code: 'invalid' }] });
  return v;
}

function intParam(q: Record<string, unknown>, key: string, min: number, max: number, dflt: number): number {
  const v = oneString(q, key);
  if (v === undefined) return dflt;
  const n = /^[0-9]+$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new ProblemException(422, 'validation_failed', { detail: `${key} is out of range.`, errors: [{ path: `/${key}`, code: 'invalid' }] });
  return n;
}

function oneOf<T extends string>(q: Record<string, unknown>, key: string, allowed: readonly T[], dflt: T): T {
  const v = oneString(q, key);
  if (v === undefined) return dflt;
  if (!(allowed as readonly string[]).includes(v)) throw new ProblemException(422, 'validation_failed', { detail: `${key} is not allowed.`, errors: [{ path: `/${key}`, code: 'invalid' }] });
  return v as T;
}

/** A comma-separated filter: up to max values, trimmed, empty parts dropped. */
function csvParam(q: Record<string, unknown>, key: string, max: number): string[] {
  const v = oneString(q, key);
  if (v === undefined) return [];
  const parts = v.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
  if (parts.length > max || parts.some((x) => x.length > 100)) throw new ProblemException(422, 'validation_failed', { detail: `${key} has too many values.`, errors: [{ path: `/${key}`, code: 'invalid' }] });
  return parts;
}
