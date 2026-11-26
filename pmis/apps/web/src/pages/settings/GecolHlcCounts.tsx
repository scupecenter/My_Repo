import { useTranslation } from 'react-i18next';
import { useGecolHlcCounts } from '@/api/settings';
import { QueryFallback } from '@/components/States';

type StateRow = { state: string; count: number };

function States({ rows, empty }: { rows: StateRow[]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-mute">{empty}</p>;
  return (
    <ul className="text-sm">
      {rows.map((r) => <li key={r.state} className="flex justify-between gap-6"><span>{r.state}</span><span className="tabular-nums font-semibold">{r.count}</span></li>)}
    </ul>
  );
}

function Stat({ label, value, testid }: { label: string; value: number; testid: string }) {
  return <div className="flex justify-between gap-6 text-sm"><span>{label}</span><span className="tabular-nums font-semibold" data-testid={testid}>{value}</span></div>;
}

/**
 * Settings > Data > GECOL / HLC counts (contract 0.15.84). Read only: the numbers of the GECOL, HLC and Procurement records (latest version of each record)
 * that a System Admin needs to see before any move of GECOL or HLC data. The screen has no button that changes data.
 */
export function GecolHlcCounts() {
  const { t } = useTranslation();
  const q = useGecolHlcCounts();
  const d = q.data;
  if (!d) return <section className="card p-4" data-testid="page-gecol-hlc-counts"><QueryFallback queries={[q]} testid="ghc-loading" /></section>;
  const empty = t('gecolHlcCounts.empty');
  return (
    <section className="card space-y-4 p-4" data-testid="page-gecol-hlc-counts">
      <h2 className="font-bold">{t('gecolHlcCounts.title')}</h2>
      <p className="text-sm text-mute">{t('gecolHlcCounts.note')}</p>
      <p className="text-xs text-mute">{t('gecolHlcCounts.as_of')}: {new Date(d.as_of).toLocaleString()}</p>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-1">
          <h3 className="font-semibold">{t('gecolHlcCounts.gecol')}</h3>
          <Stat label={t('gecolHlcCounts.total')} value={d.gecol.total} testid="ghc-gecol-total" />
          <Stat label={t('gecolHlcCounts.with_pr_no')} value={d.gecol.with_pr_no} testid="ghc-gecol-pr" />
          <Stat label={t('gecolHlcCounts.with_request_date')} value={d.gecol.with_request_date} testid="ghc-gecol-date" />
          <p className="pt-1 text-xs font-semibold text-mute">{t('gecolHlcCounts.by_state')}</p>
          <States rows={d.gecol.by_state} empty={empty} />
        </div>
        <div className="space-y-1">
          <h3 className="font-semibold">{t('gecolHlcCounts.hlc')}</h3>
          <Stat label={t('gecolHlcCounts.total')} value={d.hlc.total} testid="ghc-hlc-total" />
          <Stat label={t('gecolHlcCounts.linked')} value={d.hlc.linked_to_procurement} testid="ghc-hlc-linked" />
          <Stat label={t('gecolHlcCounts.not_linked')} value={d.hlc.not_linked} testid="ghc-hlc-notlinked" />
          <p className="pt-1 text-xs font-semibold text-mute">{t('gecolHlcCounts.by_state')}</p>
          <States rows={d.hlc.by_state} empty={empty} />
        </div>
        <div className="space-y-1">
          <h3 className="font-semibold">{t('gecolHlcCounts.sites')}</h3>
          <Stat label={t('gecolHlcCounts.sites_gecol')} value={d.sites.with_gecol_scope} testid="ghc-sites-gecol" />
          <Stat label={t('gecolHlcCounts.sites_hlc')} value={d.sites.with_hlc_scope} testid="ghc-sites-hlc" />
        </div>
      </div>
      <div>
        <h3 className="mb-1 font-semibold">{t('gecolHlcCounts.procurement')} ({d.procurement.total})</h3>
        {d.procurement.by_scope_state.length === 0 ? <p className="text-sm text-mute">{empty}</p> : (
          <table className="w-full max-w-md text-sm" data-testid="ghc-procurement">
            <thead><tr className="text-start text-mute"><th className="text-start">{t('gecolHlcCounts.scope')}</th><th className="text-start">{t('gecolHlcCounts.state')}</th><th className="text-end">{t('gecolHlcCounts.count')}</th></tr></thead>
            <tbody>
              {d.procurement.by_scope_state.map((r) => <tr key={`${r.scope ?? ''}|${r.state}`}><td>{r.scope ?? t('gecolHlcCounts.no_scope')}</td><td>{r.state}</td><td className="text-end tabular-nums">{r.count}</td></tr>)}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
