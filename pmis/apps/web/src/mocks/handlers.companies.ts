import { http, HttpResponse } from 'msw';
import { API_BASE as B } from '@/api/client';
import type { CompanyCompliance, CompanyContact, CompanyDocument, CompanyDocumentType, CompanyOnboardingItem, CompanyOnboardingStatus, OnboardingState } from '@/api/companies';
import { MOCK_COMPANIES } from './handlers.registers';
import { viewer } from './db';
import { guard, problem } from './handlers';

/** Contract 0.15.625 (Companies K3): contacts, documents with expiry, compliance and the document types, as migration 0745 decides them. Synthetic data. */
const TYPES0: CompanyDocumentType[] = [
  ['commercial_registration', 'Commercial registration', 'السجل التجاري', 30], ['tax', 'Tax certificate', 'الشهادة الضريبية', 30], ['insurance', 'Insurance', 'التأمين', 30],
  ['safety', 'Safety certificate', 'شهادة السلامة', 30], ['trade_licence', 'Trade licence', 'الرخصة التجارية', 30], ['iso', 'ISO certificate', 'شهادة الأيزو', 60],
  ['staff_certificate', 'Staff certificate', 'شهادة العاملين', 30],
].map(([code, label_en, label_ar, lead_days]) => ({ code: code as string, label_en: label_en as string, label_ar: label_ar as string, required_for: [], lead_days: lead_days as number, has_expiry: true, is_active: true }));
let types = TYPES0.map((t) => ({ ...t }));
let typesVersion = 7;
let contacts: CompanyContact[] = [];
let docs: CompanyDocument[] = [];
const uid = () => crypto.randomUUID();
/** Companies K4 (contract 0.15.626): the checklist items (applies to nobody until set), the statuses, the bulk change and the import. */
const ITEMS0: CompanyOnboardingItem[] = [['documents_received', 'Documents received', 'استلام المستندات'], ['safety_induction', 'Safety induction', 'التوعية بالسلامة'], ['insurance', 'Insurance', 'التأمين'], ['reference_check', 'Reference check', 'التحقق من المراجع']]
  .map(([code, label_en, label_ar]) => ({ code: code!, label_en: label_en!, label_ar: label_ar!, required_for: [], is_active: true }));
let items = ITEMS0.map((x) => ({ ...x }));
let itemsVersion = 4;
let onb: { party: string; item: string; status: OnboardingState; note: string | null; approver_name: string | null; decided_at: string | null }[] = [];
export const resetCompanies = () => { types = TYPES0.map((t) => ({ ...t })); typesVersion = 7; contacts = []; docs = []; items = ITEMS0.map((x) => ({ ...x })); itemsVersion = 4; onb = []; };
const PARTY_TYPES = ['cw_contractor', 'te_vendor', 'gecol', 'hlc', 'supplier', 'landlord', 'other'];
const typeOf = (party: string) => (MOCK_COMPANIES.find((c) => c.id === party)?.type ?? 'other');
const applies = (party: string) => items.filter((i) => i.is_active && i.required_for.includes(typeOf(party)));
const checklist = (party: string): CompanyOnboardingStatus[] => items
  .filter((i) => applies(party).some((a) => a.code === i.code) || onb.some((o) => o.party === party && o.item === i.code))
  .map((i) => { const o = onb.find((x) => x.party === party && x.item === i.code); return { code: i.code, label_en: i.label_en, label_ar: i.label_ar ?? null, status: o?.status ?? 'not_started', approver_id: null, approver_name: o?.approver_name ?? null, decided_at: o?.decided_at ?? null, note: o?.note ?? null, updated_at: null }; });
const applyStatus = (party: string, item: string, status: OnboardingState, note: string | null | undefined) => {
  const i = onb.findIndex((x) => x.party === party && x.item === item);
  const was = i < 0 ? null : onb[i]!;
  if (was && was.status === status && (note === undefined || note === was.note)) return false;
  const row = { party, item, status, note: note === undefined ? (was?.note ?? null) : note, approver_name: status === 'approved' ? (was?.approver_name ?? 'Test admin') : null, decided_at: status === 'approved' ? (was?.decided_at ?? new Date().toISOString()) : null };
  if (i < 0) onb.push(row); else onb[i] = row;
  return true;
};
const isAdmin = () => viewer()?.key === 'pm';
const now = () => new Date().toISOString();
const status = (exp: string | null, lead: number) => {
  if (!exp) return 'no_expiry' as const;
  const d = (new Date(exp).getTime() - new Date(new Date().toISOString().slice(0, 10)).getTime()) / 86_400_000;
  return d < 0 ? ('expired' as const) : d <= lead ? ('expiring' as const) : ('valid' as const);
};
const tag = (v: number) => ({ headers: { ETag: `"${v}"` } });
const compliance = (party: string): CompanyCompliance => {
  const held = docs.filter((d) => d.party_id === party && d.is_active);
  const st = held.map((d) => d.status);
  const expired = st.filter((s) => s === 'expired').length, expiring = st.filter((s) => s === 'expiring').length;
  return { party_id: party, status: expired ? 'expired' : expiring ? 'expiring' : 'ok', expired, expiring, missing: 0, valid: st.length - expired - expiring };
};

