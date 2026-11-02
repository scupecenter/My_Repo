import { UserRoundCog } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useMe } from '@/api/hooks';
import { useRegions } from '@/api/sites';
import type { UserRef } from '@/api/types';
import { useTimeReport, useWorkload } from '@/api/x';
import { useDurationUnits } from '@/components/InsightPanels';
import { PageHeader, Toolbar } from '@/components/PageHeader';
import { PersonTag } from '@/components/PersonTag';
import { EmptyState, ErrorState, LoadingSkeleton, NoPermission } from '@/components/States';
import { ApiError } from '@/api/client';
import { canReassign, fmtDuration } from '@/lib/x';
import { CoverDialog } from './Absence';

const TEAM_TONE: Record<string, string> = { cw: 'bg-openBg text-openInk', te: 'bg-waitBg text-waitInk', both: 'bg-card2 text-ink', none: 'bg-lockBg text-lockInk' };

function RegionSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t, i18n } = useTranslation();
  const regions = useRegions();
  return (
    <select className="input w-auto" aria-label={t('sites.all_regions')} data-testid="workload-region" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('sites.all_regions')}</option>
      {(regions.data ?? []).map((r) => <option key={r.id} value={r.id}>{(i18n.language === 'ar' && r.name_ar) || r.name_en}</option>)}
    </select>
  );
}

/** X5: open and late tasks per holder. A lead (the reassign right) opens the existing B12b reassign decision for one person from here. */
function WorkloadTable({ region, lead }: { region: string; lead: boolean }) {
  const { t } = useTranslation();
  const q = useWorkload({ region_id: region, stage_code: '' });
  const [act, setAct] = useState<UserRef | null>(null);
  if (q.isLoading) return <LoadingSkeleton testid="workload-loading" />;
  if (q.error instanceof ApiError && q.error.status === 403) return <NoPermission testid="workload-forbidden" />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => void q.refetch()} testid="workload-error" />;
  const { items, no_holder } = q.data;
  return (
    <>
      {!items.length && !no_holder.open ? <EmptyState testid="workload-empty" title={t('workload.empty')} /> : (
        <table className="card w-full text-sm" data-testid="workload-table">
          <thead><tr className="text-start text-mute"><th className="p-2 text-start font-semibold">{t('workload.person')}</th><th className="text-start font-semibold">{t('workload.team')}</th><th className="text-start font-semibold">{t('workload.open')}</th><th className="text-start font-semibold">{t('workload.late')}</th><th className="text-start font-semibold">{t('workload.by_level')}</th><th /></tr></thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.holder.id} data-testid={`workload-row-${r.holder.employee_id ?? r.holder.id}`} className="border-t border-line">
                <td className="p-2"><PersonTag name={r.holder.display_name} employeeId={r.holder.employee_id} /></td>
                <td><span className={`chip ${TEAM_TONE[r.team] ?? ''}`}>{t(`workload.team_${r.team}`)}</span></td>
                <td className="mono" data-testid="workload-open">{r.open}</td>
                <td>{r.late > 0 ? <span className="chip bg-lateBg text-lateInk mono" data-testid="workload-late">{r.late}</span> : <span className="mono text-mute" data-testid="workload-late">0</span>}</td>
                <td className="mono text-mute">{[['entry', 'L1'], ['review', 'L2'], ['approve', 'L2']].map(([k, l]) => ((r.by_level as Record<string, number | undefined>)[k as string] ? `${l}: ${(r.by_level as Record<string, number>)[k as string]}` : null)).filter(Boolean).join(' · ') || '—'}</td>
                <td className="p-2 text-end">{lead && <button className="btn px-2 py-1 text-xs" data-testid={`workload-reassign-${r.holder.employee_id ?? r.holder.id}`} onClick={() => setAct(r.holder)}><UserRoundCog size={14} aria-hidden />{t('workload.reassign')}</button>}</td>
              </tr>
            ))}
            {no_holder.open > 0 && (
              <tr className="border-t border-line bg-lockBg/40" data-testid="workload-no-holder"><td className="p-2" colSpan={2}>{t('workload.no_holder')}</td><td className="mono">{no_holder.open}</td><td className="mono">{no_holder.late}</td><td colSpan={2} /></tr>
            )}
          </tbody>
        </table>
      )}
      <p className="mt-2 text-xs text-mute">{t(lead ? 'workload.reassign_hint' : 'workload.no_reassign_hint')}</p>
      {act && <CoverDialog personOnly decision="reassign" alert={{ holder: act }} onClose={() => setAct(null)} />}
    </>
  );
}

