import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import { MODULES } from '../permissions/catalogue';
import { customModuleDefs } from '../permissions/custom-modules';
import { parseIfMatch } from '../common/etag';
import { ProblemException, problems } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';

/**
 * Item 13 of the improvement research of 2026-11-27 (migration 0342, contract 0.15.242): the generic if/then alert rules, NOTIFICATIONS ONLY.
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
  locked: z.boolean().optional(),
}).strict();

// Create and update send the whole rule (the database checks every field on both); the code is chosen at create and fixed once the rule exists.
const bodySchema = z.intersection(ruleSchema, z.object({ reason }));

interface RuleRow {
  id: string; code: string; kind: string; params: Record<string, unknown>; audience: Record<string, unknown>;
  title_en: string; title_ar: string; body_en: string; body_ar: string;
  link: string | null; enabled: boolean; locked: boolean; version: number; created_at: string; updated_at: string;
}

/**
 * 0.15.473 (migration 0612): the ready-made rules of the Automation centre. A template only fills the existing alert rule form: the admin reviews it,
 * gives a code and a reason and saves it through the same create call, so every check, the audit row and the notifications-only limit are those of the rules.
 * The closed list lives here (no table); `params` and `audience` are exactly what admin_alert_rule_save accepts.
 */
const TEMPLATES = [
  { id: 'links-conflict', kind: 'link_conflict', params: { min_rows: 1 }, audience: { type: 'system_admin' }, link: '/admin/settings/alerts/rules',
    title_en: 'Closed records with open links: {{register}}', title_ar: 'سجلات مغلقة مرتبطة بسجلات مفتوحة: {{register}}',
    body_en: '{{count}} approved row(s) of {{register}} point to a record that is still open ({{field}}).', body_ar: '{{count}} صف معتمد في {{register}} يشير إلى سجل لا يزال مفتوحاً ({{field}}).' },
  { id: 'data-completeness', kind: 'data_gaps', params: { min_sites: 1 }, audience: { type: 'module', module: 'sites' }, link: '/sites?data_gaps=with',
    title_en: 'Data to complete: {{region}}', title_ar: 'بيانات تحتاج استكمالاً: {{region}}',
    body_en: '{{count}} site(s) in {{region}} have missing data for the week of {{week}}. Open the sites with data gaps and complete them.', body_ar: '{{count}} موقعاً في {{region}} ينقصها بيانات لأسبوع {{week}}. افتح المواقع ذات النواقص واستكملها.' },
  { id: 'weekly-status', kind: 'weekly_status_missing', params: {}, audience: { type: 'system_admin' }, link: '/status-updates',
    title_en: 'Weekly status missing: {{region}}', title_ar: 'التحديث الأسبوعي غير مسلّم: {{region}}',
    body_en: 'No weekly status update for {{region}} for the week of {{week}}.', body_ar: 'لا يوجد تحديث أسبوعي للمنطقة {{region}} لأسبوع {{week}}.' },
  { id: 'issue-stuck', kind: 'record_idle', params: { register_key: 'issues', state: 'entry', days: 7 }, audience: { type: 'system_admin' }, link: null,
    title_en: 'Issue idle for {{days}} days: {{record}}', title_ar: 'مشكلة بلا حركة منذ {{days}} أيام: {{record}}',
    body_en: '{{record}} has been {{state}} for at least {{days}} days.', body_ar: '{{record}} في حالة {{state}} منذ {{days}} أيام على الأقل.' },
  { id: 'advance-unsettled', kind: 'advance_unsettled', params: {}, audience: { type: 'system_admin' }, link: null,
    title_en: 'Advance not settled: {{record}}', title_ar: 'سلفة غير مسوّاة: {{record}}',
    body_en: '{{record}} is {{state}} and has been open for {{days}} days.', body_ar: '{{record}} في حالة {{state}} ومفتوحة منذ {{days}} أيام.' },
  { id: 'invoice-due', kind: 'invoice_due_soon', params: { days: 7 }, audience: { type: 'system_admin' }, link: null,
    title_en: 'Invoice due soon: {{record}}', title_ar: 'فاتورة تستحق قريباً: {{record}}',
    body_en: 'Invoice {{record}} is due on {{due}} ({{days}} days left).', body_ar: 'الفاتورة {{record}} تستحق في {{due}} (متبقي {{days}} أيام).' },
  { id: 'links-orphans', kind: 'link_orphans', params: { min_rows: 1 }, audience: { type: 'system_admin' }, link: '/admin/settings/alerts/rules',
    title_en: 'Broken register links: {{register}}', title_ar: 'روابط سجلات مكسورة: {{register}}',
    body_en: '{{count}} row(s) of {{register}} point to a record that no longer exists ({{field}}).', body_ar: '{{count}} صف في {{register}} يشير إلى سجل غير موجود ({{field}}).' },
] as const;

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
    const kpis = (await this.db.tx.$queryRaw<{ k: { code: string; label_en: string; label_ar: string; unit: string; direction: string }[] }[]>(Prisma.sql`
      SELECT dashboard_settings_catalogue() -> 'kpis' AS k`))[0]!.k;
    return {
      rules,
      catalogue: {
        kinds: [
          { kind: 'weekly_status_missing', params: [] },
          { kind: 'record_idle', params: ['register_key', 'state', 'days'] },
          { kind: 'kpi_threshold', params: ['kpi', 'op', 'value'] },
          { kind: 'advance_unsettled', params: ['days'] },
          { kind: 'invoice_due_soon', params: ['days'] },
          { kind: 'link_orphans', params: ['register_key', 'field_code', 'min_rows'] },
          { kind: 'data_gaps', params: ['min_sites'] },
          { kind: 'link_conflict', params: ['register_key', 'field_code', 'min_rows'] },
        ],
        kpis,
        audiences: ['system_admin', 'module'],
        templates: TEMPLATES,
        registers,
        modules: [...MODULES, ...(await customModuleDefs(this.db, true))].map((m) => ({ key: m.key, name_en: m.name_en })),
      },
    };
  }

  /** GET /settings/alert-rules/runs (0.15.473, migration 0612): the last runs of the rules, written by the system (audit action alert_rule_run, no actor). System Admin. */
  async runs() {
    await this.requireAdmin();
    return { runs: (await this.db.tx.$queryRaw<{ j: unknown[] }[]>(Prisma.sql`SELECT alert_rule_runs_json(50) AS j`))[0]!.j };
  }

  /** GET /settings/alert-rules/link-orphans (0.15.510, migration 0650): the dangling-link report with example ids, System Admin. */
  async linkOrphans() {
    await this.requireAdmin();
    return { links: (await this.db.tx.$queryRaw<{ j: unknown[] }[]>(Prisma.sql`SELECT register_link_orphans_json(20) AS j`))[0]!.j };
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
