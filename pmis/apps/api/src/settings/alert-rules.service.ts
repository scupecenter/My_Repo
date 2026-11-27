import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import { MODULES } from '../permissions/catalogue';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

/**
 * Item 13 of the PM-platforms research of 2026-11-27 (migration 0342, contract 0.15.242): the generic if/then alert rules, NOTIFICATIONS ONLY.
 * The database owns the rules (alert_rules_json, admin_alert_rule_save): the closed kinds with their params, the closed audience, the templates,
 * the If-Match version, the reason and the audit row. The daily job (jobs.service) fires them through alert_rules_run; a fire writes one in-app
 * notification per recipient, deduped by (rule, period, target). The screen is a System Admin screen (admin.settings edit for all regions), as
 * the other system settings; the service only shapes the call.
 */

const reason = z.string().trim().min(3).max(1000);

// The shape only; the closed per-kind params, the audience, the templates and the code are checked by the database (admin_alert_rule_save),
// which answers field errors per path.
const ruleSchema = z.object({
  code: z.string().min(2).max(61),
  kind: z.string().max(40),
  params: z.record(z.string(), z.unknown()).default({}),
  audience: z.record(z.string(), z.unknown()),
  title_en: z.string().max(200),
  title_ar: z.string().max(200),
  body_en: z.string().max(2000),
  body_ar: z.string().max(2000),
  link: z.string().max(200).nullish(),
  enabled: z.boolean().optional(),
}).strict();

// Create and update send the whole rule (the database checks every field on both); the code is chosen at create and fixed once the rule exists.
const bodySchema = z.intersection(ruleSchema, z.object({ reason }));

interface RuleRow {
  id: string; code: string; kind: string; params: Record<string, unknown>; audience: Record<string, unknown>;
  title_en: string; title_ar: string; body_en: string; body_ar: string;
  link: string | null; enabled: boolean; version: number; created_at: string; updated_at: string;
}

@Injectable()
export class AlertRulesService {
  constructor(private readonly db: DbService, private readonly access: AccessService) {}

  private async requireAdmin(): Promise<void> {
    if (!(await this.access.isSystemAdmin())) throw new ProblemException(403, 'action_forbidden', { detail: 'Only a System Admin manages the alert rules.' });
  }

  /** GET /settings/alert-rules: the rules plus the closed catalogues the form offers (kinds, audiences, registers, modules). */
  async get() {
    await this.requireAdmin();
    const rules = (await this.db.tx.$queryRaw<{ j: RuleRow[] }[]>(Prisma.sql`SELECT alert_rules_json() AS j`))[0]!.j;
    const registers = await this.db.tx.$queryRaw<{ register_key: string; name_en: string; name_ar: string | null; module_key: string }[]>(Prisma.sql`
      SELECT register_key, name_en, name_ar, module_key FROM register_definitions WHERE is_active ORDER BY sort_order`);
    return {
      rules,
      catalogue: {
        kinds: [
          { kind: 'weekly_status_missing', params: [] },
          { kind: 'record_idle', params: ['register_key', 'state', 'days'] },
        ],
        audiences: ['system_admin', 'module'],
        registers,
        modules: MODULES.map((m) => ({ key: m.key, name_en: m.name_en })),
      },
    };
  }

  /** POST /settings/alert-rules: create a rule. */
  async create(raw: unknown): Promise<{ id: string; version: number }> {
    await this.requireAdmin();
    const b = parse(bodySchema, raw);
    const { reason: r, ...rule } = b;
    const out = await this.db.tx.$queryRaw<{ j: { id: string; version: number } }[]>(Prisma.sql`
      SELECT admin_alert_rule_save(${JSON.stringify(rule)}::jsonb, ${r}::text, NULL::uuid, NULL::int) AS j`);
    return out[0]!.j;
  }

  /** PUT /settings/alert-rules/{id} (If-Match): update a rule. */
  async update(id: string, ifMatch: string | undefined, raw: unknown): Promise<{ id: string; version: number }> {
    await this.requireAdmin();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw problems.validation([{ path: '/id', code: 'invalid', message: 'The rule id.' }]);
    const version = parseIfMatch(ifMatch);
    const b = parse(bodySchema, raw);
    const { reason: r, ...rule } = b;
    const out = await this.db.tx.$queryRaw<{ j: { id: string; version: number } }[]>(Prisma.sql`
      SELECT admin_alert_rule_save(${JSON.stringify(rule)}::jsonb, ${r}::text, ${id}::uuid, ${version}::int) AS j`);
    return out[0]!.j;
  }
}
