import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { FINANCE_HUB_SEED, useFinanceHubSettings, useFinanceHubSummary, type FinanceHubSummary } from '@/api/financeHub';
import { PageHeader } from '@/components/PageHeader';
import { errText } from '@/components/FormDialog';
import { EmptyState, LoadingSkeleton } from '@/components/States';
import { ICONS, ICON_PROPS, type Concept } from '@/lib/icons';

/** One summary card of the Finance hub (the Data hub widget, kept identical in shape). */
function Card({ id, icon, title, link, children }: { id: string; icon: Concept; title: string; link?: { to: string; label: string }; children: ReactNode }) {
  const Icon = ICONS[icon];
  return (
    <section className="card flex flex-col gap-2 p-4" data-testid={`fh-card-${id}`} aria-labelledby={`fh-c-${id}`}>
      <div className="flex items-center gap-2">
        <Icon {...ICON_PROPS} size={18} className="shrink-0" />
        <h2 id={`fh-c-${id}`} className="min-w-0 flex-1 truncate text-base font-bold">{title}</h2>
        {link && <Link to={link.to} className="text-xs text-link" data-testid={`fh-more-${id}`}>{link.label}</Link>}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, testid, tone }: { label: string; value: ReactNode; testid: string; tone?: 'late' }) {
  return (
    <div className="flex items-baseline justify-between gap-2" data-testid={testid}>
      <span className="text-sm text-mute">{label}</span>
      <span className={`text-lg font-bold ${tone === 'late' ? 'text-lateInk' : ''}`}>{value}</span>
    </div>
  );
}

const fmtAmount = (n: number, lang: string) => new Intl.NumberFormat(lang === 'ar' ? 'ar-LY' : 'en-US', { maximumFractionDigits: 2 }).format(n);

/**
 * The Finance hub landing page (owner decision D57, contract 0.15.312): read-only summary cards over the two separate registers Financial Advances and
 * Invoices, quick links into them, and their templates. A card a caller cannot see (no module) is left out; advance amounts appear only where the
 * register's own amounts rule shows them. The cards can be hidden and the thresholds set in Settings > Screens > Finance hub.
 */
