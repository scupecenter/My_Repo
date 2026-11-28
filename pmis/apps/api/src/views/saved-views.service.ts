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
import { FilterCatalogService } from './filter-catalog.service';

/**
 * P10 (owner answers Q115 and Q117, migration 0065): saved views of the list screens, kept on the server, and the caller's drafts.
 * The database decides (sv_* and dr_* functions): who reads a view, who may share it, which columns a reader may see. The API adds the checks
 * that need the caller's region scope (a region filter of a shared view) and the read check of a draft's task or record.
 */

/** Site 360 was renamed Site Master (0158): the old screen key `site360-<menu>` is read as `site-master-<menu>` for one release. */
export const normScreen = (s: string): string => s.replace(/^site360-/, 'site-master-');
const SCREEN = z.string().regex(/^[a-z][a-z0-9_-]{1,80}$/).transform(normScreen);
const colId = z.string().max(100);
const columnsSchema = z.object({
  order: z.array(colId).max(200).optional(),
  hidden: z.array(colId).max(200).optional(),
  width: z.record(colId, z.number().int().min(40).max(1000)).optional(),
  density: z.enum(['comfortable', 'normal', 'compact']).optional(),
  // W8 item 4 (0.15.68): the Display options of the view
  display: z.object({
    size: z.enum(['sm', 'md', 'lg']).optional(),
    align: z.enum(['start', 'center']).optional(),
    wrap: z.boolean().optional(),
    zebra: z.boolean().optional(),
    groupbar: z.boolean().optional(),
  }).strict().optional(),
  // 0.15.590: the person's conditional formatting rules of the view (display only)
  rules: z.array(z.object({
    id: z.string().min(1).max(40),
    col: colId.min(1),
    op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'contains', 'empty', 'notempty', 'days_past', 'days_ahead']),
    value: z.union([z.string().max(120), z.number().finite()]).optional(),
    tone: z.enum(['red', 'amber', 'green', 'blue', 'grey']),
    scope: z.enum(['cell', 'row']),
  }).strict()).max(20).optional(),
}).strict();
const sortSchema = z.array(z.object({ id: colId, dir: z.enum(['asc', 'desc']) }).strict()).max(5);
const filtersSchema = z.record(z.string().max(100), z.unknown()).refine((f) => Object.keys(f).length <= 50, { message: 'At most 50 filters.' });
const audienceSchema = z.object({
  everyone: z.boolean().optional(),
  role_ids: z.array(uuidSchema).max(100).optional(),
  group_ids: z.array(uuidSchema).max(100).optional(),
  user_ids: z.array(uuidSchema).max(100).optional(),
  // F3 (0.15.31): a view shared with regions reaches the users whose own view right covers the region
  region_ids: z.array(z.number().int().min(1).max(999)).max(100).optional(),
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
const nonEmpty = (a: Audience | undefined): boolean => !!a && (!!a.everyone || !!a.role_ids?.length || !!a.group_ids?.length || !!a.user_ids?.length || !!a.region_ids?.length);

/** The region values a filter tree pins (conditions region_id is / in, at any level): a shared view may only pin the sharer's regions. */
function treeRegions(tree: unknown): unknown[] {
  if (!tree || typeof tree !== 'object' || !Array.isArray((tree as { items?: unknown }).items)) return [];
  const out: unknown[] = [];
  for (const it of (tree as { items: unknown[] }).items) {
    if (it && typeof it === 'object' && Array.isArray((it as { items?: unknown }).items)) out.push(...treeRegions(it));
    else {
      const c = it as { field?: unknown; operator?: unknown; value?: unknown };
      if (c?.field === 'region_id' && (c.operator === 'is' || c.operator === 'in')) out.push(...(Array.isArray(c.value) ? c.value : [c.value]));
    }
  }
  return out;
}

/** The Master-column conditions (`m:<ord>`) of a tree, at any level. */
function treeHasMaster(tree: unknown): boolean {
  if (!tree || typeof tree !== 'object' || !Array.isArray((tree as { items?: unknown }).items)) return false;
  return (tree as { items: unknown[] }).items.some((it) => (it && typeof it === 'object' && Array.isArray((it as { items?: unknown }).items) ? treeHasMaster(it) : typeof (it as { field?: unknown })?.field === 'string' && /^m:/.test((it as { field: string }).field)));
}

/** The tree without the conditions on fields the reader may not use (a group left empty goes too), and how many conditions went. */
function stripTree(tree: { op?: unknown; items: unknown[] }, keys: Set<string>): { tree: { op?: unknown; items: unknown[] }; n: number } {
  let n = 0;
  const items: unknown[] = [];
  for (const it of tree.items) {
    if (it && typeof it === 'object' && Array.isArray((it as { items?: unknown }).items)) {
      const sub = stripTree(it as { items: unknown[] }, keys);
      n += sub.n;
      if (sub.tree.items.length) items.push(sub.tree);
    } else if (typeof (it as { field?: unknown })?.field === 'string' && keys.has((it as { field: string }).field)) items.push(it);
    else n += 1;
  }
  return { tree: { ...tree, items }, n };
}

@Injectable()
export class SavedViewsService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly catalog: FilterCatalogService) {}

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

  /**
   * 0.15.49: a view of `site-master-<menu>` may hold a condition on a Master column (`m:<ord>`) that the reader may not use (a register the reader may not view, a
   * custom field a field rule hides): the condition is removed from what the reader gets and counted in `stripped_columns`, as hidden columns and fields are
   * on the other screens (the database strips `f:` and `c:` fields; the Master columns are decided by the catalogue of the reader).
   */
  private async scrub<T extends SavedViewDto>(dto: T): Promise<T> {
    if (!dto || typeof dto.screen_key !== 'string' || !/^site-master-/.test(dto.screen_key)) return dto;
    const adv = (dto.filters as { advanced?: unknown } | undefined)?.advanced;
    if (!treeHasMaster(adv)) return dto;
    const keys = new Set((await this.catalog.catalog(dto.screen_key)).keys());
    const out = stripTree(adv as { items: unknown[] }, keys);
    if (!out.n) return dto;
    const stripped = typeof dto.stripped_columns === 'number' ? dto.stripped_columns : 0;
    return { ...dto, filters: { ...dto.filters, advanced: out.tree }, stripped_columns: stripped + out.n };
  }

  // ------------------------------------------------------------------ views
  async list(_auth: AuthContext, q: Record<string, unknown>): Promise<{ items: SavedViewDto[]; can_share: string; can_manage: boolean }> {
    const screen = typeof q.screen_key === 'string' && q.screen_key !== '' ? normScreen(q.screen_key) : null;
    if (screen !== null && !SCREEN.safeParse(screen).success) throw problems.validation([{ path: '/screen_key', code: 'invalid' }]);
    const scope = typeof q.scope === 'string' && q.scope !== '' ? q.scope : 'all';
    const inactive = boolParam(q, 'include_inactive') === true;
    const items = await Promise.all((await this.run<SavedViewDto[]>(Prisma.sql`SELECT sv_list(${screen}::text, ${scope}::text, ${inactive}::boolean) AS r`)).map((v) => this.scrub(v)));
    const flags = await this.run<{ share: string; manage: boolean }>(Prisma.sql`SELECT jsonb_build_object('share', sv_share_scope(app_actor()), 'manage', sv_is_manager()) AS r`);
    return { items, can_share: flags.share, can_manage: flags.manage };
  }

  async get(_auth: AuthContext, id: string): Promise<SavedViewDto> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    return this.scrub(await this.run<SavedViewDto>(Prisma.sql`SELECT sv_get(${id}::uuid) AS r`));
  }

  // ------------------------------------------------------------------ default view per screen (0.15.582, migration 0655)
  /** Make a view the caller's default for its screen, or clear it. Personal; the database re-checks that the caller may read the view. */
  async setDefault(_auth: AuthContext, id: string, on: boolean): Promise<{ view_id: string; screen_key: string | null; is_default: boolean }> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    return this.run(Prisma.sql`SELECT ${on ? Prisma.sql`default_view_set` : Prisma.sql`default_view_clear`}(${id}::uuid) AS r`);
  }

  /** The caller's default views, one per screen (inactive or unreadable views drop out). */
  async defaultViews(): Promise<{ items: { screen_key: string; view_id: string; name: string }[] }> {
    return { items: await this.run<{ screen_key: string; view_id: string; name: string }[]>(Prisma.sql`SELECT default_views() AS r`) };
  }

  // ------------------------------------------------------------------ home pins (0.15.245, item 16)
  /** Pin or unpin a view as a card on the caller's home dashboard. Personal; the database re-checks that the caller may read the view. */
  async pin(_auth: AuthContext, id: string, on: boolean): Promise<{ view_id: string; pinned_home: boolean }> {
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    return this.run(Prisma.sql`SELECT ${on ? Prisma.sql`home_pin_view` : Prisma.sql`home_unpin_view`}(${id}::uuid) AS r`);
  }

  /** The caller's pinned views (id, name, screen, filters), in the pin order; the filters are scrubbed like a read of the view. */
  async homePins(): Promise<{ items: { view_id: string; name: string; screen_key: string; filters: Record<string, unknown>; position: number }[] }> {
    const pins = await this.run<{ view_id: string; name: string; screen_key: string; filters: Record<string, unknown>; position: number }[]>(Prisma.sql`SELECT home_pins() AS r`);
    return { items: await Promise.all(pins.map(async (p) => ({ ...p, filters: (await this.scrub({ screen_key: p.screen_key, filters: p.filters } as SavedViewDto)).filters }))) };
  }

  /**
   * "Within the creator's scope" (Q117): a shared view may only carry a region filter inside the sharer's regions for the screen's module.
   * The recipients' own rights still filter the rows; this keeps a lead of one region from publishing a view of another.
   */
  private async checkRegionScope(screen: string, filters: Record<string, unknown> | undefined): Promise<void> {
    const raw = filters?.region_id;
    const fromTree = treeRegions(filters?.advanced);
    if ((raw === undefined || raw === null || raw === '') && fromTree.length === 0) return;
    const values = [...(raw === undefined || raw === null || raw === '' ? [] : Array.isArray(raw) ? raw : [raw]), ...fromTree].map((x) => Number(x));
    const mod = await this.run<string | null>(Prisma.sql`SELECT sv_screen_module(${screen}::text) AS r`);
    if (!mod) return;
    const regs = await this.access.regions(mod, 'view');
    if (regs === null) return;
    if (values.some((v) => !Number.isInteger(v) || !regs.includes(v))) {
      throw problems.validation([{ path: raw === undefined || raw === null || raw === '' ? '/filters/advanced' : '/filters/region_id', code: 'out_of_scope', message: 'A shared view may only filter on your own regions.' }]);
    }
  }

  async create(auth: AuthContext, raw: unknown): Promise<SavedViewDto> {
    const b = parse(createSchema, raw);
    await this.catalog.validate(b.screen_key, b.filters?.advanced);
    if (nonEmpty(b.audience)) await this.checkRegionScope(b.screen_key, b.filters);
    const { reason: why, ...body } = b;
    return this.scrub(await this.run<SavedViewDto>(Prisma.sql`SELECT sv_save(NULL::uuid, NULL::int, ${JSON.stringify(body)}::jsonb, ${why ?? null}::text) AS r`));
  }

  async update(auth: AuthContext, id: string, ifMatch: string | undefined, raw: unknown): Promise<SavedViewDto> {
    const version = parseIfMatch(ifMatch);
    const b = parse(patchSchema, raw);
    const cur = await this.get(auth, id);
    if (b.filters !== undefined) await this.catalog.validate(cur.screen_key, b.filters.advanced);
    const shared = b.audience === undefined ? cur.shared : nonEmpty(b.audience);
    if (shared && (b.filters !== undefined || b.audience !== undefined)) await this.checkRegionScope(cur.screen_key, b.filters ?? cur.filters);
    const { reason: why, ...body } = b;
    return this.scrub(await this.run<SavedViewDto>(Prisma.sql`SELECT sv_save(${id}::uuid, ${version}::int, ${JSON.stringify(body)}::jsonb, ${why ?? null}::text) AS r`));
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
    // the browser's old local views never held a filter tree (F3); one that claims to is refused rather than stored unchecked
    const adv = b.items.findIndex((it) => it.filters?.advanced !== undefined);
    if (adv >= 0) throw problems.validation([{ path: `/items/${adv}/filters/advanced`, code: 'invalid', message: 'An imported view has no filter tree.' }]);
    return this.run<unknown>(Prisma.sql`SELECT sv_import(${b.screen_key}::text, ${JSON.stringify(b.items)}::jsonb) AS r`);
  }

  /** The screen of a filter-fields request: it must have a filter builder and the caller must be able to open its module(s). */
  private async requireFilterScreen(q: Record<string, unknown>, auth?: AuthContext): Promise<string> {
    const screen = typeof q.screen_key === 'string' ? normScreen(q.screen_key) : '';
    if (!SCREEN.safeParse(screen).success || !FilterCatalogService.supports(screen)) {
      throw problems.validation([{ path: '/screen_key', code: 'invalid', message: 'This list has no filter builder.' }]);
    }
    const admin = FilterCatalogService.adminModuleOf(screen); // users and assignments: the module grant their own list asks for
    if (admin) {
      if (!auth) throw problems.validation([{ path: '/screen_key', code: 'invalid', message: 'This list has no filter builder.' }]);
      await this.access.requireModuleView(auth, admin);
      return screen;
    }
    if (screen === 'audit-log' || screen === 'security-log') {
      await this.catalog.requireLogReader(screen); // the reader right of the log function itself
      return screen;
    }
    const local = FilterCatalogService.modulesOf(screen); // dashboard and site-master-<menu>: two rights for the dashboard, the Site Register for the menus
    if (local) {
      for (const m of local) await this.access.requireRegions(m, 'view');
      return screen;
    }
    const mod = await this.run<string | null>(Prisma.sql`SELECT sv_screen_module(${screen}::text) AS r`);
    if (!mod) throw problems.validation([{ path: '/screen_key', code: 'invalid', message: 'Not a list screen with saved views.' }]);
    await this.access.requireRegions(mod, 'view');
    return screen;
  }

  /** F3: the filter fields of a list screen the caller may filter on (the whitelist, hidden fields left out). */
  async filterFields(q: Record<string, unknown>, auth?: AuthContext): Promise<Record<string, unknown>> {
    return this.catalog.describe(await this.requireFilterScreen(q, auth));
  }

  /** 0.15.49: the values of one enum field that match `q` (a field whose list was cut at 500 stays reachable); the same scope and hidden-field rules as the catalogue. */
  async filterFieldValues(field: string, q: Record<string, unknown>, auth?: AuthContext): Promise<Record<string, unknown>> {
    const screen = await this.requireFilterScreen(q, auth);
    const text = q.q === undefined || q.q === null ? '' : typeof q.q === 'string' ? q.q : null;
    if (text === null || text.length > 100) throw problems.validation([{ path: '/q', code: 'invalid', message: 'q is a text of at most 100 characters.' }]);
    let limit = 50;
    if (q.limit !== undefined && q.limit !== '') {
      limit = Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw problems.validation([{ path: '/limit', code: 'out_of_range', message: 'limit is a whole number from 1 to 500.' }]);
    }
    if (!field || field.length > 100) throw problems.validation([{ path: '/field', code: 'unknown_field' }]);
    return this.catalog.values(screen, field, text, limit);
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
