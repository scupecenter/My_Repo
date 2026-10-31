import type { RegisterDefinition, RegisterField } from '@/api/types';

/**
 * Form layout and client-side checks of the registers built first (spec registers-and-streams.md §3.3, §3.5, §3.6, §3.7).
 * Field codes, values and sections are the ones of the API (`register_fields`, migration 0019): the form is built from
 * `GET /registers`, and `RegisterField.section` (contract 0.4.6) gives the section of each base field. The checks below
 * mirror the rules the server repeats at submit (V1 to V6), so Submit stays off until they pass.
 */
export const REGISTER_KEYS_LIVE = ['procurement', 'gecol', 'hlc', 'permits_hse'] as const;
export const REGISTER_KEYS_SOON = ['contractors', 'warehouse', 'quality', 'issues', 'risks', 'change_control', 'readiness_handover', 'as_built', 'meetings'] as const;
export const isLive = (k: string): k is (typeof REGISTER_KEYS_LIVE)[number] => (REGISTER_KEYS_LIVE as readonly string[]).includes(k);

type Data = Record<string, unknown>;

/** The server's section names that have a translated title; any other name is shown as the server gives it. */
const SECTION_ID: Record<string, string> = {
  'Site and scope': 'site_scope', Request: 'request', Order: 'order', Assignment: 'assignment', 'Status and remark': 'status_remark', 'Survey and layout': 'survey',
  'Notice and works': 'notice', Acceptance: 'acceptance', 'Meter and power-on': 'meter', Remark: 'remark', 'Status and team': 'fiber_status', 'Installation and test': 'install',
  Permit: 'permit', Validity: 'validity', 'N/A': 'na', 'PTW checks': 'ptw', 'Stop work': 'stop',
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'details';

/** Permit types of the permit-to-work kind are the `PTW - ...` codes of the permit type list. */
const isPtw = (d: Data) => typeof d.permit_type === 'string' && d.permit_type.startsWith('PTW');
const isNa = (d: Data) => typeof d.status === 'string' && d.status.toLowerCase() === 'n/a';
const isApproved = (d: Data) => typeof d.status === 'string' && d.status.toLowerCase() === 'approved';
const is = (v: unknown, s: string) => typeof v === 'string' && v.toLowerCase() === s.toLowerCase();
/** Q63c: the switch decides whether the expiry date exists. Unset counts as Yes (the permit type's default is a Setting, not in the contract). */
export const hasExpiry = (d: Data) => d.has_expiry !== false;

export type FormSection = { id: string; title: string; fields: RegisterField[] };

/** Sections to show, in the order the server lists the fields: only fields the caller may see and that apply (see `isHidden`). Custom fields land in "details". */
export function sectionsFor(def: RegisterDefinition, data: Data): FormSection[] {
  const out: FormSection[] = [];
  for (const f of def.fields) {
    if (isHidden(def.register_key, f.code, data)) continue;
    const title = f.section ?? 'Details';
    const id = f.section ? (SECTION_ID[f.section] ?? slug(f.section)) : 'details';
    let s = out.find((x) => x.id === id);
    if (!s) { s = { id, title, fields: [] }; out.push(s); }
    s.fields.push(f);
  }
  return out;
}

/** A field that is not shown is not sent: `valid_to` of a permanent permit, N/A fields on other rows, PTW fields on other permit types. */
export function isHidden(key: string, code: string, d: Data) {
  if (key !== 'permits_hse') return false;
  if (code === 'valid_to') return !hasExpiry(d);
  if (code === 'na_reason' || code === 'na_approved_by') return !isNa(d);
  if (['jsa_tra', 'toolbox_talk', 'work_at_height', 'lifting_plan', 'loto', 'rescue_plan', 'stop_work', 'stop_lifted_date'].includes(code)) return !isPtw(d);
  return false;
}

/** The data the server accepts: no hidden field, no system-filled field (`read_only`, Q45), no empty value. */
export function visibleData(def: RegisterDefinition, d: Data): Data {
  const ro = new Set(def.fields.filter((f) => f.read_only).map((f) => f.code));
  return Object.fromEntries(Object.entries(d).filter(([c, v]) => !isHidden(def.register_key, c, d) && !ro.has(c) && v !== '' && v !== undefined));
}

/**
 * The patch of an edit: the visible values, and `null` for every value the record had that is now empty or hidden (the API clears a
 * field with an explicit null; a key that is absent stays as it is).
 */
export function patchData(def: RegisterDefinition, before: Data, after: Data): Data {
  const now = visibleData(def, after);
  const ro = new Set(def.fields.filter((f) => f.read_only).map((f) => f.code));
  const cleared = Object.keys(before).filter((c) => !ro.has(c) && !(c in now) && before[c] !== null && before[c] !== undefined);
  return { ...now, ...Object.fromEntries(cleared.map((c) => [c, null])) };
}

/** Who enters what (Q56): the note shown under the title of each register. */
export const OWNER_NOTE: Record<string, string> = { procurement: 'registers.owner_procurement', gecol: 'registers.owner_gecol', hlc: 'registers.owner_hlc', permits_hse: 'registers.owner_permits' };

/** Values a new form starts with. Q63c: the permit type gives the default of the expiry switch; the Setting is not in the contract, so Yes. */
export const defaultsFor = (key: string): Data => (key === 'permits_hse' ? { has_expiry: true } : {});

export const DATE_MIN = '2020-01-01';
export const DATE_MAX = '2035-12-31';
/** Actual dates may not lie in the future (V2): the fields the server marks `is_actual`. The date of a task source is checked by the server at submit. */
const NO_FUTURE: Record<string, string[] | 'all-dates'> = { procurement: ['pr_date', 'po_wo_date'], gecol: 'all-dates', hlc: 'all-dates', permits_hse: ['applied_date', 'stop_lifted_date'] };
/** later >= earlier: the chronology rules the server enforces (spec §3; Q96 lists what is not enforced). */
const ORDER: Record<string, [string, string][]> = {
  procurement: [['pr_date', 'po_wo_date']],
  gecol: [['request_date', 'installation_finish']],
  hlc: [['installation_date', 'tx_link_tested_date']],
  permits_hse: [['valid_from', 'valid_to']],
};

export type FieldIssue = { code: string; params?: Record<string, string> };

/** Mirrors the register rules of spec §1.2 and §3 so Submit stays off until they pass; the server repeats every check. */
export function validateRecord(def: RegisterDefinition, data: Data, siteId: string | null, today: string): Record<string, FieldIssue> {
  const key = def.register_key, out: Record<string, FieldIssue> = {};
  const fail = (c: string, code: string, params?: Record<string, string>) => { out[c] ??= { code, params }; };
  if (def.site_scoped && !siteId) fail('site_id', 'site_required');
  for (const f of def.fields) {
    if (isHidden(key, f.code, data) || f.read_only) continue;
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
    const hasPr = !!(data.pr_no || data.pr_date), hasPo = !!(data.po_wo_no || data.po_wo_date);
    if (is(data.delivery, 'In-House') && hasPr) fail('pr_no', 'in_house_with_pr');
    if (is(data.delivery, 'Outsourced') && hasPo && !hasPr) fail('pr_no', 'po_without_pr');
    if (is(data.scope, 'TE Installation') && (hasPr || hasPo)) fail('scope', 'no_pr_po');
  }
  if (key === 'permits_hse') {
    if (isApproved(data) && !data.valid_from) fail('valid_from', 'approved_needs_valid_from');
    if (isNa(data) && !data.na_reason) fail('na_reason', 'required');
    // Q63c: an approved permit with "has expiry date" = Yes needs the expiry date; No hides it and the permit is permanent.
    if (isApproved(data) && hasExpiry(data) && !data.valid_to) fail('valid_to', 'required');
    if (data.stop_lifted_date && data.stop_work !== true && isPtw(data)) fail('stop_lifted_date', 'no_stop_work');
  }
  return out;
}

/** Server `errors[].path` -> field code: `/data/<code>`, `field:<code>` or `/site_id`. */
export function pathToField(path: string): string {
  if (path.startsWith('field:')) return path.slice(6);
  return path.replace(/^\/(data|custom)\//, '').replace(/^\//, '');
}
