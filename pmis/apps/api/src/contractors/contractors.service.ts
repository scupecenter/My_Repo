import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { parseIfMatch } from '../common/etag';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

const texts = z.array(z.string().trim().min(1).max(60)).max(30);
const rulesSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
  safety_cert_lead_days: z.number().int().min(0).max(365),
  recipient_roles: texts,
  cw_delivery_scopes: texts,
  internal_team_types: texts,
  closed_order_statuses: texts,
}).strict();

interface RulesJson {
  safety_cert_lead_days: number; recipient_roles: string[]; cw_delivery_scopes: string[]; internal_team_types: string[]; closed_order_statuses: string[];
  version: number; updated_at: string; updated_by: string | null;
}

/**
 * P4b (migration 0061): the reports of the Contractors and Procurement data (Q142, Q145) and the contractor rules (Q147, D145b).
 *   GET /reports/team-scope-mismatch      running orders that no longer match; Procurement view, rows of the caller's Procurement regions (B3).
 *   GET /reports/contractors-completeness teams, parties and contracts that need data; Contractors view (the register is global, Q69).
 *   GET/PUT /settings/contractor-rules    the certificate lead days, the alert roles, the CW Delivery Model scopes, the internal team types and the
 *                                         order statuses that close an order; saving needs admin.settings edit for all regions, a reason, If-Match,
 *                                         and a step-up when a rule that decides eligibility changes (checked in the database).
 */
@Injectable()
export class ContractorsService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  async mismatch(auth: AuthContext) {
    await this.access.requireRegions('procurement', 'view');
    void auth;
    const r = await this.db.tx.$queryRaw<{ j: unknown }[]>`SELECT team_scope_mismatch_report() AS j`;
    return r[0]!.j;
  }

  async completeness(auth: AuthContext) {
    await this.access.requireModuleView(auth, 'contractors');
    const r = await this.db.tx.$queryRaw<{ j: unknown }[]>`SELECT contractors_completeness_report() AS j`;
    return r[0]!.j;
  }

  private async rulesDto(j: RulesJson) {
    let updated_by: { id: string; display_name: string; employee_id: string | null } | null = null;
    if (j.updated_by) {
      const u = await this.db.tx.$queryRaw<{ display_name: string; employee_id: string | null }[]>`SELECT display_name, employee_id FROM users WHERE id = ${j.updated_by}::uuid`;
      updated_by = { id: j.updated_by, display_name: u[0]?.display_name ?? '', employee_id: u[0]?.employee_id?.trim() ?? null };
    }
    return { ...j, updated_by };
  }

  async rules(auth: AuthContext) {
    await this.access.requireModuleView(auth, 'admin.settings');
    const r = await this.db.tx.$queryRaw<{ j: RulesJson }[]>`SELECT contractor_rules_json() AS j`;
    return this.rulesDto(r[0]!.j);
  }

  async setRules(ifMatch: string | undefined, raw: unknown) {
    await this.access.requireAdmin('admin.settings', 'edit');
    const version = parseIfMatch(ifMatch);
    const { reason, ...rest } = parse(rulesSchema, raw);
    const r = await this.db.tx.$queryRaw<{ j: RulesJson }[]>(Prisma.sql`
      SELECT admin_save_contractor_rules(${JSON.stringify(rest)}::jsonb, ${reason}::text, ${version}::int) AS j`);
    return this.rulesDto(r[0]!.j);
  }
}
