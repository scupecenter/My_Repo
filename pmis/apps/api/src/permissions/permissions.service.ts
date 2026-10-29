import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { checkIfMatch } from '../common/etag';
import { FieldError, problems } from '../common/problem';
import { boolParam, Query } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { DELEGABLE_RIGHTS, MODULE_KEYS, MODULES } from './catalogue';

/** The contract's PermissionAction. The database enum may hold fewer (manage_users and view_security_log are not in migration 0001). */
const CONTRACT_ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'import', 'download_documents', 'view_audit', 'administer', 'manage_users', 'view_security_log'] as const;

const reason = z.string().trim().min(3).max(1000);
const grantSchema = z.object({ module_key: z.string().min(1).max(80), action: z.enum(CONTRACT_ACTIONS) }).strict();
const ruleSchema = z.object({
  field_id: z.string().uuid(),
  field_code: z.string().optional(),
  entity_type: z.string().optional(),
  access: z.enum(['hidden', 'read', 'edit']),
}).strict();

const inputSchema = z.object({
  code: z.string().min(1).max(60),
  name_en: z.string().trim().min(1).max(200),
  name_ar: z.string().trim().max(200).optional(),
  description: z.string().max(2000).optional(),
  is_active: z.boolean().default(true),
  grants: z.array(grantSchema).max(2000),
  field_rules: z.array(ruleSchema).max(2000).default([]),
  reason,
}).strict();

export interface ProfileDto {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  description: string | null;
  is_active: boolean;
  grants: { module_key: string; action: string }[];
  field_rules: { field_id: string; field_code: string; entity_type: string; access: string }[];
  assignment_count: number;
  version: number;
  changed_by?: { id: string; display_name: string; employee_id: string | null };
  changed_at: Date;
}

/** Contract pattern of a new profile code. The seeded profiles (viewer, data_entry, ...) predate it, so only create checks it. */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,40}$/;
const PROFILE_VIEWERS = ['admin.roles', 'admin.users'];

