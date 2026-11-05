import type { SiteListItem, SitesExportColumnCode } from '@/api/types';
import { Download, FileDown, FilePlus2, FileUp, Map as MapIcon, RotateCcw, Table2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useMe } from '@/api/hooks';
import { downloadTemplate, useTemplates } from '@/api/registers';
import { useRegions, useSites, useStreams, useViews } from '@/api/sites';
import { batchPath } from '@/api/types';
import { TemplateUploadDialog } from '@/components/TemplateUploadDialog';
import { isAdmin } from '@/lib/perm';
import { registerErrorMessage } from '@/lib/registerErrors';
import { ExportDialog, ExportViewButton } from '@/components/ExportDialog';
import { SavedViews } from '@/components/SavedViews';
import { MoreMenu, PageHeader, Toolbar } from '@/components/PageHeader';
import { ActiveChips, BulkBar, ColumnMenu, Empty, HeaderRow, pin, QuickFilter, SelectBox, tracks, totalWidth, Trunc, useTablePrefs } from '@/components/TableKit';
import { useToast } from '@/components/Toast';
import type { ColDef } from '@/lib/tablePrefs';
import { EmptyState, NoResults } from '@/components/States';
import { MiniRail } from '@/components/Pipeline';
import { SiteMap } from '@/components/SiteMap';
import { useVirtual } from '@/components/useVirtual';
import { DEFAULT_STREAMS, DEFAULT_VIEWS, DISMANTLE_CODE, isRealStream, statusOf, streamName, viewName } from '@/lib/streams';