export function FinanceHubPage() {
  const { t, i18n } = useTranslation();
  const cfg = useFinanceHubSettings();
  const w = cfg.widgets;
  const summary = useFinanceHubSummary(w.advances || w.invoices);
  const s: FinanceHubSummary | undefined = summary.data;
  const [b0, b1] = cfg.aging_days ?? FINANCE_HUB_SEED.aging_days;
  const anyCard = w.advances || w.invoices || w.quick_links || w.templates;
  const noAccess = s && s.advances == null && s.invoices == null;
  return (
    <div className="space-y-4" data-testid="page-finance-hub">
      <PageHeader title={t('fhub.title')} subtitle={t('fhub.subtitle')} settings="finance_hub" />
      {!anyCard && <EmptyState title={t('fhub.all_hidden')} />}
      {anyCard && summary.isError && <p role="alert" className="card p-4 text-lateInk" data-testid="fh-error">{errText(summary.error, t)}</p>}
      {anyCard && !summary.isError && !s && (w.advances || w.invoices) && <LoadingSkeleton rows={3} />}
      <div className="grid gap-3 md:grid-cols-2">
        {w.advances && s?.advances && (
          <Card id="advances" icon="financeHub" title={t('fhub.adv_title')} link={{ to: '/registers/financial_advances?record_type=advance', label: t('fhub.open_register') }}>
            <Stat label={t('fhub.adv_open')} value={s.advances.open_count} testid="fh-adv-open" />
            <Stat label={t('fhub.adv_overdue', { days: cfg.settle_warn_days })} value={s.advances.overdue_count} testid="fh-adv-overdue" tone={s.advances.overdue_count > 0 ? 'late' : undefined} />
            {s.advances.open_amount != null
              ? <Stat label={t('fhub.adv_amount')} value={`${fmtAmount(s.advances.open_amount, i18n.language)} ${s.advances.currency ?? 'LYD'}`} testid="fh-adv-amount" />
              : <p className="text-xs text-mute" data-testid="fh-adv-amount-hidden">{t('fhub.amounts_hidden')}</p>}
          </Card>
        )}
        {w.invoices && s?.invoices && (
          <Card id="invoices" icon="financeHub" title={t('fhub.inv_title')} link={{ to: '/registers/invoices', label: t('fhub.open_register') }}>
            <Stat label={t('fhub.inv_open')} value={s.invoices.open_count} testid="fh-inv-open" />
            <Stat label={t('fhub.inv_overdue')} value={s.invoices.overdue_count} testid="fh-inv-overdue" tone={s.invoices.overdue_count > 0 ? 'late' : undefined} />
            <div className="mt-1 border-t border-line pt-2">
              <p className="mb-1 text-xs font-semibold text-mute">{t('fhub.inv_by_state')}</p>
              {(['Received', 'UnderReview', 'Approved', 'Disputed'] as const).map((st) => (
                <Stat key={st} label={t(`fhub.inv_state_${st}`)} value={s.invoices?.by_state?.[st] ?? 0} testid={`fh-inv-state-${st}`} />
              ))}
              <p className="mb-1 mt-2 text-xs font-semibold text-mute">{t('fhub.inv_aging')}</p>
              <Stat label={t('fhub.inv_age_first', { days: b0 })} value={s.invoices.aging.first} testid="fh-inv-age-first" />
              <Stat label={t('fhub.inv_age_second', { from: b0 + 1, to: b1 })} value={s.invoices.aging.second} testid="fh-inv-age-second" />
              <Stat label={t('fhub.inv_age_third', { days: b1 })} value={s.invoices.aging.third} testid="fh-inv-age-third" />
            </div>
          </Card>
        )}
        {w.quick_links && (s?.advances != null || s?.invoices != null) && (
          <Card id="links" icon="link" title={t('fhub.links_title')}>
            <nav className="flex flex-col gap-1" aria-label={t('fhub.links_title')}>
              {s?.advances != null && (
                <>
                  <Link className="text-sm text-link" data-testid="fh-link-adv" to="/registers/financial_advances">{t('fhub.link_adv_all')}</Link>
                  <Link className="text-sm text-link" data-testid="fh-link-adv-open" to="/registers/financial_advances?record_type=advance">{t('fhub.link_adv_open')}</Link>
                  <Link className="text-sm text-link" data-testid="fh-link-adv-expenses" to="/registers/financial_advances?record_type=expense">{t('fhub.link_adv_expenses')}</Link>
                  <Link className="text-sm text-link" data-testid="fh-link-adv-settlements" to="/registers/financial_advances?record_type=settlement">{t('fhub.link_adv_settlements')}</Link>
                  <Link className="text-sm text-link" data-testid="fh-link-adv-triage" to="/registers/financial_advances?triage=pending">{t('fhub.link_adv_triage')}</Link>
                </>
              )}
              {s?.invoices != null && (
                <>
                  <Link className="text-sm text-link" data-testid="fh-link-inv" to="/registers/invoices">{t('fhub.link_inv_all')}</Link>
                  <Link className="text-sm text-link" data-testid="fh-link-inv-triage" to="/registers/invoices?triage=pending">{t('fhub.link_inv_triage')}</Link>
                </>
              )}
            </nav>
          </Card>
        )}
        {w.templates && (s?.advances != null || s?.invoices != null) && (
          <Card id="templates" icon="template" title={t('fhub.templates_title')} link={{ to: '/templates', label: t('fhub.open_templates') }}>
            <p className="text-sm text-mute">{t('fhub.templates_note')}</p>
            <ul className="list-disc ps-5 text-sm">
              {s?.advances != null && <li data-testid="fh-tpl-adv">{t('fhub.tpl_adv')}</li>}
              {s?.invoices != null && <li data-testid="fh-tpl-inv">{t('fhub.tpl_inv')}</li>}
            </ul>
          </Card>
        )}
      </div>
      {noAccess && <EmptyState title={t('fhub.no_access')} />}
    </div>
  );
}
