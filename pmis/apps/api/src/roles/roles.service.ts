import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { checkIfMatch, contentVersion } from '../common/etag';
import { FieldError, problems, ProblemException } from '../common/problem';
import { boolParam, Query } from '../common/query';
import { parse, uuidSchema } from '../common/zod';
import { DbService } from '../db/db.service';
import { TOP_LEVEL_KEYS } from '../permissions/catalogue';

const reason = z.string().trim().min(3).max(1000);
const regionId = z.number().int().min(1).max(7);
const regionScope = z.union([z.literal('all'), z.array(regionId).max(7)]);
const moduleScope = z.union([z.literal('all'), z.array(z.string().min(1).max(60)).max(100)]);

const inputSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/),
  name_en: z.string().trim().min(2).max(200),
  name_ar: z.string().trim().max(200).optional(),
  description_en: z.string().max(2000).optional(),
  description_ar: z.string().max(2000).optional(),
  parent_role_id: z.string().uuid().nullable().optional(),
  default_profile_id: z.string().uuid().nullable().optional(),
  default_region_ids: regionScope.optional(),
  default_module_keys: moduleScope.optional(),
  can_hold_matrix_levels: z.boolean(),
  reason,
}).strict();

const patchSchema = z.object({
  name_en: z.string().trim().min(2).max(200).optional(),
  name_ar: z.string().trim().max(200).optional(),
  description_en: z.string().max(2000).optional(),
  description_ar: z.string().max(2000).optional(),
  default_profile_id: z.string().uuid().nullable().optional(),
  default_region_ids: regionScope.optional(),
  default_module_keys: moduleScope.optional(),
  can_hold_matrix_levels: z.boolean().optional(),
  is_active: z.boolean().optional(),
  reason,
}).strict();

export interface RoleRefDto {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  parent_role_id: string | null;
}

export interface RoleDto extends RoleRefDto {
  description_en: string | null;
  description_ar: string | null;
  default_profile_id: string | null;
  default_region_ids: 'all' | number[];
  default_module_keys: 'all' | string[];
  can_hold_matrix_levels: boolean;
  is_active: boolean;
  active_assignment_count: number;
  sub_roles: RoleRefDto[];
  version: number;
}

const ROLE_INCLUDE = { default_regions: true, default_modules: true } satisfies Prisma.RoleInclude;
type RoleRow = Prisma.RoleGetPayload<{ include: typeof ROLE_INCLUDE }>;

const ref = (r: { id: string; code: string; name_en: string; name_ar: string | null; parent_role_id: string | null }): RoleRefDto => ({
  id: r.id, code: r.code, name_en: r.name_en, name_ar: r.name_ar, parent_role_id: r.parent_role_id,
});

