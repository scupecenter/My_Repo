import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useContractorCompanies } from '@/api/registers';
import { useContractorPerformance } from '@/api/settings';
import { Chip, pctText } from './ContractorPerformance';

const TABS = ['overview', 'performance', 'record'] as const;
type Tab = (typeof TABS)[number];

/**
 * One company (Companies K2): /companies/:id. Everything shown is read from records that exist: the company in the register, and its performance row (delay
 * days, snags, quality, orders, contract end) worked out by the server. Tabs are in the URL (`?tab=`). The register record (edit, drafts, approval, history)
 * stays the place to change data; the Record tab links to it. Contacts and Documents (K3) and the score, status and orders tabs (K5, K2b) mount as tabs here.
 */
export function CompanyPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'overview';
  const companies = useContractorCompanies(true);
  const perf = useContractorPerformance();
  const company = companies.data?.find((c) => c.id === id);
  const row = perf.data?.items.find((r) => r.party_id === id);
  const days = row?.contract.days_left;
  const contractText = !row ? '—' : days === null || days === undefined ? t('contractorPerf.no_contract') : days < 0 ? t('contractorPerf.expired', { n: -days }) : t('contractorPerf.days_left', { n: days });
  if (companies.data && !company) {
    return <div className="space-y-3" data-testid="page-company-missing"><p>{t('company.not_found')}</p><Link className="underline" to="/companies">{t('company.back')}</Link></div>;
  }
  return (
    <div className="space-y-4" data-testid="page-company">
      <nav className="text-sm text-mute"><Link className="underline" to="/companies" data-testid="company-back">{t('company.back')}</Link></nav>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold" data-testid="company-name">{company?.name ?? '...'}</h1>
        {company && <span className="chip bg-card2" title={t('company.type_hint')}>{company.type}</span>}
        {row && <Chip level={row.level} label={t(`contractorPerf.level_${row.level}`)} testid="company-level" />}
      </div>
      <div role="tablist" aria-label={t('company.tabs')} className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} title={t(`company.tab_${k}_hint`)} data-testid={`company-tab-${k}`}
            className={`px-3 py-2 text-sm font-semibold ${tab === k ? 'border-b-2 border-accent text-accent' : 'text-mute'}`} onClick={() => setSp(k === 'overview' ? {} : { tab: k }, { replace: true })}>
            {t(`company.tab_${k}`)}
          </button>
        ))}
      </div>
      {tab === 'overview' && (
        <section className="card space-y-3 p-4" data-testid="company-overview">
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-xs text-mute">{t('contractorPerf.delay_days')}</dt><dd className="text-xl font-bold" data-testid="company-delay">{row ? row.delay_days : '—'}</dd></div>
            <div><dt className="text-xs text-mute">{t('contractorPerf.orders')}</dt><dd className="text-xl font-bold" data-testid="company-orders">{row ? `${row.orders.open} / ${row.orders.total}` : '—'}</dd></div>
            <div><dt className="text-xs text-mute">{t('contractorPerf.contract')}</dt><dd className="text-xl font-bold" data-testid="company-contract">{contractText}</dd></div>
            <div><dt className="text-xs text-mute">{t('company.scopes')}</dt><dd className="text-sm" data-testid="company-scopes">{company?.scopes?.length ? company.scopes.join(', ') : '—'}</dd></div>
          </dl>
          {!row && !(perf.error instanceof ApiError) && <p className="text-sm text-mute">{t('company.no_perf')}</p>}
          {perf.error instanceof ApiError && perf.error.status === 403 && <p className="text-sm text-mute">{t('company.perf_forbidden')}</p>}
        </section>
      )}
      {tab === 'performance' && (
        <section className="card space-y-2 p-4" data-testid="company-performance">
          {!row ? <p className="text-sm text-mute">{t('company.no_perf')}</p> : (
            <table className="w-full text-sm"><tbody>
              <tr><th className="p-2 text-start">{t('contractorPerf.delay_days')}</th><td className="p-2">{row.delay_days} <span className="text-xs text-mute">({t('contractorPerf.open_note', { open: row.issues_open, total: row.issues_total })})</span></td></tr>
              <tr><th className="p-2 text-start">{t('contractorPerf.overdue')}</th><td className="p-2"><Chip level={row.snags.overdue_level} label={pctText(row.snags.overdue_pct)} /> <span className="text-xs text-mute">{t('contractorPerf.open_note', { open: row.snags.open, total: row.snags.total })}</span></td></tr>
              <tr><th className="p-2 text-start">{t('contractorPerf.returned')}</th><td className="p-2"><Chip level={row.snags.returned_level} label={pctText(row.snags.returned_pct)} /></td></tr>
              <tr><th className="p-2 text-start">{t('contractorPerf.quality')}</th><td className="p-2"><Chip level={row.quality.fail_level} label={pctText(row.quality.fail_pct)} /> <span className="text-xs text-mute">{row.quality.failed} / {row.quality.total}</span></td></tr>
              <tr><th className="p-2 text-start">{t('contractorPerf.contract')}</th><td className="p-2"><Chip level={row.contract.level} label={contractText} /></td></tr>
            </tbody></table>
          )}
          <p className="text-xs text-mute">{t('contractorPerf.note')}</p>
        </section>
      )}
      {tab === 'record' && (
        <section className="card space-y-2 p-4" data-testid="company-record">
          <p className="text-sm">{t('company.record_note')}</p>
          <Link className="btn" to={`/registers/contractors/records/${id}`} data-testid="company-open-record">{t('company.open_record')}</Link>
        </section>
      )}
    </div>
  );
}
