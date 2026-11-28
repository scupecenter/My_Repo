import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSites } from '@/api/sites';
import type { SiteCompare as Compare } from '@/api/types';
import { useSiteCompare } from '@/api/x';
import { ErrorState, LoadingSkeleton } from '@/components/States';

/**
 * Compare two sites side by side (contract 0.15.483, migration 0624). Read only. The first site is the page's, the second is picked from the sites the
 * caller may see. The difference column is the second site minus the first: a plus means the second took longer.
 */
const NO_FILTER = { region_id: '', scenario: '', overall_status: '', stage_code: '' };

export function SiteCompare({ siteId }: { siteId: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [other, setOther] = useState('');
  const list = useSites({ q, ...NO_FILTER }, q.trim().length >= 2);
  const cmp = useSiteCompare(siteId, other);
  const options = (list.data?.pages.flatMap((p) => p.items) ?? []).filter((s) => s.id !== siteId).slice(0, 12);
  return (
    <section className="card space-y-3 p-4" data-testid="site-compare" aria-label={t('siteCompare.title')}>
      <header>
        <h2 className="text-lg font-bold" title={t('siteCompare.tip')}>{t('siteCompare.title')}</h2>
        <p className="text-xs text-mute">{t('siteCompare.note')}</p>
      </header>
      {!other ? (
        <div>
          <input className="input w-72" data-testid="sc-search" aria-label={t('siteCompare.search')} placeholder={t('siteCompare.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          <p className="mt-1 text-xs text-mute">{t('siteCompare.pick')}</p>
          <ul className="mt-1 max-h-48 overflow-y-auto text-sm">
            {options.map((s) => <li key={s.id}><button className="w-full px-2 py-1 text-start hover:bg-card2" data-testid={`sc-pick-${s.id}`} onClick={() => setOther(s.id)}>{s.site_code} · {s.name}</button></li>)}
            {q.trim().length >= 2 && list.data && options.length === 0 && <li className="px-2 py-1 text-mute" data-testid="sc-none">{t('siteCompare.none')}</li>}
          </ul>
        </div>
      ) : cmp.isLoading ? <LoadingSkeleton rows={4} testid="sc-loading" />
        : cmp.isError || !cmp.data ? <ErrorState onRetry={() => void cmp.refetch()} testid="sc-error" />
        : <Result d={cmp.data} onChange={() => { setOther(''); setQ(''); }} />}
    </section>
  );
}

function Result({ d, onChange }: { d: Compare; onChange: () => void }) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const num = (v: number | null | undefined) => (v == null ? '—' : String(v));
  const rows: [string, string, string][] = [
    [t('siteCompare.status'), t(`status.${d.a.status}`, { defaultValue: d.a.status }), t(`status.${d.b.status}`, { defaultValue: d.b.status })],
    [t('siteCompare.milestone'), d.a.current_milestone ?? '—', d.b.current_milestone ?? '—'],
    [t('siteCompare.tasks'), num(d.a.tasks.applicable), num(d.b.tasks.applicable)],
    [t('siteCompare.approved'), num(d.a.tasks.approved), num(d.b.tasks.approved)],
    [t('siteCompare.open'), num(d.a.tasks.open), num(d.b.tasks.open)],
    [t('siteCompare.overdue'), num(d.a.tasks.overdue), num(d.b.tasks.overdue)],
    [t('siteCompare.worst'), num(d.a.tasks.worst_delay_days), num(d.b.tasks.worst_delay_days)],
  ];
  const nm = (s: { name?: string | null; name_ar?: string | null }) => (ar && s.name_ar ? s.name_ar : s.name ?? '');
  return (
    <div className="space-y-4" data-testid="sc-result">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{d.a.site_code} {nm(d.a)} <span className="text-mute">vs</span> {d.b.site_code} {nm(d.b)}</p>
        <button className="btn" data-testid="sc-change" onClick={onChange}>{t('siteCompare.change')}</button>
      </div>
      <table className="w-full text-sm">
        <thead><tr className="text-mute"><th className="p-1 text-start" /><th className="p-1 text-start" data-testid="sc-head-a">{d.a.site_code}</th><th className="p-1 text-start" data-testid="sc-head-b">{d.b.site_code}</th></tr></thead>
        <tbody>{rows.map(([k, a, b]) => <tr key={k} className="border-t border-line"><td className="p-1 text-mute">{k}</td><td className="p-1">{a}</td><td className="p-1">{b}</td></tr>)}</tbody>
      </table>
      <table className="w-full text-sm" data-testid="sc-stages">
        <thead><tr className="text-mute"><th className="p-1 text-start">{t('siteCompare.stage')}</th><th className="p-1 text-start">{d.a.site_code}</th><th className="p-1 text-start">{d.b.site_code}</th><th className="p-1 text-start">{t('siteCompare.diff')}</th></tr></thead>
        <tbody>
          {d.stages.map((s) => (
            <tr key={s.code} className="border-t border-line" data-testid={`sc-stage-${s.code}`}>
              <td className="p-1">{s.code} · {ar && s.name_ar ? s.name_ar : s.name_en}</td>
              <td className="p-1">{s.a_days != null ? t('stageTimes.days', { count: s.a_days }) : t(`stageTimes.state_${s.a_state ?? 'not_started'}`)}</td>
              <td className="p-1">{s.b_days != null ? t('stageTimes.days', { count: s.b_days }) : t(`stageTimes.state_${s.b_state ?? 'not_started'}`)}</td>
              <td className={`p-1 ${(s.diff_days ?? 0) > 0 ? 'text-danger' : ''}`} data-testid={`sc-diff-${s.code}`}>{s.diff_days == null ? '—' : s.diff_days > 0 ? `+${s.diff_days}` : String(s.diff_days)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