export const companiesHandlers = [
  http.get(`${B}/settings/company-document-types`, () => {
    const g = guard();
    if (g) return g;
    return HttpResponse.json({ types, party_types: ['cw_contractor', 'te_vendor', 'gecol', 'hlc', 'supplier', 'landlord', 'other'], version: typesVersion, can_edit: isAdmin() }, tag(typesVersion));
  }),
  http.put(`${B}/settings/company-document-types`, async ({ request }) => {
    const g = guard();
    if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'You are not allowed to do this.');
    const b = (await request.json()) as { reason?: string; types?: CompanyDocumentType[] };
    if ((b.reason ?? '').trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required' }] });
    for (const n of b.types ?? []) {
      const o = types.find((x) => x.code === n.code);
      if (o) Object.assign(o, n); else types.push(n);
    }
    typesVersion += 1;
    return HttpResponse.json({ types, party_types: ['cw_contractor', 'te_vendor', 'gecol', 'hlc', 'supplier', 'landlord', 'other'], version: typesVersion, can_edit: true }, tag(typesVersion));
  }),
  http.get(`${B}/companies/compliance`, () => {
    const g = guard();
    if (g) return g;
    return HttpResponse.json({ items: [...new Set(docs.map((d) => d.party_id))].map(compliance) });
  }),
  http.get(`${B}/companies/:id/compliance`, ({ params }) => {
    const g = guard();
    if (g) return g;
    return HttpResponse.json(compliance(String(params.id)));
  }),
  http.get(`${B}/companies/:id/contacts`, ({ params }) => {
    const g = guard();
    if (g) return g;
    return HttpResponse.json({ items: contacts.filter((c) => c.party_id === params.id) });
  }),
  http.post(`${B}/companies/:id/contacts`, async ({ params, request }) => {
    const g = guard();
    if (g) return g;
    const b = (await request.json()) as Partial<CompanyContact>;
    if (!(b.name ?? '').trim()) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/name', code: 'required' }] });
    if (b.is_primary) contacts = contacts.map((c) => (c.party_id === params.id ? { ...c, is_primary: false } : c));
    const c: CompanyContact = { id: uid(), party_id: String(params.id), name: b.name!.trim(), role: b.role ?? null, phone: b.phone ?? null, email: b.email ?? null, is_primary: !!b.is_primary, is_active: true, version: 1, updated_at: now() };
    contacts.push(c);
    return HttpResponse.json(c, { status: 201, ...tag(1) });
  }),
  http.patch(`${B}/companies/:id/contacts/:cid`, async ({ params, request }) => {
    const g = guard();
    if (g) return g;
    const i = contacts.findIndex((c) => c.id === params.cid);
    if (i < 0) return problem(404, 'not_found', 'Not found');
    const b = (await request.json()) as Partial<CompanyContact>;
    if (b.is_primary) contacts = contacts.map((c) => ({ ...c, is_primary: false }));
    contacts[i] = { ...contacts[i]!, ...b, is_primary: b.is_active === false ? false : (b.is_primary ?? contacts[i]!.is_primary), version: contacts[i]!.version + 1, updated_at: now() };
    return HttpResponse.json(contacts[i], tag(contacts[i]!.version));
  }),
  http.get(`${B}/companies/:id/documents`, ({ params }) => {
    const g = guard();
    if (g) return g;
    return HttpResponse.json({ items: docs.filter((d) => d.party_id === params.id) });
  }),
  http.post(`${B}/companies/:id/documents`, async ({ params, request }) => {
    const g = guard();
    if (g) return g;
    const fd = await request.formData();
    const code = String(fd.get('type_code') ?? '');
    const ty = types.find((t) => t.code === code && t.is_active);
    if (!ty) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/type_code', code: 'unknown_type' }] });
    const exp = String(fd.get('expires_on') ?? '') || null, iss = String(fd.get('issued_on') ?? '') || null;
    if (iss && exp && exp < iss) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/expires_on', code: 'before_issue' }] });
    const file = fd.get('file');
    const d: CompanyDocument = {
      id: uid(), party_id: String(params.id), type_code: code, type_label_en: ty.label_en, type_label_ar: ty.label_ar ?? null, title: null, doc_number: String(fd.get('doc_number') ?? '') || null,
      issued_on: iss, expires_on: exp, notes: null, has_file: file instanceof File, original_name: file instanceof File ? file.name : null, mime_type: null, size_bytes: null,
      status: status(exp, ty.lead_days), is_active: true, version: 1, updated_at: now(),
    };
    docs.push(d);
    return HttpResponse.json(d, { status: 201, ...tag(1) });
  }),
  http.patch(`${B}/companies/:id/documents/:did`, async ({ params, request }) => {
    const g = guard();
    if (g) return g;
    const i = docs.findIndex((d) => d.id === params.did);
    if (i < 0) return problem(404, 'not_found', 'Not found');
    const fd = await request.formData();
    if (fd.has('is_active')) docs[i] = { ...docs[i]!, is_active: fd.get('is_active') === 'true' };
    docs[i] = { ...docs[i]!, version: docs[i]!.version + 1, updated_at: now() };
    return HttpResponse.json(docs[i], tag(docs[i]!.version));
  }),
  http.get(`${B}/companies/:id/documents/:did/file`, () => {
    const g = guard();
    if (g) return g;
    return new HttpResponse('synthetic', { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="document.txt"' } });
  }),
  http.get(`${B}/settings/company-onboarding-items`, () => {
    const g = guard();
    if (g) return g;
    return HttpResponse.json({ items, party_types: PARTY_TYPES, version: itemsVersion, can_edit: isAdmin() }, tag(itemsVersion));
  }),
  http.put(`${B}/settings/company-onboarding-items`, async ({ request }) => {
    const g = guard();
    if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'You are not allowed to do this.');
    const b = (await request.json()) as { reason?: string; items?: CompanyOnboardingItem[] };
    if ((b.reason ?? '').trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required' }] });
    for (const n of b.items ?? []) {
      const o = items.find((x) => x.code === n.code);
      if (o) Object.assign(o, n); else items.push(n);
    }
    itemsVersion += 1;
    return HttpResponse.json({ items, party_types: PARTY_TYPES, version: itemsVersion, can_edit: true }, tag(itemsVersion));
  }),
  http.get(`${B}/companies/onboarding`, () => {
    const g = guard();
    if (g) return g;
    return HttpResponse.json({ items: MOCK_COMPANIES.map((c) => {
      const list = checklist(c.id), approved = list.filter((x) => x.status === 'approved').length, inProgress = list.filter((x) => x.status === 'in_progress').length;
      return { party_id: c.id, total: list.length, approved, in_progress: inProgress, status: list.length === 0 ? 'none' : approved === list.length ? 'approved' : approved + inProgress > 0 ? 'in_progress' : 'not_started' };
    }) });
  }),
  http.post(`${B}/companies/onboarding-bulk`, async ({ request }) => {
    const g = guard();
    if (g) return g;
    const b = (await request.json()) as { party_ids: string[]; item: string; status: OnboardingState };
    const errors = b.party_ids.flatMap((p, n) => (applies(p).some((a) => a.code === b.item) || onb.some((o) => o.party === p && o.item === b.item) ? [] : [{ path: `/parties/${n + 1}`, code: 'not_applicable' }]));
    if (errors.length) return problem(422, 'validation_failed', 'Validation failed', { errors });
    let changed = 0;
    for (const p of b.party_ids) if (applyStatus(p, b.item, b.status, undefined)) changed += 1;
    return HttpResponse.json({ companies: b.party_ids.length, changed, unchanged: b.party_ids.length - changed, item: b.item, status: b.status });
  }),
  http.post(`${B}/companies/import`, () => {
    const g = guard();
    if (g) return g;
    return HttpResponse.json({ id: crypto.randomUUID(), rows: 1, added: 1, updated: 0, unchanged: 0, template_id: 'TPL-COMPANY-CONTACTS', template_version: 1, source: 'template', file_name: 'companies.xlsx', status: 'applied' }, { status: 202 });
  }),
  http.get(`${B}/companies/:id/onboarding`, ({ params }) => {
    const g = guard();
    if (g) return g;
    return HttpResponse.json({ items: checklist(String(params.id)) });
  }),
  http.put(`${B}/companies/:id/onboarding/:item`, async ({ params, request }) => {
    const g = guard();
    if (g) return g;
    const b = (await request.json()) as { status: OnboardingState; note?: string | null };
    const party = String(params.id), item = String(params.item);
    if (!applies(party).some((a) => a.code === item) && !onb.some((o) => o.party === party && o.item === item)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/item', code: 'not_applicable' }] });
    return HttpResponse.json({ party_id: party, item, status: b.status, changed: applyStatus(party, item, b.status, b.note) });
  }),
];
