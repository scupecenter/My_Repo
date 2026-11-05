import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { decodeCursor, encodeCursor, likePattern, parseLimit } from '../common/cursor';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { problems } from '../common/problem';
import { oneParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { TaskViewService } from '../workflow/task-view.service';

const DRAFT_STATUSES = ['entry', 'in_approval', 'approved', 'rejected', 'discarded'];

/**
 * The body of POST /sites and PATCH /site-drafts/{id}: plain values only. Which fields are accepted, and every rule on them, is decided by the database
 * (site_new_clean): an unknown field (a landlord, a phone, an e-mail) is refused there with 422 `unknown_field`, because those data are not loaded (Q469).
 */
const draftBody = z.record(z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).refine((v) => Object.keys(v).length <= 40, 'too many fields');
const decisionBody = z.object({ action: z.enum(['approve', 'reject']), note: z.string().trim().max(2000).optional() }).strict();

interface DraftRow {
  id: string;
  site_code: string;
  region_id: number;
  data: Record<string, unknown>;
  status: string;
  version: number;
  created_by: string;
  created_at: Date;
  submitted_at: Date | null;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  return_count: number;
  last_return_note: string | null;
  self_approval: boolean;
  site_id: string | null;
  batch_id: string | null;
  actions: string[] | null;
  total: bigint | null;
}

/** Site creation, the manual way: a draft (POST /sites), then L1 sends it and L2 decides. The database holds every rule (migration 0070). */
@Injectable()
export class SiteDraftsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly view: TaskViewService,
  ) {}

  /** A savepoint around a database function: its refusals become problems and the request transaction stays usable. */
  private async call(sql: Prisma.Sql): Promise<Record<string, unknown>> {
    await this.db.tx.$executeRaw`SAVEPOINT site_draft`;
    try {
      const rows = await this.db.tx.$queryRaw<{ r: Record<string, unknown> }[]>(sql);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT site_draft`;
      return rows[0]?.r ?? {};
    } catch (e) {
      const p = mapDbError(e);
      if (!p) throw e;
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT site_draft`;
      throw p;
    }
  }

  private async dtos(rows: DraftRow[], warnings?: Map<string, unknown[]>): Promise<Record<string, unknown>[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.created_by, r.decided_by]).filter((x): x is string => !!x))];
    const refs = await this.view.userRefs(ids);
    return rows.map((r) => {
      const dto: Record<string, unknown> = {
        id: r.id,
        site_code: r.site_code,
        region_id: r.region_id,
        status: r.status,
        data: r.data,
        version: r.version,
        created_at: r.created_at,
        submitted_at: r.submitted_at,
        decided_at: r.decided_at,
        decision_note: r.decision_note,
        return_count: r.return_count,
        last_return_note: r.last_return_note,
        self_approval: r.self_approval,
        site_id: r.site_id,
        batch_id: r.batch_id,
        allowed_actions: r.actions ?? [],
      };
      const w = warnings?.get(r.id);
      if (w) dto.warnings = w;
      const by = refs.get(r.created_by);
      if (by) dto.created_by = by;
      dto.decided_by = r.decided_by ? (refs.get(r.decided_by) ?? null) : null;
      return dto;
    });
  }

  private select(where: Prisma.Sql, tail: Prisma.Sql = Prisma.empty): Prisma.Sql {
    return Prisma.sql`
      SELECT d.id::text AS id, d.site_code, d.region_id, d.data, d.status, d.version, d.created_by::text AS created_by, d.created_at, d.submitted_at, d.decided_by::text AS decided_by,
        d.decided_at, d.decision_note, d.return_count, d.last_return_note, d.self_approval, d.site_id::text AS site_id, d.batch_id::text AS batch_id,
        site_draft_actions(d.id) AS actions, count(*) OVER () AS total
      FROM site_drafts d WHERE ${where} ${tail}`;
  }

  private async one(auth: AuthContext, id: string, withWarnings = true): Promise<Record<string, unknown>> {
    const regions = await this.access.requireRegions('sites', 'view');
    if (!uuidSchema.safeParse(id).success) throw problems.notFound('The draft does not exist or is not visible to you.');
    const rows = await this.db.tx.$queryRaw<DraftRow[]>(this.select(Prisma.sql`d.id = ${id}::uuid ${regions === null ? Prisma.empty : Prisma.sql`AND d.region_id = ANY(${regions}::int[])`}`));
    const row = rows[0];
    if (!row) throw problems.notFound('The draft does not exist or is not visible to you.');
    const warnings = new Map<string, unknown[]>();
    if (withWarnings) {
      const w = await this.db.tx.$queryRaw<{ w: unknown[] }[]>(Prisma.sql`SELECT site_draft_warnings(${id}::uuid) AS w`);
      warnings.set(row.id, w[0]?.w ?? []);
    }
    const [dto] = await this.dtos([row], warnings);
    void auth;
    return dto as Record<string, unknown>;
  }

  async get(auth: AuthContext, id: string): Promise<Record<string, unknown>> {
    return this.one(auth, id);
  }

  async list(auth: AuthContext, q: Record<string, unknown>): Promise<unknown> {
    const regions = await this.access.requireRegions('sites', 'view');
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 1);
    const offset = cursor ? Number(cursor[0]) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw problems.badRequest('The cursor is not valid.');
    const status = oneParam(q, 'status');
    if (status !== undefined && !DRAFT_STATUSES.includes(status)) throw problems.validation([{ path: '/status', code: 'invalid', message: `status is one of ${DRAFT_STATUSES.join(', ')}.` }]);
    const region = oneParam(q, 'region_id');
    if (region !== undefined && !/^[1-9][0-9]?$/.test(region)) throw problems.validation([{ path: '/region_id', code: 'invalid', message: 'region_id is a region number.' }]);
    const text = oneParam(q, 'q')?.trim();
    const where: Prisma.Sql[] = [Prisma.sql`true`];
    if (regions !== null) where.push(Prisma.sql`d.region_id = ANY(${regions}::int[])`);
    if (status) where.push(Prisma.sql`d.status = ${status}`);
    if (region) where.push(Prisma.sql`d.region_id = ${Number(region)}::int`);
    if (oneParam(q, 'mine') === 'true') where.push(Prisma.sql`d.created_by = ${auth.user.id}::uuid`);
    if (oneParam(q, 'waiting_for_me') === 'true') where.push(Prisma.sql`d.status = 'in_approval' AND 'approve' = ANY(site_draft_actions(d.id))`);
    if (text) where.push(Prisma.sql`(d.site_code ILIKE ${likePattern(text)} OR d.data ->> 'name' ILIKE ${likePattern(text)})`);
    const rows = await this.db.tx.$queryRaw<DraftRow[]>(this.select(Prisma.join(where, ' AND '), Prisma.sql`ORDER BY d.created_at DESC, d.id DESC LIMIT ${limit + 1} OFFSET ${offset}`));
    const page = rows.slice(0, limit);
    return {
      items: await this.dtos(page),
      page: { limit, next_cursor: rows.length > limit ? encodeCursor([String(offset + limit)]) : null, total: rows[0] ? Number(rows[0].total) : 0 },
    };
  }

  /** POST /sites: the draft of a new site (manual entry). */
  async create(auth: AuthContext, raw: unknown): Promise<Record<string, unknown>> {
    const body = parse(draftBody, raw);
    const r = await this.call(Prisma.sql`SELECT site_draft_create(${JSON.stringify(body)}::jsonb) AS r`);
    return this.withWarnings(auth, r);
  }

  private async withWarnings(auth: AuthContext, r: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = String(r.id ?? '');
    const dto = await this.one(auth, id, false);
    return r.warnings ? { ...dto, warnings: r.warnings } : dto;
  }

  async update(auth: AuthContext, id: string, ifMatch: string | undefined, raw: unknown): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    const body = parse(draftBody, raw);
    await this.one(auth, id, false);
    const r = await this.call(Prisma.sql`SELECT site_draft_save(${id}::uuid, ${version}::int, ${JSON.stringify(body)}::jsonb) AS r`);
    return this.withWarnings(auth, r);
  }

  async submit(auth: AuthContext, id: string, ifMatch: string | undefined): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    await this.one(auth, id, false);
    const r = await this.call(Prisma.sql`SELECT site_draft_submit(${id}::uuid, ${version}::int) AS r`);
    return this.withWarnings(auth, r);
  }

  async decide(auth: AuthContext, id: string, ifMatch: string | undefined, raw: unknown): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    const body = parse(decisionBody, raw);
    await this.one(auth, id, false);
    const r = await this.call(Prisma.sql`SELECT site_draft_decide(${id}::uuid, ${version}::int, ${body.action}::text, ${body.note ?? null}::text) AS r`);
    return this.withWarnings(auth, r);
  }

  async discard(auth: AuthContext, id: string, ifMatch: string | undefined): Promise<Record<string, unknown>> {
    const version = parseIfMatch(ifMatch);
    await this.one(auth, id, false);
    const r = await this.call(Prisma.sql`SELECT site_draft_discard(${id}::uuid, ${version}::int) AS r`);
    return this.withWarnings(auth, r);
  }
}
