import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { mapDbError } from '../common/db-errors';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { boolParam } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';

/**
 * P10 (owner answers Q115 and Q117, migration 0065): saved views of the list screens, kept on the server, and the caller's drafts.
 * The database decides (sv_* and dr_* functions): who reads a view, who may share it, which columns a reader may see. The API adds the checks
 * that need the caller's region scope (a region filter of a shared view) and the read check of a draft's task or record.
 */

const SCREEN = z.string().regex(/^[a-z][a-z0-9_-]{1,80}$/);
const colId = z.string().max(100);
const columnsSchema = z.object({
  order: z.array(colId).max(200).optional(),
  hidden: z.array(colId).max(200).optional(),
  width: z.record(colId, z.number().int().min(40).max(1000)).optional(),
  density: z.enum(['comfortable', 'compact']).optional(),
}).strict();
const sortSchema = z.array(z.object({ id: colId, dir: z.enum(['asc', 'desc']) }).strict()).max(5);
const filtersSchema = z.record(z.string().max(100), z.unknown()).refine((f) => Object.keys(f).length <= 50, { message: 'At most 50 filters.' });
const audienceSchema = z.object({
  everyone: z.boolean().optional(),
  role_ids: z.array(uuidSchema).max(100).optional(),
  group_ids: z.array(uuidSchema).max(100).optional(),
  user_ids: z.array(uuidSchema).max(100).optional(),
}).strict();
const reason = z.string().trim().max(1000).optional();

const createSchema = z.object({
  screen_key: SCREEN, name: z.string().trim().min(1).max(120), filters: filtersSchema.optional(), columns: columnsSchema.optional(),
  sort: sortSchema.optional(), audience: audienceSchema.optional(), reason,
}).strict();
const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(), filters: filtersSchema.optional(), columns: columnsSchema.optional(),
  sort: sortSchema.optional(), audience: audienceSchema.optional(), reason,
}).strict();
const reasonSchema = z.object({ reason }).strict();
const transferSchema = z.object({ owner_id: uuidSchema, reason: z.string().trim().min(3).max(1000) }).strict();
const importSchema = z.object({
  screen_key: SCREEN,
  items: z.array(z.object({
    local_id: z.string().min(1).max(100), name: z.string().trim().min(1).max(120), filters: filtersSchema.optional(),
    columns: columnsSchema.optional(), sort: sortSchema.optional(),
  }).strict()).max(50),
}).strict();
const draftSchema = z.object({ payload: z.record(z.string(), z.unknown()), base_version: z.number().int().min(1).nullable().optional() }).strict();
const DRAFT_KEY = /^(task|record|form)\.[A-Za-z0-9_.-]{1,200}$/;

export interface SavedViewDto {
  id: string;
  screen_key: string;
  filters: Record<string, unknown>;
  shared: boolean;
  version: number;
  [k: string]: unknown;
}

type Audience = z.infer<typeof audienceSchema>;
const nonEmpty = (a: Audience | undefined): boolean => !!a && (!!a.everyone || !!a.role_ids?.length || !!a.group_ids?.length || !!a.user_ids?.length);