@Injectable()
export class RolesService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
  ) {}

  /** GET /roles: main roles first, each followed by its sub-roles; every role lists its sub_roles. */
  async list(q: Query): Promise<{ items: RoleDto[] }> {
    const includeInactive = boolParam(q, 'include_inactive') ?? false;
    const rows = await this.db.tx.role.findMany({
      where: includeInactive ? {} : { is_active: true },
      include: ROLE_INCLUDE,
      orderBy: [{ sort: 'asc' }, { name_en: 'asc' }, { id: 'asc' }],
    });
    const dtos = await this.toDtos(rows);
    const byParent = new Map<string, RoleDto[]>();
    for (const d of dtos) if (d.parent_role_id) byParent.set(d.parent_role_id, [...(byParent.get(d.parent_role_id) ?? []), d]);
    const ordered: RoleDto[] = [];
    const placed = new Set<string>();
    for (const d of dtos) {
      if (d.parent_role_id && dtos.some((x) => x.id === d.parent_role_id)) continue; // placed under its parent
      ordered.push(d);
      placed.add(d.id);
      for (const s of byParent.get(d.id) ?? []) { ordered.push(s); placed.add(s.id); }
    }
    return { items: ordered };
  }

  async get(id: string): Promise<RoleDto> {
    const r = await this.find(id);
    if (!r) throw problems.notFound();
    return r;
  }

  async create(auth: AuthContext, raw: unknown): Promise<RoleDto> {
    await this.access.requireAdmin('roles', 'create');
    await this.stepUp.require(auth);
    const b = parse(inputSchema, raw);
    await this.checkReferences(b.parent_role_id ?? null, b.default_profile_id ?? null, b.default_module_keys);
    const rows = await this.db.tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT idm_role_save(NULL::uuid, ${b.code}::text, ${b.name_en}::text, ${b.name_ar ?? null}::text,
      ${b.description_en ?? null}::text, ${b.description_ar ?? null}::text, ${b.parent_role_id ?? null}::uuid, NULL::"TeamKind", ${b.default_profile_id ?? null}::uuid,
      ${b.default_region_ids === 'all'}::boolean, ${b.default_module_keys === 'all'}::boolean, ${b.can_hold_matrix_levels}::boolean, NULL::int, NULL::boolean,
      ${b.reason}::text)::text AS id`);
    const id = rows[0]!.id;
    if (b.default_region_ids !== undefined || b.default_module_keys !== undefined) {
      await this.setDefaults(id, listOf(b.default_region_ids), listOf(b.default_module_keys), b.reason);
    }
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return this.get(id);
  }

  async update(auth: AuthContext, id: string, ifMatch: string | undefined, raw: unknown): Promise<RoleDto> {
    await this.access.requireAdmin('roles', 'edit');
    if (ifMatch === undefined || ifMatch.trim() === '') checkIfMatch(undefined, ''); // 428 first
    await this.stepUp.require(auth);
    const b = parse(patchSchema, raw);
    if (Object.keys(b).length < 2) throw problems.validation([{ path: '/', code: 'min_properties', message: 'Send at least one field to change, with the reason.' }]);
    const cur = await this.find(id);
    if (!cur) throw problems.notFound();
    checkIfMatch(ifMatch, cur.version);

    if (b.is_active === false && cur.is_active) {
      // current and scheduled assignments both count: a scheduled row would start under an inactive role
      const open = await this.db.tx.userRoleAssignment.count({ where: { role_id: id, OR: [{ valid_to: null }, { valid_to: { gt: new Date() } }] } });
      if (open > 0) {
        throw new ProblemException(409, 'role_in_use', {
          detail: `The role has ${open} assignment(s) that have not ended. End them first; a role is deactivated, never deleted while assigned.`,
        });
      }
    }
    await this.checkReferences(null, b.default_profile_id ?? null, b.default_module_keys);

    const regionsGiven = b.default_region_ids !== undefined;
    const modulesGiven = b.default_module_keys !== undefined;
    const allRegions = regionsGiven ? b.default_region_ids === 'all' : cur.default_region_ids === 'all';
    const allModules = modulesGiven ? b.default_module_keys === 'all' : cur.default_module_keys === 'all';
    // idm_role_save overwrites the optional columns, so every value not in the patch is passed back unchanged.
    await this.db.tx.$executeRaw(Prisma.sql`SELECT idm_role_save(${id}::uuid, ${cur.code}::text, ${b.name_en ?? cur.name_en}::text,
      ${b.name_ar !== undefined ? b.name_ar : cur.name_ar}::text, ${b.description_en !== undefined ? b.description_en : cur.description_en}::text,
      ${b.description_ar !== undefined ? b.description_ar : cur.description_ar}::text, ${cur.parent_role_id}::uuid, NULL::"TeamKind",
      ${b.default_profile_id !== undefined ? b.default_profile_id : cur.default_profile_id}::uuid, ${allRegions}::boolean, ${allModules}::boolean,
      ${b.can_hold_matrix_levels ?? cur.can_hold_matrix_levels}::boolean, NULL::int, ${b.is_active ?? cur.is_active}::boolean, ${b.reason}::text)`);
    if (regionsGiven || modulesGiven) {
      await this.setDefaults(
        id,
        regionsGiven ? listOf(b.default_region_ids) : cur.default_region_ids === 'all' ? [] : cur.default_region_ids,
        modulesGiven ? listOf(b.default_module_keys) : cur.default_module_keys === 'all' ? [] : cur.default_module_keys,
        b.reason,
      );
    }
    await this.db.tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return this.get(id);
  }

  private async setDefaults(id: string, regions: number[], modules: string[], why: string): Promise<void> {
    await this.db.tx.$executeRaw(Prisma.sql`SELECT idm_role_set_defaults(${id}::uuid, ${regions}::int[], ${modules}::text[], ${why}::text)`);
  }

  private async checkReferences(parent: string | null, profile: string | null, modules: 'all' | string[] | undefined): Promise<void> {
    const errors: FieldError[] = [];
    if (parent) {
      const p = await this.db.tx.role.findUnique({ where: { id: parent }, select: { parent_role_id: true } });
      if (!p) errors.push({ path: '/parent_role_id', code: 'not_found', message: 'No such role.' });
      else if (p.parent_role_id) errors.push({ path: '/parent_role_id', code: 'invalid', message: 'A sub-role must have a main role as its parent (two levels only).' });
    }
    if (profile && (await this.db.tx.permissionProfile.count({ where: { id: profile } })) === 0) {
      errors.push({ path: '/default_profile_id', code: 'not_found', message: 'No such permission profile.' });
    }
    if (Array.isArray(modules)) {
      modules.forEach((m, i) => { if (!TOP_LEVEL_KEYS.has(m)) errors.push({ path: `/default_module_keys/${i}`, code: 'unknown_module', message: `Unknown module ${m}.` }); });
    }
    if (errors.length > 0) throw problems.validation(errors);
  }

  private async find(id: string): Promise<RoleDto | null> {
    if (!uuidSchema.safeParse(id).success) return null;
    const row = await this.db.tx.role.findUnique({ where: { id }, include: ROLE_INCLUDE });
    if (!row) return null;
    return (await this.toDtos([row]))[0] ?? null;
  }

  private async toDtos(rows: RoleRow[]): Promise<RoleDto[]> {
    if (rows.length === 0) return [];
    const counts = await this.db.tx.$queryRaw<{ role_id: string; n: bigint }[]>(Prisma.sql`SELECT role_id::text AS role_id, count(*) AS n FROM user_role_assignments
      WHERE role_id = ANY(${rows.map((r) => r.id)}::uuid[]) AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now()) GROUP BY role_id`);
    const count = new Map(counts.map((c) => [c.role_id, Number(c.n)]));
    const children = await this.db.tx.role.findMany({
      where: { parent_role_id: { in: rows.map((r) => r.id) } },
      orderBy: [{ sort: 'asc' }, { name_en: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => {
      const regions = r.default_regions.map((x) => x.region_id).sort((a, b) => a - b);
      const modules = r.default_modules.map((x) => x.module_key).sort();
      return {
        ...ref(r),
        description_en: r.description_en,
        description_ar: r.description_ar,
        default_profile_id: r.default_profile_id,
        default_region_ids: r.default_all_regions ? 'all' : regions,
        default_module_keys: r.default_all_modules ? 'all' : modules,
        can_hold_matrix_levels: r.can_hold_matrix_levels,
        is_active: r.is_active,
        active_assignment_count: count.get(r.id) ?? 0,
        sub_roles: children.filter((c) => c.parent_role_id === r.id).map(ref),
        version: contentVersion([r.code, r.name_en, r.name_ar, r.description_en, r.description_ar, r.parent_role_id, r.team, r.default_profile_id,
          r.default_all_regions, r.default_all_modules, r.can_hold_matrix_levels, r.sort, r.is_active, regions, modules]),
      };
    });
  }
}

const listOf = <T>(v: 'all' | T[] | undefined): T[] => (Array.isArray(v) ? v : []);
