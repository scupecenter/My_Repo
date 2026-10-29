import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { UserStateService } from '../auth/user-state.service';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { mapDbError } from '../common/db-errors';
import { IdempotencyService } from '../common/idempotency.service';
import { ErrorCode, FieldError, problems, ProblemException } from '../common/problem';
import { boolParam, oneParam, Query } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { TOP_LEVEL_KEYS } from '../permissions/catalogue';
import { ASSIGNMENT_INCLUDE, assignmentVersion, AssignmentDto, AssignmentRow, toAssignmentDto, UsersRepo } from '../users/users.repo';

const LEVELS = ['view', 'entry', 'review', 'approve', 'admin'] as const;
const TEAMS = ['cw', 'te', 'both', 'none'] as const;
/** Rows (users x roles) one request may create. The whole request is one transaction with a savepoint per row. */
const MAX_ROWS = 2000;

const reason = z.string().trim().min(3).max(1000);
const regionId = z.number().int().min(1).max(7);
const instant = z.string().datetime({ offset: true });

const patchShape = {
  permission_level: z.enum(LEVELS).optional(),
  team: z.enum(TEAMS).optional(),
  region_ids: z.union([z.literal('all'), z.array(regionId).min(1).max(7)]).optional(),
  module_keys: z.union([z.literal('all'), z.array(z.string().min(1).max(60)).min(1).max(100)]).optional(),
  profile_ids: z.array(z.string().uuid()).min(1).max(50).optional(),
  valid_from: instant.optional(),
  valid_to: instant.nullable().optional(),
};
const patchSchema = z.object(patchShape).strict();
type Patch = z.infer<typeof patchSchema>;

const bulkAssignSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1).max(500),
  role_ids: z.array(z.string().uuid()).min(1).max(50),
  defaults: z.object({ ...patchShape, permission_level: z.enum(LEVELS) }).strict(),
  reason,
  dry_run: z.boolean().default(false),
}).strict();

const versionedRef = z.object({ id: z.string().uuid(), version: z.number().int().min(1) }).strict();
const bulkUpdateSchema = z.object({
  items: z.array(versionedRef).min(1).max(500),
  patch: patchSchema.refine((p) => Object.keys(p).length > 0, { message: 'Send at least one field to change.' }),
  reason,
  dry_run: z.boolean().default(false),
}).strict();
const bulkEndSchema = z.object({
  items: z.array(versionedRef).min(1).max(500),
  valid_to: instant.optional(),
  reason,
  dry_run: z.boolean().default(false),
}).strict();
const copySchema = z.object({
  from_user_id: z.string().uuid(),
  to_user_ids: z.array(z.string().uuid()).min(1).max(200),
  mode: z.enum(['add', 'replace']),
  reason,
  dry_run: z.boolean().default(true),
}).strict();

interface Issue { ref: string; code: ErrorCode; message?: string }
export interface BulkResultDto {
  bulk_action_id: string;
  dry_run: boolean;
  done: { id: string; created_id?: string }[];
  skipped: Issue[];
  failed: Issue[];
}

/** What one idm_assign call needs. */
interface NewRow {
  userId: string;
  roleId: string;
  level: (typeof LEVELS)[number];
  team: (typeof TEAMS)[number];
  validFrom: Date | null;
  validTo: Date | null;
  primary: boolean;
  allRegions: boolean;
  regions: number[];
  allModules: boolean;
  modules: string[];
  profiles: string[];
}

