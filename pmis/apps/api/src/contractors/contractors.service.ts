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
 *   GET /reports/gecol-hlc-counts         read only counts of the GECOL, HLC and Procurement records (0.15.84); admin.settings view for all regions.
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

  /** 0.15.84: read-only counts, a step before any move of GECOL / HLC data. The latest version of every logical record; no write, no setting read. */
  async gecolHlcCounts() {
    await this.access.requireAdmin('admin.settings', 'view');
    const latest = Prisma.sql`SELECT DISTINCT ON (entity_id) entity_id, register_key, state, data FROM register_records
                              WHERE register_key IN ('gecol', 'hlc', 'procurement') ORDER BY entity_id, version_no DESC`;
    // one statement per register, so the numbers of that register come from one snapshot (the totals are the sums of the states)
    const reg = async (key: string) => {
      const rows = await this.db.tx.$queryRaw<{ state: string; n: number; pr: number; rd: number; linked: number }[]>(Prisma.sql`
        WITH l AS (${latest}) SELECT state, count(*)::int AS n,
          (count(*) FILTER (WHERE btrim(coalesce(data ->> 'pr_no', '')) <> ''))::int AS pr,
          (count(*) FILTER (WHERE btrim(coalesce(data ->> 'request_date', '')) <> ''))::int AS rd,
          (count(*) FILTER (WHERE btrim(coalesce(data ->> 'procurement_record_id', '')) <> ''))::int AS linked
        FROM l WHERE register_key = ${key} GROUP BY state ORDER BY state`);
      const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
      return { by_state: rows.map((r) => ({ state: r.state, count: r.n })), total: sum((r) => r.n), pr: sum((r) => r.pr), rd: sum((r) => r.rd), linked: sum((r) => r.linked) };
    };
    const g = await reg('gecol');
    const h = await reg('hlc');
    const p = await this.db.tx.$queryRaw<{ scope: string | null; state: string; n: number }[]>(Prisma.sql`
      WITH l AS (${latest}) SELECT data ->> 'scope' AS scope, state, count(*)::int AS n FROM l WHERE register_key = 'procurement'
      GROUP BY 1, 2 ORDER BY 1 NULLS LAST, 2`);
    const s = await this.db.tx.$queryRaw<{ g: number; h: number }[]>`
      SELECT (count(*) FILTER (WHERE scope_gecol_power = 'yes'))::int AS g, (count(*) FILTER (WHERE scope_hlc_fiber = 'yes'))::int AS h FROM sites`;
    return {
      as_of: new Date().toISOString(),
      gecol: { total: g.total, with_pr_no: g.pr, with_request_date: g.rd, by_state: g.by_state },
      hlc: { total: h.total, linked_to_procurement: h.linked, not_linked: h.total - h.linked, by_state: h.by_state },
      procurement: { total: p.reduce((a, r) => a + r.n, 0), by_scope_state: p.map((r) => ({ scope: r.scope, state: r.state, count: r.n })) },
      sites: { with_gecol_scope: s[0]!.g, with_hlc_scope: s[0]!.h },
    };
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
