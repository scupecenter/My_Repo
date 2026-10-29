import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { decodeCursor, encodeCursor, parseLimit } from '../common/cursor';
import { FieldError, problems, ProblemException } from '../common/problem';
import { oneParam, Query, TS_TEXT } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { DELEGABLE_RIGHTS, grantsFromRights, rightsFromGrants, TOP_LEVEL_KEYS } from '../permissions/catalogue';

const STATES = ['active', 'scheduled', 'expired', 'revoked', 'all'] as const;
const reason = z.string().trim().min(3).max(1000);
const regionId = z.number().int().min(1).max(7);
const instant = z.string().datetime({ offset: true });

const inputSchema = z.object({
  to_user_id: z.string().uuid().optional(),
  target_kind: z.enum(['user', 'role', 'group']).optional(),
  target_id: z.string().uuid().optional(),
  scope: z.enum(['full', 'partial']),
  rights: z.array(z.enum(DELEGABLE_RIGHTS as [string, ...string[]])).min(1).max(DELEGABLE_RIGHTS.length).optional(),
  region_codes: z.array(regionId).max(7).default([]),
  module_codes: z.array(z.string().min(1).max(60)).max(100).default([]),
  allow_redelegate: z.boolean().default(false),
  valid_from: instant,
  valid_to: instant.nullable().optional(),
  reason,
}).strict();

const revokeSchema = z.object({ reason }).strict();

type UserRef = { id: string; display_name: string; employee_id: string | null };

export interface DelegationDto {
  id: string;
  from_user: UserRef;
  to_user: UserRef | null;
  target_kind: 'user' | 'role' | 'group';
  target: { kind: 'user' | 'role' | 'group'; id: string; label: string };
  scope: 'full' | 'partial';
  rights: string[];
  region_codes: number[];
  module_codes: string[];
  allow_redelegate: boolean;
  valid_from: Date;
  valid_to: Date | null;
  state: 'active' | 'scheduled' | 'expired' | 'revoked';
  reason: string | null;
  revoked_at: Date | null;
  revoked_by?: UserRef;
}

const INCLUDE = {
  grants: true,
  regions: true,
  from_user: { select: { id: true, display_name: true, employee_id: true } },
  target_user: { select: { id: true, display_name: true, employee_id: true } },
  target_role: { select: { id: true, name_en: true } },
  target_group: { select: { id: true, name: true } },
} satisfies Prisma.DelegationInclude;
type Row = Prisma.DelegationGetPayload<{ include: typeof INCLUDE }>;

const ref = (u: { id: string; display_name: string; employee_id: string | null }): UserRef => ({ id: u.id, display_name: u.display_name, employee_id: u.employee_id?.trim() ?? null });

