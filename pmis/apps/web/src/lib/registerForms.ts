import type { PermitEntryType, RegisterDefinition, RegisterField } from '@/api/types';

/**
 * Form layout and client-side checks of the registers built first (spec registers-and-streams.md §3.3, §3.5, §3.6, §3.7).
 * Field codes, values and sections are the ones of the API (`register_fields`, migration 0019): the form is built from
 * `GET /registers`, and `RegisterField.section` (contract 0.4.6) gives the section of each base field. The checks below
 * mirror the rules the server repeats at submit (V1 to V6), so Submit stays off until they pass.
 */
export const REGISTER_KEYS_LIVE = ['procurement', 'contractors', 'gecol', 'hlc', 'permits_hse', 'warehouse', 'quality', 'issues', 'risks', 'change_control', 'readiness_handover', 'as_built', 'meetings', 'rf_design', 'acquisition', 'dismantle'] as const;
export const isLive = (k: string): k is (typeof REGISTER_KEYS_LIVE)[number] => (REGISTER_KEYS_LIVE as readonly string[]).includes(k);

type Data = Record<string, unknown>;

/** The server's section names that have a translated title; any other name is shown as the server gives it. */
const SECTION_ID: Record<string, string> = {
  'Site and scope': 'site_scope', Request: 'request', Order: 'order', Assignment: 'assignment', 'Status and remark': 'status_remark', 'Survey and layout': 'survey',
  'Notice and works': 'notice', Acceptance: 'acceptance', 'Meter and power-on': 'meter', Remark: 'remark', 'Status and team': 'fiber_status', 'Installation and test': 'install',
  Permit: 'permit', Validity: 'validity', 'N/A': 'na', 'PTW checks': 'ptw', 'Stop work': 'stop', 'Purchase request': 'purchase_request', 'In service': 'in_service',
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
    if (isHidden(def.register_key, f.code, data, def)) continue;
    const title = f.section ?? 'Details';
    const id = f.section ? (SECTION_ID[f.section] ?? slug(f.section)) : 'details';
    let s = out.find((x) => x.id === id);
    if (!s) { s = { id, title, fields: [] }; out.push(s); }
    s.fields.push(f);
  }
  return out;
}

/** Migration 0042: the scope whose purchase request is entered by the HLC Fiber Team in Procurement. */
export const HLC_SCOPE = 'HLC';
const isHlcScope = (d: Data) => d.scope === HLC_SCOPE;

/**
 * A field that is not shown is not sent: `valid_to` of a permanent permit, N/A fields on other rows, PTW fields on other permit types,
 * the HLC approval date on a Procurement scope other than HLC, and the HLC record's pointer to its purchase request (shown as a link instead).
 */
export function isHidden(key: string, code: string, d: Data, def?: RegisterDefinition) {
  if (key === 'procurement') return code === 'hlc_approval_date' && !isHlcScope(d);
  if (key === 'hlc') return code === 'procurement_record_id';
  if (key !== 'permits_hse') return false;
  // 0.12.2 (D220b): the stream is chosen only for the purpose-based permit types; a record that has one shows it
  if (code === 'permit_stream') { const m = permitMeta(def, d); return m ? !m.choose_stream : !d.permit_stream; }
  if (code === 'valid_to') return !hasExpiry(d);
  if (code === 'na_reason' || code === 'na_approved_by') return !isNa(d);
  if (['jsa_tra', 'toolbox_talk', 'work_at_height', 'lifting_plan', 'loto', 'rescue_plan', 'stop_work', 'stop_lifted_date'].includes(code)) return !isPtw(d);
  return false;
}

