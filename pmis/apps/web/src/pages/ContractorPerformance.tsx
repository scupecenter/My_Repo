import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useContractorPerformance } from '@/api/settings';
import type { ContractorPerformanceRow } from '@/api/types';

type Level = ContractorPerformanceRow['level'];
const TONE: Record<Level, string> = { ok: 'bg-card2', amber: 'bg-lateBg text-lateInk', red: 'bg-lateBg text-lateInk font-bold', insufficient: 'bg-card2 text-mute' };

function Chip({ level, label, testid }: { level: Level; label: string; testid?: string }) {
  const { t } = useTranslation();
  return <span className={`chip ${TONE[level]}`} data-testid={testid} data-level={level}>{label} <span className="text-xs">({t(`contractorPerf.level_${level}`)})</span></span>;
}

const pctText = (p: number | null | undefined) => (p === null || p === undefined ? '—' : `${p}%`);

/** Contractor performance, read only (contract 0.15.88): a section of the Contractors reports; a caller who may not read it sees nothing. */
export function ContractorPerformance() {
  const { t } = useTranslation();
  const q = useContractorPerformance();
  if (q.error instanceof ApiError && q.error.status === 403) return null;
  const days = (c: ContractorPerformanceRow['contract']) =>
    c.days_left === null ? t('contractorPerf.no_contract') : c.days_left < 0 ? t('contractorPerf.expired', { n: -c.days_left }) : t('contractorPerf.days_left', { n: c.days_left });
  return (
    <section className="card space-y-2 p-4" data-testid="cr-performance">
      <h2 className="font-bold">{t('contractorPerf.title')}</h2>
      <p className="text-sm text-mute">{t('contractorPerf.note')}</p>
      {q.data && !q.data.items.length && <p className="text-sm">{t('contractorPerf.none')}</p>}
      {!!q.data?.items.length && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-mute"><tr>
              <th className="p-2 text-start">{t('contractorPerf.contractor')}</th><th className="p-2 text-start">{t('contractorPerf.overall')}</th>
              <th className="p-2 text-start">{t('contractorPerf.delay_days')}</th><th className="p-2 text-start">{t('contractorPerf.overdue')}</th>
              <th className="p-2 text-start">{t('contractorPerf.returned')}</th><th className="p-2 text-start">{t('contractorPerf.quality')}</th>
              <th className="p-2 text-start">{t('contractorPerf.orders')}</th><th className="p-2 text-start">{t('contractorPerf.contract')}</th>
            </tr></thead>
            <tbody>
              {q.data.items.map((r) => (
                <tr key={r.party_id} className="border-t border-line align-top" data-testid={`perf-${r.name}`}>
                  <td className="p-2 font-semibold"><Link className="underline" to="/registers/contractors">{r.name}</Link></td>
                  <td className="p-2"><Chip level={r.level} label={t(`contractorPerf.level_${r.level}`)} testid={`perf-level-${r.name}`} /></td>
                  <td className="p-2">{r.delay_days}<span className="block text-xs text-mute">{t('contractorPerf.open_note', { open: r.issues_open, total: r.issues_total })}</span></td>
                  <td className="p-2"><Chip level={r.snags.overdue_level} label={pctText(r.snags.overdue_pct)} /><span className="block text-xs text-mute">{t('contractorPerf.open_note', { open: r.snags.open, total: r.snags.total })}</span></td>
                  <td className="p-2"><Chip level={r.snags.returned_level} label={pctText(r.snags.returned_pct)} /></td>
                  <td className="p-2"><Chip level={r.quality.fail_level} label={pctText(r.quality.fail_pct)} /><span className="block text-xs text-mute">{r.quality.failed} / {r.quality.total}</span></td>
                  <td className="p-2">{r.orders.open} / {r.orders.total}</td>
                  <td className="p-2"><Chip level={r.contract.level} label={days(r.contract)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
