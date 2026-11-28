import { useState } from 'react';
import { Download, EyeOff, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  downloadCompanyDocument, useCompanyCompliance, useCompanyContacts, useCompanyDocuments, useCompanyDocumentTypes, useSaveCompanyContact, useSaveCompanyDocument,
  type CompanyContact, type CompanyDocument,
} from '@/api/companies';
import { QueryFallback } from './States';
import { errText } from './FormDialog';
import { useToast } from './Toast';
import { fieldErrors } from '@/lib/fields';

const chip: Record<string, string> = { expired: 'bg-lateBg text-lateInk', expiring: 'bg-waitBg text-waitInk', missing: 'bg-lateBg text-lateInk', valid: 'bg-doneBg text-doneInk', ok: 'bg-doneBg text-doneInk', no_expiry: 'bg-doneBg text-doneInk' };

/** The red chip of a company: expired or missing required documents (amber when expiring). Nothing shows when all is in order. */
export function CompanyComplianceChip({ party }: { party: string }) {
  const { t } = useTranslation();
  const q = useCompanyCompliance(party);
  const c = q.data;
  if (!c || c.status === 'ok') return null;
  const n = c.status === 'expired' ? c.expired : c.status === 'missing' ? c.missing : c.expiring;
  return <span data-testid="company-compliance-chip" className={`rounded-full px-2 py-0.5 text-xs font-semibold ${chip[c.status]}`}>{t(`companyDocs.chip_${c.status}`, { count: n })}</span>;
}