/** X4: how long tasks sat at each level, per person or per team (completed visits only). */
function TimeReport({ region }: { region: string }) {
  const { t } = useTranslation();
  const units = useDurationUnits();
  const [group, setGroup] = useState<'holder' | 'team'>('holder');
  const q = useTimeReport({ group_by: group, region_id: region, stage_code: '', from: '', to: '' });
  return (
    <section aria-label={t('tis.report_title')} data-testid="time-report">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="font-bold">{t('tis.report_title')}</h2>
        <div role="group" aria-label={t('tis.group_by')} className="inline-flex overflow-hidden rounded-md border border-line">
          {(['holder', 'team'] as const).map((g) => <button key={g} type="button" aria-pressed={group === g} data-testid={`time-group-${g}`} onClick={() => setGroup(g)} className={`px-3 py-1 text-sm ${group === g ? 'bg-accentSoft font-semibold text-accentText' : 'bg-card text-mute hover:bg-hover'}`}>{t(`tis.group_${g}`)}</button>)}
        </div>
      </div>
      {q.isLoading ? <LoadingSkeleton rows={3} testid="time-loading" /> : q.isError || !q.data ? <ErrorState onRetry={() => void q.refetch()} testid="time-error" /> : !q.data.items.length ? <EmptyState testid="time-empty" title={t('tis.report_empty')} /> : (
        <table className="card w-full text-sm" data-testid="time-table">
          <thead><tr><th className="p-2 text-start font-semibold text-mute">{group === 'holder' ? t('workload.person') : t('workload.team')}</th>{(['entry', 'approve'] as const).map((k) => <th key={k} className="text-start font-semibold text-mute">{t(`level.${k}`)} · {t('tis.average')}</th>)}<th className="text-start font-semibold text-mute">{t('tis.visits')}</th></tr></thead>
          <tbody>
            {q.data.items.map((r, i) => {
              const lv = r.levels as Record<string, { visits: number; average_seconds: number } | undefined>;
              return (
                <tr key={r.holder?.id ?? r.team ?? i} className="border-t border-line" data-testid={`time-row-${r.holder?.employee_id ?? r.team ?? i}`}>
                  <td className="p-2">{r.holder ? <PersonTag name={r.holder.display_name} employeeId={r.holder.employee_id} /> : t(`workload.team_${r.team ?? 'none'}`)}</td>
                  {(['entry', 'approve'] as const).map((k) => <td key={k} className="mono">{lv[k] ? fmtDuration(lv[k]!.average_seconds, units) : '—'}</td>)}
                  <td className="mono">{Object.values(lv).reduce((a, x) => a + (x?.visits ?? 0), 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function Workload() {
  const { t } = useTranslation();
  const me = useMe(true);
  const [sp, setSp] = useSearchParams();
  const region = sp.get('region_id') ?? '';
  const setRegion = (v: string) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set('region_id', v); else n.delete('region_id'); return n; }, { replace: true });
  return (
    <div data-testid="page-workload" className="space-y-4">
      <PageHeader title={t('workload.title')} subtitle={t('workload.subtitle')} />
      <Toolbar filters={<RegionSelect value={region} onChange={setRegion} />} />
      <WorkloadTable region={region} lead={canReassign(me.data)} />
      <TimeReport region={region} />
    </div>
  );
}
