import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { parseIfMatch } from '../common/etag';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const reason = z.string().trim().min(3).max(1000);
const label = z.string().trim().min(1).max(60);
const group = z.enum(['CW', 'TE']);
const putSchema = z.object({
  reason,
  specializations: z.array(label).max(30),
  scopes: z.array(z.object({
    scope: label, exempt: z.boolean().default(false), allowed: z.array(label).max(30), allowed_groups: z.array(group).max(2).optional(),
  }).strict()).max(60),
  catalogue: z.array(z.object({
    code: z.string().trim().min(1).max(30), label_en: label, label_ar: z.string().trim().max(60).nullable().optional(), group: group.nullable().optional(),
    groups: z.array(group).max(2).optional(),
    aliases: z.array(label).max(20).optional(),
  }).strict()).max(60).optional(),
}).strict();

interface CatalogueEntry { code: string; label_en: string; label_ar: string | null; group: 'CW' | 'TE' | null; groups: ('CW' | 'TE')[]; aliases: string[]; is_active: boolean }
interface MatchJson {
  specializations: string[];
  groups: string[];
  catalogue: CatalogueEntry[];
  scopes: { scope: string; exempt: boolean; allowed: string[]; allowed_groups: string[] }[];
  version: number;
  updated_at: string;
  updated_by: string | null;
}

/** Who may read the table: the Settings screen, and read-only Procurement and Contractors (Q147). */
export const MATCH_READERS = ['admin.settings', 'procurement', 'contractors'];

/**
 * Q97 (migration 0043), Q143, Q144 and Q147 (migration 0061): the team specialization / scope match of Procurement, with its specialization
 * catalogue (codes, labels, CW / TE groups, aliases) and the groups a scope allows. Read by the Settings screen and, read-only, by Procurement and
 * Contractors; written through admin_save_team_scope_match (System Admin or a delegation of admin.settings edit for all regions, reason, If-Match,
 * a fresh step-up when the change affects eligibility, audited).
 */
@Injectable()
export class TeamScopeMatchService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  private async dto(j: MatchJson) {
    let updated_by: { id: string; display_name: string; employee_id: string | null } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>`SELECT display_name, employee_id FROM users WHERE id = ${j.updated_by}::uuid`;
      updated_by = { id: j.updated_by, display_name: u[0]?.display_name ?? '', employee_id: u[0]?.employee_id?.trim() ?? null };
    }
    const edit = await this.db.tx.$queryRaw<{ ok: boolean }[]>`
      SELECT app_actor_is_admin('admin.settings', 'edit') AND app_actor_region_filter('admin.settings', 'edit') IS NULL AS ok`;
    return {
      specializations: j.specializations, groups: j.groups, catalogue: j.catalogue, scopes: j.scopes,
      version: j.version, updated_at: j.updated_at, updated_by, can_edit: !!edit[0]?.ok,
    };
  }

  /** GET /settings/team-scope-match */
  async get(auth: AuthContext) {
    await this.access.requireAnyModuleView(auth, MATCH_READERS);
    const r = await this.db.tx.$queryRaw<{ j: MatchJson }[]>`SELECT team_scope_match_json() AS j`;
    return this.dto(r[0]!.j);
  }

  /** PUT /settings/team-scope-match (the database asks for a step-up when eligibility changes) */
  async put(_auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin('admin.settings', 'edit');
    const version = parseIfMatch(ifMatch);
    const b = parse(putSchema, raw);
    const config: Record<string, unknown> = { specializations: b.specializations, scopes: b.scopes };
    if (b.catalogue) config.catalogue = b.catalogue;
    const r = await this.db.tx.$queryRaw<{ j: MatchJson }[]>(Prisma.sql`
      SELECT admin_save_team_scope_match(${JSON.stringify(config)}::jsonb, ${b.reason}::text, ${version}::int) AS j`);
    return this.dto(r[0]!.j);
  }
}