@Injectable()
export class SavedViewsService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  private async run<T>(sql: Prisma.Sql): Promise<T> {
    try {
      const rows = await this.db.tx.$queryRaw<{ r: T }[]>(sql);
      return rows[0]?.r as T;
    } catch (e) {
      const p = mapDbError(e);
      if (p) throw p;
      throw e;
    }
  }

  // ------------------------------------------------------------------ views
  async list(_auth: AuthContext, q: Record<string, unknown>): Promise<{ items: SavedViewDto[]; can_share: string; can_manage: boolean }> {
    const screen = typeof q.screen_key === 'string' && q.screen_key !== '' ? q.screen_key : null;
    if (screen !== null && !SCREEN.safeParse(screen).success) throw problems.validation([{ path: '/screen_key', code: 'invalid' }]);
    const scope = typeof q.scope === 'string' && q.scope !== '' ? q.scope : 'all';
    const inactive = boolParam(q, 'include_inactive') === true;
    const items = await this.run<SavedViewDto[]>(Prisma.sql`SELECT sv_list(${screen}::text, ${scope}::text, ${inactive}::boolean) AS r`);
    const flags = await this.run<{ share: string; manage: boolean }>(Prisma.sql`SELECT jsonb_build_object('share', sv_share_scope(app_actor()), 'manage', sv_is_manager()) AS r`);
    return { items, can_share: flags.share, can_manage: flags.manage };
  }

  async get(_auth: AuthContext, id: string): Promise<SavedViewDto> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    return this.run<SavedViewDto>(Prisma.sql`SELECT sv_get(${id}::uuid) AS r`);
  }

  /**
   * "Within the creator's scope" (Q117): a shared view may only carry a region filter inside the sharer's regions for the screen's module.
   * The recipients' own rights still filter the rows; this keeps a lead of one region from publishing a view of another.
   */
  private async checkRegionScope(screen: string, filters: Record<string, unknown> | undefined): Promise<void> {
    const raw = filters?.region_id;
    if (raw === undefined || raw === null || raw === '') return;
    const values = (Array.isArray(raw) ? raw : [raw]).map((x) => Number(x));
    const mod = await this.run<string | null>(Prisma.sql`SELECT sv_screen_module(${screen}::text) AS r`);
    if (!mod) return;
    const regs = await this.access.regions(mod, 'view');
    if (regs === null) return;
    if (values.some((v) => !Number.isInteger(v) || !regs.includes(v))) {
      throw problems.validation([{ path: '/filters/region_id', code: 'out_of_scope', message: 'A shared view may only filter on your own regions.' }]);
    }
  }

  async create(auth: AuthContext, raw: unknown): Promise<SavedViewDto> {
    const b = parse(createSchema, raw);
    if (nonEmpty(b.audience)) await this.checkRegionScope(b.screen_key, b.filters);
    const { reason: why, ...body } = b;
    return this.run<SavedViewDto>(Prisma.sql`SELECT sv_save(NULL::uuid, NULL::int, ${JSON.stringify(body)}::jsonb, ${why ?? null}::text) AS r`);
  }

  async update(auth: AuthContext, id: string, ifMatch: string | undefined, raw: unknown): Promise<SavedViewDto> {
    const version = parseIfMatch(ifMatch);
    const b = parse(patchSchema, raw);
    const cur = await this.get(auth, id);
    const shared = b.audience === undefined ? cur.shared : nonEmpty(b.audience);
    if (shared && (b.filters !== undefined || b.audience !== undefined)) await this.checkRegionScope(cur.screen_key, b.filters ?? cur.filters);
    const { reason: why, ...body } = b;
    return this.run<SavedViewDto>(Prisma.sql`SELECT sv_save(${id}::uuid, ${version}::int, ${JSON.stringify(body)}::jsonb, ${why ?? null}::text) AS r`);
  }

  async setActive(_auth: AuthContext, id: string, active: boolean, ifMatch: string | undefined, raw: unknown): Promise<SavedViewDto> {
    const version = parseIfMatch(ifMatch);
    const b = parse(reasonSchema, raw ?? {});
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    return this.run<SavedViewDto>(Prisma.sql`SELECT sv_set_active(${id}::uuid, ${version}::int, ${active}::boolean, ${b.reason ?? null}::text) AS r`);
  }

  async transfer(_auth: AuthContext, id: string, ifMatch: string | undefined, raw: unknown): Promise<SavedViewDto> {
    const version = parseIfMatch(ifMatch);
    const b = parse(transferSchema, raw);
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    return this.run<SavedViewDto>(Prisma.sql`SELECT sv_transfer(${id}::uuid, ${version}::int, ${b.owner_id}::uuid, ${b.reason}::text) AS r`);
  }

  async versions(_auth: AuthContext, id: string): Promise<{ items: unknown[] }> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    return { items: await this.run<unknown[]>(Prisma.sql`SELECT sv_versions(${id}::uuid) AS r`) };
  }

  async import(_auth: AuthContext, raw: unknown): Promise<unknown> {
    const b = parse(importSchema, raw);
    return this.run<unknown>(Prisma.sql`SELECT sv_import(${b.screen_key}::text, ${JSON.stringify(b.items)}::jsonb) AS r`);
  }

  // ------------------------------------------------------------------ drafts (Q115)
  /** A draft is kept and returned only while the caller may still read its task or record (and create, for a new record). */
  private async checkDraftTarget(auth: AuthContext, key: string): Promise<void> {
    if (!DRAFT_KEY.test(key)) throw problems.validation([{ path: '/draft_key', code: 'invalid' }]);
    const [kind, ...rest] = key.split('.');
    if (kind === 'form') return;
    if (kind === 'task') {
      const id = rest.join('.');
      if (!uuidSchema.safeParse(id).success) throw problems.validation([{ path: '/draft_key', code: 'invalid' }]);
      const regs = await this.access.regions('sites', 'view');
      if (regs !== null && regs.length === 0) throw problems.notFound();
      const rows = await this.db.tx.$queryRaw<{ region_id: number }[]>(Prisma.sql`
        SELECT s.region_id FROM task_instances ti JOIN sites s ON s.id = ti.site_id WHERE ti.id = ${id}::uuid`);
      const r = rows[0];
      if (!r || (regs !== null && !regs.includes(r.region_id))) throw problems.notFound('The task does not exist or is not visible to you.');
      return;
    }
    const [regKey, id] = rest;
    if (rest.length !== 2 || !regKey || !id) throw problems.validation([{ path: '/draft_key', code: 'invalid' }]);
    const mod = (await this.db.tx.$queryRaw<{ m: string | null }[]>(Prisma.sql`SELECT reg_module(${regKey}::text) AS m`))[0]?.m;
    if (!mod) throw problems.notFound('This register does not exist.');
    if (id === 'new') {
      if (!(await this.access.hasGrant(auth, mod, 'create'))) throw problems.forbidden('action_forbidden', `You cannot create in ${mod}.`);
      return;
    }
    if (!uuidSchema.safeParse(id).success) throw problems.validation([{ path: '/draft_key', code: 'invalid' }]);
    const regs = await this.access.regions(mod, 'view');
    if (regs !== null && regs.length === 0) throw problems.notFound();
    const rows = await this.db.tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`
      SELECT true AS ok FROM register_records r WHERE r.register_key = ${regKey} AND (r.id = ${id}::uuid OR r.entity_id = ${id}::uuid)
        ${regs === null ? Prisma.empty : Prisma.sql`AND (r.is_global OR r.region_id = ANY(${regs}::int[]))`} LIMIT 1`);
    if (!rows.length) throw problems.notFound('The record does not exist or is not visible to you.');
  }

  async drafts(): Promise<{ items: unknown[]; retention_days: number }> {
    const items = await this.run<unknown[]>(Prisma.sql`SELECT dr_list() AS r`);
    const days = await this.run<number>(Prisma.sql`SELECT dr_retention_days() AS r`);
    return { items, retention_days: days };
  }

  async getDraft(auth: AuthContext, key: string): Promise<unknown> {
    await this.checkDraftTarget(auth, key);
    const d = await this.run<unknown>(Prisma.sql`SELECT dr_get(${key}::text) AS r`);
    if (!d) throw problems.notFound('There is no draft.');
    return d;
  }

  async saveDraft(auth: AuthContext, key: string, raw: unknown): Promise<unknown> {
    const b = parse(draftSchema, raw);
    await this.checkDraftTarget(auth, key);
    if (JSON.stringify(b.payload).length > 65536) {
      throw new ProblemException(422, 'validation_failed', { detail: 'A draft is at most 64 KB.', errors: [{ path: '/payload', code: 'too_large' }] });
    }
    return this.run<unknown>(Prisma.sql`SELECT dr_save(${key}::text, ${JSON.stringify(b.payload)}::jsonb, ${b.base_version ?? null}::int) AS r`);
  }

  async discardDraft(key: string): Promise<void> {
    if (!DRAFT_KEY.test(key)) return;
    await this.run<boolean>(Prisma.sql`SELECT dr_discard(${key}::text) AS r`);
  }
}
