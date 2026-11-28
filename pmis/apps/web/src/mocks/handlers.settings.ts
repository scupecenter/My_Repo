// MSW handlers for phase 3b: work calendar, rules, freeze, DLP, idle days, notification policy, log retention,
// staff visibility, security log, integrity, online now. Synthetic data; validation mirrors the contract.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { ContractorRulesInput, Holiday, NotificationPolicyInput, SecurityLogEntry, SlaPublishPreview, SlaRuleSet, SlaTaskRule, TeamScopeMatch, TeamScopeMatchInput, TeamSpecialization, WeightSet } from '@/api/types';
import { tripoliToday } from '@/lib/today';
import { weightIssues } from '@/lib/weights';
import { NAV_SIDE } from '@/lib/navLayout';
import { accountKeyOf, cred, db, identity, loginPage, loginPagePublic, putUiAssetBytes, save, stepUpValid, uiAssetBytesOf, viewer } from './db';
import { BRANDS, isBrand } from '@/lib/brands';
import { APPEARANCE_OPTIONS } from '../lib/appearance';
import { guard, page, problem, stepUp } from './handlers';
import { byId, uid } from './ids';
import type { TableDisplaySetting } from '@/api/display';
import { UI_FEATURES_SEED, type UiFeaturesSetting } from '@/api/uiFeatures';
import { CALENDAR_CODES, CATALOGUE, COMPLETENESS, MAIL_KIND_CATALOGUE, MISMATCH, initCfg, GATES, MILESTONES, OPEN_TASKS, SCENARIOS, START_EVENT_CODES, TASK_DEFS, type SlaSetRec, type WeightRec } from './settingsData';
import { newDeviceState } from './newDevice';
import { passkeyDto, passkeyState, type MockPasskey } from './passkeys';

const B = API_BASE;
const TODAY = '2026-10-25';
const C = () => db().cfg;
/** W8 (0.15.64): the defaults of the Display menu, the seed look until an admin saves them. */
const TD = () => (C().tableDisplay ??= { defaults: { size: 'md', align: 'start', density: 'comfortable', wrap: false, zebra: true }, version: 0 } as TableDisplaySetting);
/** 0.15.102: the interface features, the seed until an admin saves them. */
const UF = () => (C().uiFeatures ??= { sections: structuredClone(UI_FEATURES_SEED), version: 0 } as UiFeaturesSetting);
/** A mock store saved before 0.9.1 has no match table, one saved before 0.12.9 no catalogue: start it from the seed. */
const SM = () => (C().scopeMatch?.catalogue ? C().scopeMatch : (C().scopeMatch = initCfg().scopeMatch));
const CR = () => (C().contractorRules ??= initCfg().contractorRules);
/** Contractor performance (contract 0.15.89): demo thresholds, kept in memory; the report is computed from them in the mock like the API does. */
const PERF_DEFAULT = { min_sample: 3, snag_overdue_pct: { amber: 10, red: 25 }, snag_return_pct: { amber: 20, red: 40 }, quality_fail_pct: { amber: 10, red: 20 }, contract_expiry_days: { amber: 60, red: 15 } };
interface AlertRuleRow {
  id: string; code: string; kind: 'weekly_status_missing' | 'record_idle' | 'kpi_threshold' | 'advance_unsettled' | 'invoice_due_soon'; params: Record<string, unknown>; audience: Record<string, unknown>;
  title_en: string; title_ar: string; body_en: string; body_ar: string; link: string | null; enabled: boolean; locked: boolean; version: number;
  created_at: string; updated_at: string;
}
const ALERT_RULES: AlertRuleRow[] = [
  {
    id: '00000000-0000-4000-8000-000000000001', code: 'weekly-status-missing', kind: 'weekly_status_missing', params: {}, audience: { type: 'system_admin' },
    title_en: 'Weekly status missing: {{region}}', title_ar: 'تحديث أسبوعي مفقود: {{region}}',
    body_en: 'No Weekly status update was filed for {{region}} this working week.', body_ar: 'لم يُقدَّم تحديث الحالة الأسبوعي لمنطقة {{region}} هذا الأسبوع.',
    link: '/project-status', enabled: true, locked: false, version: 1, created_at: '2026-11-27T00:00:00.000Z', updated_at: '2026-11-27T00:00:00.000Z',
  },
];
let perf = { thresholds: structuredClone(PERF_DEFAULT), version: 1 };
const PERF_ROWS = [
  { party_id: '11111111-1111-4111-8111-111111111101', name: 'Delta Build', type: 'cw_contractor', delay_days: 42, issues_total: 5, issues_open: 2,
    snags: { total: 10, open: 4, overdue: 3, overdue_pct: 30, overdue_level: 'red' as const, returned: 2, returned_pct: 20, returned_level: 'amber' as const },
    quality: { total: 8, failed: 1, fail_pct: 12.5, fail_level: 'amber' as const }, orders: { total: 6, open: 3 },
    contract: { active: 1, end_date: '2027-01-10', days_left: 45, level: 'amber' as const }, level: 'red' as const },
  { party_id: '11111111-1111-4111-8111-111111111102', name: 'Omega Works', type: 'cw_contractor', delay_days: 0, issues_total: 1, issues_open: 0,
    snags: { total: 2, open: 0, overdue: 0, overdue_pct: 0, overdue_level: 'insufficient' as const, returned: 0, returned_pct: 0, returned_level: 'insufficient' as const },
    quality: { total: 0, failed: 0, fail_pct: null, fail_level: 'insufficient' as const }, orders: { total: 1, open: 0 },
    contract: { active: 1, end_date: '2027-09-01', days_left: 279, level: 'ok' as const }, level: 'ok' as const },
];

/** GET /reports/gecol-hlc-counts (contract 0.15.84): demo numbers only. */
const GECOL_HLC_COUNTS = {
  as_of: '2026-11-26T12:00:00.000Z',
  gecol: { total: 5, with_pr_no: 3, with_request_date: 4, by_state: [{ state: 'approved', count: 3 }, { state: 'entry', count: 2 }] },
  hlc: { total: 4, linked_to_procurement: 2, not_linked: 2, by_state: [{ state: 'approved', count: 2 }, { state: 'entry', count: 2 }] },
  procurement: { total: 6, by_scope_state: [{ scope: 'CW', state: 'approved', count: 3 }, { scope: 'HLC', state: 'approved', count: 2 }, { scope: null, state: 'entry', count: 1 }] },
  sites: { with_gecol_scope: 5, with_hlc_scope: 4 },
};

/** The field rules of PUT /settings/contractor-rules (admin_save_contractor_rules of migration 0061). Exported for unit tests. */
export function validateContractorRules(b: Record<string, unknown>) {
  const errs: { path: string; code: string }[] = [];
  const LISTS = ['recipient_roles', 'cw_delivery_scopes', 'internal_team_types', 'closed_order_statuses'];
  for (const k of Object.keys(b)) if (![...LISTS, 'safety_cert_lead_days', 'reason'].includes(k)) errs.push({ path: `/${k}`, code: 'unknown_key' });
  if (!int(b.safety_cert_lead_days, 0, 365)) errs.push({ path: '/safety_cert_lead_days', code: 'out_of_range' });
  for (const k of LISTS) {
    const v = b[k];
    if (!Array.isArray(v) || v.length > 30 || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > 60)) errs.push({ path: `/${k}`, code: 'invalid' });
  }
  const scopes = new Set(SM().scopes.map((s) => s.scope));
  if (Array.isArray(b.cw_delivery_scopes) && (b.cw_delivery_scopes as string[]).some((s) => !scopes.has(String(s).trim()))) errs.push({ path: '/cw_delivery_scopes', code: 'unknown_scope' });
  return errs;
}
const isAdmin = () => viewer()?.key === 'pm';
const targetPolicy: { manual_override: boolean; version: number; updated_at: string | null; updated_by: { id: string; display_name: string; employee_id: string | null } | null } =
  { manual_override: false, version: 1, updated_at: null, updated_by: null };
const targetPolicyView = () => ({ ...targetPolicy, can_edit: isAdmin() });
const needAdmin = () => guard() ?? (isAdmin() ? null : problem(403, 'action_forbidden', 'Administrators only'));
const fields = (...errors: { path: string; code: string }[]) => problem(422, 'validation_failed', 'Validation failed', { errors });
const reasonErr = (r?: string) => ((r ?? '').trim().length < 3 || (r ?? '').length > 1000 ? fields({ path: '/reason', code: 'required' }) : null);
const tag = (n: number) => ({ headers: { ETag: `"${n}"` } });
const ver = (req: Request, v: number) => { const h = req.headers.get('If-Match'); return h && Number(h.replace(/"/g, '')) !== v ? problem(412, 'precondition_failed', 'Changed by someone else; reload') : null; };
const ref = (e: string) => ({ id: uid(e), display_name: byId(e).name_en, employee_id: e });
const me = () => ref(viewer()!.employee_id!);
const day = (d: string) => Date.parse(`${d}T00:00:00Z`);
const int = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const body = async <T,>(r: Request) => ((await r.json().catch(() => ({}))) ?? {}) as T;

// ---- 0.2.6 helpers: rule sets and weight sets
const slaOut = ({ _rev, ...x }: SlaSetRec): SlaRuleSet => (void _rev, x);
const slaSummary = ({ rules, ...x }: SlaRuleSet) => (void rules, ((s) => { delete (s as { _rev?: number })._rev; return s; })({ ...x }));
const wOut = ({ _rev, ...x }: WeightRec): WeightSet => (void _rev, x);
const canon = (rules: SlaTaskRule[]) => [...rules].sort((a, b) => a.task_code.localeCompare(b.task_code)).map((r) => ({ ...r, overrides: r.overrides ?? [] }));
const wCanon = (w: WeightSet) => w.activities.map((a) => ({ c: a.code, w: a.weight, n: a.name_en, na: a.name_ar ?? null, i: a.items.map((i) => [i.code, i.weight, i.name_en, i.name_ar ?? null, i.unit ?? null, i.measure_rule ?? null]) }));

/** Effective date rules shared by the previews and the publishes: required, not in the past (Africa/Tripoli), after the latest published version. */
function dateErrs(d: string | undefined, kind: 'sla' | 'weights', code?: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d ?? '')) return [{ path: '/effective_date', code: 'required' }];
  if (d! < tripoliToday()) return [{ path: '/effective_date', code: 'effective_date_in_past' }];
  const last = (kind === 'sla' ? C().slaSets : C().weightSets.filter((w) => w.code === code)).filter((s) => s.status === 'published').map((s) => s.effective_from!).sort().pop();
  return last && d! <= last ? [{ path: '/effective_date', code: 'effective_date_not_after_current' }] : [];
}

/** The comparison form of a name (p4b_norm of migration 0061): lower case, spaces and punctuation removed. */
export const specNorm = (s: string) => s.trim().toLowerCase().replace(/[\s\p{P}]+/gu, '');
type Cat = TeamSpecialization & { is_active?: boolean };
/** A name (code, label or alias) as its catalogue code. */
export function resolveSpec(catalogue: Cat[], name: string): string | null {
  const n = specNorm(name);
  if (!n) return null;
  return catalogue.find((c) => [c.code, c.label_en, c.label_ar ?? '', ...(c.aliases ?? [])].some((x) => x && specNorm(x) === n))?.code ?? null;
}
/** A new code from a new name (as admin_save_team_scope_match). */
export const newSpecCode = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);

/**
 * The field rules of PUT /settings/team-scope-match (admin_save_team_scope_match of migrations 0043 and 0061). Exported for unit tests.
 * Returns the errors and, when there are none, the resulting catalogue and rows.
 */
export function validateScopeMatch(b: Partial<TeamScopeMatchInput> & Record<string, unknown>, current: Cat[] = SM().catalogue as Cat[]) {
  const errs: { path: string; code: string }[] = [];
  for (const k of Object.keys(b)) if (!['reason', 'specializations', 'scopes', 'catalogue'].includes(k)) errs.push({ path: `/${k}`, code: 'unknown_key' });
  const cat: Cat[] = current.map((c) => ({ ...c, aliases: [...(c.aliases ?? [])] }));
  const codes: string[] = [];
  if (!Array.isArray(b.specializations)) errs.push({ path: '/specializations', code: 'required' });
  else b.specializations.forEach((x, i) => {
    const v = typeof x === 'string' ? x.trim() : '';
    if (!v || v.length > 60) { errs.push({ path: `/specializations/${i}`, code: 'invalid' }); return; }
    let code = resolveSpec(cat, v);
    if (!code && ['CW', 'TE'].includes(v.toUpperCase())) { errs.push({ path: `/specializations/${i}`, code: 'is_a_group' }); return; }
    if (!code) { code = newSpecCode(v) || `SPEC_${cat.length + 1}`; cat.push({ code, label_en: v, label_ar: null, group: null, groups: [], aliases: [], is_active: true }); }
    if (codes.includes(code)) errs.push({ path: `/specializations/${i}`, code: 'duplicate' });
    else codes.push(code);
  });
  (Array.isArray(b.catalogue) ? b.catalogue : []).forEach((e, i) => {
    const c = cat.find((x) => x.code === e.code);
    if (!c) { errs.push({ path: `/catalogue/${i}/code`, code: 'not_a_column' }); return; }
    c.label_en = e.label_en; if (e.label_ar !== undefined) c.label_ar = e.label_ar; if (e.groups !== undefined) { c.groups = [...new Set(e.groups)]; c.group = c.groups[0] ?? null; } else if (e.group !== undefined) { c.group = e.group; c.groups = e.group ? [e.group] : []; } if (e.aliases) c.aliases = e.aliases;
  });
  const owner = new Map<string, string>();
  for (const c of cat) for (const n of [c.code, c.label_en, c.label_ar ?? '', ...(c.aliases ?? [])].map(specNorm).filter(Boolean)) {
    if (owner.has(n) && owner.get(n) !== c.code) { errs.push({ path: '/catalogue', code: 'name_clash' }); break; }
    owner.set(n, c.code);
  }
  const seen = new Set<string>();
  const scopes: { scope: string; exempt: boolean; allowed: string[]; allowed_groups: ('CW' | 'TE')[] }[] = [];
  if (!Array.isArray(b.scopes)) errs.push({ path: '/scopes', code: 'required' });
  else b.scopes.forEach((row, i) => {
    const v = typeof row?.scope === 'string' ? row.scope.trim() : '';
    if (!v || v.length > 60) errs.push({ path: `/scopes/${i}/scope`, code: 'invalid' });
    else if (seen.has(v)) errs.push({ path: `/scopes/${i}/scope`, code: 'duplicate' });
    seen.add(v);
    const allowed: string[] = [];
    if (!Array.isArray(row?.allowed)) errs.push({ path: `/scopes/${i}/allowed`, code: 'required' });
    else row.allowed.forEach((a, j) => {
      const c = typeof a === 'string' ? resolveSpec(cat, a) : null;
      if (!c || !codes.includes(c)) errs.push({ path: `/scopes/${i}/allowed/${j}`, code: 'unknown_specialization' });
      else allowed.push(c);
    });
    const groups = row?.allowed_groups ?? [];
    if (!Array.isArray(groups) || groups.some((g) => g !== 'CW' && g !== 'TE')) errs.push({ path: `/scopes/${i}/allowed_groups`, code: 'invalid' });
    scopes.push({ scope: v, exempt: row?.exempt ?? false, allowed: codes.filter((c) => allowed.includes(c)), allowed_groups: [...new Set(groups)].sort() as ('CW' | 'TE')[] });
  });
  cat.forEach((c) => { c.is_active = codes.includes(c.code); });
  const ordered = [...codes.map((c) => cat.find((x) => x.code === c)!), ...cat.filter((c) => !codes.includes(c.code))];
  return Object.assign(errs, { result: { codes, catalogue: ordered, scopes } });
}
/** What decides eligibility (Q147): a change of it needs a step-up; labels do not. */
const matchRules = (m: { catalogue: Cat[]; scopes: unknown[] }) => JSON.stringify({ s: m.scopes, c: m.catalogue.filter((c) => c.is_active).map((c) => [c.code, c.group, c.aliases]).sort() });

/** Closed-schema validation of SLA rule items; `min_exceeds_max` sits on the max_working_days path. Exported for unit tests. */
export function validateSlaRules(rules: (SlaTaskRule & { __i?: number })[]) {
  const errs: { path: string; code: string }[] = [], seen = new Set<string>();
  const KEYS = ['task_code', 'min_working_days', 'max_working_days', 'start_event', 'calendar_code', 'overrides'], OKEYS = ['scenario', 'region_id', 'min_working_days', 'max_working_days'];
  rules.forEach((r, n) => {
    const i = r.__i ?? n, P = `/rules/${i}`;
    for (const k of Object.keys(r)) if (k !== '__i' && !KEYS.includes(k)) errs.push({ path: `${P}/${k}`, code: 'unknown_key' });
    if (!TASK_DEFS.some((t) => t.code === r.task_code)) errs.push({ path: `${P}/task_code`, code: 'unknown_task_code' });
    else if (seen.has(r.task_code)) errs.push({ path: `${P}/task_code`, code: 'duplicate_task_code' });
    seen.add(r.task_code);
    for (const k of ['min_working_days', 'max_working_days'] as const) if (!int(r[k], 0, 365)) errs.push({ path: `${P}/${k}`, code: 'out_of_range' });
    if (int(r.min_working_days, 0, 365) && int(r.max_working_days, 0, 365) && r.min_working_days > r.max_working_days) errs.push({ path: `${P}/max_working_days`, code: 'min_exceeds_max' });
    if (!START_EVENT_CODES.has(r.start_event)) errs.push({ path: `${P}/start_event`, code: 'unknown_start_event' });
    if (!CALENDAR_CODES.includes(r.calendar_code)) errs.push({ path: `${P}/calendar_code`, code: 'unknown_calendar' });
    const keys = new Set<string>();
    (r.overrides ?? []).forEach((o, j) => {
      const O = `${P}/overrides/${j}`;
      for (const k of Object.keys(o)) if (!OKEYS.includes(k)) errs.push({ path: `${O}/${k}`, code: 'unknown_key' });
      if (o.scenario === undefined && o.region_id === undefined) errs.push({ path: `${O}/scenario`, code: 'required' });
      if (o.scenario !== undefined && !SCENARIOS.includes(o.scenario)) errs.push({ path: `${O}/scenario`, code: 'invalid' });
      if (o.region_id !== undefined && !int(o.region_id, 1, 7)) errs.push({ path: `${O}/region_id`, code: 'invalid' });
      for (const k of ['min_working_days', 'max_working_days'] as const) if (!int(o[k], 0, 365)) errs.push({ path: `${O}/${k}`, code: 'out_of_range' });
      if (int(o.min_working_days, 0, 365) && int(o.max_working_days, 0, 365) && o.min_working_days > o.max_working_days) errs.push({ path: `${O}/max_working_days`, code: 'min_exceeds_max' });
      const key = `${o.scenario ?? ''}|${o.region_id ?? ''}`;
      if (keys.has(key)) errs.push({ path: `${O}/scenario`, code: 'duplicate_override' });
      keys.add(key);
    });
  });
  return errs;
}