function Contacts({ party, canEdit }: { party: string; canEdit: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useCompanyContacts(party), save = useSaveCompanyContact(party);
  const [f, setF] = useState({ name: '', role: '', phone: '', email: '', is_primary: false });
  const errs = fieldErrors(save.error);
  const add = () => save.mutate({ body: { name: f.name, role: f.role || null, phone: f.phone || null, email: f.email || null, is_primary: f.is_primary } }, {
    onSuccess: () => { setF({ name: '', role: '', phone: '', email: '', is_primary: false }); toast(t('companyDocs.saved')); },
  });
  const patch = (c: CompanyContact, body: Parameters<typeof save.mutate>[0]['body']) => save.mutate({ id: c.id, version: c.version, body });
  if (!q.data) return <QueryFallback queries={[q]} testid="company-contacts-loading" />;
  return (
    <section className="space-y-2" data-testid="company-contacts">
      <h3 className="font-semibold">{t('companyDocs.contacts')}</h3>
      <p className="text-sm text-mute">{t('companyDocs.contacts_note')}</p>
      {q.data.length === 0 && <p className="text-mute" data-testid="company-contacts-none">{t('companyDocs.contacts_none')}</p>}
      <ul className="divide-y">
        {q.data.map((c) => (
          <li key={c.id} className={`flex flex-wrap items-center gap-3 py-2 ${c.is_active ? '' : 'opacity-60'}`} data-testid={`company-contact-${c.id}`}>
            <span className="font-semibold">{c.name}</span>
            {c.is_primary && <span className="flex items-center gap-1 text-xs text-doneInk"><Star size={12} />{t('companyDocs.primary')}</span>}
            <span className="text-sm text-mute">{[c.role, c.phone, c.email].filter(Boolean).join(' · ')}</span>
            {!c.is_active && <span className="text-xs text-mute">{t('companyDocs.hidden')}</span>}
            {canEdit && (
              <span className="ms-auto flex gap-2 text-sm">
                {c.is_active && !c.is_primary && <button type="button" className="text-link hover:underline" data-testid={`company-contact-primary-${c.id}`} onClick={() => patch(c, { is_primary: true })}>{t('companyDocs.make_primary')}</button>}
                <button type="button" className="text-link hover:underline" data-testid={`company-contact-toggle-${c.id}`} onClick={() => patch(c, { is_active: !c.is_active })}><EyeOff size={12} className="me-1 inline" />{c.is_active ? t('companyDocs.hide') : t('companyDocs.show')}</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form className="grid gap-2 sm:grid-cols-5" onSubmit={(e) => { e.preventDefault(); add(); }} data-testid="company-contact-form">
          <label className="text-sm font-semibold">{t('companyDocs.name')}<input className="input mt-1 font-normal" data-testid="cc-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            {errs['/name'] && <span role="alert" className="text-xs text-lateInk">{t(`fieldError.${errs['/name']}`, { defaultValue: errs['/name'] })}</span>}</label>
          <label className="text-sm font-semibold">{t('companyDocs.role')}<input className="input mt-1 font-normal" data-testid="cc-role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} /></label>
          <label className="text-sm font-semibold">{t('companyDocs.phone')}<input className="input mt-1 font-normal" data-testid="cc-phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
          <label className="text-sm font-semibold">{t('companyDocs.email')}<input className="input mt-1 font-normal" data-testid="cc-email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            {errs['/email'] && <span role="alert" className="text-xs text-lateInk">{t(`fieldError.${errs['/email']}`, { defaultValue: errs['/email'] })}</span>}</label>
          <div className="flex items-end gap-2">
            <label className="flex items-center gap-1 text-sm"><input type="checkbox" data-testid="cc-primary" checked={f.is_primary} onChange={(e) => setF({ ...f, is_primary: e.target.checked })} />{t('companyDocs.primary')}</label>
            <button className="btn btn-accent" data-testid="cc-add" disabled={!f.name.trim() || save.isPending}>{t('companyDocs.add')}</button>
          </div>
        </form>
      )}
      {save.isError && !Object.keys(errs).length && <p role="alert" className="text-lateInk">{errText(save.error, t)}</p>}
    </section>
  );
}

function Documents({ party, canEdit }: { party: string; canEdit: boolean }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useCompanyDocuments(party), types = useCompanyDocumentTypes(), save = useSaveCompanyDocument(party);
  const [f, setF] = useState({ type_code: '', doc_number: '', issued_on: '', expires_on: '', notes: '' });
  const [file, setFile] = useState<File | null>(null);
  const errs = fieldErrors(save.error);
  const ar = i18n.language.startsWith('ar');
  const label = (d: CompanyDocument) => (ar ? d.type_label_ar : null) ?? d.type_label_en ?? d.type_code;
  const add = () => save.mutate({ fields: { type_code: f.type_code, doc_number: f.doc_number, issued_on: f.issued_on || null, expires_on: f.expires_on || null, notes: f.notes }, file }, {
    onSuccess: () => { setF({ type_code: '', doc_number: '', issued_on: '', expires_on: '', notes: '' }); setFile(null); toast(t('companyDocs.saved')); },
  });
  if (!q.data) return <QueryFallback queries={[q]} testid="company-docs-loading" />;
  return (
    <section className="space-y-2" data-testid="company-documents">
      <h3 className="font-semibold">{t('companyDocs.documents')}</h3>
      <p className="text-sm text-mute">{t('companyDocs.documents_note')}</p>
      {q.data.length === 0 && <p className="text-mute" data-testid="company-docs-none">{t('companyDocs.documents_none')}</p>}
      <ul className="divide-y">
        {q.data.map((d) => (
          <li key={d.id} className={`flex flex-wrap items-center gap-3 py-2 ${d.is_active ? '' : 'opacity-60'}`} data-testid={`company-doc-${d.id}`}>
            <span className="font-semibold">{label(d)}</span>
            <span className="mono text-sm text-mute">{d.doc_number}</span>
            <span className="text-sm text-mute">{d.expires_on ? t('companyDocs.expires', { date: d.expires_on }) : t('companyDocs.no_expiry')}</span>
            {d.is_active && <span data-testid={`company-doc-status-${d.id}`} className={`rounded-full px-2 py-0.5 text-xs font-semibold ${chip[d.status]}`}>{t(`companyDocs.status_${d.status}`)}</span>}
            {d.has_file && <button type="button" className="text-link hover:underline" data-testid={`company-doc-dl-${d.id}`} onClick={() => void downloadCompanyDocument(party, d.id)}><Download size={12} className="me-1 inline" />{d.original_name}</button>}
            {!d.is_active && <span className="text-xs text-mute">{t('companyDocs.hidden')}</span>}
            {canEdit && <button type="button" className="ms-auto text-sm text-link hover:underline" data-testid={`company-doc-toggle-${d.id}`} onClick={() => save.mutate({ id: d.id, version: d.version, fields: { is_active: !d.is_active } })}><EyeOff size={12} className="me-1 inline" />{d.is_active ? t('companyDocs.hide') : t('companyDocs.show')}</button>}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form className="grid gap-2 sm:grid-cols-6" onSubmit={(e) => { e.preventDefault(); add(); }} data-testid="company-doc-form">
          <label className="text-sm font-semibold">{t('companyDocs.type')}
            <select className="input mt-1 font-normal" data-testid="cd-type" value={f.type_code} onChange={(e) => setF({ ...f, type_code: e.target.value })}>
              <option value="" />
              {(types.data?.types ?? []).filter((x) => x.is_active).map((x) => <option key={x.code} value={x.code}>{(ar ? x.label_ar : null) ?? x.label_en}</option>)}
            </select>
            {errs['/type_code'] && <span role="alert" className="text-xs text-lateInk">{t(`fieldError.${errs['/type_code']}`, { defaultValue: errs['/type_code'] })}</span>}</label>
          <label className="text-sm font-semibold">{t('companyDocs.number')}<input className="input mt-1 font-normal" data-testid="cd-number" value={f.doc_number} onChange={(e) => setF({ ...f, doc_number: e.target.value })} /></label>
          <label className="text-sm font-semibold">{t('companyDocs.issued')}<input type="date" className="input mt-1 font-normal" data-testid="cd-issued" value={f.issued_on} onChange={(e) => setF({ ...f, issued_on: e.target.value })} /></label>
          <label className="text-sm font-semibold">{t('companyDocs.expiry')}<input type="date" className="input mt-1 font-normal" data-testid="cd-expiry" value={f.expires_on} onChange={(e) => setF({ ...f, expires_on: e.target.value })} />
            {errs['/expires_on'] && <span role="alert" className="text-xs text-lateInk">{t(`fieldError.${errs['/expires_on']}`, { defaultValue: errs['/expires_on'] })}</span>}</label>
          <label className="text-sm font-semibold">{t('companyDocs.file')}<input type="file" className="mt-1 block w-full text-sm font-normal" data-testid="cd-file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          <div className="flex items-end"><button className="btn btn-accent" data-testid="cd-add" disabled={!f.type_code || save.isPending}>{t('companyDocs.add')}</button></div>
        </form>
      )}
      {save.isError && !Object.keys(errs).length && <p role="alert" className="text-lateInk">{errText(save.error, t)}</p>}
    </section>
  );
}

/** Contacts and documents of one company. Companies K1/K2 mount this as the Contacts and Documents tabs of the company page; until then /companies/:id shows it. */
export function CompanyContactsDocuments({ party, canEdit }: { party: string; canEdit: boolean }) {
  return <div className="space-y-6" data-testid="company-contacts-documents"><Contacts party={party} canEdit={canEdit} /><Documents party={party} canEdit={canEdit} /></div>;
}
