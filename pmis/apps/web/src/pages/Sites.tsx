import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useRegions, useSites, type SiteFilters } from '@/api/sites';
import { ExportDialog, ExportViewButton } from '@/components/ExportDialog';
import { MiniRail } from '@/components/Pipeline';
import { useVirtual } from '@/components/useVirtual';

const ROW = 52;
// ExportColumnCode values (stable codes of the `sites` part).
const SITE_COLUMNS = ['site_code', 'site_name', 'region', 'delivery_scenario', 'overall_status', 'current_milestone'];
const SCENARIOS = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'];
const STATUSES = ['not_started', 'in_progress', 'on_hold', 'completed', 'cancelled'];
const STAGES = ['site_release', 'pre_cw', 'cw', 'site_rfi', 'te_installation', 'on_air', 'te_pac', 'kpi_acceptance', 'hoto', 'final_closure'];
const TONE: Record<string, string> = { completed: 'bg-doneBg text-doneInk', in_progress: 'bg-openBg text-openInk', on_hold: 'bg-waitBg text-waitInk', not_started: 'bg-lockBg text-lockInk', cancelled: 'bg-lateBg text-lateInk' };

function Select({ id, value, onChange, all, options }: { id: string; value: string; onChange: (v: string) => void; all: string; options: [string, string][] }) {
  return (
    <select aria-label={all} data-testid={`sites-filter-${id}`} className="input w-auto" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{all}</option>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

export function Sites() {
  const { t, i18n } = useTranslation();
  const [f, setF] = useState<SiteFilters>({ q: '', region_id: '', scenario: '', overall_status: '', stage_code: '' });
  const [exp, setExp] = useState(false);
  const set = (k: keyof SiteFilters) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const regions = useRegions();
  const q = useSites(f);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[0]?.page.total ?? items.length;
  const viewport = Math.max(320, (typeof window === 'undefined' ? 800 : window.innerHeight) - 330);
  const v = useVirtual(items.length, ROW, viewport);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;
  useEffect(() => { if (hasNextPage && !isFetchingNextPage && v.end >= items.length - 20) void fetchNextPage(); }, [v.end, items.length, hasNextPage, isFetchingNextPage, fetchNextPage]);
  const rname = (id: number) => { const r = regions.data?.find((x) => x.id === id); return (i18n.language === 'ar' && r?.name_ar) || r?.name_en || String(id); };
  const ncols = 'grid grid-cols-[90px_minmax(140px,1.4fr)_100px_110px_120px_150px_90px] items-center gap-3 px-4';

  return (
    <div data-testid="page-sites">
      <h1 className="text-2xl font-bold">{t('sites.title')}</h1>
      <p className="mb-4 text-mute">{t('sites.subtitle')}</p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input className="input max-w-64" data-testid="sites-search" placeholder={t('sites.search')} aria-label={t('sites.search')} value={f.q} onChange={(e) => set('q')(e.target.value)} />
        <Select id="region" value={f.region_id} onChange={set('region_id')} all={t('sites.all_regions')} options={(regions.data ?? []).map((r) => [String(r.id), (i18n.language === 'ar' && r.name_ar) || r.name_en])} />
        <Select id="scenario" value={f.scenario} onChange={set('scenario')} all={t('sites.all_scenarios')} options={SCENARIOS.map((s) => [s, t(`scenario.${s}`)])} />
        <Select id="status" value={f.overall_status} onChange={set('overall_status')} all={t('sites.all_statuses')} options={STATUSES.map((s) => [s, t(`status.${s}`)])} />
        <Select id="stage" value={f.stage_code} onChange={set('stage_code')} all={t('sites.all_stages')} options={STAGES.map((s) => [s, t(`stage.${s}`)])} />
        <span className="ms-auto text-sm text-mute" data-testid="sites-count">{t('sites.count', { count: total })}</span>
        <button className="btn" data-testid="sites-export" onClick={() => setExp(true)}><Download size={16} />{t('export.open')}</button>
        <ExportViewButton testid="sites-export-view" source="sites" filters={Object.fromEntries(Object.entries(f).filter(([, x]) => x))} columns={SITE_COLUMNS} />
      </div>
      <div className="card overflow-hidden">
        <div className={`${ncols} border-b border-line bg-card2 py-2 text-sm font-semibold text-mute`} role="row">
          <span>{t('sites.code')}</span><span>{t('sites.name')}</span><span>{t('sites.region')}</span><span>{t('sites.scenario')}</span><span>{t('sites.status')}</span><span>{t('sites.pipeline')}</span><span>{t('sites.late')}</span>
        </div>
        <div data-testid="sites-list" role="list" className="relative overflow-y-auto" style={{ height: viewport }} onScroll={v.onScroll}>
          <div style={{ height: v.total }}>
            {items.slice(v.start, v.end).map((s, k) => (
              <Link key={s.id} to={`/sites/${s.id}`} role="listitem" data-testid={`site-row-${s.site_code}`} className={`${ncols} absolute inset-x-0 border-b border-line text-sm hover:bg-hover`} style={{ insetBlockStart: (v.start + k) * ROW, height: ROW }}>
                <b className="mono">{s.site_code}</b>
                <span className="truncate">{s.name}</span>
                <span>{rname(s.region_id)}</span>
                <span>{s.delivery_scenario ? t(`scenario.${s.delivery_scenario}`) : '—'}</span>
                <span><span className={`chip ${TONE[s.overall_status]}`}>{t(`status.${s.overall_status}`)}</span></span>
                <MiniRail rail={s.rail} />
                <span>{s.late_task_count ? <span className="chip bg-lateBg text-lateInk">{s.late_task_count}</span> : '—'}</span>
              </Link>
            ))}
          </div>
          {q.isSuccess && !items.length && <p className="p-6 text-center text-mute" data-testid="sites-empty">{t('sites.empty')}</p>}
        </div>
      </div>
      <ExportDialog open={exp} onClose={() => setExp(false)} />
    </div>
  );
}