/** Counts how many open tasks change when the draft is applied to them (rules that differ from the version in force). */
function slaPreview(x: SlaRuleSet, effective_date: string): SlaPublishPreview {
  const cur = C().slaSets.find((s) => s.is_active)!, SITES = ['TR204', 'MI129', 'WM105', 'ZW310', 'BG220', 'SB121'];
  const by = x.rules.map((r) => {
    const o = cur.rules.find((c) => c.task_code === r.task_code), open = OPEN_TASKS[r.task_code] ?? 0;
    const diff = JSON.stringify(canon(o ? [o] : [])) !== JSON.stringify(canon([r]));
    return { r, o, open, changed: diff ? open : 0 };
  });
  const samples: SlaPublishPreview['samples'] = [];
  by.forEach(({ r, o, changed }) => { for (let k = 0; k < changed && samples.length < 20; k++) { const delta = r.max_working_days - (o?.max_working_days ?? r.max_working_days); samples.push({ task_id: crypto.randomUUID(), site_code: SITES[(samples.length) % SITES.length], task_code: r.task_code, due_date_before: `2026-11-${String(2 + k).padStart(2, '0')}`, due_date_after: `2026-11-${String(Math.max(1, 2 + k + delta)).padStart(2, '0')}` }); } });
  const late = (f: (d: number) => boolean) => by.reduce((n, { r, o, changed }) => n + (o && f(r.max_working_days - o.max_working_days) ? Math.ceil(changed * 0.3) : 0), 0);
  return {
    set_id: x.id, effective_date, open_tasks_total: Object.values(OPEN_TASKS).reduce((a, b) => a + b, 0), changed_due_date_count: by.reduce((n, b) => n + b.changed, 0),
    became_late_count: late((d) => d < 0), no_longer_late_count: late((d) => d > 0), by_task: by.map(({ r, open, changed }) => ({ task_code: r.task_code, open_tasks: open, changed })), samples,
  };
}

type WeightInput = { reason: string; activities: { code: string; name_en: string; name_ar?: string | null; weight: number; items?: { code: string; name_en: string; name_ar?: string | null; weight: number; unit?: string | null; measure_rule?: string | null; source?: string | null }[] }[] } & Record<string, unknown>;
const w3 = (n: unknown) => typeof n === 'number' && n >= 0 && n <= 100 && Math.abs(Math.round(n * 1000) - n * 1000) < 1e-6;
const CODE = /^[A-Za-z0-9._-]{1,20}$/;
/** Closed-schema checks of a weight set body (not the 100% rule, which the preview and publish apply). */
export function validateWeightInput(b: WeightInput) {
  const errs: { path: string; code: string }[] = [];
  for (const k of Object.keys(b)) if (!['reason', 'activities'].includes(k)) errs.push({ path: `/${k}`, code: 'unknown_key' });
  if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
  if (!Array.isArray(b.activities) || !b.activities.length || b.activities.length > 50) return [...errs, { path: '/activities', code: 'required' }];
  const AK = ['code', 'name_en', 'name_ar', 'weight', 'items'], IK = ['code', 'name_en', 'name_ar', 'weight', 'unit', 'measure_rule', 'source'], codes = new Set<string>();
  b.activities.forEach((a, i) => {
    const P = `/activities/${i}`;
    for (const k of Object.keys(a)) if (!AK.includes(k)) errs.push({ path: `${P}/${k}`, code: 'unknown_key' });
    if (!CODE.test(a.code ?? '')) errs.push({ path: `${P}/code`, code: 'invalid' }); else if (codes.has(a.code)) errs.push({ path: `${P}/code`, code: 'duplicate' });
    codes.add(a.code);
    if (!(a.name_en ?? '').trim()) errs.push({ path: `${P}/name_en`, code: 'required' });
    if (!w3(a.weight)) errs.push({ path: `${P}/weight`, code: 'out_of_range' });
    const ic = new Set<string>();
    (a.items ?? []).forEach((it, j) => {
      const Q = `${P}/items/${j}`;
      for (const k of Object.keys(it)) if (!IK.includes(k)) errs.push({ path: `${Q}/${k}`, code: 'unknown_key' });
      if (!CODE.test(it.code ?? '')) errs.push({ path: `${Q}/code`, code: 'invalid' }); else if (ic.has(it.code)) errs.push({ path: `${Q}/code`, code: 'duplicate' });
      ic.add(it.code);
      if (!(it.name_en ?? '').trim()) errs.push({ path: `${Q}/name_en`, code: 'required' });
      if (!w3(it.weight)) errs.push({ path: `${Q}/weight`, code: 'out_of_range' });
    });
  });
  return errs;
}
/** The 100% rule per level, with the paths of the contract. Reuses the screen's weightIssues. */
export function weightErrors(set: Pick<WeightSet, 'activities'>) {
  return weightIssues(set).map((i) => ({ path: i.level === 'activities' ? '/activities' : `/activities/${set.activities.findIndex((a) => a.code === i.activity)}/items`, code: 'weights_must_total_100', message: `Total is ${i.sum}, not 100` }));
}
const DONE: Record<string, number> = { a1: 100, a2: 90, a3: 70, a4: 55, a5: 40, a6: 20, a7: 10, a8: 0 };
const contrib = (a?: { code: string; weight: number }) => (a ? Math.round(a.weight * (DONE[a.code] ?? 50)) / 100 : 0);
const progress = (s: Pick<WeightSet, 'activities'>) => Math.round(s.activities.reduce((n, a) => n + contrib(a), 0) * 10) / 10;

/** Q440: the confirmation state, with what stops a confirmation (the current and the next year need holidays, none tentative). A store saved before 0.14.2 starts from the seed. */
const CC = () => (C().calConfirm ??= initCfg().calConfirm);
const MP = () => (C().mailPolicy ??= initCfg().mailPolicy);
const MK = () => (C().mailKinds ??= initCfg().mailKinds);
/** 0.15.1: nav.layout (a store saved before 0.15.1 starts from the seed). */
/** 0.15.190: the admin lock keys, kept in memory like the other small settings of the mock (both off by default). */
const locks: { block_public_sharing: boolean; disable_export: boolean; version: number; updated_at: string | null; updated_by: { id: string; display_name: string; employee_id: string | null } | null } =
  { block_public_sharing: false, disable_export: false, version: 1, updated_at: null, updated_by: null };
/** 0.15.312: the operational limits (catalogue and defaults as ops_limits_catalogue() in migration 0402); a limit that was never saved reads as its default. */
const OPS_CATALOGUE: { key: string; group: string; unit: string; default: number; min: number; max: number }[] = [
  { key: 'session.idle_hours', group: 'sessions', unit: 'hours', default: 8, min: 1, max: 24 },
  { key: 'session.absolute_hours', group: 'sessions', unit: 'hours', default: 12, min: 1, max: 72 },
  { key: 'stepup.seconds', group: 'sessions', unit: 'seconds', default: 300, min: 30, max: 3600 },
  { key: 'assignments.max_rows', group: 'rows', unit: 'rows', default: 2000, min: 100, max: 50000 },
  { key: 'import.max_rows', group: 'rows', unit: 'rows', default: 2000, min: 100, max: 50000 },
  { key: 'master_import.max_rows', group: 'rows', unit: 'rows', default: 5000, min: 100, max: 50000 },
  { key: 'register_import.max_rows', group: 'rows', unit: 'rows', default: 5000, min: 100, max: 50000 },
  { key: 'prefill.max_rows', group: 'rows', unit: 'rows', default: 5000, min: 100, max: 50000 },
  { key: 'prefill.max_sites', group: 'rows', unit: 'sites', default: 5000, min: 100, max: 50000 },
  { key: 'export.max_rows', group: 'exports', unit: 'rows', default: 100000, min: 1000, max: 1000000 },
  { key: 'idempotency.max_entries', group: 'exports', unit: 'entries', default: 5000, min: 500, max: 100000 },
  { key: 'login.ip_attempts', group: 'sessions', unit: 'attempts', default: 10, min: 3, max: 100 },
  { key: 'login.ip_window_seconds', group: 'sessions', unit: 'seconds', default: 900, min: 60, max: 86400 },
  { key: 'login.ip_base_seconds', group: 'sessions', unit: 'seconds', default: 2, min: 1, max: 60 },
  { key: 'login.ip_max_seconds', group: 'sessions', unit: 'seconds', default: 60, min: 5, max: 3600 },
  { key: 'login.identifier_attempts', group: 'sessions', unit: 'attempts', default: 5, min: 3, max: 50 },
  { key: 'media.thumbnails_per_minute', group: 'media', unit: 'per_minute', default: 120, min: 0, max: 6000 },
];
const opsLimits: { stored: Record<string, number>; version: number; updated_at: string | null; updated_by: { id: string; display_name: string; employee_id: string | null } | null } =
  { stored: {}, version: 1, updated_at: null, updated_by: null };
const opsView = () => ({
  items: OPS_CATALOGUE.map((c) => ({ ...c, value: opsLimits.stored[c.key] ?? c.default, is_default: !(c.key in opsLimits.stored) })),
  updated_at: opsLimits.updated_at, updated_by: opsLimits.updated_by, version: opsLimits.version, can_edit: isAdmin(),
});
const locksView = () => ({ ...locks, can_edit: isAdmin() });
/** 0.15.193: the download lock categories (templates, uploaded files, generated documents), in memory, all off by default. */
export const dlocks: { templates: boolean; uploaded_files: boolean; generated_documents: boolean; version: number; updated_at: string | null; updated_by: { id: string; display_name: string; employee_id: string | null } | null } =
  { templates: false, uploaded_files: false, generated_documents: false, version: 1, updated_at: null, updated_by: null };
const dlocksView = () => ({ ...dlocks, can_edit: isAdmin() });

/** 0.15.191: support access (off by default) and the support grants, kept in memory like the lock keys. A grant is a time-limited delegation. */
const support: { enabled: boolean; max_hours: number; default_hours: number; version: number; updated_at: string | null; updated_by: { id: string; display_name: string; employee_id: string | null } | null } =
  { enabled: false, max_hours: 72, default_hours: 24, version: 1, updated_at: null, updated_by: null };
type SupportGrant = { id: string; to: { id: string; display_name: string; employee_id: string | null }; from: { id: string; display_name: string; employee_id: string | null }; rights: string[]; valid_from: string; valid_to: string; revoked: boolean; revoked_at: string | null; reason: string };
const supportGrants: SupportGrant[] = [];
const SUPPORT_RIGHTS = ['templates.edit', 'fields.edit', 'documents.edit', 'warehouse.items.edit'];
const newDeviceView = () => ({ enabled: newDeviceState.enabled, code_minutes: newDeviceState.code_minutes, include_admins: newDeviceState.include_admins, mail_ready: true, updated_at: newDeviceState.updated_at, updated_by: newDeviceState.updated_by, version: newDeviceState.version, can_edit: true });
const passkeyView = () => ({ enabled: passkeyState.enabled, ready: passkeyState.ready, updated_at: passkeyState.updated_at, updated_by: passkeyState.updated_by, version: passkeyState.version, can_edit: true });
const supportView = () => ({ ...support, modules: ['templates', 'fields', 'lists', 'document_types', 'warehouse_items'], can_edit: true });
const supportDto = (g: SupportGrant) => ({
  id: g.id, from_user: g.from, to_user: g.to, target_kind: 'user', target: { kind: 'user', id: g.to.id, label: g.to.display_name }, scope: 'partial', rights: g.rights, region_codes: [], module_codes: [],
  allow_redelegate: false, valid_from: g.valid_from, valid_to: g.valid_to, state: g.revoked ? 'revoked' : new Date(g.valid_to) <= new Date() ? 'expired' : 'active', reason: g.reason, revoked_at: g.revoked_at,
});
const identityView = () => ({ ...identity(), brands: [...BRANDS], can_edit: isAdmin() });
/** 0.15.97: the login page settings with the system version (shown to signed-in users only). */
const loginPageView = () => ({ ...loginPage(), server_version: '0.15.97', can_edit: isAdmin() });
const NL = () => (C().navLayout ??= initCfg().navLayout);
const navView = () => {
  const c = NL();
  return { layout: c.layout ?? null, is_default: c.layout == null, catalogue: NAV_SIDE.map((n) => n.key), updated_at: c.updated_at, updated_by: c.updated_by ? ref(c.updated_by) : null, version: c.version, can_edit: isAdmin() };
};
/** The rules of admin_set_nav_layout (migration 0081): the clean layout or the field errors. Exported for unit tests. */
export function cleanNavLayout(raw: unknown): { layout: unknown; errors: { path: string; code: string }[] } {
  const errs: { path: string; code: string }[] = [];
  const known = new Set(NAV_SIDE.map((n) => n.key));
  const keys = new Set<string>(); const ids = new Set<string>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { layout: null, errors: [{ path: '/layout', code: 'invalid' }] };
  for (const k of Object.keys(raw)) if (k !== 'headings') errs.push({ path: `/layout/${k}`, code: 'unknown_field' });
  const hs = (raw as { headings?: unknown }).headings;
  if (!Array.isArray(hs)) return { layout: null, errors: [...errs, { path: '/layout/headings', code: 'required' }] };
  if (hs.length < 1 || hs.length > 30) return { layout: null, errors: [...errs, { path: '/layout/headings', code: 'too_many' }] };
  let n = 0;
  const head = (h: unknown, p: string, depth: 1 | 2): unknown => {
    n++;
    if (!h || typeof h !== 'object' || Array.isArray(h)) { errs.push({ path: p, code: 'invalid' }); return null; }
    const o = h as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!['id', 'name_en', 'name_ar', 'icon', 'children'].includes(k)) errs.push({ path: `${p}/${k}`, code: 'unknown_field' });
    if (typeof o.id !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(o.id)) errs.push({ path: `${p}/id`, code: 'invalid' });
    else if (ids.has(o.id)) errs.push({ path: `${p}/id`, code: 'duplicate_id' }); else ids.add(o.id);
    for (const f of ['name_en', 'name_ar']) {
      const v = typeof o[f] === 'string' ? (o[f] as string).trim() : '';
      if (!v) errs.push({ path: `${p}/${f}`, code: 'required' }); else if (v.length > 60) errs.push({ path: `${p}/${f}`, code: 'too_long' });
    }
    if (o.icon != null && (typeof o.icon !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(o.icon))) errs.push({ path: `${p}/icon`, code: 'invalid' });
    if (!Array.isArray(o.children)) { errs.push({ path: `${p}/children`, code: 'required' }); return null; }
    if (o.children.length > 200) errs.push({ path: `${p}/children`, code: 'too_many' });
    const kids = o.children.map((c: unknown, i: number) => {
      const cp = `${p}/children/${i}`;
      if (typeof c === 'string') {
        if (!known.has(c)) errs.push({ path: cp, code: 'unknown_item' }); else if (keys.has(c)) errs.push({ path: cp, code: 'duplicate_item' }); else keys.add(c);
        return c;
      }
      if (c && typeof c === 'object' && !Array.isArray(c)) { if (depth === 2) { errs.push({ path: cp, code: 'too_deep' }); return null; } return head(c, cp, 2); }
      errs.push({ path: cp, code: 'invalid' }); return null;
    });
    return { id: o.id, name_en: String(o.name_en ?? '').trim(), name_ar: String(o.name_ar ?? '').trim(), icon: typeof o.icon === 'string' ? o.icon : null, children: kids };
  };
  const out = hs.map((h, i) => head(h, `/layout/headings/${i}`, 1));
  if (n > 100) errs.push({ path: '/layout/headings', code: 'too_many' });
  return errs.length ? { layout: null, errors: errs } : { layout: { headings: out }, errors: [] };
}
/** 0.14.6: imports.async_rows (a store saved before 0.14.6 starts from the seed). */
const IM = () => (C().imports ??= initCfg().imports);
const TN = { enabled: true, days: 14, version: 1, updated_at: null as string | null };
const tplNoticeView = () => ({ enabled: TN.enabled, days: TN.days, default_days: 14, min: 1, max: 365, updated_at: TN.updated_at, updated_by: null, version: TN.version, can_edit: viewer()?.key === 'admin' || !!viewer()?.nav.includes('settings') });
const importsView = () => {
  const c = IM();
  return { async_rows: c.async_rows, default_async_rows: 50, min: 10, max: 500, updated_at: c.updated_at, updated_by: c.updated_by ? ref(c.updated_by) : null, version: c.version, can_edit: isAdmin() };
};
/** D49 part 3 (0.15.322): imports.upload_policy. */
const policyView = () => {
  const c = IM();
  return { policy: c.upload_policy ?? 'enforce', default_policy: 'enforce', policies: ['enforce', 'accept_incomplete'], updated_at: c.policy_updated_at ?? null,
    updated_by: c.policy_updated_by ? ref(c.policy_updated_by) : null, version: c.policy_version ?? 1, can_edit: isAdmin() };
};
const confirmation = () => {
  const c = CC(), h = C().holidays, y = Number(TODAY.slice(0, 4));
  const blockers = [y, y + 1].flatMap((yr): { code: 'no_holidays' | 'tentative_remaining'; year: number; count: number }[] => {
    const rows = h.filter((x) => x.date.startsWith(String(yr)));
    return !rows.length ? [{ code: 'no_holidays', year: yr, count: 0 }] : rows.some((x) => x.tentative) ? [{ code: 'tentative_remaining', year: yr, count: rows.filter((x) => x.tentative).length }] : [];
  });
  return { confirmed: c.confirmed, confirmed_at: c.confirmed ? c.at : null, confirmed_by: c.confirmed && c.by ? ref(c.by) : null, version: c.version, can_edit: isAdmin(), blockers };
};
const summary = () => {
  const h = C().holidays, tent = h.filter((x) => x.tentative && x.date >= TODAY).sort((a, b) => a.date.localeCompare(b.date));
  return { tentative_count: h.filter((x) => x.tentative).length, next_tentative_date: tent[0]?.date ?? null, tentative_reminder_due: !!tent[0] && day(tent[0].date) - day(TODAY) <= 14 * 864e5, next_year: 2027, next_year_table_empty: !h.some((x) => x.date.startsWith('2027')),
    // contract 0.12.0 (Q4, D4b): the official calendar is pending owner data; tentative dates count now
    official_calendar_pending: !CC().confirmed, tentative_counted: true,
    official_confirmed_at: CC().confirmed ? CC().at : null, official_confirmed_by: CC().confirmed && CC().by ? ref(CC().by!) : null };
};
const changed = (holiday: Holiday) => HttpResponse.json({ holiday, affected_open_tasks: 12, recalculation_job_id: null });

const POLICY_KEYS = ['reason', 'enabled', 'timezone', 'digest_hour', 'work_days_follow_calendar', 'work_days', 'thresholds', 'columns', 'matrix'];
const TH: Record<string, [number, number]> = { approval_remind_hours: [4, 168], approval_escalate_days: [1, 30], sla_warning_days_before_max: [0, 30], rate_cap_per_hour: [5, 500], retention_days: [30, 730] };