/** The data the server accepts: no hidden field, no system-filled field (`read_only`, Q45), no empty value. */
export function visibleData(def: RegisterDefinition, d: Data): Data {
  const ro = new Set(def.fields.filter((f) => f.read_only).map((f) => f.code));
  return Object.fromEntries(Object.entries(d).filter(([c, v]) => !isHidden(def.register_key, c, d, def) && !ro.has(c) && v !== '' && v !== undefined));
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
export const OWNER_NOTE: Record<string, string> = { procurement: 'registers.owner_procurement', gecol: 'registers.owner_gecol', hlc: 'registers.owner_hlc', permits_hse: 'registers.owner_permits', dismantle: 'registers.owner_dismantle' };

/**
 * Values a new form starts with. Q63c: the permit type gives the default of the expiry switch; the Setting is not in the contract, so Yes.
 * 0042: when the caller may enter one scope only (the HLC Fiber Team in Procurement: `entry_scopes` = ["HLC"]), that scope is preset.
 */
export const defaultsFor = (key: string, def?: RegisterDefinition): Data => {
  if (key === 'permits_hse') return { has_expiry: true };
  const scopes = def?.entry_scopes;
  return scopes && scopes.length === 1 ? { scope: scopes[0] } : {};
};

/**
 * The definition as the form offers it to the caller: in a register whose scopes have their own Matrix rows, the scope list holds only the scopes the
 * caller may enter (`entry_scopes`, contract 0.9.0). An empty or missing list leaves the field as it is (the server decides, and says why).
 */
export function forEntry(def: RegisterDefinition, d: Data = {}): RegisterDefinition {
  if (def.entry_permit_types) return forPermitEntry(def, d);
  const scopes = def.entry_scopes;
  if (!scopes || !scopes.length) return def;
  return { ...def, fields: def.fields.map((f) => (f.code === 'scope' && f.options ? { ...f, options: f.options.filter((o) => scopes.includes(o.value)) } : f)) };
}

/** 0.12.2 (Q222): what the catalogue says about the permit type of the form (null when the caller may not enter that type, or the list is missing). */
export const permitMeta = (def: RegisterDefinition | undefined, d: Data): PermitEntryType | null =>
  (typeof d.permit_type === 'string' && def?.entry_permit_types?.find((t) => t.code === d.permit_type)) || null;

/**
 * 0.12.2 (Q222, D220b): the permit form offers only the types the caller may enter (`entry_permit_types`; the type of an existing draft stays listed so the
 * form shows it) and, for a purpose-based type, only the streams the caller may choose. The server decides again on every write.
 */
function forPermitEntry(def: RegisterDefinition, d: Data): RegisterDefinition {
  const types = def.entry_permit_types ?? [];
  const allowed = new Set([...types.map((t) => t.code), ...(typeof d.permit_type === 'string' ? [d.permit_type] : [])]);
  const meta = permitMeta(def, d);
  return {
    ...def,
    fields: def.fields.map((f) => {
      if (f.code === 'permit_type' && f.options) return { ...f, options: f.options.filter((o) => allowed.has(o.value)) };
      if (f.code === 'permit_stream' && f.options) return { ...f, required: !!meta?.choose_stream, options: f.options.filter((o) => !meta || (meta.streams as string[]).includes(o.value) || o.value === d.permit_stream) };
      return f;
    }),
  };
}

export const DATE_MIN = '2020-01-01';
export const DATE_MAX = '2035-12-31';
/** Actual dates may not lie in the future (V2): the fields the server marks `is_actual`. The date of a task source is checked by the server at submit. */
const NO_FUTURE: Record<string, string[] | 'all-dates'> = { procurement: ['pr_date', 'po_wo_date', 'hlc_approval_date'], gecol: 'all-dates', hlc: 'all-dates', permits_hse: ['applied_date', 'stop_lifted_date'], dismantle: ['rfd_date', 'work_start_date', 'work_end_date'] };
/** later >= earlier: the chronology rules the server enforces (spec §3; Q96 lists what is not enforced). */
const ORDER: Record<string, [string, string][]> = {
  procurement: [['pr_date', 'po_wo_date']],
  gecol: [['request_date', 'installation_finish']],
  // 0042: the two blocking date rules of the HLC record (owner decision 2026-11-02); every other order only warns the reviewer (Q96, RegisterRecord.warnings)
  hlc: [['installation_date', 'tx_link_tested_date'], ['tx_link_tested_date', 'in_service_date']],
  permits_hse: [['valid_from', 'valid_to']],
};

/** `message` is the server's own sentence: shown when the code has no translation (rules the client does not know). */
export type FieldIssue = { code: string; params?: Record<string, string>; message?: string };

/** Mirrors the register rules of spec §1.2 and §3 so Submit stays off until they pass; the server repeats every check. */
export function validateRecord(def: RegisterDefinition, data: Data, siteId: string | null, today: string): Record<string, FieldIssue> {
  const key = def.register_key, out: Record<string, FieldIssue> = {};
  const fail = (c: string, code: string, params?: Record<string, string>) => { out[c] ??= { code, params }; };
  if (def.site_scoped && !siteId) fail('site_id', 'site_required');
  for (const f of def.fields) {
    if (isHidden(key, f.code, data, def) || f.read_only) continue;
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
    if (typeof x === 'string' && typeof y === 'string' && x && y && y < x && !isHidden(key, b, data, def)) fail(b, 'before_earlier', { other: a });
  }
  if (key === 'procurement') {
    const hasPr = !!(data.pr_no || data.pr_date), hasPo = !!(data.po_wo_no || data.po_wo_date);
    if (is(data.delivery, 'In-House') && hasPr) fail('pr_no', 'in_house_with_pr');
    if (is(data.delivery, 'Outsourced') && hasPo && !hasPr) fail('pr_no', 'po_without_pr');
    if (is(data.scope, 'TE Installation') && (hasPr || hasPo)) fail('scope', 'no_pr_po');
    // 0042: an HLC purchase request needs its PR No. and PR date
    if (isHlcScope(data)) { if (!data.pr_no) fail('pr_no', 'required'); if (!data.pr_date) fail('pr_date', 'required'); }
  }
  if (key === 'permits_hse') {
    if (isApproved(data) && !data.valid_from) fail('valid_from', 'approved_needs_valid_from');
    if (isNa(data) && !data.na_reason) fail('na_reason', 'required');
    // Q63c: an approved permit with "has expiry date" = Yes needs the expiry date; No hides it and the permit is permanent.
    if (isApproved(data) && hasExpiry(data) && !data.valid_to) fail('valid_to', 'required');
    if (data.stop_lifted_date && data.stop_work !== true && isPtw(data)) fail('stop_lifted_date', 'no_stop_work');
    // D220b: a purpose-based permit type needs its stream (the server answers `stream_required` too)
    if (permitMeta(def, data)?.choose_stream && !data.permit_stream) fail('permit_stream', 'stream_required');
  }
  return out;
}

/** Server `errors[].path` -> field code: `/data/<code>`, `field:<code>` or `/site_id`. */
export function pathToField(path: string): string {
  if (path.startsWith('field:')) return path.slice(6);
  return path.replace(/^\/(data|custom)\//, '').replace(/^\//, '');
}