const log = new Logger('Assignments');

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly states: UserStateService,
    private readonly idem: IdempotencyService,
    private readonly users: UsersRepo,
  ) {}

  // ------------------------------------------------------------------------------------------------------------- reads
  /** GET /users/{id}/assignments: the person's own rows, or any person's for a holder of admin.users view. */
  async listForUser(auth: AuthContext, userId: string, q: Query): Promise<{ items: AssignmentDto[] }> {
    if (userId !== auth.user.id) await this.access.requireModuleView(auth, 'admin.users');
    if (!uuidSchema.safeParse(userId).success || !(await this.users.find(userId))) throw problems.notFound();
    return { items: await this.users.assignmentsOf(userId, boolParam(q, 'include_ended') ?? false) };
  }

  /** GET /assignments: the by-role view, newest rows of each person first by name. */
  async list(auth: AuthContext, q: Query): Promise<{ items: AssignmentDto[]; page: { limit: number; next_cursor: string | null; total: number } }> {
    await this.access.requireModuleView(auth, 'admin.users');
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    const uuidParam = (k: string): string | undefined => {
      const v = oneParam(q, k);
      if (v !== undefined && !uuidSchema.safeParse(v).success) throw problems.validation([{ path: `/${k}`, code: 'invalid', message: 'Not a uuid.' }]);
      return v;
    };
    const roleId = uuidParam('role_id');
    const userId = uuidParam('user_id');
    const profileId = uuidParam('profile_id');
    const includeEnded = boolParam(q, 'include_ended') ?? false;
    const activeOn = oneParam(q, 'active_on');
    if (activeOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(activeOn)) throw problems.validation([{ path: '/active_on', code: 'invalid', message: 'Use a date (YYYY-MM-DD).' }]);

    const where: Prisma.Sql[] = [Prisma.sql`u.deleted_at IS NULL`];
    if (roleId) where.push(Prisma.sql`a.role_id = ${roleId}::uuid`);
    if (userId) where.push(Prisma.sql`a.user_id = ${userId}::uuid`);
    if (profileId) where.push(Prisma.sql`EXISTS (SELECT 1 FROM user_role_assignment_profiles ap WHERE ap.assignment_id = a.id AND ap.profile_id = ${profileId}::uuid)`);
    if (activeOn) {
      where.push(Prisma.sql`a.valid_from < (${activeOn}::date + 1)::timestamptz AND (a.valid_to IS NULL OR a.valid_to >= ${activeOn}::date::timestamptz)`);
    } else if (!includeEnded) {
      where.push(Prisma.sql`a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now())`);
    }
    const base = Prisma.join(where, ' AND ');
    const page = cursor ? Prisma.sql`AND (u.display_name, a.id::text) > (${cursor[0] as string}, ${cursor[1] as string})` : Prisma.empty;
    const ids = await this.db.tx.$queryRaw<{ id: string; name: string }[]>(Prisma.sql`SELECT a.id::text AS id, u.display_name AS name
      FROM user_role_assignments a JOIN users u ON u.id = a.user_id WHERE ${base} ${page} ORDER BY u.display_name, a.id::text LIMIT ${limit + 1}`);
    const total = await this.db.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM user_role_assignments a JOIN users u ON u.id = a.user_id WHERE ${base}`);
    const slice = ids.slice(0, limit);
    const rows = await this.db.tx.userRoleAssignment.findMany({ where: { id: { in: slice.map((r) => r.id) } }, include: ASSIGNMENT_INCLUDE });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const now = new Date();
    const items = slice.map((r) => byId.get(r.id)).filter((r): r is AssignmentRow => r !== undefined).map((r) => toAssignmentDto(r, now));
    const last = slice[slice.length - 1];
    return { items, page: { limit, next_cursor: ids.length > limit && last ? encodeCursor([last.name, last.id]) : null, total: Number(total[0]?.n ?? 0) } };
  }

  // ------------------------------------------------------------------------------------------------------------ writes
  /** POST /assignments/bulk-assign: users x roles, one idm_assign per pair inside its own savepoint. */
  async bulkAssign(auth: AuthContext, key: string | undefined, raw: unknown, requestId: string | undefined): Promise<BulkResultDto> {
    await this.access.requireAdmin('assignments', 'create');
    await this.stepUp.require(auth);
    const b = parse(bulkAssignSchema, raw);
    return this.idem.run(auth.user.id, 'bulk-assign', key, raw, () => this.runAssign(auth, b, requestId));
  }

  /** POST /assignments/bulk-update */
  async bulkUpdate(auth: AuthContext, key: string | undefined, raw: unknown, requestId: string | undefined): Promise<BulkResultDto> {
    await this.access.requireAdmin('assignments', 'edit');
    await this.stepUp.require(auth);
    const b = parse(bulkUpdateSchema, raw);
    return this.idem.run(auth.user.id, 'bulk-update', key, raw, () => this.runUpdate(auth, b, requestId));
  }

  /** POST /assignments/bulk-end */
  async bulkEnd(auth: AuthContext, key: string | undefined, raw: unknown, requestId: string | undefined): Promise<BulkResultDto> {
    await this.access.requireAdmin('assignments', 'delete');
    await this.stepUp.require(auth);
    const b = parse(bulkEndSchema, raw);
    return this.idem.run(auth.user.id, 'bulk-end', key, raw, () => this.runEnd(auth, b, requestId));
  }

  /** POST /assignments/copy */
  async copy(auth: AuthContext, key: string | undefined, raw: unknown, requestId: string | undefined): Promise<BulkResultDto> {
    await this.access.requireAdmin('assignments', 'create');
    // Copying reads the source person's assignments, so it needs the same right as listing them.
    await this.access.requireModuleView(auth, 'admin.users');
    await this.stepUp.require(auth);
    const b = parse(copySchema, raw);
    // Nobody copies another person's rights to themselves, not even as a preview. (The database refuses it for System Admins too.)
    if (b.to_user_ids.includes(auth.user.id)) {
      throw new ProblemException(403, 'self_beneficiary', { detail: 'You cannot copy assignments to yourself.' });
    }
    if (b.mode === 'replace') await this.access.requireAdmin('assignments', 'delete');
    return this.idem.run(auth.user.id, 'copy', key, raw, () => this.runCopy(auth, b, requestId));
  }

  // ------------------------------------------------------------------------------------------------------------ bulk-assign
  private async runAssign(auth: AuthContext, b: z.infer<typeof bulkAssignSchema>, requestId: string | undefined): Promise<BulkResultDto> {
    const userIds = [...new Set(b.user_ids)];
    const roleIds = [...new Set(b.role_ids)];
    if (userIds.length * roleIds.length > MAX_ROWS) {
      throw problems.validation([{ path: '/user_ids', code: 'too_many_rows', message: `One request creates at most ${MAX_ROWS} assignments (users x roles).` }]);
    }
    const d = b.defaults;
    await this.checkScope(d, '/defaults');
    const validFrom = d.valid_from ? new Date(d.valid_from) : null;
    const validTo = d.valid_to ? new Date(d.valid_to) : null;
    if (validFrom && validTo && validTo <= validFrom) {
      throw problems.validation([{ path: '/defaults/valid_to', code: 'invalid', message: 'valid_to must be after valid_from.' }]);
    }

    const [users, roles, taken, primaries] = await Promise.all([
      this.db.tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, status: true, deleted_at: true } }),
      this.db.tx.role.findMany({ where: { id: { in: roleIds } }, include: { default_regions: true, default_modules: true } }),
      this.overlapping(userIds, roleIds, validFrom, validTo),
      this.db.tx.userRoleAssignment.findMany({ where: { user_id: { in: userIds }, is_primary: true }, select: { user_id: true } }),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const roleById = new Map(roles.map((r) => [r.id, r]));
    const hasPrimary = new Set(primaries.map((p) => p.user_id));

    const result: BulkResultDto = { bulk_action_id: randomUUID(), dry_run: b.dry_run, done: [], skipped: [], failed: [] };
    const touched = new Set<string>();
    await this.db.tx.$executeRaw`SAVEPOINT bulk_all`;
    for (const roleId of roleIds) {
      for (const userId of userIds) {
        const ref = `${userId}:${roleId}`;
        const u = userById.get(userId);
        const role = roleById.get(roleId);
        if (!u || u.deleted_at) { result.failed.push({ ref, code: 'not_found', message: 'No such user.' }); continue; }
        if (!role) { result.failed.push({ ref, code: 'not_found', message: 'No such role.' }); continue; }
        if (!role.is_active) { result.failed.push({ ref, code: 'validation_failed', message: 'The role is inactive.' }); continue; }
        if (userId === auth.user.id) { result.failed.push({ ref, code: 'self_beneficiary', message: 'You cannot assign roles to yourself.' }); continue; }
        if (taken.has(ref)) { result.skipped.push({ ref, code: 'already_assigned', message: 'The person already holds this role in that period.' }); continue; }

        // Missing defaults come from the role definition (ADR 0003 item 2).
        const allRegions = d.region_ids !== undefined ? d.region_ids === 'all' : role.default_all_regions;
        const regions = Array.isArray(d.region_ids) ? [...new Set(d.region_ids)] : d.region_ids === undefined ? role.default_regions.map((r) => r.region_id) : [];
        const allModules = d.module_keys !== undefined ? d.module_keys === 'all' : role.default_all_modules;
        const modules = Array.isArray(d.module_keys) ? [...new Set(d.module_keys)] : d.module_keys === undefined ? role.default_modules.map((m) => m.module_key) : [];
        const profiles = d.profile_ids ? [...new Set(d.profile_ids)] : role.default_profile_id ? [role.default_profile_id] : [];
        const missing: string[] = [];
        if (!allRegions && regions.length === 0) missing.push('region_ids');
        if (!allModules && modules.length === 0) missing.push('module_keys');
        if (profiles.length === 0) missing.push('profile_ids');
        if (missing.length > 0) {
          result.failed.push({ ref, code: 'validation_failed', message: `Give ${missing.join(', ')}: the role ${role.code} has no default for it.` });
          continue;
        }
        const row: NewRow = {
          userId, roleId, level: d.permission_level, team: d.team ?? role.team, validFrom, validTo,
          primary: role.parent_role_id === null && !hasPrimary.has(userId),
          allRegions, regions, allModules, modules, profiles,
        };
        const created = await this.tryAssign(row, b.reason);
        if ('code' in created) { result.failed.push({ ref, ...created }); continue; }
        if (row.primary) hasPrimary.add(userId);
        touched.add(userId);
        result.done.push({ id: created.id, created_id: created.id });
      }
    }
    await this.finish(auth, 'bulk_assign', result, b.reason, requestId, [...touched]);
    return result;
  }

  /** One idm_assign in a savepoint; returns the new id, or the problem that refused the row. */
  private async tryAssign(r: NewRow, why: string): Promise<{ id: string } | Omit<Issue, 'ref'>> {
    await this.db.tx.$executeRaw`SAVEPOINT bulk_item`;
    try {
      const rows = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT idm_assign(${r.userId}::uuid, ${r.roleId}::uuid, ${r.level}::"PermissionLevel",
        ${r.team}::"TeamKind", ${r.validFrom}::timestamptz, ${r.validTo}::timestamptz, ${r.primary}::boolean, ${r.allRegions}::boolean, ${r.regions}::int[],
        ${r.allModules}::boolean, ${r.modules}::text[], ${r.profiles}::uuid[], ${why}::text)::text AS id`);
      await this.checkNow();
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT bulk_item`;
      return { id: rows[0]!.id };
    } catch (e) {
      await this.undoItem();
      const p = mapDbError(e);
      if (!p) throw e;
      return { code: p.code, message: p.opts.detail };
    }
  }

  // ------------------------------------------------------------------------------------------------------------ bulk-update
  private async runUpdate(auth: AuthContext, b: z.infer<typeof bulkUpdateSchema>, requestId: string | undefined): Promise<BulkResultDto> {
    await this.checkScope(b.patch, '/patch');
    const p = b.patch;
    const result: BulkResultDto = { bulk_action_id: randomUUID(), dry_run: b.dry_run, done: [], skipped: [], failed: [] };
    const rows = await this.load(b.items.map((i) => i.id));
    const touched = new Set<string>();
    await this.db.tx.$executeRaw`SAVEPOINT bulk_all`;
    for (const item of b.items) {
      const cur = rows.get(item.id);
      const bad = this.refuse(cur, item.version);
      if (bad) { result.failed.push({ ref: item.id, ...bad }); continue; }
      const a = cur!;
      if (p.valid_from !== undefined && new Date(p.valid_from).getTime() !== a.valid_from.getTime()) {
        result.failed.push({ ref: item.id, code: 'validation_failed', message: 'valid_from cannot change: end the row and assign again.' });
        continue;
      }
      const problem = await this.tryUpdate(a, p, p.valid_to !== undefined ? (p.valid_to ? new Date(p.valid_to) : null) : a.valid_to, b.reason);
      if (problem) { result.failed.push({ ref: item.id, ...problem }); continue; }
      touched.add(a.user_id);
      result.done.push({ id: item.id });
    }
    // Every row refused for the same reason that protects the last System Admin: the whole request is refused (contract: 409).
    if (result.done.length === 0 && result.failed.length > 0 && result.failed.every((f) => f.code === 'last_admin')) {
      throw new ProblemException(409, 'last_admin', { detail: 'At least one active System Admin must remain.' });
    }
    await this.finish(auth, 'bulk_update_assignments', result, b.reason, requestId, [...touched], { patch: p });
    return result;
  }

  private async tryUpdate(a: AssignmentRow, p: Patch, validTo: Date | null, why: string): Promise<Omit<Issue, 'ref'> | null> {
    await this.db.tx.$executeRaw`SAVEPOINT bulk_item`;
    try {
      const allRegions = p.region_ids === undefined ? null : p.region_ids === 'all';
      const regions = Array.isArray(p.region_ids) ? [...new Set(p.region_ids)] : null;
      const allModules = p.module_keys === undefined ? null : p.module_keys === 'all';
      const modules = Array.isArray(p.module_keys) ? [...new Set(p.module_keys)] : null;
      const profiles = p.profile_ids ? [...new Set(p.profile_ids)] : null;
      await this.db.tx.$executeRaw(Prisma.sql`SELECT idm_update_assignment(${a.id}::uuid, ${p.permission_level ?? null}::"PermissionLevel", ${p.team ?? null}::"TeamKind",
        ${validTo}::timestamptz, ${allRegions}::boolean, ${regions}::int[], ${allModules}::boolean, ${modules}::text[], ${profiles}::uuid[], ${why}::text)`);
      await this.checkNow();
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT bulk_item`;
      return null;
    } catch (e) {
      await this.undoItem();
      const pr = mapDbError(e);
      if (!pr) throw e;
      return { code: pr.code, message: pr.opts.detail };
    }
  }

  // --------------------------------------------------------------------------------------------------------------- bulk-end
  private async runEnd(auth: AuthContext, b: z.infer<typeof bulkEndSchema>, requestId: string | undefined): Promise<BulkResultDto> {
    const result: BulkResultDto = { bulk_action_id: randomUUID(), dry_run: b.dry_run, done: [], skipped: [], failed: [] };
    const rows = await this.load(b.items.map((i) => i.id));
    const until = b.valid_to ? new Date(b.valid_to) : null;
    const future = until !== null && until.getTime() > Date.now();
    if (future) await this.access.requireAdmin('assignments', 'edit'); // a future end date is an edit of the row
    const touched = new Set<string>();
    await this.db.tx.$executeRaw`SAVEPOINT bulk_all`;
    for (const item of b.items) {
      const cur = rows.get(item.id);
      const bad = this.refuse(cur, item.version);
      if (bad) { (bad.code === 'invalid_transition' ? result.skipped : result.failed).push({ ref: item.id, ...bad }); continue; }
      const a = cur!;
      await this.db.tx.$executeRaw`SAVEPOINT bulk_item`;
      try {
        if (future) {
          await this.db.tx.$executeRaw(Prisma.sql`SELECT idm_update_assignment(${a.id}::uuid, NULL::"PermissionLevel", NULL::"TeamKind", ${until}::timestamptz,
            NULL::boolean, NULL::int[], NULL::boolean, NULL::text[], NULL::uuid[], ${b.reason}::text)`);
        } else {
          await this.db.tx.$executeRaw`SELECT idm_end_assignment(${a.id}::uuid, ${b.reason}::text)`;
        }
        await this.checkNow();
        await this.db.tx.$executeRaw`RELEASE SAVEPOINT bulk_item`;
        touched.add(a.user_id);
        result.done.push({ id: item.id });
      } catch (e) {
        await this.undoItem();
        const pr = mapDbError(e);
        if (!pr) throw e;
        result.failed.push({ ref: item.id, code: pr.code, message: pr.opts.detail });
      }
    }
    if (result.done.length === 0 && result.failed.length > 0 && result.failed.every((f) => f.code === 'last_admin')) {
      throw new ProblemException(409, 'last_admin', { detail: 'At least one active System Admin must remain.' });
    }
    await this.finish(auth, 'bulk_end_assignments', result, b.reason, requestId, [...touched], { valid_to: b.valid_to ?? null });
    return result;
  }

  // ------------------------------------------------------------------------------------------------------------------ copy
  /**
   * Copy the active rows of one person to others. There is no idm_copy_assignments in the database (migration 0009), so each
   * target row is an idm_assign call (and, in `replace` mode, each current row of the target an idm_end_assignment). The
   * beneficiary rules of idm_assign therefore apply row by row.
   */
  private async runCopy(auth: AuthContext, b: z.infer<typeof copySchema>, requestId: string | undefined): Promise<BulkResultDto> {
    if (!(await this.users.find(b.from_user_id))) throw problems.notFound('The person to copy from does not exist.');
    const source = await this.db.tx.userRoleAssignment.findMany({
      where: { user_id: b.from_user_id, valid_from: { lte: new Date() }, OR: [{ valid_to: null }, { valid_to: { gt: new Date() } }] },
      include: ASSIGNMENT_INCLUDE,
      orderBy: [{ is_primary: 'desc' }, { assigned_at: 'asc' }, { id: 'asc' }],
    });
    const targets = [...new Set(b.to_user_ids)];
    const found = await this.db.tx.user.findMany({ where: { id: { in: targets } }, select: { id: true, deleted_at: true } });
    const known = new Map(found.map((u) => [u.id, u]));
    const result: BulkResultDto = { bulk_action_id: randomUUID(), dry_run: b.dry_run, done: [], skipped: [], failed: [] };
    const touched = new Set<string>();
    await this.db.tx.$executeRaw`SAVEPOINT bulk_all`;

    for (const target of targets) {
      const u = known.get(target);
      if (!u || u.deleted_at) { result.failed.push({ ref: target, code: 'not_found', message: 'No such user.' }); continue; }
      if (target === b.from_user_id) { result.skipped.push({ ref: target, code: 'already_assigned', message: 'That is the person being copied.' }); continue; }
      if (b.mode === 'replace') {
        const current = await this.db.tx.userRoleAssignment.findMany({
          where: { user_id: target, OR: [{ valid_to: null }, { valid_to: { gt: new Date() } }] }, select: { id: true },
        });
        for (const c of current) {
          await this.db.tx.$executeRaw`SAVEPOINT bulk_item`;
          try {
            await this.db.tx.$executeRaw`SELECT idm_end_assignment(${c.id}::uuid, ${b.reason}::text)`;
            await this.db.tx.$executeRaw`RELEASE SAVEPOINT bulk_item`;
            touched.add(target);
          } catch (e) {
            await this.undoItem();
            const pr = mapDbError(e);
            if (!pr) throw e;
            result.failed.push({ ref: `${target}:${c.id}`, code: pr.code, message: pr.opts.detail ?? 'The current assignment could not be ended.' });
          }
        }
      }
      const hasPrimary = (await this.db.tx.userRoleAssignment.count({ where: { user_id: target, is_primary: true } })) > 0;
      let primaryTaken = hasPrimary;
      for (const s of source) {
        const ref = `${target}:${s.role_id}`;
        if ((await this.overlapping([target], [s.role_id], null, s.valid_to)).has(ref)) {
          result.skipped.push({ ref, code: 'already_assigned', message: 'The person already holds this role in that period.' });
          continue;
        }
        const row: NewRow = {
          userId: target, roleId: s.role_id, level: s.permission_level, team: s.team, validFrom: null, validTo: s.valid_to,
          primary: s.is_primary && !primaryTaken, allRegions: s.all_regions, regions: s.regions.map((r) => r.region_id),
          allModules: s.all_modules, modules: s.modules.map((m) => m.module_key), profiles: s.UserRoleAssignmentProfile.map((p) => p.profile_id),
        };
        const created = await this.tryAssign(row, b.reason);
        if ('code' in created) { result.failed.push({ ref, ...created }); continue; }
        if (row.primary) primaryTaken = true;
        touched.add(target);
        result.done.push({ id: s.id, created_id: created.id });
      }
    }
    await this.finish(auth, 'copy_assignments', result, b.reason, requestId, [...touched], { from_user_id: b.from_user_id, mode: b.mode });
    return result;
  }

  // ------------------------------------------------------------------------------------------------------------- helpers
  /** Validation shared by the defaults of bulk-assign and the patch of bulk-update: module keys and profiles must exist. */
  private async checkScope(p: Patch, base: string): Promise<void> {
    const errors: FieldError[] = [];
    if (Array.isArray(p.module_keys)) {
      p.module_keys.forEach((m, i) => { if (!TOP_LEVEL_KEYS.has(m)) errors.push({ path: `${base}/module_keys/${i}`, code: 'unknown_module', message: `Unknown module ${m}.` }); });
    }
    if (p.profile_ids) {
      const ids = [...new Set(p.profile_ids)];
      const found = await this.db.tx.permissionProfile.findMany({ where: { id: { in: ids } }, select: { id: true, is_active: true } });
      const byId = new Map(found.map((f) => [f.id, f]));
      p.profile_ids.forEach((id, i) => {
        const f = byId.get(id);
        if (!f) errors.push({ path: `${base}/profile_ids/${i}`, code: 'not_found', message: 'No such permission profile.' });
        else if (!f.is_active) errors.push({ path: `${base}/profile_ids/${i}`, code: 'inactive', message: 'The permission profile is inactive.' });
      });
    }
    if (p.valid_from && p.valid_to && new Date(p.valid_to) <= new Date(p.valid_from)) {
      errors.push({ path: `${base}/valid_to`, code: 'invalid', message: 'valid_to must be after valid_from.' });
    }
    if (errors.length > 0) throw problems.validation(errors);
  }

  private async load(ids: string[]): Promise<Map<string, AssignmentRow>> {
    const rows = await this.db.tx.userRoleAssignment.findMany({ where: { id: { in: ids } }, include: ASSIGNMENT_INCLUDE });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Why a row of bulk-update / bulk-end cannot be touched, or null. */
  private refuse(a: AssignmentRow | undefined, version: number): Omit<Issue, 'ref'> | null {
    if (!a) return { code: 'not_found', message: 'No such assignment.' };
    if (a.valid_to !== null && a.valid_to.getTime() <= Date.now()) return { code: 'invalid_transition', message: 'The assignment has already ended.' };
    if (assignmentVersion(a) !== version) return { code: 'precondition_failed', message: 'The assignment changed since you read it.' };
    return null;
  }

  /** (user:role) pairs that already hold an overlapping period. */
  private async overlapping(users: string[], roles: string[], from: Date | null, to: Date | null): Promise<Set<string>> {
    const rows = await this.db.tx.$queryRaw<{ user_id: string; role_id: string }[]>(Prisma.sql`SELECT user_id::text AS user_id, role_id::text AS role_id
      FROM user_role_assignments WHERE user_id = ANY(${users}::uuid[]) AND role_id = ANY(${roles}::uuid[])
        AND tstzrange(valid_from, valid_to, '[)') && tstzrange(coalesce(${from}::timestamptz, now()), ${to}::timestamptz, '[)')`);
    return new Set(rows.map((r) => `${r.user_id}:${r.role_id}`));
  }

  /** Undo one row after an error and make sure constraint checking is back to deferred. */
  private async undoItem(): Promise<void> {
    await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT bulk_item`;
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
  }

  /** Fire the deferred constraint triggers now (scope check, last admin) so a violation is reported for this row only. */
  private async checkNow(): Promise<void> {
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
  }

  /**
   * Common ending of every bulk operation. A dry run undoes everything the loop wrote (one savepoint), so nothing is
   * written, not even the audit row. A real run activates pending people who now hold a row, writes one audit row that
   * carries the bulk_action_id, and drops the cached user state so the new rights apply on the next request.
   */
  private async finish(auth: AuthContext, action: string, result: BulkResultDto, why: string, requestId: string | undefined, userIds: string[],
    extra: Record<string, unknown> = {}): Promise<void> {
    if (result.dry_run) {
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT bulk_all`;
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT bulk_all`;
      return;
    }
    if (action === 'bulk_assign' || action === 'copy_assignments') await this.activatePending(userIds, why);
    await this.db.tx.$executeRaw`RELEASE SAVEPOINT bulk_all`;
    const after = JSON.stringify({ ...extra, done: result.done.length, skipped: result.skipped.length, failed: result.failed.length, ids: result.done.map((d) => d.created_id ?? d.id) });
    await this.db.tx.$executeRaw(Prisma.sql`INSERT INTO audit_log (action, entity_type, entity_id, after, reason, actor_id, on_behalf_of, ip, request_id)
      VALUES (${action}, 'bulk_action', ${result.bulk_action_id}, ${after}::jsonb, ${why}, ${auth.user.id}::uuid,
        CASE WHEN app_actor_is_system_admin() THEN NULL
             ELSE (SELECT d.from_user_id FROM app_user_delegations(app_actor()) x(id) JOIN delegations d ON d.id = x.id LIMIT 1) END,
        ${auth.ip}::text, ${requestId ?? null}::text)`);
    this.states.invalidate(...userIds);
  }

  /**
   * A person created in the PMIS or at first sign-in is `pending_assignment`. The first assignment makes the account usable:
   * the status becomes `active` through idm_set_user_status (it needs users.edit, which a System Admin holds). Someone who
   * may assign but not edit users leaves the status as it is; the person is then still "pending" and an admin finishes it.
   */
  private async activatePending(userIds: string[], why: string): Promise<void> {
    if (userIds.length === 0) return;
    const pending = await this.db.tx.user.findMany({
      where: { id: { in: userIds }, status: 'pending_assignment', deleted_at: null,
        assignments: { some: { valid_from: { lte: new Date() }, OR: [{ valid_to: null }, { valid_to: { gt: new Date() } }] } } },
      select: { id: true },
    });
    for (const u of pending) {
      await this.db.tx.$executeRaw`SAVEPOINT activate_user`;
      try {
        await this.db.tx.$executeRaw`SELECT idm_set_user_status(${u.id}::uuid, 'active'::"UserStatus", ${why}::text)`;
        await this.db.tx.$executeRaw`RELEASE SAVEPOINT activate_user`;
      } catch (e) {
        await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT activate_user`;
        if (!mapDbError(e)) throw e;
        log.warn(`could not activate user ${u.id} after the assignment: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}`);
      }
    }
  }
}