/** Pure validation of a notification policy body (also unit-tested). */
export function validatePolicy(b: NotificationPolicyInput & Record<string, unknown>, tzOk = (z: string) => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; } }) {
  const errs: { path: string; code: string }[] = [];
  for (const k of Object.keys(b)) if (!POLICY_KEYS.includes(k)) errs.push({ path: `/${k}`, code: 'unknown_key' });
  if (!tzOk(b.timezone ?? '')) errs.push({ path: '/timezone', code: 'invalid_timezone' });
  if (!int(b.digest_hour, 0, 23)) errs.push({ path: '/digest_hour', code: 'out_of_range' });
  const t = (b.thresholds ?? {}) as Record<string, number>;
  for (const k of Object.keys(t)) if (!TH[k]) errs.push({ path: `/thresholds/${k}`, code: 'unknown_key' });
  for (const [k, [lo, hi]] of Object.entries(TH)) if (!int(t[k], lo, hi)) errs.push({ path: `/thresholds/${k}`, code: t[k] === undefined ? 'required' : 'out_of_range' });
  if (!errs.some((e) => e.path.startsWith('/thresholds/approval_')) && t.approval_escalate_days * 24 <= t.approval_remind_hours)
    errs.push({ path: '/thresholds/approval_escalate_days', code: 'must_exceed_remind_hours' }, { path: '/thresholds/approval_remind_hours', code: 'must_exceed_remind_hours' });
  if (!b.work_days_follow_calendar && !(b.work_days ?? []).length) errs.push({ path: '/work_days', code: 'required' });
  (b.matrix ?? []).forEach((row, i) => {
    const def = CATALOGUE.find((c) => c.code === row.type_code);
    if (!def) return void errs.push({ path: `/matrix/${i}/type_code`, code: 'unknown_type' });
    if (def.mandatory) {
      (['in_app', 'email'] as const).forEach((ch) => { if (def.default_channels[ch] && !row.channels[ch]) errs.push({ path: `/matrix/${i}/channels/${ch}`, code: 'mandatory_locked' }); });
      row.cells.forEach((c, j) => { if (!c.on) errs.push({ path: `/matrix/${i}/cells/${j}`, code: 'mandatory_locked' }); });
    }
  });
  return errs;
}

/** F20 (contract 0.15.24): the dashboard settings in memory. The catalogue mirrors migration 0108; the values are the seed. */
const DASH_CATALOGUE = {
  kpis: [
    { code: 'sla_breach', label_en: 'SLA breaches (open tasks past the maximum)', label_ar: 'تجاوزات SLA', unit: 'pct', direction: 'lower', default_green: 5, default_amber: 10 },
    { code: 'sla_at_risk', label_en: 'SLA at risk (past the warning share)', label_ar: 'SLA معرّض للخطر', unit: 'pct', direction: 'lower', default_green: 10, default_amber: 20 },
    { code: 'data_quality_gap', label_en: 'Empty mandatory cells', label_ar: 'خلايا إلزامية فارغة', unit: 'pct', direction: 'lower', default_green: 2, default_amber: 5 },
    { code: 'vehicle_ready', label_en: 'Vehicle-ready rate of assignments', label_ar: 'نسبة جاهزية المركبة', unit: 'pct', direction: 'higher', default_green: 90, default_amber: 75 },
    { code: 'advances_open_after_close', label_en: 'Advances open after the work closed', label_ar: 'سلفيات مفتوحة بعد إغلاق العمل', unit: 'count', direction: 'lower', default_green: 0, default_amber: 3 },
    { code: 'dismantle_pending', label_en: 'Dismantle CW and TE pending', label_ar: 'تفكيك CW وTE المعلّق', unit: 'count', direction: 'lower', default_green: 0, default_amber: 5 },
    { code: 'as_built_submitted', label_en: 'As-Built submitted against PAC', label_ar: 'As-Built المقدَّم مقابل PAC', unit: 'pct', direction: 'higher', default_green: 90, default_amber: 70 },
    { code: 'time_in_state_p85', label_en: 'Time in state, 85th percentile', label_ar: 'الزمن في الحالة، المئين 85', unit: 'days', direction: 'lower', default_green: 10, default_amber: 20 },
    { code: 'stale_tasks', label_en: 'Stale tasks (idle for N working days)', label_ar: 'مهام راكدة', unit: 'pct', direction: 'lower', default_green: 5, default_amber: 10 },
    { code: 'on_air_vs_target', label_en: 'On-Air against the monthly target', label_ar: 'الربط On-Air مقابل الهدف', unit: 'pct', direction: 'higher', default_green: 100, default_amber: 80 },
  ],
  cards: [
    { code: 'site_map', label_en: 'Site map', label_ar: 'خريطة المواقع' },
    { code: 'f13', label_en: 'Risk matrix, data quality, decisions, swap and relocation', label_ar: 'مصفوفة المخاطر وجودة البيانات والقرارات والاستبدال والنقل' },
    { code: 'headline', label_en: 'Headline KPIs', label_ar: 'المؤشرات الرئيسية' },
    { code: 'pipeline', label_en: 'Milestone pipeline', label_ar: 'مسار المعالم' },
    { code: 'health_ps', label_en: 'Health index and Project Status', label_ar: 'مؤشر الصحة وحالة المشروع' },
    { code: 'streams', label_en: 'Streams', label_ar: 'المسارات' },
    { code: 'sla', label_en: 'SLA per stage and top late tasks', label_ar: 'SLA لكل مرحلة' },
    { code: 'gates_issues_delay', label_en: 'Blocked gates, issues and delay attribution', label_ar: 'البوابات المعطلة والقضايا والتأخير' },
    { code: 'goals', label_en: 'Goals', label_ar: 'الأهداف' },
    { code: 'regions', label_en: 'Regions', label_ar: 'المناطق' },
    { code: 'region_health', label_en: 'Region health', label_ar: 'صحة المناطق' },
    { code: 'ops_procurement', label_en: 'Procurement and materials', label_ar: 'المشتريات والمواد' },
    { code: 'pinned_views', label_en: 'Pinned views', label_ar: 'العروض المثبتة' },
    { code: 'ops_scurve', label_en: 'Progress curve: planned vs actual, velocity and forecast', label_ar: 'منحنى التقدم: المخطط مقابل الفعلي والسرعة والتوقع' },
    { code: 'ops_permits_hse', label_en: 'Permits and HSE: status, validity, stop-work and PTW checks', label_ar: 'التصاريح والسلامة: الحالة والصلاحية وإيقاف العمل وفحوصات تصاريح العمل' },
    { code: 'ops_gecol_hlc', label_en: 'Power and fiber readiness: GECOL and HLC waiting sites by age', label_ar: 'جاهزية الكهرباء والألياف: مواقع GECOL وHLC المنتظرة حسب العمر' },
    { code: 'ops_contractors', label_en: 'Contractor and supplier scorecard: levels, delay and quality', label_ar: 'بطاقة أداء المقاولين والموردين: المستويات والتأخير والجودة' },
    { code: 'ops_quality', label_en: 'Quality: open snags and NCR, closure age, first-time acceptance', label_ar: 'الجودة: الـSnag والـNCR المفتوحة وعمر الإغلاق والقبول من أول مرة' },
    { code: 'ops_approvals', label_en: 'Pending approvals: waiting review or approval, ages per role', label_ar: 'الموافقات المعلقة: بانتظار المراجعة أو الاعتماد، الأعمار حسب الدور' },
    { code: 'ops_phase', label_en: 'Phase scope: sites per project phase, progress and derived targets', label_ar: 'نطاق المراحل: المواقع لكل مرحلة والتقدم والمستهدفات المشتقة' },
    { code: 'ops_changes', label_en: 'Change requests and overdue meeting actions', label_ar: 'طلبات التغيير وبنود الاجتماعات المتأخرة' },
  ],
};
const dashSeedThresholds = Object.fromEntries(DASH_CATALOGUE.kpis.map((k) => [k.code, { green: k.default_green, amber: k.default_amber }]));
let dashState = {
  version: 0,
  targets: { sites_per_batch: null as number | null, monthly_on_air: null as number | null },
  thresholds: dashSeedThresholds as Record<string, { green: number; amber: number }>,
  tabs: { pmo: { order: [] as string[], hidden: [] as string[] }, cw: { order: [] as string[], hidden: [] as string[] }, te: { order: [] as string[], hidden: [] as string[] } },
  updated_at: null as string | null,
  updated_by: null as null | { id: string; display_name: string; employee_id: string | null },
};
const dashView = () => ({ ...dashState, catalogue: DASH_CATALOGUE });
/** The weekday of the weekly dashboard snapshot (contract 0.15.430): the setting dashboard.snapshot_weekday, default 4 (Thursday), version 0 until the first save. */
let snapState = { version: 0, weekday: 4, updated_at: null as string | null, updated_by: null as null };
const snapView = () => ({ ...snapState });
/** The colours of the progress figures (contract 0.15.432): nothing enabled until saved, the suggested numbers shown. */
const RAG_CAT = [
  { code: 'spi', label_en: 'Progress vs plan index (SPI)', label_ar: 'مؤشر التقدم مقابل الخطة (SPI)', unit: 'index', min: 0, max: 5, default_green: 0.95, default_amber: 0.85 },
  { code: 'progress_gap', label_en: 'Progress against plan (points)', label_ar: 'التقدم مقابل الخطة (نقاط)', unit: 'points', min: -100, max: 100, default_green: -2, default_amber: -5 },
  { code: 'velocity', label_en: 'Weekly velocity (points per week)', label_ar: 'السرعة الأسبوعية (نقاط في الأسبوع)', unit: 'points_per_week', min: -100, max: 100, default_green: 1.5, default_amber: 0.75 },
];
let ragState: { version: number; saved: Record<string, { enabled: boolean; green: number; amber: number }>; updated_at: string | null } = { version: 0, saved: {}, updated_at: null };
const ragView = () => ({
  items: RAG_CAT.map((c) => ({ ...c, enabled: ragState.saved[c.code]?.enabled ?? false, green: ragState.saved[c.code]?.green ?? c.default_green, amber: ragState.saved[c.code]?.amber ?? c.default_amber })),
  version: ragState.version, updated_at: ragState.updated_at, updated_by: null,
});
/** The number of weeks the dashboard forecast averages (contract 0.15.431): the setting dashboard.forecast_window_weeks, default 4, version 0 until the first save. */
let fcState = { version: 0, weeks: 4, updated_at: null as string | null, updated_by: null as null };
const fcView = () => ({ ...fcState });
/** The health index bands (contract 0.15.435): the setting dashboard.health_bands, default 85 and 70, version 0 until the first save. */
let bandsState = { version: 0, green: 85, amber: 70, updated_at: null as string | null, updated_by: null as null };
const bandsView = () => ({ ...bandsState });

/** Goals (contract 0.15.160): the list in memory; the progress is a fixed demo count against each goal. */
const GOALS_CATALOGUE = {
  metrics: [{ code: 'MS1', label_en: 'Site acceptance', label_ar: 'قبول الموقع' }, { code: 'MS6', label_en: 'On-Air', label_ar: 'الربط On-Air' }],
  regions: [{ id: 1, code: 'Tripoli', name_en: 'Tripoli', name_ar: 'طرابلس' }, { id: 5, code: 'Benghazi', name_en: 'Benghazi', name_ar: 'بنغازي' }],
  periods: ['month', 'quarter', 'year'],
};
type MockGoal = { id: string; name_en: string; name_ar?: string | null; metric: string; region_id?: number | null; period: 'month' | 'quarter' | 'year'; target: number; active?: boolean };
let goalsState = { version: 0, goals: [] as MockGoal[], updated_at: null as string | null, updated_by: null as null | { id: string; display_name: string } };
const goalsView = () => ({ ...goalsState, catalogue: GOALS_CATALOGUE });
const goalsProgress = () => goalsState.goals.filter((g) => g.active !== false).map((g) => {
  const actual = Math.min(g.target, 3), percent = Math.round((1000 * actual) / g.target) / 10;
  return { id: g.id, name_en: g.name_en, name_ar: g.name_ar ?? null, metric: g.metric, region_id: g.region_id ?? null, period: g.period, period_start: '2026-11-01', period_end: '2026-11-30', target: g.target, actual, percent, expected_percent: 90, status: (percent >= 100 ? 'achieved' : percent >= 90 ? 'on_track' : percent >= 75 ? 'at_risk' : 'behind') as 'achieved' | 'on_track' | 'at_risk' | 'behind' };
});

/** GET /settings/sla-tasks and PUT /settings/sla-tasks/:task/no-sla (contract 0.15.85): demo tasks, one per status, one in the open draft. */
type MockSlaTask = { task_code: string; name_en: string; name_ar: string | null; stage_code: string; workflow_version: number; in_draft: boolean; mode: 'set' | 'none' | 'undecided'; none_reason: string | null; min_working_days: number | null; max_working_days: number | null; start_event: string | null; unit: string | null };
const SLA_TASKS: MockSlaTask[] = [
  { task_code: 'A1', name_en: 'Site survey', name_ar: null, stage_code: 'MS1', workflow_version: 1, in_draft: false, mode: 'set', none_reason: null, min_working_days: 2, max_working_days: 4, start_event: 'PRED', unit: 'working' },
  { task_code: 'A2', name_en: 'TSSR approval', name_ar: null, stage_code: 'MS1', workflow_version: 1, in_draft: false, mode: 'undecided', none_reason: null, min_working_days: null, max_working_days: null, start_event: null, unit: null },
  { task_code: 'B1', name_en: 'Information step', name_ar: null, stage_code: 'MS2', workflow_version: 1, in_draft: false, mode: 'none', none_reason: 'Information only', min_working_days: null, max_working_days: null, start_event: null, unit: null },
  { task_code: 'NEW9', name_en: 'Draft task', name_ar: null, stage_code: 'MS2', workflow_version: 2, in_draft: true, mode: 'undecided', none_reason: null, min_working_days: null, max_working_days: null, start_event: null, unit: null },
];
const slaCounts = () => ({ total: SLA_TASKS.length, set: SLA_TASKS.filter((x) => x.mode === 'set').length, none: SLA_TASKS.filter((x) => x.mode === 'none').length, undecided: SLA_TASKS.filter((x) => x.mode === 'undecided').length, in_draft: SLA_TASKS.filter((x) => x.in_draft).length });

/** GET/PUT/POST /recycle-bin (contract 0.15.98): demo voided records. */
const BIN = {
  retention_days: 90, version: 1,
  items: [
    { id: '00000000-0000-4000-8000-0000000000a1', register_key: 'procurement', register_name_en: 'Procurement', register_name_ar: null, label: 'GN-0012 / Procurement v1', site_id: null, site_code: 'GN-0012', version: 4, version_no: 1, voided_at: '2026-11-20T09:00:00.000Z', voided_by: null, voided_by_name: 'Demo Admin', void_reason: 'Entered on the wrong site', restorable_until: '2027-02-18T09:00:00.000Z', blocked: null as string | null },
    { id: '00000000-0000-4000-8000-0000000000a2', register_key: 'gecol', register_name_en: 'GECOL', register_name_ar: null, label: 'GN-0031 / GECOL v1', site_id: null, site_code: 'GN-0031', version: 3, version_no: 1, voided_at: '2026-11-22T09:00:00.000Z', voided_by: null, voided_by_name: 'Demo Admin', void_reason: 'Duplicate', restorable_until: '2027-02-20T09:00:00.000Z', blocked: 'site_slot_taken' },
  ],
};

/** GET /matrix/coverage (contract 0.15.94): demo numbers only. */
const MATRIX_COVERAGE = {
  workflow_version: 1,
  as_of: '2026-11-27T12:00:00.000Z',
  regions: [{ id: 1, code: 'Tripoli', name_en: 'Tripoli', name_ar: null }, { id: 2, code: 'Middle', name_en: 'Middle', name_ar: null }],
  summary: { cells: 8, ok: 5, empty: 2, no_active_holder: 1 },
  rows: [
    { kind: 'stage', code: 'MS1', name_en: 'Site acquisition', name_ar: null, module: 'sites', gaps: 1, cells: [
      { region_id: 1, level_code: 'L1', source: 'default', assignees: 1, holders: 2, status: 'ok' }, { region_id: 1, level_code: 'L2', source: 'default', assignees: 1, holders: 1, status: 'ok' },
      { region_id: 2, level_code: 'L1', source: 'region', assignees: 1, holders: 1, status: 'ok' }, { region_id: 2, level_code: 'L2', source: 'none', assignees: 0, holders: 0, status: 'empty' } ] },
    { kind: 'register', code: 'gecol', name_en: 'GECOL', name_ar: null, module: 'gecol', gaps: 2, cells: [
      { region_id: 1, level_code: 'L1', source: 'default', assignees: 1, holders: 0, status: 'no_active_holder' }, { region_id: 1, level_code: 'L2', source: 'default', assignees: 1, holders: 1, status: 'ok' },
      { region_id: 2, level_code: 'L1', source: 'none', assignees: 0, holders: 0, status: 'empty' }, { region_id: 2, level_code: 'L2', source: 'default', assignees: 1, holders: 1, status: 'ok' } ] },
  ],
};

/** Preventive-maintenance schedules (contract 0.15.161): the list in memory; "Create draft" only moves the next due date (the mock saves no record). */
type MockPm = { id: string; name_en: string; name_ar?: string | null; register_key: string; site_id?: string | null; record_type?: string | null; data: Record<string, unknown>; every: number; unit: 'week' | 'month'; next_due: string; active?: boolean; last_generated_at?: string; last_record_id?: string };
let pmState = { version: 0, schedules: [] as MockPm[], updated_at: null as string | null, updated_by: null as null | { id: string; display_name: string } };
const PM_CATALOGUE = { registers: [{ key: 'procurement', name_en: 'Procurement', name_ar: 'المشتريات', site_scoped: false }], units: ['week', 'month'] };
const pmView = () => ({ ...pmState, today: tripoliToday(), catalogue: PM_CATALOGUE });

