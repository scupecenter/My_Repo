import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { ListCatalogue, ListValue, RegisterRecord } from '@/api/types';
import { db, save, viewer } from './db';
import { guard, problem } from './handlers';
import { toRecord } from './handlers.registers';

/**
 * Contract 0.12.5 (Q104, Q111): the list catalogue and the conversion of the old text of a meeting, as admin_save_list_catalogue, admin_save_list_value
 * and reg_meeting_convert of migration 0057 decide them (synthetic seed: a few lists of the real seed).
 */
const B = API_BASE;
const val = (code: string, i: number, o: Partial<ListValue> = {}): ListValue => ({ id: `5b000000-0000-4000-8000-${String(i).padStart(12, '0')}`, code, label_en: code, label_ar: null, aliases: [], groups: [], sort_order: i * 10, is_active: true, version: 1, ...o });
let seq = 0;
const vals = (codes: string[]) => codes.map((c) => val(c, ++seq));
const cat = (code: string, name_en: string, name_ar: string, o: Partial<ListCatalogue>, values: ListValue[], used: ListCatalogue['used_by'] = []): ListCatalogue => ({
  code, name_en, name_ar, description: null, critical: false, status: 'pending', allow_other: false, is_active: true, version: 1, values, used_by: used, ...o,
});
export function seedLists(): ListCatalogue[] {
  seq = 0;
  return [
    cat('TeamSpecialization', 'Team specialization', 'تخصص الفريق', { critical: true, status: 'confirmed' },
      [...['Tower RT', 'Tower GF', 'Adaption'].map((c) => val(c, ++seq, { groups: ['CW'] })), val('TE', ++seq, { groups: ['TE'] }), ...vals(['Dismantle', 'GECOL', 'Fiber', 'Survey']), val('CW', ++seq, { groups: ['CW'], is_active: false })],
      [{ register_key: 'contractors', field_code: 'specialization' }]),
    cat('StaffStatus', 'Staff status', 'حالة الموظف', { critical: true, status: 'confirmed' }, vals(['Active', 'Inactive'])),
    cat('CompletionStatus', 'Execution status', 'حالة التنفيذ', { critical: true, status: 'confirmed' }, vals(['Done', 'Pending', 'N/A'])),
    cat('Severity', 'Severity', 'الخطورة', { critical: true }, vals(['Critical', 'Major', 'Minor']), [{ register_key: 'quality', field_code: 'severity' }]),
    cat('RiskStatus', 'Risk status', 'حالة الخطر', { allow_other: true }, vals(['Open', 'Monitoring', 'Closed', 'Materialized']), [{ register_key: 'risks', field_code: 'status' }]),
    cat('MeetingType', 'Meeting type', 'نوع الاجتماع', { allow_other: true }, [], [{ register_key: 'meetings', field_code: 'meeting_type' }]),
    cat('ActionStatus', 'Action status', 'حالة الإجراء', {},
      [val('Open', ++seq, { groups: ['open'] }), val('In Progress', ++seq, { groups: ['open'] }), val('Done', ++seq, { groups: ['closed'] }), val('Cancelled', ++seq, { groups: ['closed'] })],
      [{ register_key: 'meetings', field_code: 'action_items_list', column: 'status' }]),
  ];
}
type Store = { lists?: ListCatalogue[] };
const L = (): ListCatalogue[] => { const d = db() as unknown as Store; d.lists ??= seedLists(); return d.lists; };
const isAdmin = () => viewer()?.key === 'pm' || viewer()?.key === 'admin';
const invalid = (path: string, code: string) => problem(422, 'validation_failed', 'Validation failed', { errors: [{ path, code }] });
const version = (req: Request) => Number((req.headers.get('If-Match') ?? '').replace(/"/g, ''));
const tokens = (v: ListValue) => [v.code, v.label_en, v.label_ar ?? '', ...v.aliases].filter(Boolean).map((x) => x.toLowerCase());
const reasonOk = (b: { reason?: string }) => (b.reason ?? '').trim().length >= 3;

export const listHandlers = [
  http.get(`${B}/list-catalogues`, ({ request }) => {
    const g = guard(); if (g) return g;
    const all = new URL(request.url).searchParams.get('include_inactive') === 'true';
    return HttpResponse.json({ items: L().filter((c) => all || c.is_active).map((c) => ({ ...c, values: c.values.filter((v) => all || v.is_active) })) });
  }),
  http.get(`${B}/list-catalogues/:code`, ({ params }) => {
    const g = guard(); if (g) return g;
    const c = L().find((x) => x.code === params.code);
    return c ? HttpResponse.json(c, { headers: { ETag: `"${c.version}"` } }) : problem(404, 'not_found', 'The list does not exist.');
  }),
  http.post(`${B}/list-catalogues`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'You are not allowed to do this.');
    const b = (await request.json()) as Partial<ListCatalogue> & { reason?: string };
    if (!reasonOk(b)) return invalid('/reason', 'required');
    if (!/^[A-Z][A-Za-z0-9]{1,40}$/.test(b.code ?? '')) return invalid('/code', 'invalid');
    if (b.critical && b.allow_other) return invalid('/allow_other', 'critical_closed');
    if (L().some((c) => c.code.toLowerCase() === b.code!.toLowerCase())) return problem(409, 'duplicate', 'A list with this code exists already.');
    const c = cat(b.code!, b.name_en ?? b.code!, b.name_ar ?? '', { critical: !!b.critical, allow_other: !!b.allow_other }, []);
    L().push(c); save();
    return HttpResponse.json(c, { status: 201, headers: { ETag: '"1"' } });
  }),
  http.patch(`${B}/list-catalogues/:code`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'You are not allowed to do this.');
    const c = L().find((x) => x.code === params.code);
    if (!c) return problem(404, 'not_found', 'The list does not exist.');
    if (version(request) !== c.version) return problem(412, 'precondition_failed', 'The list changed since you read it.');
    const b = (await request.json()) as Partial<ListCatalogue> & { reason?: string };
    if (!reasonOk(b)) return invalid('/reason', 'required');
    const next = { ...c, ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'reason')) } as ListCatalogue;
    if (next.critical && next.allow_other) return invalid('/allow_other', 'critical_closed');
    if (next.status === 'confirmed' && !next.values.some((v) => v.is_active)) return invalid('/status', 'no_values');
    if (c.is_active && !next.is_active && c.used_by.length) return problem(422, 'item_in_use', 'An active field uses this list.', { errors: [{ path: '/is_active', code: 'item_in_use' }] });
    Object.assign(c, next, { version: c.version + 1 }); save();
    return HttpResponse.json(c, { headers: { ETag: `"${c.version}"` } });
  }),
  http.post(`${B}/list-catalogues/:code/values`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'You are not allowed to do this.');
    const c = L().find((x) => x.code === params.code);
    if (!c) return problem(404, 'not_found', 'The list does not exist.');
    const b = (await request.json()) as Partial<ListValue> & { reason?: string };
    if (!reasonOk(b)) return invalid('/reason', 'required');
    const code = b.code ?? '';
    if (!code || code !== code.trim() || code.includes(';') || code.length > 80) return invalid('/code', 'invalid');
    if (c.values.some((v) => v.code === code)) return problem(409, 'duplicate', 'This list has a value with this code already.');
    const v = val(code, 1000 + c.values.length, { id: crypto.randomUUID(), label_en: b.label_en ?? code, label_ar: b.label_ar ?? null, aliases: b.aliases ?? [], groups: b.groups ?? [], sort_order: (c.values.length + 1) * 10 });
    if (tokens(v).some((t) => c.values.some((x) => tokens(x).includes(t)))) return invalid(b.aliases?.length ? '/aliases' : '/label_en', 'duplicate');
    c.values.push(v); c.version += 1; save();
    return HttpResponse.json(c, { status: 201, headers: { ETag: `"${c.version}"` } });
  }),
  http.patch(`${B}/list-catalogues/:code/values/:id`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'You are not allowed to do this.');
    const c = L().find((x) => x.code === params.code);
    const v = c?.values.find((x) => x.id === params.id);
    if (!c || !v) return problem(404, 'not_found', 'The value does not exist in this list.');
    if (version(request) !== v.version) return problem(412, 'precondition_failed', 'The value changed since you read it.');
    const b = (await request.json()) as Partial<ListValue> & { reason?: string };
    if (!reasonOk(b)) return invalid('/reason', 'required');
    if ('code' in b) return invalid('/code', 'field_read_only');
    if (c.critical && v.is_active && b.is_active === false && !c.values.some((x) => x !== v && x.is_active)) return invalid('/is_active', 'last_active_value');
    const next = { ...v, ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'reason')), version: v.version + 1 } as ListValue;
    if (tokens(next).some((t) => c.values.some((x) => x !== v && tokens(x).includes(t)))) return invalid(b.aliases ? '/aliases' : '/label_en', 'duplicate');
    Object.assign(v, next); c.version += 1; save();
    return HttpResponse.json(c);
  }),

  // Q111: the proposal from the old text and the reviewed conversion (once per meeting)
  http.get(`${B}/registers/:key/records/:id/legacy-conversion`, ({ params }) => {
    const g = guard(); if (g) return g;
    const r = db().reg.records.find((x) => x.id === params.id && x.register_key === params.key);
    if (!r || params.key !== 'meetings') return problem(404, 'not_found', 'Only a meeting has old text to convert.');
    const d = r.data as Record<string, string | undefined>;
    const split = (s?: string, re = /[,;\n]+/) => (s ?? '').split(re).map((x) => x.trim()).filter(Boolean);
    return HttpResponse.json({
      record_id: r.id, converted: !!d.legacy_converted_at,
      legacy: { attendees: d.attendees ?? null, linked_sites: d.linked_sites ?? null, minutes_ref: d.minutes_ref ?? null, action_items: d.action_items ?? null },
      attendees: [], sites: [], unmatched: { attendees: split(d.attendees), sites: split(d.linked_sites, /[,;\s]+/) },
      action_items: split(d.action_items, /\n+/).map((x) => ({ description: x.replace(/^\s*(?:[-*]|\d+[.)])\s*/, ''), status: 'Open' })),
      minutes_note: d.minutes_ref ?? null,
    });
  }),
  http.post(`${B}/registers/:key/records/:id/legacy-conversion`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const r = db().reg.records.find((x) => x.id === params.id && x.register_key === params.key);
    if (!r || params.key !== 'meetings') return problem(404, 'not_found', 'Only a meeting has old text to convert.');
    if (version(request) !== r.version) return problem(412, 'precondition_failed', 'The record changed since you read it.');
    if (r.data.legacy_converted_at) return problem(409, 'duplicate', 'The old text of this meeting was converted already.');
    const b = (await request.json()) as { reason?: string; values?: { attendee_users?: string[]; linked_site_ids?: string[]; action_items_list?: Record<string, unknown>[] } };
    if (!reasonOk(b)) return invalid('/reason', 'required');
    const items = (r.data.action_items_list as Record<string, unknown>[] | undefined) ?? [];
    const seen = new Set(items.map((x) => String(x.description ?? '').toLowerCase()));
    const added = (b.values?.action_items_list ?? []).filter((x) => !seen.has(String(x.description ?? '').toLowerCase())).map((x) => ({ ...x, id: crypto.randomUUID() }));
    r.data = { ...r.data, attendee_users: [...new Set([...((r.data.attendee_users as string[]) ?? []), ...(b.values?.attendee_users ?? [])])],
      linked_site_ids: [...new Set([...((r.data.linked_site_ids as string[]) ?? []), ...(b.values?.linked_site_ids ?? [])])], action_items_list: [...items, ...added], legacy_converted_at: '2026-11-04' };
    r.version += 1; save();
    const out: RegisterRecord = toRecord(r);
    return HttpResponse.json(out, { headers: { ETag: `"${r.version}"` } });
  }),
];
