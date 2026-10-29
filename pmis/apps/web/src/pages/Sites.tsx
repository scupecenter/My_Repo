import type { SiteListItem, SitesExportColumnCode } from '@/api/types';
import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useRegions, useSites, useStreams, type SiteFilters } from '@/api/sites';
import { ExportDialog, ExportViewButton } from '@/components/ExportDialog';
import { MiniRail } from '@/components/Pipeline';
import { useVirtual } from '@/components/useVirtual';
import { DISMANTLE_CODE, isRealStream, statusOf, streamName, withDismantle } from '@/lib/streams';

const ROW = 52;
// ExportColumnCode values (stable codes of the `sites` part).
const SITE_COLUMNS: SitesExportColumnCode[] = ['site_code', 'site_name', 'region', 'scenario', 'overall_status', 'current_stage'];
const SCENARIOS = ['new_build', 'expansion', 'hot_swap', 'cold_swap', 'relocation'];
const STATUSES = ['not_started', 'in_progress', 'on_hold', 'completed', 'cancelled'];
const TONE: Record<string, string> = { completed: 'bg-doneBg text-doneInk', in_progress: 'bg-openBg text-openInk', on_hold: 'bg-waitBg text-waitInk', not_started: 'bg-lockBg text-lockInk', cancelled: 'bg-lateBg text-lateInk' };
const STREAM_TONE: Record<string, string> = { done: 'bg-doneBg text-doneInk', in_progress: 'bg-openBg text-openInk', not_started: 'bg-lockBg text-lockInk', na: 'bg-lockBg text-lockInk' };

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
  const [sp, setSp] = useSearchParams();
  const stream = sp.get('stream') ?? '';
  const [f, setF] = useState<Omit<SiteFilters, 'stream'>>({ q: '', region_id: '', scenario: '', overall_status: '', stage_code: '' });
  const [exp, setExp] = useState(false);
  const [showNa, setShowNa] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const setStream = (code: string) => setSp((p) => { const n = new URLSearchParams(p); if (code) n.set('stream', code); else n.delete('stream'); return n; }, { replace: true });
  const regions = useRegions();
  const streamsQ = useStreams();
  const tabs = withDismantle(streamsQ.data);
  const real = !!stream && isRealStream(stream, streamsQ.data); // Dismantle has no API stream yet: nothing is fetched for it
  const dismantle = stream === DISMANTLE_CODE && !real;

  const q = useSites({ ...f, ...(real ? { stream } : {}) }, !dismantle);
  // Sites where the stream does not apply are not in the stream list. They come from the unfiltered list (their `streams[]` says "na").
  const allQ = useSites({ ...f, stage_code: '' }, real);
  const { hasNextPage: moreAll, isFetchingNextPage: fetchingAll, fetchNextPage: nextAll } = allQ;
  useEffect(() => { if (real && moreAll && !fetchingAll) void nextAll(); }, [real, moreAll, fetchingAll, nextAll]);
  const inStream = q.data?.pages.flatMap((p) => p.items) ?? [];
  const naItems = real ? (allQ.data?.pages.flatMap((p) => p.items) ?? []).filter((s) => statusOf(s.streams, stream)?.state === 'na') : [];
  const items = dismantle ? [] : showNa && real ? [...inStream, ...naItems] : inStream;
  const total = (q.data?.pages[0]?.page.total ?? inStream.length) + (showNa && real ? naItems.length : 0);
  const stageOptions = (inStream[0] ?? q.data?.pages[0]?.items[0])?.rail.map((r) => r.code) ?? [];

  const viewport = Math.max(320, (typeof window === 'undefined' ? 800 : window.innerHeight) - 380);
  const v = useVirtual(items.length, ROW, viewport);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;
  useEffect(() => { if (hasNextPage && !isFetchingNextPage && v.end >= inStream.length - 20) void fetchNextPage(); }, [v.end, inStream.length, hasNextPage, isFetchingNextPage, fetchNextPage]);
  const rname = (id: number) => { const r = regions.data?.find((x) => x.id === id); return (i18n.language === 'ar' && r?.name_ar) || r?.name_en || String(id); };
  const stageName = (code?: string | null) => (code ? t(`stage.${code}`, { defaultValue: code }) : '—');
  const ncols = real
    ? 'grid grid-cols-[80px_minmax(130px,1.3fr)_90px_120px_150px_90px_70px_110px] items-center gap-3 px-4'
    : 'grid grid-cols-[90px_minmax(140px,1.4fr)_100px_110px_120px_150px_90px] items-center gap-3 px-4';
  const linkTo = (s: SiteListItem) => `/sites/${s.id}${real ? `?stream=${stream}` : ''}`;

  return (
    <div data-testid="page-sites">
      <h1 className="text-2xl font-bold">{t('sites.title')}</h1>
      <p className="mb-3 text-mute">{t('sites.subtitle')}</p>
      <div role="tablist" aria-label={t('sites.streams_label')} className="mb-3 flex flex-wrap gap-1 border-b border-line" data-testid="stream-tabs">
        {[{ code: '', label: t('sites.stream_all') }, ...tabs.map((s) => ({ code: s.code, label: streamName(t, i18n.language, s) }))].map((s) => (
          <button key={s.code || 'ALL'} role="tab" aria-selected={stream === s.code} data-testid={`stream-tab-${s.code || 'ALL'}`} onClick={() => setStream(s.code)}
            className={`px-4 py-2 text-sm font-semibold ${stream === s.code ? 'border-b-2 border-accent text-accentText' : 'text-mute hover:text-ink'}`}>{s.label}</button>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input className="input max-w-64" data-testid="sites-search" placeholder={t('sites.search')} aria-label={t('sites.search')} value={f.q} onChange={(e) => set('q')(e.target.value)} />
        <Select id="region" value={f.region_id} onChange={set('region_id')} all={t('sites.all_regions')} options={(regions.data ?? []).map((r) => [String(r.id), (i18n.language === 'ar' && r.name_ar) || r.name_en])} />
        <Select id="scenario" value={f.scenario} onChange={set('scenario')} all={t('sites.all_scenarios')} options={SCENARIOS.map((s) => [s, t(`scenario.${s}`)])} />
        <Select id="status" value={f.overall_status} onChange={set('overall_status')} all={t('sites.all_statuses')} options={STATUSES.map((s) => [s, t(`status.${s}`)])} />
        <Select id="stage" value={f.stage_code} onChange={set('stage_code')} all={t('sites.all_stages')} options={stageOptions.map((s) => [s, stageName(s)])} />
        {real && (
          <label className="flex items-center gap-2 text-sm" title={t('sites.na_hint')}>
            <input type="checkbox" data-testid="sites-show-na" checked={showNa} onChange={(e) => setShowNa(e.target.checked)} />
            <span data-testid="sites-show-na-label">{t('sites.show_na', { count: naItems.length })}</span>
          </label>
        )}
        <span className="ms-auto text-sm text-mute" data-testid="sites-count">{t('sites.count', { count: total })}</span>
        <button className="btn" data-testid="sites-export" onClick={() => setExp(true)}><Download size={16} />{t('export.open')}</button>
        <ExportViewButton testid="sites-export-view" source="sites" filters={Object.fromEntries(Object.entries({ ...f, ...(real ? { stream } : {}) }).filter(([, x]) => x))} columns={SITE_COLUMNS} />
      </div>
      {dismantle ? (
        <p className="card p-6 text-mute" data-testid="stream-dismantle-todo">{t('sites.dismantle_todo')}</p>
      ) : (
        <div className="card overflow-hidden" data-stream={stream || 'ALL'}>
          <div className={`${ncols} border-b border-line bg-card2 py-2 text-sm font-semibold text-mute`} role="row">
            <span>{t('sites.code')}</span><span>{t('sites.name')}</span><span>{t('sites.region')}</span>
            {real ? <><span>{t('sites.stream_status')}</span><span>{t('sites.current_stage')}</span><span>{t('sites.progress')}</span><span>{t('sites.late')}</span><span>{t('sites.milestone')}</span></>
              : <><span>{t('sites.scenario')}</span><span>{t('sites.status')}</span><span>{t('sites.pipeline')}</span><span>{t('sites.late')}</span></>}
          </div>
          <div data-testid="sites-list" role="list" className="relative overflow-y-auto" style={{ height: viewport }} onScroll={v.onScroll}>
            <div style={{ height: v.total }}>
              {items.slice(v.start, v.end).map((s, k) => {
                const st = statusOf(s.streams, stream);
                const na = real && st?.state === 'na';
                return (
                  <Link key={s.id} to={linkTo(s)} role="listitem" data-testid={`site-row-${s.site_code}`} data-stream-state={st?.state} className={`${ncols} absolute inset-x-0 border-b border-line text-sm hover:bg-hover ${na ? 'opacity-60' : ''}`} style={{ insetBlockStart: (v.start + k) * ROW, height: ROW }}>
                    <b className="mono">{s.site_code}</b>
                    <span className="truncate">{s.name}</span>
                    <span>{rname(s.region_id)}</span>
                    {real ? (
                      <>
                        <span><span className={`chip ${STREAM_TONE[st?.state ?? 'na']}`} data-testid={`stream-state-${s.site_code}`}>{t(`streamState.${st?.state ?? 'na'}`)}</span></span>
                        <span data-testid={`stream-stage-${s.site_code}`}>{stageName(st?.current_stage)}</span>
                        <span className="mono" data-testid={`stream-progress-${s.site_code}`}>{st ? `${st.done_tasks}/${st.total_tasks}` : '—'}</span>
                        <span>{st?.late_count ? <span className="chip bg-lateBg text-lateInk" data-testid={`stream-late-${s.site_code}`}>{st.late_count}</span> : '—'}</span>
                        <span className="mono" data-testid={`stream-ms-${s.site_code}`}>{st?.milestone_date ?? '—'}</span>
                      </>
                    ) : (
                      <>
                        <span>{s.delivery_scenario ? t(`scenario.${s.delivery_scenario}`) : '—'}</span>
                        <span><span className={`chip ${TONE[s.overall_status]}`}>{t(`status.${s.overall_status}`)}</span></span>
                        <MiniRail rail={s.rail} />
                        <span>{s.late_task_count ? <span className="chip bg-lateBg text-lateInk">{s.late_task_count}</span> : '—'}</span>
                      </>
                    )}
                  </Link>
                );
              })}
            </div>
            {q.isSuccess && !items.length && <p className="p-6 text-center text-mute" data-testid="sites-empty">{t('sites.empty')}</p>}
          </div>
        </div>
      )}
      <ExportDialog open={exp} onClose={() => setExp(false)} />
    </div>
  );
}