const ROWS = { comfortable: 52, compact: 38 } as const;
const DEFS_ALL: ColDef[] = [{ id: 'code', w: 100, min: 70, pinned: true }, { id: 'name', w: 220, min: 100 }, { id: 'region', w: 120, min: 80 }, { id: 'scenario', w: 120, min: 80 }, { id: 'status', w: 130, min: 90 }, { id: 'pipeline', w: 170, min: 120 }, { id: 'late', w: 80, min: 60 }];
const DEFS_STREAM: ColDef[] = [{ id: 'code', w: 100, min: 70, pinned: true }, { id: 'name', w: 220, min: 100 }, { id: 'region', w: 120, min: 80 }, { id: 'stream_status', w: 130, min: 90 }, { id: 'stage', w: 150, min: 90 }, { id: 'progress', w: 90, min: 60 }, { id: 'late', w: 80, min: 60 }, { id: 'milestone', w: 120, min: 90 }];
const LABEL: Record<string, string> = { code: 'sites.code', name: 'sites.name', region: 'sites.region', scenario: 'sites.scenario', status: 'sites.status', pipeline: 'sites.pipeline', late: 'sites.late', stream_status: 'sites.stream_status', stage: 'sites.current_stage', progress: 'sites.progress', milestone: 'sites.milestone' };
const F_KEYS = ['q', 'region_id', 'scenario', 'overall_status', 'stage_code'] as const;
// P10: what a saved view of the Site Register keeps (the filters of the URL, the quick filter included).
const VIEW_EMPTY = { q: '', region_id: '', scenario: '', overall_status: '', stage_code: '', bucket: '' };
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
  const view = sp.get('view') ?? '';
  const [exp, setExp] = useState(false);
  const [showNa, setShowNa] = useState(false);
  // Filters, quick filter and the selected row live in the URL, so Back and shared links restore them (plan F9).
  const f = { q: sp.get('q') ?? '', region_id: sp.get('region_id') ?? '', scenario: sp.get('scenario') ?? '', overall_status: sp.get('overall_status') ?? '', stage_code: sp.get('stage_code') ?? '' };
  const bucket = sp.get('bucket') ?? '';
  // 0.14.5: the sites the map cannot draw (the link of the dashboard map), and the map layout of the register (SC-10)
  const coordinates = sp.get('coordinates') === 'missing' ? 'missing' : '';
  const asMap = sp.get('layout') === 'map';
  const sel = sp.get('sel') ?? '';
  const activeFilters = Object.values(f).filter(Boolean).length + (bucket ? 1 : 0) + (coordinates ? 1 : 0);
  const setParams = (kv: Record<string, string>) => setSp((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(kv)) { if (v) n.set(k, v); else n.delete(k); } return n; }, { replace: true });
  const set = (k: keyof typeof f) => (v: string) => setParams({ [k]: v, sel: '' });
  const clearAll = () => setParams({ ...Object.fromEntries(F_KEYS.map((k) => [k, ''])), bucket: '', coordinates: '', sel: '' });
  const toast = useToast();
  const nav = useNavigate();
  // Site creation (contract 0.14.0, Q460): the New sites template is listed only for those who may create sites
  const me = useMe(true).data;
  const newTpl = useTemplates().data?.find((x) => x.template_id === 'TPL-SITE-NEW');
  const canCreate = isAdmin(me) || !!me?.effective.grants.some((g) => g.module_key === 'sites' && (g.action as string) === 'create');
  const [upSites, setUpSites] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const regions = useRegions();
  const viewsQ = useViews();
  const streamsQ = useStreams();
  // Name of the Site Register sub-menu that is open (sidebar request 2026-11-05): the view wins, else the stream; empty = all sites.
  const viewRef = view ? (viewsQ.data ?? DEFAULT_VIEWS).find((x) => x.code === view) : undefined;
  const streamRef = stream ? (streamsQ.data?.length ? streamsQ.data : DEFAULT_STREAMS).find((x) => x.code === stream) : undefined;
  const subMenu = view ? (viewRef ? viewName(i18n.language, viewRef) : view) : streamRef ? streamName(t, i18n.language, streamRef) : '';
  const real = !!stream && isRealStream(stream, streamsQ.data); // Dismantle has no API stream yet: nothing is fetched for it
  const dismantle = stream === DISMANTLE_CODE && !real;

  const q = useSites({ ...f, ...(bucket ? { bucket } : {}), ...(coordinates ? { coordinates } : {}), ...(real ? { stream } : {}), ...(view ? { view } : {}) }, !dismantle && !asMap);
  // Sites where the stream does not apply are not in the stream list. They come from the unfiltered list (their `streams[]` says "na").
  const allQ = useSites({ ...f, stage_code: '', ...(bucket ? { bucket } : {}), ...(coordinates ? { coordinates } : {}), ...(view ? { view } : {}) }, real && !asMap);
  const { hasNextPage: moreAll, isFetchingNextPage: fetchingAll, fetchNextPage: nextAll } = allQ;
  useEffect(() => { if (real && moreAll && !fetchingAll) void nextAll(); }, [real, moreAll, fetchingAll, nextAll]);
  const inStream = q.data?.pages.flatMap((p) => p.items) ?? [];
  const naItems = real ? (allQ.data?.pages.flatMap((p) => p.items) ?? []).filter((s) => statusOf(s.streams, stream)?.state === 'na') : [];
  const items = dismantle ? [] : showNa && real ? [...inStream, ...naItems] : inStream;
  const total = (q.data?.pages[0]?.page.total ?? inStream.length) + (showNa && real ? naItems.length : 0);
  const stageOptions = (inStream[0] ?? q.data?.pages[0]?.items[0])?.rail.map((r) => r.code) ?? [];

  const tbl = useTablePrefs(real ? 'sites-stream' : 'sites', real ? DEFS_STREAM : DEFS_ALL);
  const ROW = ROWS[tbl.density];
  const viewport = Math.max(320, (typeof window === 'undefined' ? 800 : window.innerHeight) - 380);
  const v = useVirtual(items.length, ROW, viewport);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;
  useEffect(() => { if (hasNextPage && !isFetchingNextPage && v.end >= inStream.length - 20) void fetchNextPage(); }, [v.end, inStream.length, hasNextPage, isFetchingNextPage, fetchNextPage]);
  const scroller = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const scrollKey = `pmis.scroll.sites.${stream || 'ALL'}`;
  useLayoutEffect(() => { // back from a site: the list comes back where it was
    const el = scroller.current;
    if (!el || restored.current || !items.length) return;
    restored.current = true;
    const y = Number(sessionStorage.getItem(scrollKey) ?? 0);
    if (y) el.scrollTop = y;
  }, [items.length, scrollKey]);
  const rname = (id: number) => { const r = regions.data?.find((x) => x.id === id); return (i18n.language === 'ar' && r?.name_ar) || r?.name_en || String(id); };
  const stageName = (code?: string | null) => (code ? t(`stage.${code}`, { defaultValue: code }) : '—');
  const label = (id: string) => t(LABEL[id]);
  const cols = tbl.cols, W = totalWidth(cols, true);
  const linkTo = (s: SiteListItem) => `/sites/${s.id}${new URLSearchParams([...(real ? [['stream', stream]] : []), ...(view ? [['view', view]] : [])]).toString().replace(/^(?=.)/, '?')}`;
  const flip = (code: string) => setPicked((p) => { const n = new Set(p); if (n.has(code)) n.delete(code); else n.add(code); return n; });
  const allCodes = items.map((s) => s.site_code), allPicked = allCodes.length > 0 && allCodes.every((c) => picked.has(c));
  const chips = [
    ...(f.q ? [{ key: 'q', label: t('table.filter_q', { v: f.q }), onRemove: () => set('q')('') }] : []),
    ...(f.region_id ? [{ key: 'region_id', label: t('table.filter_region', { v: rname(Number(f.region_id)) }), onRemove: () => set('region_id')('') }] : []),
    ...(f.scenario ? [{ key: 'scenario', label: t('table.filter_scenario', { v: t(`scenario.${f.scenario}`) }), onRemove: () => set('scenario')('') }] : []),
    ...(f.overall_status ? [{ key: 'overall_status', label: t('table.filter_status', { v: t(`status.${f.overall_status}`) }), onRemove: () => set('overall_status')('') }] : []),
    ...(f.stage_code ? [{ key: 'stage_code', label: t('table.filter_stage', { v: stageName(f.stage_code) }), onRemove: () => set('stage_code')('') }] : []),
    ...(coordinates ? [{ key: 'coordinates', label: t('table.filter_coords'), onRemove: () => setParams({ coordinates: '' }) }] : []),
    ...(bucket ? [{ key: 'bucket', label: t('table.filter_bucket', { v: t(bucket === 'mine' ? 'table.mine' : 'table.late') }), onRemove: () => setParams({ bucket: '' }) }] : []),
  ];

  const cell = (id: string, s: SiteListItem) => {
    const st = statusOf(s.streams, stream);
    switch (id) {
      case 'code': return <b className="mono">{s.site_code}</b>;
      case 'name': return <span className="flex min-w-0 items-baseline gap-2"><Trunc text={s.name} />{s.name_ar && <span dir="rtl" lang="ar" className="truncate text-xs text-mute" data-testid={`site-name-ar-${s.site_code}`}>{s.name_ar}</span>}</span>;
      case 'region': return <Trunc text={rname(s.region_id)} />;
      case 'stream_status': return <span className={`chip ${STREAM_TONE[st?.state ?? 'na']}`} data-testid={`stream-state-${s.site_code}`}>{t(`streamState.${st?.state ?? 'na'}`)}</span>;
      case 'stage': return <span data-testid={`stream-stage-${s.site_code}`}><Trunc text={stageName(st?.current_stage)} /></span>;
      case 'progress': return <span className="mono" data-testid={`stream-progress-${s.site_code}`}>{st ? `${st.done_tasks}/${st.total_tasks}` : <Empty />}</span>;
      case 'milestone': return <span className="mono" data-testid={`stream-ms-${s.site_code}`}>{st?.milestone_date ?? <Empty />}</span>;
      case 'scenario': return s.delivery_scenario ? <Trunc text={t(`scenario.${s.delivery_scenario}`)} /> : <Empty />;
      case 'status': return <span className={`chip ${TONE[s.overall_status]}`}>{t(`status.${s.overall_status}`)}</span>;
      case 'pipeline': return <MiniRail rail={s.rail} />;
      default: { // late
        const n = real ? st?.late_count : s.late_task_count;
        return n ? <span className="chip bg-lateBg text-lateInk" data-testid={real ? `stream-late-${s.site_code}` : undefined}>{n}</span> : <Empty />;
      }
    }
  };

  return (
    <div data-testid="page-sites">
      <PageHeader title={subMenu ? `${t('sites.title')}: ${subMenu}` : t('sites.title')} subtitle={t('sites.subtitle')} context={(canCreate || newTpl) && (
        <span className="ms-auto flex flex-wrap gap-1" data-testid="sites-create-actions">
          {canCreate && <Link className="btn btn-primary px-2 py-1 text-xs" to="/sites/new" data-testid="sites-new"><FilePlus2 size={14} />{t('sites.new_site')}</Link>}
          {newTpl && <><button type="button" className="btn px-2 py-1 text-xs" data-testid="sites-template-download"
            onClick={() => downloadTemplate(newTpl.template_id).then((n) => toast(t('grid.downloaded', { name: n })), (e) => toast(registerErrorMessage(t, e), 'err'))}><FileDown size={14} />{t('sites.download_template')}</button>
          <button type="button" className="btn px-2 py-1 text-xs" data-testid="sites-template-upload" onClick={() => setUpSites(true)}><FileUp size={14} />{t('sites.upload_template')}</button></>}
        </span>)} />
      <Toolbar activeFilters={activeFilters} activeLabel={t('states.filters')}
        filters={<>
        <SavedViews screen={real ? 'sites-stream' : 'sites'} value={{ ...f, bucket }} empty={VIEW_EMPTY} table={tbl}
          onApply={(v) => setParams({ ...Object.fromEntries(Object.keys(VIEW_EMPTY).map((k) => [k, String((v as Record<string, unknown>)[k] ?? '')])), sel: '' })} />
        <input className="input max-w-64" data-testid="sites-search" placeholder={t('sites.search')} aria-label={t('sites.search')} value={f.q} onChange={(e) => set('q')(e.target.value)} />
        <Select id="region" value={f.region_id} onChange={set('region_id')} all={t('sites.all_regions')} options={(regions.data ?? []).map((r) => [String(r.id), (i18n.language === 'ar' && r.name_ar) || r.name_en])} />
        <Select id="scenario" value={f.scenario} onChange={set('scenario')} all={t('sites.all_scenarios')} options={SCENARIOS.map((s) => [s, t(`scenario.${s}`)])} />
        <Select id="status" value={f.overall_status} onChange={set('overall_status')} all={t('sites.all_statuses')} options={STATUSES.map((s) => [s, t(`status.${s}`)])} />
        <Select id="stage" value={f.stage_code} onChange={set('stage_code')} all={t('sites.all_stages')} options={stageOptions.map((s) => [s, stageName(s)])} />
        <QuickFilter testid="sites-quick-mine" on={bucket === 'mine'} onClick={() => setParams({ bucket: bucket === 'mine' ? '' : 'mine', sel: '' })}>{t('table.mine')}</QuickFilter>
        <QuickFilter testid="sites-quick-late" on={bucket === 'late'} onClick={() => setParams({ bucket: bucket === 'late' ? '' : 'late', sel: '' })}>{t('table.late')}</QuickFilter>
        {real && (
          <label className="flex items-center gap-2 text-sm" title={t('sites.na_hint')}>
            <input type="checkbox" data-testid="sites-show-na" checked={showNa} onChange={(e) => setShowNa(e.target.checked)} />
            <span data-testid="sites-show-na-label">{t('sites.show_na', { count: naItems.length })}</span>
          </label>
        )}
        </>}
        count={<span className="text-sm text-mute" data-testid="sites-count">{t('sites.count', { count: total })}</span>}
        tools={<>
        <button type="button" className="btn px-2 py-1 text-xs" data-testid="sites-layout" aria-pressed={asMap} onClick={() => setParams({ layout: asMap ? '' : 'map', sel: '' })}>
          {asMap ? <><Table2 size={14} />{t('sites.table')}</> : <><MapIcon size={14} />{t('sites.map')}</>}
        </button>
        <ColumnMenu api={tbl} label={label} />
        <ExportViewButton testid="sites-export-view" source="sites" filters={Object.fromEntries(Object.entries({ ...f, ...(bucket ? { bucket } : {}), ...(real ? { stream } : {}) }).filter(([, x]) => x))} columns={SITE_COLUMNS} />
        <MoreMenu items={[
          { id: 'export', label: t('export.open'), icon: <Download size={16} />, testid: 'sites-export', onSelect: () => setExp(true) },
          { id: 'reset', label: t('table.reset'), icon: <RotateCcw size={16} />, testid: 'sites-reset-cols', onSelect: tbl.reset },
        ]} />
        </>} />
      <ActiveChips chips={chips} onClear={clearAll} />
      {dismantle ? (
        <Navigate to="/registers/dismantle" replace />
      ) : asMap ? (
        // SC-10: the same map as the dashboard; a stream sub-menu shows the sites whose current stream it is
        <SiteMap testid="sites-map" height={560} outer={{ region_id: f.region_id, scenario: f.scenario, ...(real ? { stream } : {}) }} />
      ) : (
        <div className="card overflow-hidden" data-stream={stream || 'ALL'} data-density={tbl.density}>
          <div ref={scroller} data-testid="sites-scroll" className="relative overflow-auto" style={{ height: viewport }} onScroll={(e) => { v.onScroll(e); sessionStorage.setItem(scrollKey, String(e.currentTarget.scrollTop)); }}>
            <HeaderRow api={tbl} label={label} select={{ checked: allPicked, indeterminate: picked.size > 0, onChange: () => setPicked(allPicked ? new Set() : new Set(allCodes)), label: t('table.select_all'), testid: 'sites-select-all' }} />
            <div data-testid="sites-list" role="list" className="relative" style={{ height: v.total, minWidth: W }}>
              {items.slice(v.start, v.end).map((s, k) => {
                const st = statusOf(s.streams, stream);
                const na = real && st?.state === 'na', on = picked.has(s.site_code), cur = sel === s.site_code;
                return (
                  <div key={s.id} role="listitem" aria-selected={on || cur} data-selected={cur || undefined} className={`absolute inset-x-0 border-b border-line text-sm ${on ? 'bg-accentSoft' : 'bg-card hover:bg-hover'} ${cur ? 'ring-2 ring-inset ring-accent' : ''} ${na ? 'opacity-60' : ''}`} style={{ insetBlockStart: (v.start + k) * ROW, height: ROW }}>
                    <span className="absolute inset-y-0 start-0 z-20 flex w-9 items-center justify-center"><SelectBox checked={on} onChange={() => flip(s.site_code)} label={t('table.select_row', { code: s.site_code })} testid={`site-select-${s.site_code}`} /></span>
                    <Link to={linkTo(s)} data-testid={`site-row-${s.site_code}`} data-stream-state={st?.state} onClick={() => setParams({ sel: s.site_code })} className="grid h-full items-center bg-inherit" style={{ gridTemplateColumns: tracks(cols, true) }}>
                      <span aria-hidden />
                      {cols.map((c) => { const p = pin(c, true); return <span key={c.id} data-col={c.id} className={`min-w-0 px-2 ${p.className}`} style={p.style}>{cell(c.id, s)}</span>; })}
                    </Link>
                  </div>
                );
              })}
              {q.isSuccess && !items.length && (activeFilters ? <NoResults testid="sites-empty" onClear={clearAll} /> : <EmptyState testid="sites-empty" title={t('sites.empty')} />)}
            </div>
          </div>
        </div>
      )}
      <BulkBar testid="sites-bulk" count={picked.size} loaded={items.length} total={total} onClear={() => setPicked(new Set())}>
        {picked.size === 1 && <button type="button" className="btn" data-testid="sites-bulk-open" onClick={() => { const s = items.find((x) => picked.has(x.site_code)); if (s) nav(linkTo(s)); }}>{t('table.open_selected')}</button>}
        <button type="button" className="btn" data-testid="sites-bulk-copy" onClick={() => { void navigator.clipboard?.writeText([...picked].join('\n')); toast(t('table.copied', { count: picked.size })); }}>{t('table.copy_codes')}</button>
      </BulkBar>
      <ExportDialog open={exp} onClose={() => setExp(false)} />
      {upSites && newTpl && <TemplateUploadDialog open onClose={() => setUpSites(false)} templateId={newTpl.template_id} templateName={`${(i18n.language === 'ar' && newTpl.name_ar) || newTpl.name_en} · v${newTpl.current_version}`}
        kind="sites" onDone={(b) => { setUpSites(false); toast(t('grid.uploaded')); nav(batchPath(b)); }} />}
    </div>
  );
}