@Injectable()
export class DelegationsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
  ) {}

  /** GET /delegations: the timeline, filtered by state (default active). */
  async list(auth: AuthContext, q: Query): Promise<{ items: DelegationDto[]; page: { limit: number; next_cursor: string | null; total: number } }> {
    await this.access.requireModuleView(auth, 'admin.delegation');
    const limit = parseLimit(oneParam(q, 'limit'));
    const cursor = decodeCursor(oneParam(q, 'cursor'), 2);
    const state = oneParam(q, 'state') ?? 'active';
    if (!(STATES as readonly string[]).includes(state)) throw problems.validation([{ path: '/state', code: 'invalid', message: `state is one of ${STATES.join(', ')}.` }]);
    const stateSql = Prisma.sql`CASE WHEN d.revoked THEN 'revoked' WHEN d.valid_from > now() THEN 'scheduled'
      WHEN d.valid_to IS NOT NULL AND d.valid_to <= now() THEN 'expired' ELSE 'active' END`;
    const where = state === 'all' ? Prisma.sql`true` : Prisma.sql`(${stateSql}) = ${state}`;
    const page = cursor ? Prisma.sql`AND (d.created_at, d.id::text) < (${cursor[0] as string}::timestamptz, ${cursor[1] as string})` : Prisma.empty;
    const ids = await this.db.tx.$queryRaw<{ id: string; at: string }[]>(Prisma.sql`SELECT d.id::text AS id, ${Prisma.raw(TS_TEXT('d.created_at'))} AS at
      FROM delegations d WHERE ${where} ${page} ORDER BY d.created_at DESC, d.id::text DESC LIMIT ${limit + 1}`);
    const total = await this.db.tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM delegations d WHERE ${where}`);
    const slice = ids.slice(0, limit);
    const items = await this.dtos(slice.map((r) => r.id));
    const last = slice[slice.length - 1];
    return { items, page: { limit, next_cursor: ids.length > limit && last ? encodeCursor([last.at, last.id]) : null, total: Number(total[0]?.n ?? 0) } };
  }

  /**
   * POST /delegations. A System Admin delegates. Anyone else may only pass on what a delegation to them allows
   * (`allow_redelegate`, never wider than that delegation); the database checks it again in idm_delegate.
   */
  async create(auth: AuthContext, raw: unknown): Promise<DelegationDto> {
    // Refuse early (before any body check) a caller who could never delegate: not a System Admin and holding nothing to pass on.
    if (!(await this.access.isSystemAdmin()) && (await this.redelegable()).length === 0) await this.refuseDelegate(auth);
    await this.stepUp.require(auth);
    const b = parse(inputSchema, raw);
    const errors: FieldError[] = [];

    // Target: either to_user_id, or target_kind with target_id; not both, not neither.
    const byUser = b.to_user_id !== undefined;
    const byKind = b.target_kind !== undefined || b.target_id !== undefined;
    if (byUser === byKind) errors.push({ path: '/', code: 'target', message: 'Name the target with to_user_id, or with target_kind and target_id (not both).' });
    if (byKind && (b.target_kind === undefined || b.target_id === undefined)) errors.push({ path: '/target_id', code: 'required', message: 'target_kind and target_id go together.' });
    const kind = byUser ? 'user' : b.target_kind;
    const targetId = byUser ? b.to_user_id : b.target_id;
    if (b.scope === 'partial' && !b.rights) errors.push({ path: '/rights', code: 'required', message: 'A partial delegation lists its rights.' });
    if (b.scope === 'full' && b.rights) errors.push({ path: '/rights', code: 'invalid', message: 'A full delegation has no list of rights.' });
    const validFrom = new Date(b.valid_from);
    const validTo = b.valid_to ? new Date(b.valid_to) : null;
    if (validTo && validTo <= validFrom) errors.push({ path: '/valid_to', code: 'invalid', message: 'valid_to must be after valid_from.' });
    if (b.module_codes.length > 0) {
      b.module_codes.forEach((m, i) => { if (!TOP_LEVEL_KEYS.has(m)) errors.push({ path: `/module_codes/${i}`, code: 'unknown_module', message: `Unknown module ${m}.` }); });
      errors.push({ path: '/module_codes', code: 'not_supported', message: 'A delegation cannot be limited to modules yet: the database stores rights and regions only.' });
    }
    if (new Set(b.region_codes).size !== b.region_codes.length) errors.push({ path: '/region_codes', code: 'duplicate', message: 'A region appears twice.' });
    if (errors.length > 0 || !kind || !targetId) throw problems.validation(errors);
    await this.checkTarget(kind, targetId, byUser ? '/to_user_id' : '/target_id');

    const grants = b.scope === 'partial' ? grantsFromRights(b.rights ?? []) : [];
    const parent = await this.parentFor(auth, b.scope === 'full', grants);
    const rows = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT idm_delegate(${kind}::"DelegationTarget", ${kind === 'user' ? targetId : null}::uuid,
      ${kind === 'role' ? targetId : null}::uuid, ${kind === 'group' ? targetId : null}::uuid, ${b.scope === 'full'}::boolean,
      ${JSON.stringify(grants)}::jsonb, ${b.region_codes.length === 0}::boolean, ${b.region_codes}::int[], ${validFrom}::timestamptz, ${validTo}::timestamptz,
      ${b.allow_redelegate}::boolean, ${parent}::uuid, ${b.reason}::text)::text AS id`);
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return (await this.dtos([rows[0]!.id]))[0]!;
  }

  /** POST /delegations/{id}/revoke: a System Admin, or the person who made the delegation. */
  async revoke(auth: AuthContext, id: string, raw: unknown): Promise<DelegationDto> {
    await this.stepUp.require(auth);
    const b = parse(revokeSchema, raw);
    if (!uuidSchema.safeParse(id).success) throw problems.notFound();
    const cur = await this.db.tx.delegation.findUnique({ where: { id }, select: { from_user_id: true, revoked: true } });
    if (!cur) throw problems.notFound();
    if (cur.from_user_id !== auth.user.id && !(await this.access.isSystemAdmin())) {
      throw new ProblemException(403, (await this.holdsDelegation(auth)) ? 'delegate_forbidden' : 'action_forbidden', {
        detail: 'Only a System Admin or the person who made the delegation can revoke it.',
      });
    }
    if (cur.revoked) throw new ProblemException(409, 'invalid_transition', { detail: 'The delegation is already revoked.' });
    await this.db.tx.$executeRaw`SELECT idm_revoke_delegation(${id}::uuid, ${b.reason}::text)`;
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return (await this.dtos([id]))[0]!;
  }

  // ------------------------------------------------------------------------------------------------------------- helpers
  private async checkTarget(kind: 'user' | 'role' | 'group', id: string, path: string): Promise<void> {
    const found =
      kind === 'user' ? await this.db.tx.user.count({ where: { id, deleted_at: null, status: { in: ['active', 'pending_assignment'] } } })
      : kind === 'role' ? await this.db.tx.role.count({ where: { id, is_active: true } })
      : await this.db.tx.group.count({ where: { id, is_active: true } });
    if (found === 0) throw problems.validation([{ path, code: 'not_found', message: `No such active ${kind}.` }]);
  }

  /** Delegations to the caller that may be passed on (`allow_redelegate`), longest-lived first. */
  private async redelegable(): Promise<{ id: string; is_full: boolean }[]> {
    return this.db.tx.$queryRaw<{ id: string; is_full: boolean }[]>`SELECT d.id::text AS id, d.is_full FROM app_user_delegations(app_actor()) x(id)
      JOIN delegations d ON d.id = x.id WHERE d.allow_redelegate ORDER BY d.valid_to DESC NULLS FIRST, d.id`;
  }

  private async refuseDelegate(auth: AuthContext): Promise<never> {
    throw new ProblemException(403, (await this.holdsDelegation(auth)) ? 'delegate_forbidden' : 'action_forbidden', {
      detail: 'Only a System Admin delegates. A delegate may pass on only what the admin allowed with allow_redelegate.',
    });
  }

  /** The delegation the caller re-delegates under, or null for a System Admin. Anyone else without a covering one is refused. */
  private async parentFor(auth: AuthContext, full: boolean, grants: { module: string; action: string }[]): Promise<string | null> {
    if (await this.access.isSystemAdmin()) return null;
    for (const c of await this.redelegable()) {
      if (c.is_full) return c.id;
      if (full) continue;
      let covers = true;
      for (const g of grants) {
        const r = await this.db.tx.$queryRaw<{ ok: boolean }[]>`SELECT deleg_covers(${c.id}::uuid, ${g.module}, ${g.action}::"PermissionAction") AS ok`;
        if (r[0]?.ok !== true) { covers = false; break; }
      }
      if (covers) return c.id;
    }
    return this.refuseDelegate(auth);
  }

  private async holdsDelegation(auth: AuthContext): Promise<boolean> {
    const r = await this.db.tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM app_user_delegations(${auth.user.id}::uuid)`;
    return Number(r[0]?.n ?? 0) > 0;
  }

  private async dtos(ids: string[]): Promise<DelegationDto[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.tx.delegation.findMany({ where: { id: { in: ids } }, include: INCLUDE });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const revokers = await this.db.tx.user.findMany({
      where: { id: { in: rows.map((r) => r.revoked_by).filter((x): x is string => x !== null) } },
      select: { id: true, display_name: true, employee_id: true },
    });
    const by = new Map(revokers.map((u) => [u.id, u]));
    const now = new Date();
    return ids.map((id) => byId.get(id)).filter((r): r is Row => r !== undefined).map((r) => {
      const kind = r.target_kind as 'user' | 'role' | 'group';
      const target =
        kind === 'user' && r.target_user ? { kind, id: r.target_user.id, label: r.target_user.display_name }
        : kind === 'role' && r.target_role ? { kind, id: r.target_role.id, label: r.target_role.name_en }
        : { kind, id: r.target_group?.id ?? '', label: r.target_group?.name ?? '' };
      const state = r.revoked ? 'revoked' : r.valid_from > now ? 'scheduled' : r.valid_to !== null && r.valid_to <= now ? 'expired' : 'active';
      const revoker = r.revoked_by ? by.get(r.revoked_by) : undefined;
      return {
        id: r.id,
        from_user: ref(r.from_user),
        to_user: r.target_user ? ref(r.target_user) : null,
        target_kind: kind,
        target,
        scope: r.is_full ? 'full' : 'partial',
        rights: r.is_full ? [] : rightsFromGrants(r.grants),
        region_codes: r.all_regions ? [] : r.regions.map((x) => x.region_id).sort((a, b) => a - b),
        module_codes: [],
        allow_redelegate: r.allow_redelegate,
        valid_from: r.valid_from,
        valid_to: r.valid_to,
        state,
        reason: r.reason,
        revoked_at: r.revoked_at,
        ...(revoker ? { revoked_by: ref(revoker) } : {}),
      };
    });
  }
}
