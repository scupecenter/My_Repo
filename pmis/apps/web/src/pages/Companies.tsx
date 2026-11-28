import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { ScreenSettingsLink } from '@/components/ScreenSettingsLink';
import { ContractorsReports, type CompanySection } from './ContractorsReports';
import { RegisterPage } from './Register';

const TABS = ['list', 'ranking', 'complete', 'match'] as const;
export type CompanyTab = (typeof TABS)[number];
const SECTION: Record<Exclude<CompanyTab, 'list'>, CompanySection> = { ranking: 'ranking', complete: 'complete', match: 'match' };

/**
 * Companies: contractors, executing companies and vendors in one page. The list is the Contractors register (add and edit with drafts and approval,
 * template download and upload, all its settings); the other tabs are the former Contractor reports page: the performance ranking, the data to
 * complete and the team / scope match. The tab is in the URL (`?tab=`), so a link opens the same tab. Nothing is copied: every tab is the existing screen.
 */
export function Companies() {
  const { t } = useTranslation();
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('tab');
  const tab: CompanyTab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as CompanyTab) : 'list';
  const go = (k: CompanyTab) => setSp(k === 'list' ? {} : { tab: k }, { replace: true });
  return (
    <div className="space-y-4" data-testid="page-companies">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold">{t('companies.title')}</h1>
        <span className="ms-auto"><ScreenSettingsLink screen="register_contractors" /></span>
      </div>
      <div role="tablist" aria-label={t('companies.tabs')} className="flex flex-wrap gap-1 border-b border-line" data-testid="companies-tabs">
        {TABS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} title={t(`companies.tab_${k}_hint`)} data-testid={`companies-tab-${k}`}
            className={`px-3 py-2 text-sm font-semibold ${tab === k ? 'border-b-2 border-accent text-accent' : 'text-mute'}`} onClick={() => go(k)}>
            {t(`companies.tab_${k}`)}
          </button>
        ))}
      </div>
      {tab === 'list' ? <RegisterPage registerKey="contractors" /> : <ContractorsReports section={SECTION[tab]} />}
    </div>
  );
}
