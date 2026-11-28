import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useContractorCompanies } from '@/api/registers';
import { useAllCompanyCompliance, useAllCompanyOnboarding, useBulkCompanyOnboarding, useCompanyOnboardingItems, type OnboardingState } from '@/api/companies';
import { CompanyTemplatesBar, ONBOARDING_STATES, stateChip } from '@/components/CompanyOnboarding';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { registerErrorMessage } from '@/lib/registerErrors';

/**
 * /companies (Companies K4): the list of companies with the document and onboarding chips, the pick-and-act bar (set one checklist item to one status for the companies
 * picked, export the picked ones in the three company templates) and the import. The full company page (K1/K2) takes the place of the name link.
 */
export function Companies() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const companies = useContractorCompanies(true), onb = useAllCompanyOnboarding(true), comp = useAllCompanyCompliance(true), items = useCompanyOnboardingItems();
  const bulk = useBulkCompanyOnboarding();
  const [picked, setPicked] = useState<string[]>([]);
  const [item, setItem] = useState('');
  const [status, setStatus] = useState<OnboardingState>('approved');
  const [q, setQ] = useState('');
  const progress = useMemo(() => new Map((onb.data ?? []).map((x) => [x.party_id, x])), [onb.data]);
  const docs = useMemo(() => new Map((comp.data ?? []).map((x) => [x.party_id, x])), [comp.data]);
  if (!companies.data) return <main className="p-4"><QueryFallback queries={[companies]} testid="companies-loading" /></main>;
  const rows = companies.data.filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase()));
  const label = (x: { label_en: string; label_ar?: string | null }) => (i18n.language === 'ar' && x.label_ar) || x.label_en;
  const active = (items.data?.items ?? []).filter((x) => x.is_active);
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id]);
  const apply = () => bulk.mutate({ party_ids: picked, item, status }, {
    onSuccess: (r) => { toast(t('companyOnb.bulk_done', { changed: r.changed, unchanged: r.unchanged })); setPicked([]); },
    onError: (e) => toast(registerErrorMessage(t, e), 'err'),
  });
  return (
    <main className="space-y-4 p-4" data-testid="page-companies">
      <h1 className="text-xl font-bold">{t('companyOnb.page_title')}</h1>
      <div className="card flex flex-wrap items-end gap-2 p-3" data-testid="companies-bulk" role="group" aria-label={t('companyOnb.bulk_title')}>
        <span className="text-sm font-semibold" data-testid="companies-picked">{t('companyOnb.picked', { count: picked.length })}</span>
        <label className="text-xs text-mute">{t('companyOnb.item')}
          <select className="input mt-1 block w-48" data-testid="companies-bulk-item" value={item} onChange={(e) => setItem(e.target.value)}>
            <option value="">{t('companyOnb.pick_item')}</option>
            {active.map((x) => <option key={x.code} value={x.code}>{label(x)}</option>)}
          </select>
        </label>
        <label className="text-xs text-mute">{t('companyOnb.status')}
          <select className="input mt-1 block w-40" data-testid="companies-bulk-status" value={status} onChange={(e) => setStatus(e.target.value as OnboardingState)}>
            {ONBOARDING_STATES.map((s) => <option key={s} value={s}>{t(`companyOnb.s_${s}`)}</option>)}
          </select>
        </label>
        <button type="button" className="btn btn-accent" data-testid="companies-bulk-apply" disabled={!picked.length || !item || bulk.isPending} onClick={apply}>{t('companyOnb.apply')}</button>
      </div>
      <input className="input w-72" aria-label={t('companyOnb.search')} placeholder={t('companyOnb.search')} data-testid="companies-search" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="companies-table">
          <thead><tr><th className="w-8" /><th className="text-start">{t('companyDocs.company')}</th><th className="text-start">{t('companyOnb.type')}</th><th className="text-start">{t('companyOnb.docs')}</th><th className="text-start">{t('companyOnb.title')}</th></tr></thead>
          <tbody>
            {rows.map((c) => {
              const p = progress.get(c.id), d = docs.get(c.id);
              return (
                <tr key={c.id} data-testid={`company-row-${c.id}`} className="border-t">
                  <td><input type="checkbox" aria-label={c.name} data-testid={`company-pick-${c.id}`} checked={picked.includes(c.id)} onChange={() => toggle(c.id)} /></td>
                  <td><Link className="text-link hover:underline" to={`/companies/${c.id}`}>{c.name}</Link></td>
                  <td className="text-mute">{c.type}</td>
                  <td>{d && d.status !== 'ok' ? <span className="rounded-full bg-lateBg px-2 py-0.5 text-xs font-semibold text-lateInk">{t(`companyDocs.chip_${d.status}`, { count: d.status === 'expired' ? d.expired : d.status === 'missing' ? d.missing : d.expiring })}</span> : <span className="text-mute">—</span>}</td>
                  <td>{p && p.status !== 'none' ? <span data-testid={`company-onb-progress-${c.id}`} className={`rounded-full px-2 py-0.5 text-xs font-semibold ${stateChip[p.status]}`}>{t(`companyOnb.progress`, { approved: p.approved, total: p.total })}</span> : <span className="text-mute">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="p-3 text-mute" data-testid="companies-none">{t('companyOnb.no_companies')}</p>}
      </div>
      <div className="card p-3"><CompanyTemplatesBar parties={picked} canEdit /></div>
    </main>
  );
}
