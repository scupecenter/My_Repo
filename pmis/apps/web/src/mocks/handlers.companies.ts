import { http, HttpResponse } from 'msw';
import { API_BASE as B } from '@/api/client';
import type { CompanyCompliance, CompanyContact, CompanyDocument, CompanyDocumentType } from '@/api/companies';
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
export const resetCompanies = () => { types = TYPES0.map((t) => ({ ...t })); typesVersion = 7; contacts = []; docs = []; };
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
];
