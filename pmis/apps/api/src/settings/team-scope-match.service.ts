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
const putSchema = z.object({
  reason,
  specializations: z.array(label).max(30),
  scopes: z.array(z.object({ scope: label, exempt: z.boolean().default(false), allowed: z.array(label).max(30) }).strict()).max(60),
}).strict();

interface MatchJson {
  specializations: string[];
  scopes: { scope: string; exempt: boolean; allowed: string[] }[];
  version: number;
  updated_at: string;
  updated_by: string | null;
}

/**
 * Q97 (migration 0043): the team specialization / scope match of Procurement. Reads need the Settings screen (admin.settings view); the write goes
 * through admin_save_team_scope_match (System Admin or a delegation of admin.settings edit for all regions, reason, If-Match, audit).
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
    return { specializations: j.specializations, scopes: j.scopes, version: j.version, updated_at: j.updated_at, updated_by };
  }

  /** GET /settings/team-scope-match */
  async get(auth: AuthContext) {
    await this.access.requireModuleView(auth, 'admin.settings');
    const r = await this.db.tx.$queryRaw<{ j: MatchJson }[]>`SELECT team_scope_match_json() AS j`;
    return this.dto(r[0]!.j);
  }

  /** PUT /settings/team-scope-match */
  async put(_auth: AuthContext, ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin('admin.settings', 'edit');
    const version = parseIfMatch(ifMatch);
    const b = parse(putSchema, raw);
    const config = { specializations: b.specializations, scopes: b.scopes };
    const r = await this.db.tx.$queryRaw<{ j: MatchJson }[]>(Prisma.sql`
      SELECT admin_save_team_scope_match(${JSON.stringify(config)}::jsonb, ${b.reason}::text, ${version}::int) AS j`);
    return this.dto(r[0]!.j);
  }
}