const DR = { default: 'first' as 'first' | 'last', registers: {} as Record<string, 'first' | 'last'>, version: 1, updated_at: null as string | null };
const dupRowsView = () => ({ default: DR.default, registers: DR.registers, updated_at: DR.updated_at, updated_by: null, version: DR.version, can_edit: viewer()?.key === 'admin' || !!viewer()?.nav.includes('settings') });
export const settingsHandlers = [
  http.get(`${B}/recycle-bin`, () => { const g = guard(); if (g) return g; return HttpResponse.json(BIN, tag(BIN.version)); }),
  http.put(`${B}/recycle-bin/retention`, async ({ request }) => { const g = guard(); if (g) return g; const b = (await request.json()) as { retention_days: number }; BIN.retention_days = b.retention_days; BIN.version += 1; return HttpResponse.json({ retention_days: BIN.retention_days, version: BIN.version }, tag(BIN.version)); }),
  http.post(`${B}/recycle-bin/:id/restore`, ({ params }) => { const g = guard(); if (g) return g; const i = BIN.items.findIndex((x) => x.id === params.id); if (i < 0) return HttpResponse.json({ code: 'not_found' }, { status: 404 }); const [r] = BIN.items.splice(i, 1); return HttpResponse.json({ id: r!.id, register_key: r!.register_key, state: 'entry', version: r!.version + 1 }); }),
  http.get(`${B}/matrix/simulate`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url); const kind = u.searchParams.get('kind') === 'register' ? 'register' : 'task'; const code = u.searchParams.get('code') ?? '';
    const person = (n: string, via: string | string[]) => ({ user_id: '00000000-0000-4000-8000-0000000000a1', name: n, email: `${n.toLowerCase().replace(/ /g, '.')}@example.test`, via });
    return HttpResponse.json({ site: { id: u.searchParams.get('site_id'), site_code: 'S-1', name: 'Demo', region_id: 1 }, kind, code, name_en: code, name_ar: null, module: 'sites',
      levels: [
        { level_code: 'L1', source: 'region', task_specific: true, rule: 'any_one', holders: [person('Sara Ali', 'role: Field engineer')], fallback: [] },
        { level_code: 'L2', source: 'default', task_specific: false, rule: null, holders: [], fallback: [person('Admin One', 'system_admin')] },
      ] });
  }),
  http.get(`${B}/matrix/coverage`, () => { const g = guard(); if (g) return g; return HttpResponse.json(MATRIX_COVERAGE); }),
  // ------------------------------------------------------------------ preventive-maintenance schedules (contract 0.15.161)
  http.get(`${B}/settings/pm-schedules`, () => { const g = guard(); if (g) return g; return HttpResponse.json(pmView(), tag(pmState.version)); }),
  http.put(`${B}/settings/pm-schedules`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = (await request.json()) as { schedules: MockPm[] };
    pmState = { ...pmState, version: pmState.version + 1, schedules: b.schedules.map((x) => ({ ...x, last_generated_at: pmState.schedules.find((o) => o.id === x.id)?.last_generated_at, last_record_id: pmState.schedules.find((o) => o.id === x.id)?.last_record_id })), updated_at: new Date().toISOString() };
    return HttpResponse.json(pmView(), tag(pmState.version));
  }),
  http.post(`${B}/pm-schedules/:id/generate`, ({ params }) => {
    const g = guard(); if (g) return g;
    const x = pmState.schedules.find((o) => o.id === params.id);
    if (!x) return problem(404, 'not_found', 'Schedule not found');
    const today = tripoliToday();
    if (x.active === false || x.next_due > today) return problem(409, 'invalid_transition', 'This schedule is not due.');
    let d = new Date(`${x.next_due}T00:00:00Z`);
    while (d.toISOString().slice(0, 10) <= today) { if (x.unit === 'week') d = new Date(d.getTime() + 7 * x.every * 86400000); else d.setUTCMonth(d.getUTCMonth() + x.every); }
    x.next_due = d.toISOString().slice(0, 10); x.last_generated_at = new Date().toISOString(); x.last_record_id = crypto.randomUUID();
    pmState = { ...pmState, version: pmState.version + 1 };
    return HttpResponse.json({ record_id: x.last_record_id, register_key: x.register_key, next_due: x.next_due }, { status: 201 });
  }),
  // ------------------------------------------------------------------ dashboard settings (F20, contract 0.15.24)
  // ------------------------------------------------------------------ 0.15.367: the target policy (manual override of the typed dashboard targets, off by default)
  http.get(`${B}/settings/dashboard-target-policy`, () => { const g = guard(); if (g) return g; const j = targetPolicyView(); return HttpResponse.json(j, tag(j.version)); }),
  http.put(`${B}/settings/dashboard-target-policy`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ manual_override?: unknown; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = Object.keys(b).filter((k) => !['manual_override', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_field' }));
    if (typeof b.manual_override !== 'boolean') errs.push({ path: '/manual_override', code: 'invalid' });
    if ((b.reason ?? '').trim().length < 3 || (b.reason ?? '').length > 1000) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, targetPolicy.version); if (p) return p;
    if (!stepUpValid()) return stepUp();
    if (targetPolicy.manual_override === b.manual_override) return problem(409, 'invalid_transition', 'This is already the target policy.');
    const v = viewer()!;
    Object.assign(targetPolicy, { manual_override: b.manual_override as boolean, version: targetPolicy.version + 1, updated_at: new Date().toISOString(),
      updated_by: { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id } });
    const j = targetPolicyView();
    return HttpResponse.json(j, tag(j.version));
  }),
  http.get(`${B}/settings/dashboard`, () => { const g = guard(); if (g) return g; return HttpResponse.json(dashView(), tag(dashState.version)); }),
  http.put(`${B}/settings/dashboard`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = (await request.json()) as { targets: typeof dashState.targets; thresholds: typeof dashState.thresholds; tabs: typeof dashState.tabs };
    dashState = { ...dashState, version: dashState.version + 1, targets: b.targets, thresholds: b.thresholds, tabs: b.tabs, updated_at: new Date().toISOString() };
    return HttpResponse.json(dashView(), tag(dashState.version));
  }),
  // ------------------------------------------------------------------ weekly snapshot day (contract 0.15.430, settings review gap 3)
  http.get(`${B}/settings/dashboard/snapshot-schedule`, () => { const g = guard(); if (g) return g; return HttpResponse.json(snapView(), tag(snapState.version)); }),
  http.put(`${B}/settings/dashboard/snapshot-schedule`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, snapState.version); if (p) return p;
    const b = (await request.json()) as { weekday?: number; reason?: string };
    const errs: { path: string; code: string }[] = [];
    if (!Number.isInteger(b.weekday) || b.weekday! < 0 || b.weekday! > 6) errs.push({ path: '/weekday', code: 'invalid' });
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    snapState = { ...snapState, version: snapState.version + 1, weekday: b.weekday!, updated_at: new Date().toISOString() };
    return HttpResponse.json(snapView(), tag(snapState.version));
  }),
  // ------------------------------------------------------------------ progress figure colours (contract 0.15.432, settings review gap 5)
  http.get(`${B}/settings/dashboard/progress-rag`, () => { const g = guard(); if (g) return g; return HttpResponse.json(ragView(), tag(ragState.version)); }),
  http.put(`${B}/settings/dashboard/progress-rag`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, ragState.version); if (p) return p;
    const b = (await request.json()) as { items?: Record<string, { enabled?: unknown; green?: unknown; amber?: unknown }>; reason?: string };
    const errs: { path: string; code: string }[] = [];
    const saved: typeof ragState.saved = {};
    for (const c of RAG_CAT) {
      const it = b.items?.[c.code];
      if (!it || typeof it.enabled !== 'boolean' || typeof it.green !== 'number' || typeof it.amber !== 'number') { errs.push({ path: `/items/${c.code}`, code: 'required' }); continue; }
      if (it.green < c.min || it.green > c.max || it.amber < c.min || it.amber > c.max) errs.push({ path: `/items/${c.code}`, code: 'invalid' });
      else if (it.green < it.amber) errs.push({ path: `/items/${c.code}`, code: 'invalid_order' });
      else saved[c.code] = { enabled: it.enabled, green: it.green, amber: it.amber };
    }
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    ragState = { version: ragState.version + 1, saved, updated_at: new Date().toISOString() };
    return HttpResponse.json(ragView(), tag(ragState.version));
  }),
  // ------------------------------------------------------------------ forecast window (contract 0.15.431, settings review gap 4)
  http.get(`${B}/settings/dashboard/forecast-window`, () => { const g = guard(); if (g) return g; return HttpResponse.json(fcView(), tag(fcState.version)); }),
  http.put(`${B}/settings/dashboard/forecast-window`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, fcState.version); if (p) return p;
    const b = (await request.json()) as { weeks?: number; reason?: string };
    const errs: { path: string; code: string }[] = [];
    if (!Number.isInteger(b.weeks) || b.weeks! < 2 || b.weeks! > 12) errs.push({ path: '/weeks', code: 'invalid' });
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    fcState = { ...fcState, version: fcState.version + 1, weeks: b.weeks!, updated_at: new Date().toISOString() };
    return HttpResponse.json(fcView(), tag(fcState.version));
  }),
  // ------------------------------------------------------------------ health index bands (contract 0.15.435, settings review gap 8)
  http.get(`${B}/settings/dashboard/health-bands`, () => { const g = guard(); if (g) return g; return HttpResponse.json(bandsView(), tag(bandsState.version)); }),
  http.put(`${B}/settings/dashboard/health-bands`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, bandsState.version); if (p) return p;
    const b = (await request.json()) as { green?: number; amber?: number; reason?: string };
    const errs: { path: string; code: string }[] = [];
    if (!Number.isInteger(b.green) || b.green! < 1 || b.green! > 100) errs.push({ path: '/green', code: 'invalid' });
    if (!Number.isInteger(b.amber) || b.amber! < 0 || b.amber! > 99) errs.push({ path: '/amber', code: 'invalid' });
    if (!errs.length && b.green! <= b.amber!) errs.push({ path: '/green', code: 'invalid_order' });
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    bandsState = { ...bandsState, version: bandsState.version + 1, green: b.green!, amber: b.amber!, updated_at: new Date().toISOString() };
    return HttpResponse.json(bandsView(), tag(bandsState.version));
  }),
  // ------------------------------------------------------------------ goals (contract 0.15.160)
  http.get(`${B}/settings/goals`, () => { const g = guard(); if (g) return g; return HttpResponse.json(goalsView(), tag(goalsState.version)); }),
  http.put(`${B}/settings/goals`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = (await request.json()) as { goals: MockGoal[] };
    goalsState = { ...goalsState, version: goalsState.version + 1, goals: b.goals, updated_at: new Date().toISOString() };
    return HttpResponse.json(goalsView(), tag(goalsState.version));
  }),
  http.get(`${B}/goals/progress`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ goals: goalsProgress() }); }),
  // ------------------------------------------------------------------ calendar
  http.get(`${B}/settings/holidays`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams, year = u.get('year'), tent = u.get('tentative');
    const items = C().holidays.filter((h) => (!year || h.date.startsWith(year)) && (tent === null || h.tentative === (tent === 'true'))).sort((a, b) => a.date.localeCompare(b.date));
    return HttpResponse.json({ items, summary: summary() });
  }),
  http.get(`${B}/settings/calendars`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ items: [{ id: uid('1001'), code: 'LY', name: 'Libya', weekend_days: C().weekend.days, is_default: true, holidays: C().holidays.map((h) => ({ date: h.date, name: h.name_en })), holiday_table_empty: false }] }); }),
  http.post(`${B}/settings/holidays`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ date?: string; name_en?: string; kind?: string; tentative?: boolean; name_ar?: string; reason?: string }>(request);
    const errs: { path: string; code: string }[] = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date ?? '')) errs.push({ path: '/date', code: 'required' });
    if ((b.name_en ?? '').trim().length < 2) errs.push({ path: '/name_en', code: 'min_length' });
    if (b.kind !== 'national' && b.kind !== 'religious') errs.push({ path: '/kind', code: 'required' });
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    if (C().holidays.some((h) => h.date === b.date)) return problem(409, 'duplicate', 'A holiday exists on this date', { errors: [{ path: '/date', code: 'duplicate' }] });
    const h = { id: crypto.randomUUID(), calendar_code: 'LY', date: b.date!, name_en: b.name_en!.trim(), name_ar: b.name_ar ?? null, kind: b.kind as 'national', tentative: !!b.tentative, confirmed_at: null, confirmed_by: null, version: 1 } as Holiday;
    C().holidays.push(h); save();
    return HttpResponse.json({ holiday: h, affected_open_tasks: 12, recalculation_job_id: null }, { status: 201 });
  }),
  http.post(`${B}/settings/holidays/import`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const form = await request.formData().catch(() => null);
    if (String(form?.get('reason') ?? '').trim().length < 3) return fields({ path: '/reason', code: 'required' });
    const f = form?.get('file'); // checked by size, not name: jsdom files lose their name through undici
    if (!f || typeof f === 'string' || !f.size) return problem(422, 'template_rejected', 'Not an approved template', { reason: 'tpl_missing' } as never);
    const rows = (await f.text()).split(/\r?\n/).slice(1).map((l) => l.split(',')).filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c[0]) && !C().holidays.some((h) => h.date === c[0]));
    rows.forEach((c, i) => C().holidays.push({ id: crypto.randomUUID(), calendar_code: 'LY', date: c[0], name_en: c[1] ?? `Imported ${i}`, name_ar: c[2] ?? null, kind: c[3] === 'religious' ? 'religious' : 'national', tentative: c[4] === 'yes', confirmed_at: null, confirmed_by: null, version: 1 } as Holiday));
    save();
    return HttpResponse.json({ id: crypto.randomUUID(), template_id: 'TPL-HOLIDAYS', template_version: 1, status: 'applied', counts: { create: rows.length, update: 0, unchanged: 0, error: 0 }, affected_open_tasks: 12, version: 1 }, { status: 202 });
  }),
  http.patch(`${B}/settings/holidays/:id`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const h = C().holidays.find((x) => x.id === params.id); if (!h) return problem(404, 'not_found', 'Holiday not found');
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, h.version); if (p) return p;
    const { reason, ...patch } = await body<Partial<Holiday> & { reason?: string }>(request);
    const r = reasonErr(reason); if (r) return r;
    if (patch.name_en !== undefined && patch.name_en.trim().length < 2) return fields({ path: '/name_en', code: 'min_length' });
    if (patch.date && C().holidays.some((x) => x.id !== h.id && x.date === patch.date)) return problem(409, 'duplicate', 'A holiday exists on this date', { errors: [{ path: '/date', code: 'duplicate' }] });
    Object.assign(h, patch, { version: h.version + 1 }); save();
    return changed(h);
  }),
  http.delete(`${B}/settings/holidays/:id`, ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const h = C().holidays.find((x) => x.id === params.id); if (!h) return problem(404, 'not_found', 'Holiday not found');
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    if (!stepUpValid()) return stepUp();
    const r = reasonErr(new URL(request.url).searchParams.get('reason') ?? ''); if (r) return r;
    const p = ver(request, h.version); if (p) return p;
    C().holidays = C().holidays.filter((x) => x.id !== h.id); save();
    return changed(h);
  }),
  http.post(`${B}/settings/holidays/:id/confirm`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const h = C().holidays.find((x) => x.id === params.id); if (!h) return problem(404, 'not_found', 'Holiday not found');
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, h.version); if (p) return p;
    const b = await body<{ date?: string; reason?: string }>(request);
    const r = reasonErr(b.reason); if (r) return r;
    if (!h.tentative) return problem(409, 'invalid_transition', 'Already confirmed');
    Object.assign(h, { tentative: false, date: b.date ?? h.date, confirmed_at: new Date().toISOString(), confirmed_by: me(), version: h.version + 1 }); save();
    return changed(h);
  }),
  // 0.14.2 (Q440): confirm or withdraw the official calendar
  http.get(`${B}/settings/calendar-confirmation`, () => { const g = guard(); if (g) return g; const j = confirmation(); return HttpResponse.json(j, tag(j.version)); }),
  http.put(`${B}/settings/calendar-confirmation`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, CC().version); if (p) return p;
    const b = await body<{ confirmed?: unknown; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = Object.keys(b).filter((k) => !['confirmed', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_field' }));
    if ((b.reason ?? '').trim().length < 3 || (b.reason ?? '').length > 1000) errs.push({ path: '/reason', code: 'required' });
    if (typeof b.confirmed !== 'boolean') errs.push({ path: '/confirmed', code: 'required' });
    if (errs.length) return fields(...errs);
    if (CC().confirmed === b.confirmed) return problem(409, 'invalid_transition', b.confirmed ? 'The official calendar is already confirmed.' : 'The official calendar is not confirmed.');
    if (b.confirmed) {
      const bl = confirmation().blockers;
      if (bl.length) return fields(...bl.map((x) => ({ path: '/confirmed', code: x.code })));
    }
    Object.assign(CC(), { confirmed: b.confirmed as boolean, at: b.confirmed ? new Date().toISOString() : null, by: b.confirmed ? viewer()!.employee_id! : null, version: CC().version + 1 }); save();
    const j = confirmation();
    return HttpResponse.json(j, tag(j.version));
  }),
  http.put(`${B}/settings/weekend-days`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const b = await body<{ weekend_days?: number[]; reason?: string }>(request);
    const r = reasonErr(b.reason); if (r) return r;
    const d = b.weekend_days ?? [];
    if (!d.length || d.length > 6 || new Set(d).size !== d.length || d.some((x) => !int(x, 0, 6))) return fields({ path: '/weekend_days', code: 'invalid' });
    C().weekend = { days: [...d].sort(), version: C().weekend.version + 1 }; save();
    return HttpResponse.json({ calendar_code: 'LY', weekend_days: C().weekend.days, affected_open_tasks: 12, version: C().weekend.version });
  }),

  // ------------------------------------------------------------------ 0.14.6: the background threshold of batches (Settings, Imports)
  http.get(`${B}/settings/imports`, () => { const g = guard(); if (g) return g; const j = importsView(); return HttpResponse.json(j, tag(j.version)); }),
  http.put(`${B}/settings/imports`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, IM().version); if (p) return p;
    const b = await body<{ async_rows?: unknown; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = Object.keys(b).filter((k) => !['async_rows', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_field' }));
    if ((b.reason ?? '').trim().length < 3 || (b.reason ?? '').length > 1000) errs.push({ path: '/reason', code: 'required' });
    if (typeof b.async_rows !== 'number' || !Number.isInteger(b.async_rows) || b.async_rows < 10 || b.async_rows > 500) errs.push({ path: '/async_rows', code: 'out_of_range' });
    if (errs.length) return fields(...errs);
    if (IM().async_rows === b.async_rows) return problem(409, 'invalid_transition', `The threshold is already ${String(b.async_rows)} rows.`);
    Object.assign(IM(), { async_rows: b.async_rows as number, version: IM().version + 1, updated_at: new Date().toISOString(), updated_by: viewer()!.employee_id! }); save();
    const j = importsView();
    return HttpResponse.json(j, tag(j.version));
  }),

  // ------------------------------------------------------------------ 0.15.345 (0432): duplicate rows in one file (Settings, Imports)
  http.get(`${B}/settings/duplicate-rows`, () => { const g = guard(); if (g) return g; return HttpResponse.json(dupRowsView(), tag(DR.version)); }),
  http.put(`${B}/settings/duplicate-rows`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, DR.version); if (p) return p;
    const b = await body<{ default?: string; registers?: Record<string, string>; reason?: string }>(request);
    const errs: { path: string; code: string }[] = [];
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (b.default !== 'first' && b.default !== 'last') errs.push({ path: '/default', code: 'invalid' });
    Object.entries(b.registers ?? {}).forEach(([k, v]) => { if (v !== 'first' && v !== 'last') errs.push({ path: `/registers/${k}`, code: 'invalid' }); });
    if (errs.length) return fields(...errs);
    if (DR.default === b.default && JSON.stringify(DR.registers) === JSON.stringify(b.registers ?? {})) return problem(409, 'invalid_transition', 'These values are already set.');
    Object.assign(DR, { default: b.default as 'first' | 'last', registers: (b.registers ?? {}) as Record<string, 'first' | 'last'>, version: DR.version + 1, updated_at: new Date().toISOString() });
    return HttpResponse.json(dupRowsView(), tag(DR.version));
  }),

  // ------------------------------------------------------------------ 0.15.322: the upload policy of the imports (D49 part 3)
  http.get(`${B}/settings/imports/upload-policy`, () => { const g = guard(); if (g) return g; const j = policyView(); return HttpResponse.json(j, tag(j.version)); }),
  http.put(`${B}/settings/imports/upload-policy`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, policyView().version); if (p) return p;
    const b = await body<{ policy?: unknown; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = Object.keys(b).filter((k) => !['policy', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_field' }));
    if ((b.reason ?? '').trim().length < 3 || (b.reason ?? '').length > 1000) errs.push({ path: '/reason', code: 'required' });
    if (b.policy !== 'enforce' && b.policy !== 'accept_incomplete') errs.push({ path: '/policy', code: 'invalid' });
    if (errs.length) return fields(...errs);
    if (policyView().policy === b.policy) return problem(409, 'invalid_transition', `The upload policy is already ${String(b.policy)}.`);
    Object.assign(IM(), { upload_policy: b.policy as 'enforce' | 'accept_incomplete', policy_version: (IM().policy_version ?? 1) + 1, policy_updated_at: new Date().toISOString(), policy_updated_by: viewer()!.employee_id! }); save();
    const j = policyView();
    return HttpResponse.json(j, tag(j.version));
  }),

  // ------------------------------------------------------------------ 0.15.203 (P3): the notice of a new template version (Settings, Imports)
  http.get(`${B}/settings/template-change-notice`, () => { const g = guard(); if (g) return g; return HttpResponse.json(tplNoticeView(), tag(TN.version)); }),
  http.put(`${B}/settings/template-change-notice`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, TN.version); if (p) return p;
    const b = await body<{ enabled?: unknown; days?: unknown; reason?: string }>(request);
    const errs: { path: string; code: string }[] = [];
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (typeof b.days !== 'number' || !Number.isInteger(b.days) || b.days < 1 || b.days > 365) errs.push({ path: '/days', code: 'out_of_range' });
    if (typeof b.enabled !== 'boolean') errs.push({ path: '/enabled', code: 'required' });
    if (errs.length) return fields(...errs);
    if (TN.enabled === b.enabled && TN.days === b.days) return problem(409, 'invalid_transition', 'These values are already set.');
    Object.assign(TN, { enabled: b.enabled as boolean, days: b.days as number, version: TN.version + 1, updated_at: new Date().toISOString() });
    return HttpResponse.json(tplNoticeView(), tag(TN.version));
  }),

  // ------------------------------------------------------------------ 0.15.41: Settings, Identity & themes (the organization default UI design)
  http.get(`${B}/settings/identity`, () => { const g = guard(); if (g) return g; const j = identityView(); return HttpResponse.json(j, tag(j.version)); }),
  http.put(`${B}/settings/identity`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ default_brand?: unknown; allow_user_choice?: unknown; defaults?: unknown; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = Object.keys(b).filter((k) => !['default_brand', 'allow_user_choice', 'defaults', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_field' }));
    if (!isBrand(b.default_brand)) errs.push({ path: '/default_brand', code: 'invalid' });
    if (typeof b.allow_user_choice !== 'boolean') errs.push({ path: '/allow_user_choice', code: 'required' });
    if ((b.reason ?? '').trim().length < 3 || (b.reason ?? '').length > 1000) errs.push({ path: '/reason', code: 'required' });
    if (b.defaults !== undefined) {
      const d = b.defaults;
      if (d === null || typeof d !== 'object' || Array.isArray(d)) errs.push({ path: '/defaults', code: 'invalid' });
      else for (const [k, v] of Object.entries(d)) {
        const opts = (APPEARANCE_OPTIONS as Record<string, readonly string[]>)[k];
        if (!opts || typeof v !== 'string' || !opts.includes(v)) { errs.push({ path: '/defaults', code: 'invalid' }); break; }
      }
    }
    if (errs.length) return fields(...errs);
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, identity().version); if (p) return p;
    if (!stepUpValid()) return stepUp();
    const nextDefaults = (b.defaults as Record<string, string> | undefined) ?? identity().defaults;
    if (identity().default_brand === b.default_brand && identity().allow_user_choice === b.allow_user_choice && JSON.stringify(nextDefaults) === JSON.stringify(identity().defaults)) return problem(409, 'invalid_transition', 'These are already the identity settings.');
    const v = viewer()!;
    Object.assign(identity(), { default_brand: b.default_brand, allow_user_choice: b.allow_user_choice, defaults: nextDefaults, version: identity().version + 1, updated_at: new Date().toISOString(),
      updated_by: { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id } }); save();
    const j = identityView();
    return HttpResponse.json(j, tag(j.version));
  }),

  // ------------------------------------------------------------------ 0.15.97: Settings, Screens, Login page (the sign-in page settings); the public door answers only what the page renders
  http.get(`${B}/settings/login-page/public`, () => HttpResponse.json(loginPagePublic(), { headers: { 'Cache-Control': 'public, max-age=30' } })),
  http.get(`${B}/settings/login-page`, () => { const g = guard(); if (g) return g; const j = loginPageView(); return HttpResponse.json(j, tag(j.version)); }),
  http.put(`${B}/settings/login-page`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ announcement_en?: unknown; announcement_ar?: unknown; announcement_kind?: unknown; animation?: unknown; default_locale?: unknown; support_links?: unknown; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = Object.keys(b).filter((k) => !['announcement_en', 'announcement_ar', 'announcement_kind', 'animation', 'default_locale', 'support_links', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_field' }));
    if (typeof b.announcement_en !== 'string' || b.announcement_en.trim().length > 280) errs.push({ path: '/announcement_en', code: 'invalid' });
    if (typeof b.announcement_ar !== 'string' || b.announcement_ar.trim().length > 280) errs.push({ path: '/announcement_ar', code: 'invalid' });
    if (b.announcement_kind !== 'info' && b.announcement_kind !== 'maintenance') errs.push({ path: '/announcement_kind', code: 'invalid' });
    if (typeof b.animation !== 'boolean') errs.push({ path: '/animation', code: 'invalid' });
    if (b.default_locale !== null && b.default_locale !== 'en' && b.default_locale !== 'ar') errs.push({ path: '/default_locale', code: 'invalid' });
    const links = Array.isArray(b.support_links) ? b.support_links : null;
    const linkOk = (l: unknown): l is { label_en: string; label_ar: string; url: string } =>
      !!l && typeof l === 'object' && Object.keys(l as object).every((k) => ['label_en', 'label_ar', 'url'].includes(k)) &&
      typeof (l as { label_en?: unknown }).label_en === 'string' && ((l as { label_en: string }).label_en.trim().length >= 1) && (l as { label_en: string }).label_en.trim().length <= 60 &&
      typeof (l as { label_ar?: unknown }).label_ar === 'string' && (l as { label_ar: string }).label_ar.trim().length <= 60 &&
      typeof (l as { url?: unknown }).url === 'string' && /^(https?:\/\/|mailto:)/i.test((l as { url: string }).url.trim()) && (l as { url: string }).url.trim().length <= 300;
    if (!links || links.length > 5 || !links.every(linkOk)) errs.push({ path: '/support_links', code: 'invalid' });
    if ((b.reason ?? '').trim().length < 3 || (b.reason ?? '').length > 1000) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, loginPage().version); if (p) return p;
    if (!stepUpValid()) return stepUp();
    const nxt = {
      announcement_en: (b.announcement_en as string).trim(), announcement_ar: (b.announcement_ar as string).trim(),
      announcement_kind: b.announcement_kind as 'info' | 'maintenance', animation: b.animation as boolean,
      default_locale: b.default_locale as 'en' | 'ar' | null,
      support_links: (links ?? []).map((l) => ({ label_en: l.label_en.trim(), label_ar: l.label_ar.trim(), url: l.url.trim() })),
    };
    const cur = loginPage();
    if (JSON.stringify(nxt) === JSON.stringify({ announcement_en: cur.announcement_en, announcement_ar: cur.announcement_ar, announcement_kind: cur.announcement_kind, animation: cur.animation, default_locale: cur.default_locale, support_links: cur.support_links }))
      return problem(409, 'invalid_transition', 'These are already the login page settings.');
    const v = viewer()!;
    Object.assign(cur, { ...nxt, version: cur.version + 1, updated_at: new Date().toISOString(),
      updated_by: { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id } }); save();
    const j = loginPageView();
    return HttpResponse.json(j, tag(j.version));
  }),

  // ------------------------------------------------------------------ 0.15.190: admin lock keys (block public sharing, disable export), both off by default
  http.get(`${B}/settings/security-locks`, () => { const g = guard(); if (g) return g; const j = locksView(); return HttpResponse.json(j, tag(j.version)); }),
  http.put(`${B}/settings/security-locks`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ block_public_sharing?: unknown; disable_export?: unknown; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = Object.keys(b).filter((k) => !['block_public_sharing', 'disable_export', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_field' }));
    if (typeof b.block_public_sharing !== 'boolean') errs.push({ path: '/block_public_sharing', code: 'required' });
    if (typeof b.disable_export !== 'boolean') errs.push({ path: '/disable_export', code: 'required' });
    if ((b.reason ?? '').trim().length < 3 || (b.reason ?? '').length > 1000) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, locks.version); if (p) return p;
    if (!stepUpValid()) return stepUp();
    if (locks.block_public_sharing === b.block_public_sharing && locks.disable_export === b.disable_export) return problem(409, 'invalid_transition', 'These are already the lock keys in force.');
    const v = viewer()!;
    Object.assign(locks, { block_public_sharing: b.block_public_sharing, disable_export: b.disable_export, version: locks.version + 1, updated_at: new Date().toISOString(),
      updated_by: { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id } });
    const j = locksView();
    return HttpResponse.json(j, tag(j.version));
  }),

  // ------------------------------------------------------------------ 0.15.193: download lock categories (all off by default)
  http.get(`${B}/settings/download-locks`, () => { const g = guard(); if (g) return g; const j = dlocksView(); return HttpResponse.json(j, tag(j.version)); }),
  http.put(`${B}/settings/download-locks`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const KEYS = ['templates', 'uploaded_files', 'generated_documents'] as const;
    const b = await body<Record<string, unknown> & { reason?: string }>(request);
    const errs: { path: string; code: string }[] = Object.keys(b).filter((k) => ![...KEYS, 'reason'].includes(k as never)).map((k) => ({ path: `/${k}`, code: 'unknown_field' }));
    for (const k of KEYS) if (typeof b[k] !== 'boolean') errs.push({ path: `/${k}`, code: 'required' });
    if ((b.reason ?? '').trim().length < 3 || (b.reason ?? '').length > 1000) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, dlocks.version); if (p) return p;
    if (!stepUpValid()) return stepUp();
    if (KEYS.every((k) => dlocks[k] === b[k])) return problem(409, 'invalid_transition', 'These are already the download locks in force.');
    const v = viewer()!;
    Object.assign(dlocks, { templates: b.templates, uploaded_files: b.uploaded_files, generated_documents: b.generated_documents, version: dlocks.version + 1, updated_at: new Date().toISOString(),
      updated_by: { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id } });
    const j = dlocksView();
    return HttpResponse.json(j, tag(j.version));
  }),

  // ------------------------------------------------------------------ 0.15.192: new-device email code (System Admin only)
  http.get(`${B}/settings/new-device-code`, () => { const g = needAdmin(); if (g) return g; const j = newDeviceView(); return HttpResponse.json(j, tag(j.version)); }),
  http.put(`${B}/settings/new-device-code`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ enabled?: unknown; code_minutes?: unknown; include_admins?: unknown; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = Object.keys(b).filter((k) => !['enabled', 'code_minutes', 'include_admins', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_field' }));
    if (typeof b.enabled !== 'boolean') errs.push({ path: '/enabled', code: 'required' });
    if (typeof b.include_admins !== 'boolean') errs.push({ path: '/include_admins', code: 'required' });
    if (typeof b.code_minutes !== 'number' || !Number.isInteger(b.code_minutes) || b.code_minutes < 5 || b.code_minutes > 30) errs.push({ path: '/code_minutes', code: 'invalid' });
    if ((b.reason ?? '').trim().length < 3 || (b.reason ?? '').length > 1000) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, newDeviceState.version); if (p) return p;
    if (!stepUpValid()) return stepUp();
    if (newDeviceState.enabled === b.enabled && newDeviceState.code_minutes === b.code_minutes && newDeviceState.include_admins === b.include_admins) return problem(409, 'invalid_transition', 'These are already the new-device settings.');
    const v = viewer()!;
    Object.assign(newDeviceState, { enabled: b.enabled, code_minutes: b.code_minutes, include_admins: b.include_admins, version: newDeviceState.version + 1, updated_at: new Date().toISOString(),
      updated_by: { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id } });
    const j = newDeviceView();
    return HttpResponse.json(j, tag(j.version));
  }),
  // ------------------------------------------------------------------ 0.15.194: passkeys (setting: System Admin only; own passkeys: any signed-in person with two-step on)
  http.get(`${B}/settings/passkeys`, () => { const g = needAdmin(); if (g) return g; const j = passkeyView(); return HttpResponse.json(j, tag(j.version)); }),
  http.put(`${B}/settings/passkeys`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ enabled?: unknown; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = Object.keys(b).filter((k) => !['enabled', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_field' }));
    if (typeof b.enabled !== 'boolean') errs.push({ path: '/enabled', code: 'required' });
    if ((b.reason ?? '').trim().length < 3 || (b.reason ?? '').length > 1000) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, passkeyState.version); if (p) return p;
    if (!stepUpValid()) return stepUp();
    if (b.enabled && !passkeyState.ready) return problem(409, 'invalid_transition', 'The workspace web address is not set.');
    if (passkeyState.enabled === b.enabled) return problem(409, 'invalid_transition', 'This is already the passkey setting.');
    const v = viewer()!;
    Object.assign(passkeyState, { enabled: b.enabled, version: passkeyState.version + 1, updated_at: new Date().toISOString(), updated_by: { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id } });
    const j = passkeyView();
    return HttpResponse.json(j, tag(j.version));
  }),
  http.get(`${B}/me/passkeys`, () => {
    const g = guard(); if (g) return g;
    const k = db().session!.account;
    return HttpResponse.json({ enabled: passkeyState.enabled, ready: passkeyState.ready, can_add: !!cred(k)?.tf?.on, items: (passkeyState.items[k] ?? []).map(passkeyDto) });
  }),
  http.post(`${B}/me/passkeys/register/options`, () => {
    const g = guard(); if (g) return g;
    const k = db().session!.account;
    if (!passkeyState.enabled || !passkeyState.ready) return problem(409, 'invalid_transition', 'Passkeys are not turned on.');
    if (!cred(k)?.tf?.on) return problem(409, 'invalid_transition', 'Turn on two-step verification first.');
    if (!stepUpValid()) return stepUp();
    return HttpResponse.json({ challenge: 'AAAA', rp: { id: 'localhost', name: 'GSDN' }, user: { id: 'AAAA', name: 'user', displayName: 'user' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], excludeCredentials: [] });
  }),
  http.post(`${B}/me/passkeys/register/verify`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const k = db().session!.account;
    const b = await body<{ label?: string; response?: { id?: string } }>(request);
    if (!stepUpValid()) return stepUp();
    if (typeof b.label !== 'string' || !b.label.trim() || typeof b.response?.id !== 'string') return fields({ path: '/label', code: 'required' });
    const row: MockPasskey = { id: uid(`pk${Date.now()}`), credential_id: b.response.id, label: b.label.trim(), created_at: new Date().toISOString(), last_used_at: null, device_type: 'multiDevice', backed_up: true };
    (passkeyState.items[k] ??= []).push(row);
    return HttpResponse.json(passkeyDto(row));
  }),
  http.delete(`${B}/me/passkeys/:id`, ({ params }) => {
    const g = guard(); if (g) return g;
    const list = passkeyState.items[db().session!.account] ?? [];
    const i = list.findIndex((x) => x.id === params.id);
    if (i < 0) return problem(404, 'not_found', 'Not found');
    list.splice(i, 1);
    return new HttpResponse(null, { status: 204 });
  }),
  http.post(`${B}/users/:id/passkeys/revoke`, async ({ request, params }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ reason?: string }>(request);
    if ((b.reason ?? '').trim().length < 3) return fields({ path: '/reason', code: 'required' });
    if (!stepUpValid()) return stepUp();
    const u = db().admin.users.find((x) => (x.local ? x.local.id : uid(x.employee_id)) === params.id);
    if (!u) return problem(404, 'not_found', 'Not found');
    const key = accountKeyOf(u);
    const n = (passkeyState.items[key] ?? []).length;
    delete passkeyState.items[key];
    return HttpResponse.json({ revoked: n });
  }),
  http.post(`${B}/settings/new-device-code/bypass`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ user_id?: unknown; minutes?: unknown; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = [];
    if (typeof b.user_id !== 'string' || b.user_id.length < 8) errs.push({ path: '/user_id', code: 'invalid' });
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    if (!stepUpValid()) return stepUp();
    const mins = typeof b.minutes === 'number' ? b.minutes : 30;
    return HttpResponse.json({ until: new Date(Date.now() + mins * 60_000).toISOString() });
  }),
  // ------------------------------------------------------------------ 0.15.191: support access (System Admin only)
  http.get(`${B}/settings/support-access`, () => { const g = needAdmin(); if (g) return g; const j = supportView(); return HttpResponse.json(j, tag(j.version)); }),
  http.put(`${B}/settings/support-access`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ enabled?: unknown; max_hours?: unknown; default_hours?: unknown; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = Object.keys(b).filter((k) => !['enabled', 'max_hours', 'default_hours', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_field' }));
    if (typeof b.enabled !== 'boolean') errs.push({ path: '/enabled', code: 'required' });
    const okH = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 168;
    if (!okH(b.max_hours)) errs.push({ path: '/max_hours', code: 'invalid' });
    if (!okH(b.default_hours) || (okH(b.max_hours) && b.default_hours > b.max_hours)) errs.push({ path: '/default_hours', code: 'invalid' });
    if ((b.reason ?? '').trim().length < 3 || (b.reason ?? '').length > 1000) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, support.version); if (p) return p;
    if (!stepUpValid()) return stepUp();
    if (support.enabled === b.enabled && support.max_hours === b.max_hours && support.default_hours === b.default_hours) return problem(409, 'invalid_transition', 'These are already the support access settings.');
    const v = viewer()!;
    Object.assign(support, { enabled: b.enabled, max_hours: b.max_hours, default_hours: b.default_hours, version: support.version + 1, updated_at: new Date().toISOString(),
      updated_by: { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id } });
    const j = supportView();
    return HttpResponse.json(j, tag(j.version));
  }),
  http.get(`${B}/support-access`, () => { const g = needAdmin(); if (g) return g; return HttpResponse.json({ items: [...supportGrants].reverse().map(supportDto) }); }),
  http.post(`${B}/support-access`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ to_user_id?: unknown; rights?: unknown; hours?: unknown; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = Object.keys(b).filter((k) => !['to_user_id', 'rights', 'hours', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_field' }));
    if (typeof b.to_user_id !== 'string' || b.to_user_id.length < 8) errs.push({ path: '/to_user_id', code: 'invalid' });
    if (!Array.isArray(b.rights) || b.rights.length === 0 || !b.rights.every((r) => SUPPORT_RIGHTS.includes(r as string))) errs.push({ path: '/rights', code: 'not_allowed' });
    const hours = b.hours === undefined ? support.default_hours : b.hours;
    if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > support.max_hours) errs.push({ path: '/hours', code: 'invalid' });
    if ((b.reason ?? '').trim().length < 3 || (b.reason ?? '').length > 900) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    if (!stepUpValid()) return stepUp();
    if (!support.enabled) return problem(409, 'invalid_transition', 'Support access is switched off.');
    const v = viewer()!;
    const me = { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id };
    const now = new Date();
    const row: SupportGrant = { id: `sg-${supportGrants.length + 1}-${now.getTime()}`, to: { id: b.to_user_id as string, display_name: 'Support user', employee_id: null }, from: me, rights: b.rights as string[],
      valid_from: now.toISOString(), valid_to: new Date(now.getTime() + (hours as number) * 3_600_000).toISOString(), revoked: false, revoked_at: null, reason: `[support-access] ${(b.reason as string).trim()}` };
    supportGrants.push(row);
    return HttpResponse.json(supportDto(row), { status: 201 });
  }),
  http.post(`${B}/support-access/revoke-all`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ reason?: string } & Record<string, unknown>>(request);
    if ((b.reason ?? '').trim().length < 3) return fields({ path: '/reason', code: 'required' });
    if (!stepUpValid()) return stepUp();
    let n = 0;
    for (const r of supportGrants) if (!r.revoked && new Date(r.valid_to) > new Date()) { r.revoked = true; r.revoked_at = new Date().toISOString(); n += 1; }
    return HttpResponse.json({ revoked: n });
  }),
  http.post(`${B}/support-access/:id/revoke`, async ({ request, params }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ reason?: string } & Record<string, unknown>>(request);
    if ((b.reason ?? '').trim().length < 3) return fields({ path: '/reason', code: 'required' });
    if (!stepUpValid()) return stepUp();
    const r = supportGrants.find((x) => x.id === params.id);
    if (!r) return problem(404, 'not_found', 'No such support grant');
    if (r.revoked) return problem(409, 'invalid_transition', 'The support grant is already revoked.');
    r.revoked = true; r.revoked_at = new Date().toISOString();
    return HttpResponse.json(supportDto(r));
  }),

  // ------------------------------------------------------------------ 0.15.232 (0243): the workspace logo of the identity
  http.put(`${B}/settings/identity/logo`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const f = await request.formData();
    const file = f.get('file') as { type?: string; size?: number; arrayBuffer?: () => Promise<ArrayBuffer> } | null;
    const reason = String(f.get('reason') ?? '');
    const errs: { path: string; code: string }[] = [];
    const okMime = (m: string) => ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'].includes(m);
    // duck-typed: the multipart parser's File is not always the window File
    if (!file || typeof file.arrayBuffer !== 'function' || !file.size) errs.push({ path: '/file', code: 'required' });
    else if (!okMime(String(file.type)) || file.size > 262144) errs.push({ path: '/file', code: 'invalid' });
    if (reason.trim().length < 3 || reason.length > 1000) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    if (identity().logo && !request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, identity().logo?.version ?? -1); if (p) return p;
    if (!stepUpValid()) return stepUp();
    const v = viewer()!;
    const bytes = new Uint8Array(await file!.arrayBuffer!());
    putUiAssetBytes('logo', String(file!.type), bytes);
    identity().logo = { key: 'logo', mime: String(file!.type), enabled: true, show_on_login: identity().logo?.show_on_login ?? false, use_as_favicon: identity().logo?.use_as_favicon ?? false, version: (identity().logo?.version ?? 0) + 1, updated_at: new Date().toISOString(),
      updated_by: { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id } };
    save();
    return HttpResponse.json(identity().logo, tag(identity().logo!.version));
  }),
  http.patch(`${B}/settings/identity/logo`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ enabled?: unknown; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = Object.keys(b).filter((k) => !['enabled', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_field' }));
    if (typeof b.enabled !== 'boolean') errs.push({ path: '/enabled', code: 'required' });
    if ((b.reason ?? '').trim().length < 3 || (b.reason ?? '').length > 1000) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    if (!identity().logo) return fields({ path: '/key', code: 'not_found' });
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, identity().logo!.version); if (p) return p;
    if (!stepUpValid()) return stepUp();
    if (identity().logo!.enabled === b.enabled) return problem(409, 'invalid_transition', 'The logo is already in this state.');
    identity().logo!.enabled = b.enabled as boolean; identity().logo!.version += 1; identity().logo!.updated_at = new Date().toISOString();
    save();
    return HttpResponse.json(identity().logo, tag(identity().logo!.version));
  }),
  http.patch(`${B}/settings/identity/logo/display`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ show_on_login?: unknown; use_as_favicon?: unknown; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = Object.keys(b).filter((k) => !['show_on_login', 'use_as_favicon', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_field' }));
    if (typeof b.show_on_login !== 'boolean') errs.push({ path: '/show_on_login', code: 'required' });
    if (typeof b.use_as_favicon !== 'boolean') errs.push({ path: '/use_as_favicon', code: 'required' });
    if ((b.reason ?? '').trim().length < 3 || (b.reason ?? '').length > 1000) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    if (!identity().logo) return fields({ path: '/key', code: 'not_found' });
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, identity().logo!.version); if (p) return p;
    if (!stepUpValid()) return stepUp();
    const l = identity().logo!;
    if (l.show_on_login === b.show_on_login && l.use_as_favicon === b.use_as_favicon) return problem(409, 'invalid_transition', 'The logo is already shown this way.');
    l.show_on_login = b.show_on_login as boolean; l.use_as_favicon = b.use_as_favicon as boolean; l.version += 1; l.updated_at = new Date().toISOString();
    save();
    return HttpResponse.json(l, tag(l.version));
  }),
  // Public reads (no session): only for an enabled logo whose purpose an admin switched on (both off by default).
  http.get(`${B}/ui/public/identity`, () => {
    const l = identity().logo;
    const on = (k: 'show_on_login' | 'use_as_favicon') => (l && l.enabled && l[k] ? { version: l.version, mime: l.mime } : null);
    return HttpResponse.json({ login: on('show_on_login'), favicon: on('use_as_favicon') }, { headers: { 'Cache-Control': 'public, max-age=30' } });
  }),
  http.get(`${B}/ui/public/logo/:purpose`, ({ params }) => {
    const l = identity().logo; const a = uiAssetBytesOf('logo');
    const k = params.purpose === 'login' ? 'show_on_login' : params.purpose === 'favicon' ? 'use_as_favicon' : null;
    if (!a || !l || !k || !l.enabled || !l[k]) return problem(404, 'not_found', 'The resource does not exist or is not visible to you.');
    return new HttpResponse(a.bytes, { headers: { 'Content-Type': a.mime, ETag: `"${l.version}"` } });
  }),
  http.get(`${B}/ui/assets/:key`, ({ params }) => {
    const g = guard(); if (g) return g;
    const key = String(params.key);
    const meta = identity().logo;
    const a = uiAssetBytesOf(key);
    if (!a || !meta || meta.key !== key || !meta.enabled) return problem(404, 'not_found', 'The resource does not exist or is not visible to you.');
    return new HttpResponse(a.bytes, { headers: { 'Content-Type': a.mime, ETag: `"${meta.version}"` } });
  }),

  // ------------------------------------------------------------------ 0.15.312: operational limits
  http.get(`${B}/settings/ops-limits`, () => { const g = guard(); if (g) return g; const j = opsView(); return HttpResponse.json(j, tag(j.version)); }),
  http.put(`${B}/settings/ops-limits`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ values?: Record<string, unknown>; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = Object.keys(b).filter((k) => !['values', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_field' }));
    if (!b.values || typeof b.values !== 'object') errs.push({ path: '/values', code: 'required' });
    if ((b.reason ?? '').trim().length < 3 || (b.reason ?? '').length > 1000) errs.push({ path: '/reason', code: 'required' });
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(b.values ?? {})) {
      const c = OPS_CATALOGUE.find((x) => x.key === k);
      if (!c) errs.push({ path: `/values/${k}`, code: 'unknown' });
      else if (typeof v !== 'number' || !Number.isInteger(v)) errs.push({ path: `/values/${k}`, code: 'invalid' });
      else if (v < c.min || v > c.max) errs.push({ path: `/values/${k}`, code: 'out_of_range' });
      else clean[k] = v;
    }
    if ((clean['session.absolute_hours'] ?? 12) < (clean['session.idle_hours'] ?? 8)) errs.push({ path: '/values/session.absolute_hours', code: 'invalid' });
    if (errs.length) return fields(...errs);
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, opsLimits.version); if (p) return p;
    if (!stepUpValid()) return stepUp();
    if (JSON.stringify(Object.entries(clean).sort()) === JSON.stringify(Object.entries(opsLimits.stored).sort())) return problem(409, 'invalid_transition', 'These are already the limits in force.');
    const v = viewer()!;
    Object.assign(opsLimits, { stored: clean, version: opsLimits.version + 1, updated_at: new Date().toISOString(), updated_by: { id: uid(v.employee_id ?? '9999'), display_name: v.name, employee_id: v.employee_id } });
    const j = opsView();
    return HttpResponse.json(j, tag(j.version));
  }),

  // ------------------------------------------------------------------ 0.15.1: the shared layout of the side menu
  http.get(`${B}/settings/nav-layout`, () => { const g = guard(); if (g) return g; const j = navView(); return HttpResponse.json(j, tag(j.version)); }),
  http.put(`${B}/settings/nav-layout`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, NL().version); if (p) return p;
    const b = await body<{ layout?: unknown; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = Object.keys(b).filter((k) => !['layout', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_field' }));
    if ((b.reason ?? '').trim().length < 3 || (b.reason ?? '').length > 1000) errs.push({ path: '/reason', code: 'required' });
    if (!('layout' in b)) errs.push({ path: '/layout', code: 'required' });
    const clean = b.layout === null ? { layout: null, errors: [] } : cleanNavLayout(b.layout);
    errs.push(...clean.errors);
    if (errs.length) return fields(...errs);
    const cur = NL().layout ?? null;
    if (JSON.stringify(cur) === JSON.stringify(clean.layout)) return problem(409, 'invalid_transition', clean.layout === null ? 'The menu already follows the default layout.' : 'This is already the layout of the menu.');
    Object.assign(NL(), { layout: clean.layout, version: NL().version + 1, updated_at: new Date().toISOString(), updated_by: viewer()!.employee_id! }); save();
    const j = navView();
    return HttpResponse.json(j, tag(j.version));
  }),

  // ------------------------------------------------------------------ 0.14.2 (Q441): the mail notification kinds (System Admin only)
  http.get(`${B}/settings/mail-notification-kinds`, () => {
    const g = needAdmin(); if (g) return g;
    const m = MK();
    return HttpResponse.json({ kinds: [...m.kinds, ...m.unknown], unknown_kinds: m.unknown, catalogue: MAIL_KIND_CATALOGUE, version: m.version, updated_at: m.updated_at, updated_by: m.updated_by ? ref(m.updated_by) : null }, tag(m.version));
  }),
  http.put(`${B}/settings/mail-notification-kinds`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, MK().version); if (p) return p;
    const b = await body<{ kinds?: unknown; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = Object.keys(b).filter((k) => !['kinds', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_field' }));
    if ((b.reason ?? '').trim().length < 3 || (b.reason ?? '').length > 1000) errs.push({ path: '/reason', code: 'required' });
    if (!Array.isArray(b.kinds)) errs.push({ path: '/kinds', code: 'invalid' });
    else if (b.kinds.length > 100) errs.push({ path: '/kinds', code: 'too_many' });
    else (b.kinds as unknown[]).forEach((k, i) => {
      if (typeof k !== 'string' || !/^[a-z][a-z0-9_]{1,59}$/.test(k)) errs.push({ path: `/kinds/${i}`, code: 'invalid' });
      else if (/^(security_|integrity_|audit_integrity|break_glass|retention_)/.test(k)) errs.push({ path: `/kinds/${i}`, code: 'reserved_kind' });
      else if (!MAIL_KIND_CATALOGUE.some((c) => c.kind === k)) errs.push({ path: `/kinds/${i}`, code: 'unknown_kind' });
      else if ((b.kinds as unknown[]).indexOf(k) !== i) errs.push({ path: `/kinds/${i}`, code: 'duplicate' });
    });
    if (errs.length) return fields(...errs);
    Object.assign(MK(), { kinds: [...(b.kinds as string[])].sort(), unknown: [], version: MK().version + 1, updated_at: new Date().toISOString(), updated_by: viewer()!.employee_id! }); save();
    const m = MK();
    return HttpResponse.json({ kinds: m.kinds, unknown_kinds: [], catalogue: MAIL_KIND_CATALOGUE, version: m.version, updated_at: m.updated_at, updated_by: ref(m.updated_by!) }, tag(m.version));
  }),

  // ------------------------------------------------------------------ 0.15.261: the mail policy (System Admin only)
  http.get(`${B}/settings/mail-policy`, () => {
    const g = needAdmin(); if (g) return g;
    const m = MP();
    return HttpResponse.json({ ...m, catalogue: MAIL_KIND_CATALOGUE, block_public_sharing: false, updated_by: m.updated_by ? ref(m.updated_by) : null }, tag(m.version));
  }),
  http.put(`${B}/settings/mail-policy`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, MP().version); if (p) return p;
    const b = await body<{ reason?: string; enabled?: boolean; mode?: string; internal_domains?: string[]; kinds?: Record<string, { enabled: boolean; mode: string }> }>(request);
    const errs: { path: string; code: string }[] = [];
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (typeof b.enabled !== 'boolean') errs.push({ path: '/enabled', code: 'required' });
    if (b.mode !== 'internal_only' && b.mode !== 'internal_external') errs.push({ path: '/mode', code: 'invalid' });
    (b.internal_domains ?? []).forEach((d, i) => { if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) errs.push({ path: `/internal_domains/${i}`, code: 'invalid' }); });
    Object.keys(b.kinds ?? {}).forEach((k) => { if (!MAIL_KIND_CATALOGUE.some((c) => c.kind === k)) errs.push({ path: `/kinds/${k}`, code: 'unknown_kind' }); });
    if (errs.length) return fields(...errs);
    Object.assign(MP(), { enabled: b.enabled!, mode: b.mode!, internal_domains: b.internal_domains ?? [], kinds: b.kinds ?? {}, version: MP().version + 1, updated_at: new Date().toISOString(), updated_by: viewer()!.employee_id! }); save();
    const m = MP();
    return HttpResponse.json({ ...m, catalogue: MAIL_KIND_CATALOGUE, block_public_sharing: false, updated_by: ref(m.updated_by!) }, tag(m.version));
  }),

  // ------------------------------------------------------------------ SLA rule sets (0.2.6)
  http.get(`${B}/settings/sla-rules`, () => {
    const g = guard(); if (g) return g;
    const act = C().slaSets.find((x) => x.is_active)!;
    return page(act.rules.map((r, i) => ({ id: `99100000-0000-4000-8000-0000000000${10 + i}`, ...r, effective_from: act.effective_from!, reason: act.reason, open_task_count: OPEN_TASKS[r.task_code] ?? 0, set_version: act.version })));
  }),
  http.get(`${B}/workflow/versions`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ items: [{ version: 1, status: 'published', is_current: true, light_revision: 1, parent_version: null, site_count: 150 }] }); }),
  http.get(`${B}/workflow/versions/:v`, ({ params }) => {
    const g = guard(); if (g) return g;
    if (params.v !== '1') return problem(404, 'not_found', 'Version not found');
    return HttpResponse.json({ version: 1, status: 'published', is_current: true, light_revision: 1, milestones: MILESTONES, gates: GATES, placements: TASK_DEFS.map((t) => ({ task_code: t.code, stage_code: t.stage_code, sort_order: t.sort_order })) });
  }),
  http.get(`${B}/settings/task-definitions`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ items: TASK_DEFS }); }),
  http.get(`${B}/issues/stopped-rows`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ items: [], counts: { total: 0, not_classified: 0 } }); }),
  http.get(`${B}/settings/issue-task-map`, () => {
    const g = needAdmin(); if (g) return g;
    const items = TASK_DEFS.map((t, i) => ({ task_code: t.code, name_en: t.name_en, name_ar: null, stage_code: 'MS1', stage_seq: 1 + Math.floor(i / 5), category: 'Other', blocker_reason: null, is_active: true, not_classified: false }));
    return HttpResponse.json({ items, counts: { total: items.length, not_classified: 0 } });
  }),
  http.put(`${B}/settings/issue-task-map/:task_code`, async ({ request, params }) => {
    const g = needAdmin(); if (g) return g;
    const b = (await request.json()) as { category: string; reason?: string | null; is_active?: boolean };
    return HttpResponse.json({ task_code: String(params.task_code), category: b.category, reason: b.reason ?? null, is_active: b.is_active ?? true });
  }),
  http.get(`${B}/settings/sla-rule-sets`, ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const st = new URL(request.url).searchParams.get('status');
    return page(C().slaSets.filter((x) => !st || x.status === st).sort((a, b) => b.version - a.version).map(slaSummary));
  }),
  http.post(`${B}/settings/sla-rule-sets`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ reason?: string }>(request);
    const unk = Object.keys(b).filter((k) => k !== 'reason').map((k) => ({ path: `/${k}`, code: 'unknown_key' }));
    if (unk.length) return fields(...unk);
    const r = reasonErr(b.reason); if (r) return r;
    if (C().slaSets.some((x) => x.status === 'draft')) return problem(409, 'duplicate', 'A draft already exists', { errors: [{ path: '/', code: 'duplicate' }] });
    const base = C().slaSets.find((x) => x.is_active)!;
    const d: SlaSetRec = { ...base, id: crypto.randomUUID(), version: Math.max(...C().slaSets.map((x) => x.version)) + 1, status: 'draft', is_active: false, effective_from: null, effective_to: null, base_version: base.version, reason: b.reason!.trim(), created_by: me(), created_at: new Date().toISOString(), published_by: null, published_at: null, apply_to_open_tasks: null, affected_open_tasks: null, rules: structuredClone(base.rules), _rev: 1 };
    C().slaSets.push(d); save();
    return HttpResponse.json(slaOut(d), { status: 201, ...tag(d._rev) });
  }),
  http.get(`${B}/settings/sla-rule-sets/:id`, ({ params }) => {
    const g = needAdmin(); if (g) return g;
    const x = C().slaSets.find((s) => s.id === params.id); if (!x) return problem(404, 'not_found', 'Rule set not found');
    return HttpResponse.json(slaOut(x), tag(x._rev));
  }),
  http.patch(`${B}/settings/sla-rule-sets/:id`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const x = C().slaSets.find((s) => s.id === params.id); if (!x) return problem(404, 'not_found', 'Rule set not found');
    if (x.status !== 'draft') return problem(409, 'invalid_transition', 'Only a draft can be changed');
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, x._rev); if (p) return p;
    const b = await body<{ reason?: string; rules?: SlaTaskRule[] } & Record<string, unknown>>(request);
    const unk = Object.keys(b).filter((k) => !['reason', 'rules'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_key' }));
    if (unk.length) return fields(...unk);
    const r = reasonErr(b.reason); if (r) return r;
    if (!Array.isArray(b.rules) || !b.rules.length) return fields({ path: '/rules', code: 'required' });
    const errs = validateSlaRules(b.rules); if (errs.length) return fields(...errs);
    for (const nr of b.rules) { const i = x.rules.findIndex((o) => o.task_code === nr.task_code); if (i < 0) x.rules.push(nr); else x.rules[i] = nr; }
    Object.assign(x, { reason: b.reason!.trim(), rule_count: x.rules.length, _rev: x._rev + 1 }); save();
    return HttpResponse.json(slaOut(x), tag(x._rev));
  }),
  http.post(`${B}/settings/sla-rule-sets/:id/preview`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const x = C().slaSets.find((s) => s.id === params.id); if (!x) return problem(404, 'not_found', 'Rule set not found');
    if (x.status !== 'draft') return problem(409, 'invalid_transition', 'Only a draft can be previewed');
    const b = await body<{ effective_date?: string }>(request);
    const e = dateErrs(b.effective_date, 'sla'); if (e.length) return fields(...e);
    return HttpResponse.json(slaPreview(x, b.effective_date!));
  }),
  http.post(`${B}/settings/sla-rule-sets/:id/publish`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const x = C().slaSets.find((s) => s.id === params.id); if (!x) return problem(404, 'not_found', 'Rule set not found');
    if (x.status !== 'draft') return problem(409, 'invalid_transition', 'Only a draft can be published');
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, x._rev); if (p) return p;
    if (!stepUpValid()) return stepUp();
    const b = await body<{ effective_date?: string; reason?: string; apply_to_open_tasks?: unknown } & Record<string, unknown>>(request);
    const unk = Object.keys(b).filter((k) => !['effective_date', 'reason', 'apply_to_open_tasks'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_key' }));
    const errs = [...unk, ...((b.reason ?? '').trim().length < 3 ? [{ path: '/reason', code: 'required' }] : []), ...dateErrs(b.effective_date, 'sla'), ...validateSlaRules(x.rules.map((r, i) => ({ ...r, __i: i })))];
    if (b.apply_to_open_tasks !== undefined && typeof b.apply_to_open_tasks !== 'boolean') errs.push({ path: '/apply_to_open_tasks', code: 'invalid' });
    if (!errs.length && JSON.stringify(canon(x.rules)) === JSON.stringify(canon(C().slaSets.find((s) => s.is_active)!.rules))) errs.push({ path: '/', code: 'no_changes' });
    if (errs.length) return fields(...errs);
    // A regional delegate may re-point open tasks only in their own regions; the mock treats any delegate as regional.
    if (b.apply_to_open_tasks && C().actingDelegate) return problem(403, 'action_forbidden', 'A regional delegate can apply a rule only to open tasks in their regions');
    const apply = b.apply_to_open_tasks === true, n = apply ? slaPreview(x, b.effective_date!).changed_due_date_count : 0;
    const today = tripoliToday(), prev = C().slaSets.find((s) => s.is_active)!;
    prev.effective_to = b.effective_date!;
    if (b.effective_date! <= today) { prev.is_active = false; x.is_active = true; }
    Object.assign(x, { status: 'published', effective_from: b.effective_date!, reason: b.reason!.trim(), published_by: me(), published_at: new Date().toISOString(), apply_to_open_tasks: apply, affected_open_tasks: n, _rev: x._rev + 1 }); save();
    return HttpResponse.json({ rule_set: slaSummary(x), affected_open_tasks: n, recalculation_job_id: n ? `job-${crypto.randomUUID().slice(0, 8)}` : null });
  }),

  // ------------------------------------------------------------------ weight sets (0.2.6)
  http.get(`${B}/settings/weight-sets`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams, code = u.get('code'), st = u.get('status');
    return HttpResponse.json({ items: C().weightSets.filter((w) => (!code || w.code === code) && (!st || w.status === st)).sort((a, b) => a.code.localeCompare(b.code) || b.version - a.version).map(wOut) });
  }),
  http.post(`${B}/settings/weight-sets`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<{ code?: string; base_set_id?: string; reason?: string } & Record<string, unknown>>(request);
    const errs = [...Object.keys(b).filter((k) => !['code', 'base_set_id', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_key' })), ...(['project_status', 'health_index', 'delay_attribution'].includes(b.code ?? '') ? [] : [{ path: '/code', code: 'required' }]), ...((b.reason ?? '').trim().length < 3 ? [{ path: '/reason', code: 'required' }] : [])];
    if (errs.length) return fields(...errs);
    if (C().weightSets.some((w) => w.code === b.code && w.status === 'draft')) return problem(409, 'duplicate', 'A draft of this set already exists', { errors: [{ path: '/code', code: 'duplicate' }] });
    const base = b.base_set_id ? C().weightSets.find((w) => w.id === b.base_set_id) : C().weightSets.find((w) => w.code === b.code && w.is_active);
    if (!base) return problem(404, 'not_found', 'No set to copy');
    if (base.code !== b.code) return fields({ path: '/base_set_id', code: 'invalid' });
    const d: WeightRec = { ...structuredClone(base), id: crypto.randomUUID(), version: Math.max(...C().weightSets.filter((w) => w.code === b.code).map((w) => w.version)) + 1, status: 'draft', is_active: false, effective_from: tripoliToday(), effective_to: null, reason: b.reason!.trim(), changed_by: me(), created_at: new Date().toISOString(), published_at: null, _rev: 1 };
    C().weightSets.push(d); save();
    return HttpResponse.json(wOut(d), { status: 201, ...tag(d._rev) });
  }),
  http.get(`${B}/settings/weight-sets/:id`, ({ params }) => {
    const g = needAdmin(); if (g) return g;
    const x = C().weightSets.find((w) => w.id === params.id); if (!x) return problem(404, 'not_found', 'Weight set not found');
    return HttpResponse.json(wOut(x), tag(x._rev));
  }),
  http.put(`${B}/settings/weight-sets/:id`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const x = C().weightSets.find((w) => w.id === params.id); if (!x) return problem(404, 'not_found', 'Weight set not found');
    if (x.status !== 'draft') return problem(409, 'invalid_transition', 'Only a draft can be changed');
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, x._rev); if (p) return p;
    const b = await body<WeightInput>(request);
    const errs = validateWeightInput(b); if (errs.length) return fields(...errs);
    // A draft may be saved while the totals are not 100; the preview reports it and the publish refuses it.
    x.activities = b.activities.map((a) => ({ code: a.code, name_en: a.name_en, name_ar: a.name_ar ?? null, weight: a.weight, items: (a.items ?? []).map((i) => ({ code: i.code, name_en: i.name_en, name_ar: i.name_ar ?? null, weight: i.weight, unit: i.unit ?? null, measure_rule: i.measure_rule ?? null, source: i.source ?? null })) }));
    Object.assign(x, { reason: b.reason.trim(), changed_by: me(), _rev: x._rev + 1 }); save();
    return HttpResponse.json(wOut(x), tag(x._rev));
  }),
  http.post(`${B}/settings/weight-sets/:id/preview`, ({ params }) => {
    const g = needAdmin(); if (g) return g;
    const x = C().weightSets.find((w) => w.id === params.id); if (!x) return problem(404, 'not_found', 'Weight set not found');
    if (x.status !== 'draft') return problem(409, 'invalid_transition', 'Only a draft can be previewed');
    const errors = weightErrors(x), cur = C().weightSets.find((w) => w.code === x.code && w.is_active);
    const prog = x.code === 'project_status';
    return HttpResponse.json({
      valid: !errors.length, errors, progress_current_pct: prog && cur ? progress(cur) : null, progress_new_pct: prog && !errors.length ? progress(x) : null,
      ...(prog && cur ? { activities: x.activities.map((a) => ({ code: a.code, current_pct: contrib(cur.activities.find((c) => c.code === a.code)), new_pct: errors.length ? null : contrib(a) })) } : {}),
    });
  }),
  http.post(`${B}/settings/weight-sets/:id/publish`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const x = C().weightSets.find((w) => w.id === params.id); if (!x) return problem(404, 'not_found', 'Weight set not found');
    if (x.status !== 'draft') return problem(409, 'invalid_transition', 'Only a draft can be published');
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const p = ver(request, x._rev); if (p) return p;
    if (!stepUpValid()) return stepUp();
    const b = await body<{ effective_date?: string; reason?: string } & Record<string, unknown>>(request);
    const prev = C().weightSets.find((w) => w.code === x.code && w.is_active);
    const errs = [...Object.keys(b).filter((k) => !['effective_date', 'reason'].includes(k)).map((k) => ({ path: `/${k}`, code: 'unknown_key' })), ...((b.reason ?? '').trim().length < 3 ? [{ path: '/reason', code: 'required' }] : []),
      ...dateErrs(b.effective_date, 'weights', x.code), ...weightErrors(x).map(({ path, code, message }) => ({ path, code, message }))] as { path: string; code: string; message?: string }[];
    if (!errs.length && prev && JSON.stringify(wCanon(prev)) === JSON.stringify(wCanon(x))) errs.push({ path: '/', code: 'no_changes' });
    if (errs.length) return fields(...errs);
    const today = tripoliToday();
    if (prev) { prev.effective_to = b.effective_date!; if (b.effective_date! <= today) prev.is_active = false; }
    Object.assign(x, { status: 'published', is_active: b.effective_date! <= today, effective_from: b.effective_date!, reason: b.reason!.trim(), changed_by: me(), published_at: new Date().toISOString(), _rev: x._rev + 1 }); save();
    return HttpResponse.json({ weight_set: wOut(x), previous_set_id: prev?.id ?? null, recalculation_job_id: x.code === 'project_status' ? `job-${crypto.randomUUID().slice(0, 8)}` : null });
  }),

  // ------------------------------------------------------------------ freeze
  http.get(`${B}/settings/structural-freeze`, () => { const g = guard(); if (g) return g; return HttpResponse.json(C().freeze, tag(C().freeze.version)); }),
  http.put(`${B}/settings/structural-freeze`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const f = C().freeze, p = ver(request, f.version); if (p) return p;
    if (!stepUpValid()) return stepUp();
    const b = await body<{ starts_on?: string; ends_on?: string; reason?: string }>(request);
    const r = reasonErr(b.reason); if (r) return r;
    if (!b.starts_on) return fields({ path: '/starts_on', code: 'required' });
    if (!b.ends_on || b.ends_on < b.starts_on) return fields({ path: '/ends_on', code: 'before_start' });
    Object.assign(f, { active: true, starts_on: b.starts_on, ends_on: b.ends_on, lifted: false, lifted_at: null, lifted_by: null, lift_reason: null, version: f.version + 1 }); save();
    return HttpResponse.json(f, tag(f.version));
  }),
  http.post(`${B}/settings/structural-freeze/lift`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    const f = C().freeze, p = ver(request, f.version); if (p) return p;
    if (!stepUpValid()) return stepUp();
    const b = await body<{ reason?: string; confirm_text?: string }>(request);
    const r = reasonErr(b.reason); if (r) return r;
    if (b.confirm_text === undefined) return fields({ path: '/confirm_text', code: 'required' });
    if (b.confirm_text !== 'structural-freeze') return problem(422, 'confirmation_mismatch', 'The typed confirmation does not match', { errors: [{ path: '/confirm_text', code: 'confirmation_mismatch' }] });
    if (f.lifted) return problem(409, 'invalid_transition', 'Already lifted');
    Object.assign(f, { active: false, lifted: true, lifted_at: new Date().toISOString(), lifted_by: me(), lift_reason: b.reason!.trim(), version: f.version + 1 }); save();
    return HttpResponse.json(f, tag(f.version));
  }),

  // ------------------------------------------------------------------ DLP and idle days
  http.get(`${B}/settings/dlp`, () => { const g = guard(); if (g) return g; return HttpResponse.json(C().dlp); }),
  http.post(`${B}/settings/dlp/versions`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const b = await body<{ cw_months?: number; te_months?: number; effective_from?: string; reason?: string }>(request);
    const errs: { path: string; code: string }[] = [];
    if (!int(b.cw_months, 0, 120)) errs.push({ path: '/cw_months', code: 'out_of_range' });
    if (!int(b.te_months, 0, 120)) errs.push({ path: '/te_months', code: 'out_of_range' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.effective_from ?? '')) errs.push({ path: '/effective_from', code: 'required' });
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    const v = { version: C().dlp.current.version + 1, cw_months: b.cw_months!, te_months: b.te_months!, effective_from: b.effective_from!, reason: b.reason!.trim(), changed_by: me(), changed_at: new Date().toISOString() };
    C().dlp = { current: v, history: [v, ...C().dlp.history] }; save();
    return HttpResponse.json(v, { status: 201 });
  }),
  // 0.15.64 (W8 item 4, migration 0148): the defaults of the Display menu; read by every signed-in user, saved by an admin with a reason and If-Match
  http.get(`${B}/settings/table-display`, () => { const g = guard(); if (g) return g; return HttpResponse.json(TD(), tag(TD().version)); }),
  http.put(`${B}/settings/table-display`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const p = ver(request, TD().version); if (p) return p;
    const b = await body<{ defaults?: Record<string, unknown>; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = [];
    for (const k of Object.keys(b)) if (k !== 'defaults' && k !== 'reason') errs.push({ path: `/${k}`, code: 'unknown_key' });
    const d = b.defaults ?? {};
    for (const k of Object.keys(d)) if (!['size', 'align', 'density', 'wrap', 'zebra'].includes(k)) errs.push({ path: `/defaults/${k}`, code: 'unknown_key' });
    if (!['sm', 'md', 'lg'].includes(String(d.size))) errs.push({ path: '/defaults/size', code: 'invalid' });
    if (!['start', 'center'].includes(String(d.align))) errs.push({ path: '/defaults/align', code: 'invalid' });
    if (!['compact', 'normal', 'comfortable'].includes(String(d.density))) errs.push({ path: '/defaults/density', code: 'invalid' });
    if (typeof d.wrap !== 'boolean') errs.push({ path: '/defaults/wrap', code: 'invalid' });
    if (typeof d.zebra !== 'boolean') errs.push({ path: '/defaults/zebra', code: 'invalid' });
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    C().tableDisplay = { defaults: d as TableDisplaySetting['defaults'], version: TD().version + 1, updated_by: me(), updated_at: new Date().toISOString() }; save();
    return HttpResponse.json(TD(), tag(TD().version));
  }),
  // 0.15.102 (migration 0196): the interface features; read by every signed-in user, saved by an admin with a reason and If-Match
  http.get(`${B}/settings/ui-features`, () => { const g = guard(); if (g) return g; return HttpResponse.json(UF(), tag(UF().version)); }),
  http.put(`${B}/settings/ui-features`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const p = ver(request, UF().version); if (p) return p;
    const b = await body<{ sections?: Record<string, Record<string, unknown>>; reason?: string } & Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = [];
    for (const k of Object.keys(b)) if (k !== 'sections' && k !== 'reason') errs.push({ path: `/${k}`, code: 'unknown_key' });
    const sec = b.sections ?? {};
    const oneOf = (o: Record<string, unknown>, path: string, k: string, list: string[]) => { if (!list.includes(String(o[k]))) errs.push({ path: `${path}/${k}`, code: 'invalid' }); };
    for (const [name, o] of Object.entries(sec)) {
      const path = `/sections/${name}`;
      if (name === 'avatars') {
        for (const k of Object.keys(o)) if (!['style', 'shape', 'palette', 'in_lists'].includes(k)) errs.push({ path: `${path}/${k}`, code: 'unknown_key' });
        oneOf(o, path, 'style', ['initials', 'gradient', 'geometric', 'none']); oneOf(o, path, 'shape', ['circle', 'rounded']); oneOf(o, path, 'palette', ['brand', 'varied']);
        if (typeof o.in_lists !== 'boolean') errs.push({ path: `${path}/in_lists`, code: 'invalid' });
      } else if (name === 'new_badge') {
        for (const k of Object.keys(o)) if (!['enabled', 'days'].includes(k)) errs.push({ path: `${path}/${k}`, code: 'unknown_key' });
        if (typeof o.enabled !== 'boolean') errs.push({ path: `${path}/enabled`, code: 'invalid' });
        if (!Number.isInteger(o.days)) errs.push({ path: `${path}/days`, code: 'invalid' });
        else if ((o.days as number) < 1 || (o.days as number) > 90) errs.push({ path: `${path}/days`, code: 'out_of_range' });
      } else if (name === 'inbox') {
        for (const k of Object.keys(o)) if (!['tabs_enabled', 'default_tab', 'priority_kinds'].includes(k)) errs.push({ path: `${path}/${k}`, code: 'unknown_key' });
        if (typeof o.tabs_enabled !== 'boolean') errs.push({ path: `${path}/tabs_enabled`, code: 'invalid' });
        oneOf(o, path, 'default_tab', ['all', 'priority', 'mentions', 'tasks', 'approvals', 'system']);
        const kinds = ['mention', 'followed_change', 'task_assigned', 'task_returned', 'task_rejected', 'task_approved', 'approval_due', 'reassigned', 'absence_alert', 'idle_task_alert', 'no_holder', 'system'];
        if (!Array.isArray(o.priority_kinds) || o.priority_kinds.some((x) => !kinds.includes(String(x)))) errs.push({ path: `${path}/priority_kinds`, code: 'invalid' });
      } else if (name === 'panel') {
        for (const k of Object.keys(o)) if (!['mode', 'width', 'show_tabs'].includes(k)) errs.push({ path: `${path}/${k}`, code: 'unknown_key' });
        oneOf(o, path, 'mode', ['popover', 'side_panel']); oneOf(o, path, 'width', ['narrow', 'medium', 'wide']);
        if (typeof o.show_tabs !== 'boolean') errs.push({ path: `${path}/show_tabs`, code: 'invalid' });
      } else if (name === 'unsaved_guard') {
        const keys = ['enabled', 'settings', 'dialogs', 'drawers', 'inline', 'composers', 'navigation'];
        for (const k of Object.keys(o)) if (!keys.includes(k)) errs.push({ path: `${path}/${k}`, code: 'unknown_key' });
        for (const k of keys) if (typeof o[k] !== 'boolean') errs.push({ path: `${path}/${k}`, code: o[k] === undefined ? 'required' : 'invalid' });
      } else if (name === 'data_hub') {
        for (const k of Object.keys(o)) if (!['widgets', 'badge', 'default_view'].includes(k)) errs.push({ path: `${path}/${k}`, code: 'unknown_key' });
        if (typeof o.badge !== 'boolean') errs.push({ path: `${path}/badge`, code: 'invalid' });
        const w = o.widgets as Record<string, unknown> | undefined;
        if (!w || typeof w !== 'object') errs.push({ path: `${path}/widgets`, code: 'invalid' });
        else for (const k of Object.keys(w)) {
          if (!['quick_bar', 'batches', 'template_changes', 'recent', 'health', 'admin'].includes(k)) errs.push({ path: `${path}/widgets/${k}`, code: 'unknown_key' });
          else if (typeof w[k] !== 'boolean') errs.push({ path: `${path}/widgets/${k}`, code: 'invalid' });
        }
        const v = o.default_view as Record<string, unknown> | undefined;
        if (!v || typeof v !== 'object') errs.push({ path: `${path}/default_view`, code: 'invalid' });
        else for (const k of Object.keys(v)) {
          if (!['templates', 'uploads', 'exports', 'master_import'].includes(k)) errs.push({ path: `${path}/default_view/${k}`, code: 'unknown_key' });
          else if (!['cards', 'rows', 'table', 'compact'].includes(String(v[k]))) errs.push({ path: `${path}/default_view/${k}`, code: 'invalid' });
        }
      } else if (name === 'finance_hub') {
        for (const k of Object.keys(o)) if (!['widgets', 'settle_warn_days', 'aging_days'].includes(k)) errs.push({ path: `${path}/${k}`, code: 'unknown_key' });
        const w = o.widgets as Record<string, unknown> | undefined;
        if (!w || typeof w !== 'object') errs.push({ path: `${path}/widgets`, code: 'invalid' });
        else for (const k of Object.keys(w)) {
          if (!['advances', 'invoices', 'quick_links', 'templates'].includes(k)) errs.push({ path: `${path}/widgets/${k}`, code: 'unknown_key' });
          else if (typeof w[k] !== 'boolean') errs.push({ path: `${path}/widgets/${k}`, code: 'invalid' });
        }
        if (!Number.isInteger(o.settle_warn_days)) errs.push({ path: `${path}/settle_warn_days`, code: 'invalid' });
        else if ((o.settle_warn_days as number) < 1 || (o.settle_warn_days as number) > 365) errs.push({ path: `${path}/settle_warn_days`, code: 'out_of_range' });
        const a = o.aging_days;
        if (!Array.isArray(a) || a.length !== 2 || !a.every((x) => Number.isInteger(x) && x >= 1 && x <= 365) || (a[0] as number) >= (a[1] as number)) errs.push({ path: `${path}/aging_days`, code: 'invalid' });
      } else errs.push({ path, code: 'unknown_key' });
    }
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    C().uiFeatures = { sections: { ...UF().sections, ...sec } as UiFeaturesSetting['sections'], version: UF().version + 1, updated_by: me(), updated_at: new Date().toISOString() }; save();
    return HttpResponse.json(UF(), tag(UF().version));
  }),
  http.get(`${B}/settings/idle-task-alert`, () => { const g = guard(); if (g) return g; return HttpResponse.json(C().idle, tag(C().idle.version)); }),
  http.put(`${B}/settings/idle-task-alert`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const p = ver(request, C().idle.version); if (p) return p;
    const b = await body<{ enabled?: boolean; working_days?: number; reason?: string }>(request);
    const errs: { path: string; code: string }[] = [];
    if (!int(b.working_days, 1, 30)) errs.push({ path: '/working_days', code: 'out_of_range' });
    if (typeof b.enabled !== 'boolean') errs.push({ path: '/enabled', code: 'required' });
    if ((b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    C().idle = { enabled: b.enabled!, working_days: b.working_days!, version: C().idle.version + 1, updated_by: me() }; db().admin.idleDays = b.working_days!; save();
    return HttpResponse.json(C().idle, tag(C().idle.version));
  }),


  // ------------------------------------------------------------------ team / scope match of Procurement (0.9.1, Q97)
  // 0.12.9 (P4b): codes of the catalogue, groups, read-only for Procurement and Contractors (can_edit), step-up when eligibility changes
  http.get(`${B}/settings/team-scope-match`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ ...SM(), can_edit: isAdmin() }, tag(SM().version)); }),
  http.put(`${B}/settings/team-scope-match`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'Send the ETag you last read in If-Match.');
    const p = ver(request, SM().version); if (p) return p;
    const b = await body<TeamScopeMatchInput & { reason?: string } & Record<string, unknown>>(request);
    const r = reasonErr(b.reason); if (r) return r;
    const errs = validateScopeMatch(b);
    if (errs.length) return fields(...errs);
    const { codes, catalogue, scopes } = errs.result;
    if (matchRules({ catalogue, scopes }) !== matchRules({ catalogue: SM().catalogue as Cat[], scopes: SM().scopes.map((s) => ({ ...s, allowed_groups: [...(s.allowed_groups ?? [])].sort() })) }) && !stepUpValid()) return stepUp();
    C().scopeMatch = { specializations: codes, groups: ['CW', 'TE'], catalogue, scopes, version: SM().version + 1, can_edit: true, updated_at: new Date().toISOString(), updated_by: me() } as TeamScopeMatch;
    save();
    return HttpResponse.json(C().scopeMatch, tag(C().scopeMatch.version));
  }),

  // ------------------------------------------------------------------ contractor rules and the two reports (0.12.9, P4b: Q142, Q145, Q147, D145b)
  http.get(`${B}/settings/contractor-rules`, () => { const g = guard(); if (g) return g; return HttpResponse.json(CR(), tag(CR().version)); }),
  http.put(`${B}/settings/contractor-rules`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'Send the ETag you last read in If-Match.');
    const p = ver(request, CR().version); if (p) return p;
    const b = await body<ContractorRulesInput & { reason?: string } & Record<string, unknown>>(request);
    const r = reasonErr(b.reason); if (r) return r;
    const errs = validateContractorRules(b);
    if (errs.length) return fields(...errs);
    const same = (x: string[], y: string[]) => [...x].sort().join('|') === [...y].sort().join('|');
    if ((!same(b.cw_delivery_scopes, CR().cw_delivery_scopes) || !same(b.internal_team_types, CR().internal_team_types)) && !stepUpValid()) return stepUp();
    const { reason: _r, ...rest } = b;
    void _r;
    C().contractorRules = { ...(rest as ContractorRulesInput), version: CR().version + 1, updated_at: new Date().toISOString(), updated_by: me() };
    save();
    return HttpResponse.json(C().contractorRules, tag(C().contractorRules.version));
  }),
  http.get(`${B}/reports/team-scope-mismatch`, () => { const g = guard(); if (g) return g; return HttpResponse.json(MISMATCH); }),
  http.get(`${B}/settings/sla-tasks`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ items: SLA_TASKS, counts: slaCounts() }); }),
  http.put(`${B}/settings/sla-tasks/:task/no-sla`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const b = (await request.json()) as { no_sla?: boolean; reason?: string };
    const row = SLA_TASKS.find((x) => x.task_code === params.task);
    if (!row) return problem(404, 'not_found', 'Not found');
    if (row.mode === 'set') return problem(422, 'validation_failed', 'Validation failed');
    if (!b.reason || b.reason.trim().length < 3) return problem(422, 'validation_failed', 'Validation failed');
    row.mode = b.no_sla ? 'none' : 'undecided'; row.none_reason = b.no_sla ? b.reason.trim() : null;
    return HttpResponse.json({ task_code: row.task_code, is_none: !!b.no_sla });
  }),
  http.get(`${B}/reports/gecol-hlc-counts`, () => { const g = guard(); if (g) return g; return HttpResponse.json(GECOL_HLC_COUNTS); }),
  http.get(`${B}/reports/contractor-performance`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ as_of: '2026-11-26T12:00:00.000Z', thresholds: perf.thresholds, items: PERF_ROWS }); }),
  http.get(`${B}/settings/contractor-performance`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ thresholds: perf.thresholds, version: perf.version, can_edit: true, updated_at: null, updated_by: null }, tag(perf.version)); }),
  http.put(`${B}/settings/contractor-performance`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'Send the ETag you last read in If-Match.');
    const p = ver(request, perf.version); if (p) return p;
    const b = await body<{ reason?: string; thresholds: typeof PERF_DEFAULT }>(request);
    const r = reasonErr(b.reason); if (r) return r;
    perf = { thresholds: b.thresholds, version: perf.version + 1 };
    return HttpResponse.json({ thresholds: perf.thresholds, version: perf.version, can_edit: true, updated_at: new Date().toISOString(), updated_by: null }, tag(perf.version));
  }),
  http.get(`${B}/reports/contractors-completeness`, () => { const g = guard(); if (g) return g; return HttpResponse.json(COMPLETENESS); }),

  // ------------------------------------------------------------------ alert rules (0.15.242, migration 0342): notifications only
  http.get(`${B}/settings/alert-rules`, () => {
    const g = needAdmin(); if (g) return g;
    return HttpResponse.json({
      rules: ALERT_RULES,
      catalogue: {
        kinds: [{ kind: 'weekly_status_missing', params: [] }, { kind: 'record_idle', params: ['register_key', 'state', 'days'] }, { kind: 'kpi_threshold', params: ['kpi', 'op', 'value'] }, { kind: 'advance_unsettled', params: ['days'] }, { kind: 'invoice_due_soon', params: ['days'] }],
        kpis: [{ code: 'sla_breach', label_en: 'SLA breaches (open tasks past the maximum)', label_ar: 'تجاوزات SLA', unit: 'pct', direction: 'lower' }, { code: 'stale_tasks', label_en: 'Stale tasks (idle for N working days)', label_ar: 'مهام راكدة', unit: 'pct', direction: 'lower' }],
        audiences: ['system_admin', 'module'],
        registers: [{ register_key: 'issues', name_en: 'Issue Log', name_ar: 'سجل البلاغات', module_key: 'sites' }, { register_key: 'change_control', name_en: 'Change Control Log', name_ar: 'سجل التحكم بالتغيير', module_key: 'sites' }],
        modules: [{ key: 'sites', name_en: 'Sites' }, { key: 'procurement', name_en: 'Procurement' }],
      },
    });
  }),
  http.post(`${B}/settings/alert-rules`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = await body<Record<string, unknown>>(request);
    const r = reasonErr(b.reason as string | undefined); if (r) return r;
    if (typeof b.kind !== 'string' || !['weekly_status_missing', 'record_idle', 'kpi_threshold', 'advance_unsettled', 'invoice_due_soon'].includes(b.kind)) return fields({ path: '/kind', code: 'invalid' });
    if (ALERT_RULES.some((x) => x.code === b.code)) return fields({ path: '/code', code: 'conflict' });
    const row = {
      id: `00000000-0000-4000-8000-${String(ALERT_RULES.length + 1).padStart(12, '0')}`,
      code: String(b.code), kind: b.kind as 'weekly_status_missing' | 'record_idle' | 'kpi_threshold' | 'advance_unsettled' | 'invoice_due_soon',
      params: (b.params ?? {}) as Record<string, unknown>, audience: (b.audience ?? { type: 'system_admin' }) as Record<string, unknown>,
      title_en: String(b.title_en ?? ''), title_ar: String(b.title_ar ?? ''), body_en: String(b.body_en ?? ''), body_ar: String(b.body_ar ?? ''),
      link: (b.link ?? null) as string | null, enabled: b.enabled !== false, locked: b.locked === true, version: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    ALERT_RULES.push(row);
    return HttpResponse.json({ id: row.id, version: 1 }, { status: 201 });
  }),
  http.put(`${B}/settings/alert-rules/:id`, async ({ request, params }) => {
    const g = needAdmin(); if (g) return g;
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'Send the ETag you last read in If-Match.');
    const row = ALERT_RULES.find((x) => x.id === params.id);
    if (!row) return problem(404, 'not_found', 'The alert rule.');
    const p = ver(request, row.version); if (p) return p;
    const b = await body<Record<string, unknown>>(request);
    const r = reasonErr(b.reason as string | undefined); if (r) return r;
    if (row.locked && b.locked !== false) return fields({ path: '/locked', code: 'rule_locked' });
    Object.assign(row, {
      kind: b.kind ?? row.kind, params: b.params ?? row.params, audience: b.audience ?? row.audience,
      title_en: b.title_en ?? row.title_en, title_ar: b.title_ar ?? row.title_ar, body_en: b.body_en ?? row.body_en, body_ar: b.body_ar ?? row.body_ar,
      link: b.link === undefined ? row.link : b.link, enabled: b.enabled ?? row.enabled, locked: b.locked ?? row.locked, version: row.version + 1, updated_at: new Date().toISOString(),
    });
    return HttpResponse.json({ id: row.id, version: row.version });
  }),


  // ------------------------------------------------------------------ notification policy
  http.get(`${B}/settings/notification-policy/catalogue`, () => { const g = needAdmin(); if (g) return g; return HttpResponse.json({ items: CATALOGUE }); }),
  http.get(`${B}/settings/notification-policy`, () => { const g = needAdmin(); if (g) return g; return HttpResponse.json(C().policy, tag(C().policy.version)); }),
  http.put(`${B}/settings/notification-policy`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const cur = C().policy, p = ver(request, cur.version); if (p) return p;
    const b = await body<NotificationPolicyInput & Record<string, unknown>>(request);
    const r = reasonErr(b.reason); if (r) return r;
    const errs = validatePolicy(b); if (errs.length) return fields(...errs);
    // Security and system rows and the rate cap are System-Admin-only (no delegate) and need step-up.
    const sensitive = JSON.stringify(b.matrix.filter((m) => ['security', 'system'].includes(CATALOGUE.find((c) => c.code === m.type_code)!.category))) !== JSON.stringify(cur.matrix.filter((m) => ['security', 'system'].includes(CATALOGUE.find((c) => c.code === m.type_code)!.category)).map(({ mandatory: _m, ...x }) => (void _m, x)))
      || b.thresholds.rate_cap_per_hour !== cur.thresholds.rate_cap_per_hour;
    if (sensitive) {
      if (C().actingDelegate) return problem(403, 'delegate_forbidden', 'Only a System Admin acting without delegation may change this');
      if (!stepUpValid()) return stepUp();
    }
    C().policy = { ...cur, ...b, matrix: b.matrix, columns: b.columns ?? cur.columns, work_days: b.work_days_follow_calendar ? [0, 1, 2, 3, 4] : b.work_days ?? cur.work_days, version: cur.version + 1, updated_by: me() } as never; delete (C().policy as never as Record<string, unknown>).reason; save();
    return HttpResponse.json(C().policy, tag(C().policy.version));
  }),

  // ------------------------------------------------------------------ log retention
  http.get(`${B}/settings/log-retention`, () => { const g = needAdmin(); if (g) return g; return HttpResponse.json(C().retention, tag(C().retention.version)); }),
  http.put(`${B}/settings/log-retention`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const cur = C().retention, p = ver(request, cur.version); if (p) return p;
    const b = await body<Record<string, unknown>>(request);
    const errs: { path: string; code: string }[] = [];
    for (const k of Object.keys(b)) if (!['reason', 'system_log_days', 'security_log_days'].includes(k)) errs.push({ path: `/${k}`, code: 'unknown_key' });
    if (!int(b.system_log_days, 90, 3650)) errs.push({ path: '/system_log_days', code: 'below_minimum' });
    if (!int(b.security_log_days, 365, 3650)) errs.push({ path: '/security_log_days', code: 'below_minimum' });
    if (String(b.reason ?? '').trim().length < 3) errs.push({ path: '/reason', code: 'required' });
    if (errs.length) return fields(...errs);
    const reduced = (b.system_log_days as number) < cur.system_log_days || (b.security_log_days as number) < cur.security_log_days;
    if (reduced && !stepUpValid()) return stepUp();
    C().retention = { ...cur, system_log_days: b.system_log_days as number, security_log_days: b.security_log_days as number, version: cur.version + 1, updated_by: me() };
    if (reduced) db().notifications.unshift({ id: crypto.randomUUID(), kind: 'system', title: 'Mandatory alert: log retention was reduced', created_at: new Date().toISOString(), read_at: null, link: '/admin/settings/retention' } as never);
    save();
    return HttpResponse.json(C().retention, tag(C().retention.version));
  }),

  // ------------------------------------------------------------------ staff field visibility (item 8)
  http.get(`${B}/staff-registry/visibility`, () => { const g = needAdmin(); if (g) return g; return HttpResponse.json(C().visibility, tag(C().visibility.version)); }),
  http.put(`${B}/staff-registry/visibility`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const b = await body<{ fields?: Record<string, unknown>; reason?: string }>(request);
    const r = reasonErr(b.reason); if (r) return r;
    if (!b.fields || !Object.keys(b.fields).length) return fields({ path: '/fields', code: 'required' });
    Object.assign(C().visibility.fields, b.fields); C().visibility.version += 1; save();
    return HttpResponse.json(C().visibility, tag(C().visibility.version));
  }),
  http.patch(`${B}/staff-registry/:emp`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    if (!byIdSafe(params.emp as string)) return problem(404, 'not_found', 'Not in the registry');
    if (!stepUpValid()) return stepUp();
    const b = await body<{ hidden_fields?: string[]; reason?: string }>(request);
    const r = reasonErr(b.reason); if (r) return r;
    C().hidden[params.emp as string] = b.hidden_fields ?? []; save();
    return HttpResponse.json({ employee_id: params.emp, hidden_fields: C().hidden[params.emp as string], version: 2 });
  }),

  // ------------------------------------------------------------------ security log, integrity, jobs
  http.get(`${B}/security-log`, ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin() && viewer()?.key !== 'auditor') return problem(403, 'action_forbidden', 'Needs view_security_log');
    const u = new URL(request.url).searchParams, ev = (u.get('event') ?? '').split(',').filter(Boolean), q = (u.get('q') ?? '').toLowerCase(), from = u.get('from'), to = u.get('to'), out = u.get('outcome');
    C().secLogReads += 1; save(); // every read is audited server-side
    const items = SEC_FILTER({ ev, q, from, to, out }).map((e) => (isAdmin() ? e : { ...e, ip: null }));
    return page(items);
  }),
  http.post(`${B}/security-log/exports`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'Needs the export grant');
    await request.json().catch(() => ({}));
    const id = `job-${crypto.randomUUID().slice(0, 8)}`; C().jobs[id] = { polls: 0 }; save();
    return HttpResponse.json({ id, kind: 'security_export', status: 'queued' }, { status: 202 });
  }),
  http.get(`${B}/jobs/:id`, ({ params }) => {
    const g = guard(); if (g) return g;
    const j = C().jobs[params.id as string]; if (!j) return problem(404, 'not_found', 'Job not found');
    j.polls += 1; save();
    const done = j.polls >= 2;
    return HttpResponse.json({ id: params.id, kind: 'security_export', status: done ? 'done' : 'running', progress: done ? 1 : 0.5, result_file_id: done ? '9a000000-0000-4000-8000-000000000001' : null });
  }),
  http.get(`${B}/files/9a000000-0000-4000-8000-000000000001/download`, () => {
    const g = guard(); if (g) return g;
    return new HttpResponse('id,at,event,outcome\n', { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="security-log.csv"' } });
  }),
  ...(['audit', 'security'] as const).map((log) => http.get(`${B}/${log}-log/integrity`, ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const u = new URL(request.url).searchParams, f = u.get('from_seq'), t = u.get('to_seq');
    if (f && t && Number(t) < Number(f)) return fields({ path: '/to_seq', code: 'before_from_seq' });
    const n = log === 'audit' ? 1842 : SEC_LOG_LEN(), broken = C().tampered && log === 'security';
    return HttpResponse.json({
      log, status: broken ? 'broken' : 'ok', row_count: n, first_seq: 1, last_seq: n, head_hash: (log === 'audit' ? 'a1' : 'b2').repeat(32), checked_at: new Date().toISOString(),
      breaks: broken ? [{ seq: 17, kind: 'hash_mismatch', expected_hash: 'c3'.repeat(32), found_hash: 'd4'.repeat(32) }] : [],
    });
  })),
  http.post(`${B}/__mock/tamper`, () => { C().tampered = true; save(); return new HttpResponse(null, { status: 204 }); }),
  http.post(`${B}/__mock/acting-delegate`, async ({ request }) => { C().actingDelegate = !!(await body<{ on?: boolean }>(request)).on; save(); return new HttpResponse(null, { status: 204 }); }),

  // ------------------------------------------------------------------ online now
  http.get(`${B}/sessions/active`, ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const u = new URL(request.url).searchParams, st = u.get('status'), q = (u.get('q') ?? '').toLowerCase(), now = Date.now();
    const items = C().sessions.map((s) => ({
      session_id: s.id, user: ref(s.emp), status: s.idleMin < 5 ? 'online' : 'idle', last_activity_at: new Date(now - s.idleMin * 60_000).toISOString(), current_screen: s.screen,
      signed_in_at: new Date(now - 3 * 3600e3).toISOString(), client_type: s.client, ip: `10.20.1.${s.emp.slice(-2)}`, is_current: !!s.current && s.emp === viewer()!.employee_id,
    })).filter((s) => (!st || s.status === st) && (!q || `${s.user.display_name} ${s.user.employee_id}`.toLowerCase().includes(q)));
    return page(items);
  }),
  http.post(`${B}/sessions/:id/revoke`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const s = C().sessions.find((x) => x.id === params.id); if (!s) return problem(404, 'not_found', 'Session not found');
    if (s.current && s.emp === viewer()!.employee_id) return problem(403, 'self_beneficiary', 'Use sign out for your own session');
    if (!stepUpValid()) return stepUp();
    const r = reasonErr((await body<{ reason?: string }>(request)).reason); if (r) return r;
    C().sessions = C().sessions.filter((x) => x.id !== s.id); save();
    return HttpResponse.json({ user: ref(s.emp), revoked_count: 1 });
  }),
  http.post(`${B}/users/:uid/sessions/revoke`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const rows = C().sessions.filter((x) => uid(x.emp) === params.uid && !(x.current && x.emp === viewer()!.employee_id));
    if (!C().sessions.some((x) => uid(x.emp) === params.uid)) return problem(404, 'not_found', 'User has no sessions');
    if (!stepUpValid()) return stepUp();
    const r = reasonErr((await body<{ reason?: string }>(request)).reason); if (r) return r;
    C().sessions = C().sessions.filter((x) => !rows.includes(x)); save();
    return HttpResponse.json({ user: ref(rows[0]?.emp ?? '1001'), revoked_count: rows.length });
  }),
];

import { SEC_LOG } from './settingsData';
const SEC_LOG_LEN = () => SEC_LOG.length;
const byIdSafe = (e: string) => { try { return byId(e); } catch { return null; } };
function SEC_FILTER({ ev, q, from, to, out }: { ev: string[]; q: string; from: string | null; to: string | null; out: string | null }): SecurityLogEntry[] {
  return SEC_LOG.filter((e) => (!ev.length || ev.includes(e.event)) && (!out || e.outcome === out) && (!from || e.at >= from) && (!to || e.at <= to)
    && (!q || `${e.user?.display_name ?? ''} ${e.user?.employee_id ?? ''} ${e.identifier_masked ?? ''} ${e.request_id ?? ''}`.toLowerCase().includes(q)));
}
