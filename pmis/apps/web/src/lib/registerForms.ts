import type { RegisterDefinition, RegisterField } from '@/api/types';

/**
 * Form layout and client-side checks of the registers built first (spec registers-and-streams.md §3.3, §3.5, §3.6, §3.7).
 * The contract's RegisterField has no `section`, so the section of each field code is kept here (TODO(contract): ask tech-lead for `section`
 * on RegisterField; codes the map does not know land in a "details" section, so a new custom field still shows up).
 */
export const REGISTER_KEYS_LIVE = ['procurement', 'gecol', 'hlc', 'permits_hse'] as const;
export const REGISTER_KEYS_SOON = ['contractors', 'warehouse', 'quality', 'issues', 'risks', 'change_control', 'readiness_handover', 'as_built', 'meetings'] as const;
export const isLive = (k: string): k is (typeof REGISTER_KEYS_LIVE)[number] => (REGISTER_KEYS_LIVE as readonly string[]).includes(k);

type Data = Record<string, unknown>;
export type SectionDef = { id: string; fields: string[]; when?: (d: Data) => boolean };

const isPtw = (d: Data) => typeof d.type === 'string' && d.type.startsWith('ptw');
/** Q63c: the switch decides whether the expiry date exists. Unset counts as Yes (the permit type's default is a Setting, not in the contract). */
export const hasExpiry = (d: Data) => d.has_expiry !== false;

export const SECTIONS: Record<string, SectionDef[]> = {
  procurement: [
    { id: 'site_scope', fields: ['scope', 'delivery'] }, { id: 'request', fields: ['pr_no', 'pr_date'] }, { id: 'order', fields: ['po_wo_no', 'po_wo_date'] },
    { id: 'assignment', fields: ['contractor', 'team'] }, { id: 'status_remark', fields: ['order_status', 'remark'] },
  ],
  gecol: [
    { id: 'request', fields: ['pr_no', 'pr_date'] }, { id: 'survey', fields: ['survey_date', 'layout_received', 'layout_approved'] }, { id: 'notice', fields: ['notice_date', 'mos_date', 'install_finish'] },
    { id: 'acceptance', fields: ['aat_acceptance', 'docs_approval'] }, { id: 'meter', fields: ['meter_no', 'power_on', 'billing_conversion'] }, { id: 'remark', fields: ['remark'] },
  ],
  hlc: [
    { id: 'request', fields: ['request_no', 'request_date', 'fiber_uplink'] }, { id: 'fiber_status', fields: ['fiber_status', 'fiber_team'] },
    { id: 'install', fields: ['install_date', 'tx_tested_date'] }, { id: 'remark', fields: ['remark'] },
  ],
  permits_hse: [
    { id: 'permit', fields: ['type', 'applied_date', 'status'] }, { id: 'validity', fields: ['valid_from', 'has_expiry', 'valid_to'] },
    { id: 'na', fields: ['na_reason', 'na_approved_by'], when: (d) => d.status === 'na' },
    { id: 'ptw', fields: ['jsa_tra', 'toolbox_talk', 'work_at_height', 'lifting_plan', 'loto', 'rescue_plan'], when: isPtw },
    { id: 'stop', fields: ['stop_work', 'stop_lifted_date'], when: isPtw }, { id: 'remark', fields: ['remark'] },
  ],
};

/** Sections to show: the known ones in order (only fields the caller may see), then every other field in "details". */
export function sectionsFor(def: RegisterDefinition, data: Data): { id: string; fields: RegisterField[] }[] {
  const byCode = new Map(def.fields.map((f) => [f.code, f]));
  const known = SECTIONS[def.register_key] ?? [];
  const used = new Set(known.flatMap((s) => s.fields));
  const out = known.filter((s) => !s.when || s.when(data)).map((s) => ({ id: s.id, fields: s.fields.map((c) => byCode.get(c)).filter((f): f is RegisterField => !!f && !isHidden(def.register_key, f.code, data)) })).filter((s) => s.fields.length);
  const rest = def.fields.filter((f) => !used.has(f.code));
  return rest.length ? [...out, { id: 'details', fields: rest }] : out;
}