@Injectable()
export class PermissionsService {
  private dbActions: Set<string> | undefined;

  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
  ) {}

  /** Actions the database can store, read once from the enum type. */
  private async supportedActions(): Promise<Set<string>> {
    if (!this.dbActions) {
      const rows = await this.db.tx.$queryRaw<{ a: string }[]>`SELECT unnest(enum_range(NULL::"PermissionAction"))::text AS a`;
      this.dbActions = new Set(rows.map((r) => r.a));
    }
    return this.dbActions;
  }

  /** GET /permissions/catalogue: only actions the database can store are offered, so the editor never produces a grant it cannot save. */
  async catalogue() {
    const supported = await this.supportedActions();
    const actions = CONTRACT_ACTIONS.filter((a) => supported.has(a));
    return {
      modules: MODULES.map((m) => ({
        key: m.key,
        name_en: m.name_en,
        ...(m.screens ? { screens: m.screens } : {}),
        actions: m.actions.filter((a) => supported.has(a)),
      })),
      actions,
      delegable_rights: DELEGABLE_RIGHTS,
    };
  }

  async list(auth: AuthContext, q: Query): Promise<{ items: ProfileDto[] }> {
    await this.access.requireAnyModuleView(auth, PROFILE_VIEWERS);
    const includeInactive = boolParam(q, 'include_inactive') ?? false;
    const rows = await this.db.tx.permissionProfile.findMany({ where: includeInactive ? {} : { is_active: true }, orderBy: [{ name_en: 'asc' }, { id: 'asc' }] });
    return { items: await this.toDtos(rows.map((r) => r.id)) };
  }

  async get(auth: AuthContext, id: string): Promise<ProfileDto> {
    await this.access.requireAnyModuleView(auth, PROFILE_VIEWERS);
    const p = await this.find(id);
    if (!p) throw problems.notFound();
    return p;
  }

  async create(auth: AuthContext, raw: unknown): Promise<ProfileDto> {
    await this.access.requireAdmin('permission_profiles', 'create');
    await this.stepUp.require(auth);
    const b = parse(inputSchema, raw);
    if (!CODE_PATTERN.test(b.code)) throw problems.validation([{ path: '/code', code: 'invalid_string', message: 'Use capital letters, digits and underscores, starting with a letter.' }]);
    await this.validate(b.grants, b.field_rules);
    const rows = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT idm_profile_save(NULL::uuid, ${b.code}::text, ${b.name_en}::text,
      ${b.name_ar ?? null}::text, ${b.description ?? null}::text, ${b.is_active}::boolean, ${b.reason}::text)::text AS id`);
    const id = rows[0]!.id;
    await this.setGrants(id, b.grants, b.reason);
    for (const r of b.field_rules) await this.setRule(id, r.field_id, r.access, b.reason);
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return (await this.find(id))!;
  }

  async replace(auth: AuthContext, id: string, ifMatch: string | undefined, raw: unknown): Promise<ProfileDto> {
    await this.access.requireAdmin('permission_profiles', 'edit');
    if (ifMatch === undefined || ifMatch.trim() === '') checkIfMatch(undefined, ''); // 428 first
    await this.stepUp.require(auth);
    const b = parse(inputSchema, raw);
    const cur = await this.find(id);
    if (!cur) throw problems.notFound();
    checkIfMatch(ifMatch, cur.version);
    if (b.code !== cur.code) throw problems.validation([{ path: '/code', code: 'immutable', message: 'The code of a profile cannot change.' }]);
    await this.validate(b.grants, b.field_rules);

    await this.db.tx.$executeRaw(Prisma.sql`SELECT idm_profile_save(${id}::uuid, ${b.code}::text, ${b.name_en}::text, ${b.name_ar ?? null}::text,
      ${b.description ?? null}::text, ${b.is_active}::boolean, ${b.reason}::text)`);
    await this.setGrants(id, b.grants, b.reason);

    // Field rules: write what changed, remove what is no longer listed.
    const want = new Map(b.field_rules.map((r) => [r.field_id, r.access]));
    const have = new Map(cur.field_rules.map((r) => [r.field_id, r.access]));
    for (const [field, access] of want) if (have.get(field) !== access) await this.setRule(id, field, access, b.reason);
    for (const field of have.keys()) if (!want.has(field)) await this.setRule(id, field, null, b.reason);
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return (await this.find(id))!;
  }

  private async setGrants(id: string, grants: { module_key: string; action: string }[], why: string): Promise<void> {
    const unique = [...new Map(grants.map((g) => [`${g.module_key}\u0000${g.action}`, { module: g.module_key, action: g.action }])).values()];
    await this.db.tx.$executeRaw(Prisma.sql`SELECT idm_profile_set_grants(${id}::uuid, ${JSON.stringify(unique)}::jsonb, ${why}::text)`);
  }

  private async setRule(profile: string, field: string, access: string | null, why: string): Promise<void> {
    await this.db.tx.$executeRaw(Prisma.sql`SELECT idm_field_permission_set(${field}::uuid, NULL::uuid, ${profile}::uuid, ${access}::"FieldAccess", ${why}::text)`);
  }

  private async validate(grants: { module_key: string; action: string }[], rules: { field_id: string }[]): Promise<void> {
    const supported = await this.supportedActions();
    const errors: FieldError[] = [];
    grants.forEach((g, i) => {
      if (!MODULE_KEYS.has(g.module_key)) errors.push({ path: `/grants/${i}/module_key`, code: 'unknown_module', message: `Unknown module ${g.module_key}.` });
      if (!supported.has(g.action)) {
        errors.push({ path: `/grants/${i}/action`, code: 'not_supported', message: `The database cannot store the action ${g.action} yet.` });
      }
    });
    const ids = rules.map((r) => r.field_id);
    if (new Set(ids).size !== ids.length) errors.push({ path: '/field_rules', code: 'duplicate', message: 'A field appears twice.' });
    if (ids.length > 0) {
      const found = await this.db.tx.fieldDefinition.findMany({ where: { id: { in: ids } }, select: { id: true } });
      const have = new Set(found.map((f) => f.id));
      rules.forEach((r, i) => { if (!have.has(r.field_id)) errors.push({ path: `/field_rules/${i}/field_id`, code: 'not_found', message: 'No such field.' }); });
    }
    if (errors.length > 0) throw problems.validation(errors);
  }

  private async find(id: string): Promise<ProfileDto | null> {
    if (!uuidSchema.safeParse(id).success) return null;
    return (await this.toDtos([id]))[0] ?? null;
  }

  private async toDtos(ids: string[]): Promise<ProfileDto[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.tx.permissionProfile.findMany({ where: { id: { in: ids } }, include: { grants: true } });
    const order = new Map(ids.map((id, i) => [id, i]));
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const rules = await this.db.tx.fieldPermission.findMany({
      where: { profile_id: { in: ids } },
      include: { field: { select: { code: true, entity_type: true } } },
      orderBy: [{ field_id: 'asc' }],
    });
    const counts = await this.db.tx.$queryRaw<{ profile_id: string; n: bigint }[]>(Prisma.sql`SELECT ap.profile_id::text AS profile_id, count(DISTINCT a.id) AS n
      FROM user_role_assignment_profiles ap JOIN user_role_assignments a ON a.id = ap.assignment_id
      WHERE ap.profile_id = ANY(${ids}::uuid[]) AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now()) GROUP BY ap.profile_id`);
    const count = new Map(counts.map((c) => [c.profile_id, Number(c.n)]));
    const authors = await this.db.tx.user.findMany({
      where: { id: { in: rows.map((r) => r.changed_by).filter((x): x is string => x !== null) } },
      select: { id: true, display_name: true, employee_id: true },
    });
    const author = new Map(authors.map((u) => [u.id, u]));
    return rows.map((r) => {
      const by = r.changed_by ? author.get(r.changed_by) : undefined;
      return {
        id: r.id,
        code: r.code,
        name_en: r.name_en,
        name_ar: r.name_ar,
        description: r.description,
        is_active: r.is_active,
        grants: r.grants.map((g) => ({ module_key: g.module_key, action: g.action as string })).sort((a, b) => a.module_key.localeCompare(b.module_key) || a.action.localeCompare(b.action)),
        field_rules: rules.filter((x) => x.profile_id === r.id).map((x) => ({ field_id: x.field_id, field_code: x.field.code, entity_type: x.field.entity_type as string, access: x.access as string })),
        assignment_count: count.get(r.id) ?? 0,
        version: r.version,
        ...(by ? { changed_by: { id: by.id, display_name: by.display_name, employee_id: by.employee_id?.trim() ?? null } } : {}),
        changed_at: r.changed_at,
      };
    });
  }
}