/** A field that is not shown is not sent: `valid_to` of a permanent permit, N/A and PTW fields on other rows. */
export function isHidden(key: string, code: string, d: Data) {
  if (key !== 'permits_hse') return false;
  if (code === 'valid_to') return !hasExpiry(d);
  if (code === 'na_reason' || code === 'na_approved_by') return d.status !== 'na';
  if (['jsa_tra', 'toolbox_talk', 'work_at_height', 'lifting_plan', 'loto', 'rescue_plan', 'stop_work', 'stop_lifted_date'].includes(code)) return !isPtw(d);
  return false;
}
export function visibleData(def: RegisterDefinition, d: Data): Data {
  return Object.fromEntries(Object.entries(d).filter(([c, v]) => !isHidden(def.register_key, c, d) && v !== '' && v !== undefined));
}

/** Who enters what (Q56): the note shown under the title of each register. */
export const OWNER_NOTE: Record<string, string> = { procurement: 'registers.owner_procurement', gecol: 'registers.owner_gecol', hlc: 'registers.owner_hlc', permits_hse: 'registers.owner_permits' };

/** Values a new form starts with. Q63c: the permit type gives the default of the expiry switch; the Setting is not in the contract, so Yes. */
export const defaultsFor = (key: string): Data => (key === 'permits_hse' ? { has_expiry: true } : {});

export const DATE_MIN = '2020-01-01';
export const DATE_MAX = '2035-12-31';
/** Actual dates may not lie in the future (V2); everything else only has to be inside the range. */
const NO_FUTURE: Record<string, string[] | 'all-dates'> = { procurement: ['pr_date', 'po_wo_date'], gecol: 'all-dates', hlc: 'all-dates', permits_hse: ['applied_date'] };
/** later >= earlier (chronology, spec §3). */
const ORDER: Record<string, [string, string][]> = {
  procurement: [['pr_date', 'po_wo_date']],
  gecol: [['survey_date', 'notice_date'], ['notice_date', 'install_finish'], ['install_finish', 'aat_acceptance'], ['install_finish', 'power_on']],
  hlc: [['install_date', 'tx_tested_date']],
  permits_hse: [['valid_from', 'valid_to']],
};

export type FieldIssue = { code: string; params?: Record<string, string> };

/** Mirrors the register rules of spec §1.2 and §3 so Submit stays off until they pass; the server repeats every check. */
export function validateRecord(def: RegisterDefinition, data: Data, siteId: string | null, today: string): Record<string, FieldIssue> {
  const key = def.register_key, out: Record<string, FieldIssue> = {};
  const fail = (c: string, code: string, params?: Record<string, string>) => { out[c] ??= { code, params }; };
  if (def.site_scoped && !siteId) fail('site_id', 'site_required');
  for (const f of def.fields) {
    if (isHidden(key, f.code, data)) continue;
    const v = data[f.code];
    const empty = v === undefined || v === null || v === '';
    if (f.required && empty) { fail(f.code, 'required'); continue; }
    if (empty) continue;
    if (f.type === 'date' && typeof v === 'string') {
      if (v < DATE_MIN || v > DATE_MAX) fail(f.code, 'date_range', { min: DATE_MIN, max: DATE_MAX });
      const nf = NO_FUTURE[key];
      if (v > today && (nf === 'all-dates' || nf?.includes(f.code))) fail(f.code, 'future_date');
    }
    if (f.type === 'list' && f.options?.length && !f.options.some((o) => o.value === v)) fail(f.code, 'not_in_list');
  }
  for (const [a, b] of ORDER[key] ?? []) {
    const x = data[a], y = data[b];
    if (typeof x === 'string' && typeof y === 'string' && x && y && y < x && !isHidden(key, b, data)) fail(b, 'before_earlier', { other: a });
  }
  if (key === 'procurement') {
    if (data.delivery === 'in_house' && data.pr_no) fail('pr_no', 'in_house_with_pr');
    if (data.delivery === 'outsourced' && data.po_wo_no && !data.pr_no) fail('pr_no', 'po_without_pr');
  }
  if (key === 'permits_hse') {
    if (data.status === 'approved' && !data.valid_from) fail('valid_from', 'approved_needs_valid_from');
    if (data.status === 'na' && !data.na_reason) fail('na_reason', 'required');
    // Q63c: "has expiry date" = Yes makes the expiry date required; No hides it and the permit is permanent.
    if (hasExpiry(data) && !data.valid_to) fail('valid_to', 'required');
  }
  return out;
}

/** Server `errors[].path` -> field code: `/data/<code>`, `field:<code>` or `/site_id`. */
export function pathToField(path: string): string {
  if (path.startsWith('field:')) return path.slice(6);
  return path.replace(/^\/(data|custom)\//, '').replace(/^\//, '');
}
