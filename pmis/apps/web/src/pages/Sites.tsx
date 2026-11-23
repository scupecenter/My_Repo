import type { SiteListItem, SitesExportColumnCode } from '@/api/types';
import { errText } from '@/components/FormDialog';
import { Site360Grid, type Site360GridRow } from '@/components/Site360Grid';
import { Site360SourcePanel } from '@/components/Site360Source';
import { useRefreshSite360Rows, useSaveSite360Cell, useSite360RowsPaged, useSite360Sections } from '@/api/site360';
import { SitesBulkEdit } from '@/components/SitesBulkEdit';
import { Columns3, Download, FileDown, FilePlus2, FileUp, Map as MapIcon, Pencil, RotateCcw, Table2, TableProperties } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useMe } from '@/api/hooks';
import { downloadTemplate, useTemplates } from '@/api/registers';
import { useRegions, useSites, useStageCodes, useStreams, useViews } from '@/api/sites';
import { batchPath } from '@/api/types';
import { TemplateUploadDialog } from '@/components/TemplateUploadDialog';
import { LocksDialog } from '@/components/WorkflowLocks';
import { isAdmin } from '@/lib/perm';
import { registerErrorMessage } from '@/lib/registerErrors';
import { ExportDialog, ExportViewButton } from '@/components/ExportDialog';
import { SavedViews } from '@/components/SavedViews';
import { FilterBuilder } from '@/components/FilterBuilder';
import { decodeFilter, encodeFilter, type FilterTree } from '@/api/views';
import { MoreMenu, PageHeader, Toolbar } from '@/components/PageHeader';
import { ActiveChips, BulkBar, ColumnMenu, DensityToggle, Empty, gxRow, HeaderRow, pin, QuickFilter, SelectBox, StatusChip, tracks, totalWidth, Trunc, useAutoFit, useTablePrefs } from '@/components/TableKit';
import { Tip } from '@/components/Tip';
import type { FitSample } from '@/lib/tablePrefs';
import { useToast } from '@/components/Toast';
import type { ColDef } from '@/lib/tablePrefs';
import { EmptyState, NoResults } from '@/components/States';
import { MiniRail } from '@/components/Pipeline';
import { SiteMap } from '@/components/SiteMap';
import { SitesWideTable } from '@/components/SitesWideTable';
import { SitesBoard, SWIMLANES, type Swimlane } from '@/components/SitesBoard';
import { useVirtual } from '@/components/useVirtual';
import { SITE360_MASTER, SITE360_NAV } from '@/lib/site360Menus';
import { fmtDate } from '@/lib/time';
import { DEFAULT_STREAMS, DEFAULT_VIEWS, DISMANTLE_CODE, isRealStream, statusOf, streamName, viewName } from '@/lib/streams';

const ROWS = { comfortable: 52, compact: 38 } as const;
const DEFS_ALL: ColDef[] = [{ id: 'code', w: 100, min: 70, pinned: true }, { id: 'name', w: 220, min: 100, max: 340, pinned: true }, { id: 'region', w: 120, min: 80, max: 240 }, { id: 'scenario', w: 120, min: 80 }, { id: 'status', w: 130, min: 90 }, { id: 'pipeline', w: 170, min: 120 }, { id: 'late', w: 80, min: 60 }, { id: 'locks', w: 100, min: 70 }, { id: 'gaps', w: 100, min: 70 }];
const DEFS_STREAM: ColDef[] = [{ id: 'code', w: 100, min: 70, pinned: true }, { id: 'name', w: 220, min: 100, max: 340, pinned: true }, { id: 'region', w: 120, min: 80, max: 240 }, { id: 'stream_status', w: 130, min: 90 }, { id: 'stage', w: 150, min: 90 }, { id: 'progress', w: 90, min: 60 }, { id: 'late', w: 80, min: 60 }, { id: 'milestone', w: 120, min: 90 }];
const LABEL: Record<string, string> = { code: 'sites.code', name: 'sites.name', region: 'sites.region', scenario: 'sites.scenario', status: 'sites.status', pipeline: 'sites.pipeline', late: 'sites.late', stream_status: 'sites.stream_status', stage: 'sites.current_stage', progress: 'sites.progress', milestone: 'sites.milestone', locks: 'sites.locks', gaps: 'sites.gaps' };
const F_KEYS = ['q', 'region_id', 'scenario', 'overall_status', 'stage_code'] as const;
// P10: what a saved view of the Site Register keeps (the filters of the URL, the quick filter included).
const VIEW_EMPTY = { q: '', region_id: '', scenario: '', overall_status: '', stage_code: '', bucket: '' };
// ExportColumnCode values (stable codes of the `sites` part).
const SITE_COLUMNS: SitesExportColumnCode[] = ['site_code', 'site_name', 'region', 'scenario', 'overall_status', 'current_stage'];
// Extra pixels of a status chip (its own padding and border) when columns are sized to content.
const CHIP_PX = 24;
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
  // SITE 360 menus (F15): ?section= picks a menu. The default is the normal list (owner request 2026-11-22); the Excel-like Grid has no button any more and
  // opens only when ?layout=grid is in the URL (hidden, kept for its source panel and tests).
  const section = sp.get('section') ?? '';
  const layout = sp.get('layout') === 'grid' ? 'grid' : 'list';
  // Wide table (owner request 2026-11-22): read-only, the Master columns of the menu left to right; it reads the same GET /site360/{menu}/rows as the grid
  const asWide = sp.get('layout') === 'wide';
  const site360Q = useSite360Sections();
  // Each sub-menu keeps its OWN columns (GET /site360/sections) and values (GET /site360/{menu}/rows) in the calm list style of this page (owner request
  // 2026-11-22): no band or group rows, no inline editing. Site Master itself shows the generic list with the pipeline, workflow locks, data gaps and the
  // stage/mine/late/locks/gaps filters (owner answer 2026-11-22 "bring them back"); a stream or a work view (?stream=, ?view=) keeps it too.
  const menuKey = section || ((layout === 'grid' || asWide) && !stream && !view ? SITE360_MASTER : '');
  const lay = sp.get('layout');
  const menuList = !!section && lay !== 'list' && lay !== 'grid' && lay !== 'map' && lay !== 'board' && !asWide && !site360Q.isError;
  const menu = menuKey ? site360Q.data?.items.find((m) => m.key === menuKey) : undefined;
  // The grid reads its rows from GET /site360/{menu}/rows (one page, the same URL filters as the list), so the grid and the list share the source.
  // Multi Site ID search (paste a list, comma or newline separated) is kept in the URL as site_code, like the other filters.
  // F3 (0.15.31): the AND/OR filter tree lives in the URL as JSON (adv) and goes to the server as `filter`, which compiles it
  const adv = sp.get('adv') ?? '';
  const advTree = decodeFilter(adv);
  const gridQuery = {
    site_code: sp.get('site_code') || sp.get('site_codes') || undefined,
    filter: adv || undefined,
    region_id: sp.get('region_id') || undefined,
    scenario: sp.get('scenario') || undefined,
    // the grid reads `status` (GET /site360/{menu}/rows); the page keeps the shared URL key overall_status (audit A finding 11)
    status: sp.get('overall_status') || undefined,
    // 0.15.50: the list filters of GET /sites that the rows endpoint now takes with the same meaning: stage, mine/late, workflow locks, data gaps
    stage_code: sp.get('stage_code') || undefined,
    bucket: ['mine', 'late'].includes(sp.get('bucket') ?? '') ? sp.get('bucket')! : undefined,
    workflow_locks: ['locked', 'open'].includes(sp.get('workflow_locks') ?? '') ? sp.get('workflow_locks')! : undefined,
    data_gaps: sp.get('data_gaps') === 'with' ? 'with' : undefined,
    sort: 'site_code',
  };
  const gridRowsQ = useSite360RowsPaged(menu && (layout === 'grid' || menuList || asWide) ? menuKey : undefined, gridQuery);
  const saveCell = useSaveSite360Cell(menu && (layout === 'grid' || asWide) ? menuKey : undefined, gridQuery);
  const gridPages = gridRowsQ.data?.pages ?? [];
  const gridTotal = gridPages[0]?.total;
  const gridFiltered = gridPages[0]?.filtered;
  const gridRows = gridPages.flatMap((p) => p.rows);
  // Stable identity per fetched page: Site360Grid reports its selection from an effect keyed on `rows`, so a new array on every render loops forever.
  const grid360Rows = useMemo(() => gridRows.map((r) => ({ id: r.site_id, site_code: r.site_code, row_no: r.row_no, values: r.values, cells: r.cells })), [gridRowsQ.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [siteIdsDraft, setSiteIdsDraft] = useState(() => (sp.get('site_code') ?? '').split(',').join('\n'));
  const applySiteIds = () => {
    const codes = siteIdsDraft.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    setSp((prev) => { const n = new URLSearchParams(prev); if (codes.length) n.set('site_code', codes.join(',')); else n.delete('site_code'); return n; }, { replace: true });
  };
  const [exp, setExp] = useState(false);
  const [showNa, setShowNa] = useState(false);
  // Filters, quick filter and the selected row live in the URL, so Back and shared links restore them (plan F9).
  const f = { q: sp.get('q') ?? '', region_id: sp.get('region_id') ?? '', scenario: sp.get('scenario') ?? '', overall_status: sp.get('overall_status') ?? '', stage_code: sp.get('stage_code') ?? '' };
  const bucket = sp.get('bucket') ?? '';
  // 0.14.5: the sites the map cannot draw (the link of the dashboard map), and the map layout of the register (SC-10)
  const coordinates = sp.get('coordinates') === 'missing' ? 'missing' : '';
  const asMap = sp.get('layout') === 'map';
  // F5 (0.15.32): the read-only board by milestone (layout=board), with its swimlane in the URL (lane=region|contractor)
  const asBoard = sp.get('layout') === 'board';
  const lane = (SWIMLANES as readonly string[]).includes(sp.get('lane') ?? '') ? (sp.get('lane') as Swimlane) : 'none';
  // 0.15.4 (migration 0085): the workflow locks (locked / open) and the sites with data gaps
  const locks = ['locked', 'open'].includes(sp.get('workflow_locks') ?? '') ? (sp.get('workflow_locks') as string) : '';
  const gaps = sp.get('data_gaps') === 'with' ? 'with' : '';
  // 0.15.17 (F4): the Site IDs pasted into Ctrl+K ("Site ID in list"), kept in the URL so Back and shared links restore them
  const siteCodes = sp.get('site_codes') ?? '';
  // 0.15.33 (audit E section 2): a dashboard drill-down opens exactly the sites its card counts: the derived status (dashboard_status) or the
  // milestone reached, as of the dashboard's reference date, with its cluster; the server computes the set with the dashboard engine
  const dashStatus = sp.get('dashboard_status') ?? '';
  const reached = sp.get('milestone_reached') ?? '';
  const refDate = dashStatus || reached ? sp.get('ref_date') ?? '' : '';
  const cluster = sp.get('cluster_code') ?? '';
  const drill = { ...(dashStatus ? { dashboard_status: dashStatus } : {}), ...(reached ? { milestone_reached: reached } : {}), ...(refDate ? { ref_date: refDate } : {}), ...(cluster ? { cluster_code: cluster } : {}) };
  const extra = { ...(locks ? { workflow_locks: locks } : {}), ...(gaps ? { data_gaps: gaps } : {}), ...(siteCodes ? { site_codes: siteCodes } : {}), ...(adv ? { filter: adv } : {}), ...drill };
  const [locksDlg, setLocksDlg] = useState<null | boolean>(null);
  const [gridSel, setGridSel] = useState<Site360GridRow[]>([]);
  // the cell whose source is shown under the grid (0.15.35, P1 Master): a click on a Master cell opens it
  const [srcCell, setSrcCell] = useState<{ siteId: string; siteCode: string; ord: number } | null>(null);
  const sel = sp.get('sel') ?? '';
  const activeFilters = Object.values(f).filter(Boolean).length + (bucket ? 1 : 0) + (coordinates ? 1 : 0) + (locks ? 1 : 0) + (gaps ? 1 : 0) + (advTree ? 1 : 0) + (dashStatus ? 1 : 0) + (reached ? 1 : 0) + (cluster ? 1 : 0);
  const setParams = (kv: Record<string, string>) => setSp((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(kv)) { if (v) n.set(k, v); else n.delete(k); } return n; }, { replace: true });
  const set = (k: keyof typeof f) => (v: string) => setParams({ [k]: v, sel: '' });
  const clearAll = () => setParams({ ...Object.fromEntries(F_KEYS.map((k) => [k, ''])), bucket: '', coordinates: '', workflow_locks: '', data_gaps: '', site_codes: '', adv: '', dashboard_status: '', milestone_reached: '', ref_date: '', cluster_code: '', sel: '' });
  const toast = useToast();
  const nav = useNavigate();
  // Site creation (contract 0.14.0, Q460): the New sites template is listed only for those who may create sites
  const me = useMe(true).data;
  const newTpl = useTemplates().data?.find((x) => x.template_id === 'TPL-SITE-NEW');
  const canCreate = isAdmin(me) || !!me?.effective.grants.some((g) => g.module_key === 'sites' && (g.action as string) === 'create');
  // 0.15.4: who may switch the workflow locks (a System Admin or the delegated right to unlock); the server checks the region of every site
  const canUnlock = isAdmin(me) || !!me?.effective.grants.some((g) => g.module_key === 'overrides.unlock' && (g.action as string) === 'administer');
  const [upSites, setUpSites] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkEdit, setBulkEdit] = useState(false);
  const refreshRows = useRefreshSite360Rows(menuKey || undefined);
  const regions = useRegions();
  const viewsQ = useViews();
  const streamsQ = useStreams();
  // Name of the Site Register sub-menu that is open (sidebar request 2026-11-05): the view wins, else the stream; empty = all sites.
  const viewRef = view ? (viewsQ.data ?? DEFAULT_VIEWS).find((x) => x.code === view) : undefined;
  const streamRef = stream ? (streamsQ.data?.length ? streamsQ.data : DEFAULT_STREAMS).find((x) => x.code === stream) : undefined;
  const navSection = section && section !== SITE360_MASTER ? SITE360_NAV.find((m) => m.key === section) : undefined;
  const sectionName = navSection ? (i18n.language === 'ar' ? navSection.ar : navSection.en) : '';
  const subMenu = view ? (viewRef ? viewName(i18n.language, viewRef) : view) : streamRef ? streamName(t, i18n.language, streamRef) : sectionName;
  const real = !!stream && isRealStream(stream, streamsQ.data); // Dismantle has no API stream yet: nothing is fetched for it
  const dismantle = stream === DISMANTLE_CODE && !real;

  // "Export current view" sends exactly the query of the list: its filters, the F3 filter tree, the pasted Site IDs, the bucket and the stream (contract 0.15.34)
  const viewFilters = Object.fromEntries(Object.entries({ ...f, ...extra, ...(bucket ? { bucket } : {}), ...(coordinates ? { coordinates } : {}), ...(real ? { stream } : {}), ...(view ? { view } : {}) }).filter(([, x]) => x));
  const q = useSites({ ...f, ...extra, ...(bucket ? { bucket } : {}), ...(coordinates ? { coordinates } : {}), ...(real ? { stream } : {}), ...(view ? { view } : {}) }, !dismantle && !asMap && !asBoard && !menuList && !asWide);
  // Sites where the stream does not apply are not in the stream list. They come from the unfiltered list (their `streams[]` says "na").
  const allQ = useSites({ ...f, ...extra, stage_code: '', ...(bucket ? { bucket } : {}), ...(coordinates ? { coordinates } : {}), ...(view ? { view } : {}) }, real && !asMap && !asBoard && !menuList && !asWide);
  const { hasNextPage: moreAll, isFetchingNextPage: fetchingAll, fetchNextPage: nextAll } = allQ;
  useEffect(() => { if (real && moreAll && !fetchingAll) void nextAll(); }, [real, moreAll, fetchingAll, nextAll]);
  const inStream = q.data?.pages.flatMap((p) => p.items) ?? [];
  const naItems = real ? (allQ.data?.pages.flatMap((p) => p.items) ?? []).filter((s) => statusOf(s.streams, stream)?.state === 'na') : [];
  const items = dismantle ? [] : showNa && real ? [...inStream, ...naItems] : inStream;
  const total = (q.data?.pages[0]?.page.total ?? inStream.length) + (showNa && real ? naItems.length : 0);
  const stageCodesQ = useStageCodes(); // the menu lists do not load the site list, so the stage filter reads the stages of the workflow from one site
  const stageOptions = (inStream[0] ?? q.data?.pages[0]?.items[0])?.rail.map((r) => r.code) ?? stageCodesQ.data ?? [];

  // The list of a menu: its rows (the quick filter works on the loaded rows) and its columns. Site ID and Site Name stay frozen; the # column is not drawn.
  const mRows = useMemo(() => {
    const n = f.q.trim().toLowerCase();
    return n ? gridRows.filter((r) => r.site_code.toLowerCase().includes(n) || (r.values['4'] ?? '').toLowerCase().includes(n)) : gridRows;
  }, [gridRowsQ.data, f.q]); // eslint-disable-line react-hooks/exhaustive-deps
  const mCols = useMemo(() => (menu?.columns ?? []).filter((c) => c.ord !== 1), [menu]);
  const defsMenu: ColDef[] = mCols.map((c) => (c.ord === 2 ? { id: 'c2', w: 110, min: 70, pinned: true } : c.ord === 4 ? { id: 'c4', w: 220, min: 100, max: 340, pinned: true } : { id: `c${c.ord}`, w: 150, min: 70, max: 400 }));
  const mCol = (id: string) => mCols.find((c) => `c${c.ord}` === id);
  const tbl = useTablePrefs(menuList ? `sites-menu-${menuKey}` : real ? 'sites-stream' : 'sites', menuList ? defsMenu : real ? DEFS_STREAM : DEFS_ALL);
  const fromRows = menuList || asWide; // the rows come from GET /site360/{menu}/rows
  const nRows = fromRows ? mRows.length : items.length;
  const ROW = ROWS[tbl.density];
  const viewport = Math.max(320, (typeof window === 'undefined' ? 800 : window.innerHeight) - 380);
  const v = useVirtual(nRows, ROW, viewport);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;
  useEffect(() => { if (hasNextPage && !isFetchingNextPage && v.end >= inStream.length - 20) void fetchNextPage(); }, [v.end, inStream.length, hasNextPage, isFetchingNextPage, fetchNextPage]);
  const { hasNextPage: moreRows, isFetchingNextPage: fetchingRows, fetchNextPage: nextRows } = gridRowsQ;
  useEffect(() => { if (menuList && moreRows && !fetchingRows && v.end >= mRows.length - 20) void nextRows(); }, [menuList, moreRows, fetchingRows, v.end, mRows.length, nextRows]);
  // The wide table does not scroll in pages: while the quick search is typed, the rest of the pages load so the search covers every site of the menu, not only the first 200.
  useEffect(() => { if (asWide && f.q.trim() && moreRows && !fetchingRows) void nextRows(); }, [asWide, f.q, moreRows, fetchingRows, nextRows]);
  const scroller = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const scrollKey = `pmis.scroll.sites.${stream || 'ALL'}`;
  useLayoutEffect(() => { // back from a site: the list comes back where it was
    const el = scroller.current;
    if (!el || restored.current || !nRows) return;
    restored.current = true;
    const y = Number(sessionStorage.getItem(scrollKey) ?? 0);
    if (y) el.scrollTop = y;
  }, [nRows, scrollKey]);
  const rname = (id: number) => { const r = regions.data?.find((x) => x.id === id); return (i18n.language === 'ar' && r?.name_ar) || r?.name_en || String(id); };
  const stageName = (code?: string | null) => (code ? t(`stage.${code}`, { defaultValue: code }) : '—');
  const label = (id: string) => (mCol(id) ? mCol(id)!.header : LABEL[id] ? t(LABEL[id]) : id);
  const hint = (id: string) => { const c = mCol(id); return c ? [c.group_top, c.group_mid].filter(Boolean).join(' / ') || undefined : undefined; };
  const cols = tbl.cols, W = totalWidth(cols, true);
  const linkTo = (s: SiteListItem) => `/sites/${s.id}${new URLSearchParams([...(real ? [['stream', stream]] : []), ...(view ? [['view', view]] : [])]).toString().replace(/^(?=.)/, '?')}`;
  const flip = (code: string) => setPicked((p) => { const n = new Set(p); if (n.has(code)) n.delete(code); else n.add(code); return n; });
  const allCodes = fromRows ? mRows.map((r) => r.site_code) : items.map((s) => s.site_code), allPicked = allCodes.length > 0 && allCodes.every((c) => picked.has(c));
  const chips = [
    ...(f.q ? [{ key: 'q', label: t('table.filter_q', { v: f.q }), onRemove: () => set('q')('') }] : []),
    ...(f.region_id ? [{ key: 'region_id', label: t('table.filter_region', { v: rname(Number(f.region_id)) }), onRemove: () => set('region_id')('') }] : []),
    ...(f.scenario ? [{ key: 'scenario', label: t('table.filter_scenario', { v: t(`scenario.${f.scenario}`) }), onRemove: () => set('scenario')('') }] : []),
    ...(f.overall_status ? [{ key: 'overall_status', label: t('table.filter_status', { v: t(`status.${f.overall_status}`) }), onRemove: () => set('overall_status')('') }] : []),
    ...(f.stage_code ? [{ key: 'stage_code', label: t('table.filter_stage', { v: stageName(f.stage_code) }), onRemove: () => set('stage_code')('') }] : []),
    ...(coordinates ? [{ key: 'coordinates', label: t('table.filter_coords'), onRemove: () => setParams({ coordinates: '' }) }] : []),
    ...(locks ? [{ key: 'workflow_locks', label: `${t('locks.filter')}: ${t(locks === 'open' ? 'locks.filter_open' : 'locks.filter_locked')}`, onRemove: () => setParams({ workflow_locks: '' }) }] : []),
    ...(gaps ? [{ key: 'data_gaps', label: t('locks.quick_gaps'), onRemove: () => setParams({ data_gaps: '' }) }] : []),
    ...(bucket ? [{ key: 'bucket', label: t('table.filter_bucket', { v: t(bucket === 'mine' ? 'table.mine' : 'table.late') }), onRemove: () => setParams({ bucket: '' }) }] : []),
    ...(dashStatus ? [{ key: 'dashboard_status', label: t('table.filter_dash_status', { v: t(`status.${dashStatus}`) }), onRemove: () => setParams({ dashboard_status: '', ref_date: reached ? refDate : '' }) }] : []),
    ...(reached ? [{ key: 'milestone_reached', label: t('table.filter_reached', { v: stageName(reached) }), onRemove: () => setParams({ milestone_reached: '', ref_date: dashStatus ? refDate : '' }) }] : []),
    ...(refDate ? [{ key: 'ref_date', label: t('table.filter_ref_date', { v: refDate }), onRemove: () => setParams({ ref_date: '' }) }] : []),
    ...(cluster ? [{ key: 'cluster_code', label: t('table.filter_cluster', { v: cluster }), onRemove: () => setParams({ cluster_code: '' }) }] : []),
  ];

  // The text each cell shows, for sizing the columns to their content (null = not measurable: the pipeline rail keeps its default width).
  const fitText = (id: string, s: SiteListItem): FitSample | null => {
    const st = statusOf(s.streams, stream);
    switch (id) {
      case 'code': return s.site_code;
      case 'name': return s.name_ar ? `${s.name}  ${s.name_ar}` : s.name;
      case 'region': return rname(s.region_id);
      case 'scenario': return s.delivery_scenario ? t(`scenario.${s.delivery_scenario}`) : null;
      case 'status': return [t(`status.${s.overall_status}`), CHIP_PX];
      case 'stream_status': return [t(`streamState.${st?.state ?? 'na'}`), CHIP_PX];
      case 'stage': return stageName(st?.current_stage);
      case 'progress': return st ? `${st.done_tasks}/${st.total_tasks}` : null;
      case 'milestone': return st?.milestone_date ?? null;
      case 'locks': return [t(s.workflow_locks === false ? 'locks.col_open' : 'locks.col_locked'), CHIP_PX];
      case 'gaps': return s.data_gaps ? [String(s.data_gaps), CHIP_PX] : null;
      case 'late': { const n = real ? st?.late_count : s.late_task_count; return n ? [String(n), CHIP_PX] : null; }
      default: return null;
    }
  };
  useAutoFit(tbl, label, menuList ? [] : items, fitText, i18n.language);
  /** The read-only text of a Master cell: dates in the app's format, a list as comma separated text, the overall status by its name. */
  const mText = (ord: number, r: { site_code: string; values: Record<string, string | null> }): string => {
    if (ord === 2) return r.site_code;
    const raw = r.values[String(ord)] ?? '';
    if (!raw) return '';
    if (ord === 182 && STATUSES.includes(raw)) return t(`status.${raw}`);
    if (raw.startsWith('[') && raw.endsWith(']')) { try { const a: unknown = JSON.parse(raw); if (Array.isArray(a)) return a.map((x) => fmtDate(String(x), i18n.language)).join(', '); } catch { /* plain text */ } }
    return fmtDate(raw, i18n.language);
  };
  useAutoFit(tbl, label, menuList ? mRows : [], (id, r) => { const c = mCol(id); return c ? mText(c.ord, r) : null; }, i18n.language);

  const cell = (id: string, s: SiteListItem) => {
    const st = statusOf(s.streams, stream);
    switch (id) {
      case 'code': return <b className="mono">{s.site_code}</b>;
      case 'name': return <span className="flex min-w-0 items-baseline gap-2"><Trunc text={s.name} />{s.name_ar && <Tip text={s.name_ar}><span dir="rtl" lang="ar" className="truncate text-xs text-mute" data-testid={`site-name-ar-${s.site_code}`}>{s.name_ar}</span></Tip>}</span>;
      case 'region': return <Trunc text={rname(s.region_id)} />;
      case 'stream_status': return <StatusChip tone={STREAM_TONE[st?.state ?? 'na']} testid={`stream-state-${s.site_code}`} text={t(`streamState.${st?.state ?? 'na'}`)}>{t(`streamState.${st?.state ?? 'na'}`)}</StatusChip>;
      case 'stage': return <span data-testid={`stream-stage-${s.site_code}`}><Trunc text={stageName(st?.current_stage)} /></span>;
      case 'progress': return <span className="mono" data-testid={`stream-progress-${s.site_code}`}>{st ? `${st.done_tasks}/${st.total_tasks}` : <Empty />}</span>;
      case 'milestone': return <span className="mono" data-testid={`stream-ms-${s.site_code}`}>{st?.milestone_date ?? <Empty />}</span>;
      case 'scenario': return s.delivery_scenario ? <Trunc text={t(`scenario.${s.delivery_scenario}`)} /> : <Empty />;
      case 'status': return <StatusChip tone={TONE[s.overall_status]} text={t(`status.${s.overall_status}`)}>{t(`status.${s.overall_status}`)}</StatusChip>;
      case 'pipeline': return <MiniRail rail={s.rail} />;
      case 'locks': return <StatusChip tone={s.workflow_locks === false ? 'bg-waitBg text-waitInk' : 'bg-lockBg text-lockInk'} testid={`site-locks-${s.site_code}`} text={t(s.workflow_locks === false ? 'locks.col_open' : 'locks.col_locked')}>{t(s.workflow_locks === false ? 'locks.col_open' : 'locks.col_locked')}</StatusChip>;
      case 'gaps': return s.data_gaps ? <StatusChip tone="bg-lateBg text-lateInk" testid={`site-gaps-${s.site_code}`}>{s.data_gaps}</StatusChip> : <Empty />;
      default: { // late
        const n = real ? st?.late_count : s.late_task_count;
        return n ? <StatusChip tone="bg-lateBg text-lateInk" testid={real ? `stream-late-${s.site_code}` : undefined}>{n}</StatusChip> : <Empty />;
      }
    }
  };

  return (
    <div data-testid="page-sites">
      <PageHeader title={subMenu ? `${t('sites.title')}: ${subMenu}` : t('sites.title')} subtitle={t('sites.subtitle')} context={<>{(canCreate || newTpl) && (
        <span className="ms-auto flex flex-wrap gap-1" data-testid="sites-create-actions">
          {canCreate && <Link className="btn btn-primary px-2 py-1 text-xs" to="/sites/new" data-testid="sites-new"><FilePlus2 size={14} />{t('sites.new_site')}</Link>}
          {newTpl && <><button type="button" className="btn px-2 py-1 text-xs" data-testid="sites-template-download"
            onClick={() => downloadTemplate(newTpl.template_id).then((n) => toast(t('grid.downloaded', { name: n })), (e) => toast(registerErrorMessage(t, e), 'err'))}><FileDown size={14} />{t('sites.download_template')}</button>
          <button type="button" className="btn px-2 py-1 text-xs" data-testid="sites-template-upload" onClick={() => setUpSites(true)}><FileUp size={14} />{t('sites.upload_template')}</button></>}
        </span>)}</>} />
      <Toolbar activeFilters={activeFilters} activeLabel={t('states.filters')}
        filters={<>
        <SavedViews screen={real ? 'sites-stream' : 'sites'} value={{ ...f, bucket, ...(advTree ? { advanced: advTree } : {}) }} empty={VIEW_EMPTY} table={tbl}
          onApply={(v) => setParams({ ...Object.fromEntries(Object.keys(VIEW_EMPTY).map((k) => [k, String((v as Record<string, unknown>)[k] ?? '')])), adv: encodeFilter((v as { advanced?: FilterTree }).advanced), sel: '' })} />
        <FilterBuilder screen={real ? 'sites-stream' : 'sites'} value={advTree} onChange={(tree) => setParams({ adv: encodeFilter(tree), sel: '' })} />
        <input className="input max-w-64" data-testid="sites-search" placeholder={t('sites.search')} aria-label={t('sites.search')} value={f.q} onChange={(e) => set('q')(e.target.value)} />
        <Select id="region" value={f.region_id} onChange={set('region_id')} all={t('sites.all_regions')} options={(regions.data ?? []).map((r) => [String(r.id), (i18n.language === 'ar' && r.name_ar) || r.name_en])} />
        <Select id="scenario" value={f.scenario} onChange={set('scenario')} all={t('sites.all_scenarios')} options={SCENARIOS.map((s) => [s, t(`scenario.${s}`)])} />
        <Select id="status" value={f.overall_status} onChange={set('overall_status')} all={t('sites.all_statuses')} options={STATUSES.map((s) => [s, t(`status.${s}`)])} />
        <>
        <Select id="stage" value={f.stage_code} onChange={set('stage_code')} all={t('sites.all_stages')} options={stageOptions.map((s) => [s, stageName(s)])} />
        <QuickFilter testid="sites-quick-mine" on={bucket === 'mine'} onClick={() => setParams({ bucket: bucket === 'mine' ? '' : 'mine', sel: '' })}>{t('table.mine')}</QuickFilter>
        <QuickFilter testid="sites-quick-late" on={bucket === 'late'} onClick={() => setParams({ bucket: bucket === 'late' ? '' : 'late', sel: '' })}>{t('table.late')}</QuickFilter>
        <Select id="locks" value={locks} onChange={(v) => setParams({ workflow_locks: v, sel: '' })} all={t('locks.filter')} options={[['locked', t('locks.filter_locked')], ['open', t('locks.filter_open')]]} />
        <QuickFilter testid="sites-quick-gaps" on={!!gaps} onClick={() => setParams({ data_gaps: gaps ? '' : 'with', sel: '' })}>{t('locks.quick_gaps')}</QuickFilter>
        </>
        {real && (
          <label className="flex items-center gap-2 text-sm" title={t('sites.na_hint')}>
            <input type="checkbox" data-testid="sites-show-na" checked={showNa} onChange={(e) => setShowNa(e.target.checked)} />
            <span data-testid="sites-show-na-label">{t('sites.show_na', { count: naItems.length })}</span>
          </label>
        )}
        </>}
        count={<span className="text-sm text-mute" data-testid="sites-count">{t('sites.count', { count: menuList || asWide ? (gridFiltered ?? mRows.length) : total })}</span>}
        tools={<>
        <button type="button" className="btn px-2 py-1 text-xs" data-testid="sites-layout" aria-pressed={asMap} onClick={() => setParams({ layout: asMap ? '' : 'map', sel: '' })}>
          {asMap ? <><Table2 size={14} />{t('sites.table')}</> : <><MapIcon size={14} />{t('sites.map')}</>}
        </button>
        <button type="button" className="btn px-2 py-1 text-xs" data-testid="sites-layout-board" aria-pressed={asBoard} onClick={() => setParams({ layout: asBoard ? '' : 'board', sel: '' })}>
          {asBoard ? <><Table2 size={14} />{t('sites.table')}</> : <><Columns3 size={14} />{t('board.board')}</>}
        </button>
        <button type="button" className="btn px-2 py-1 text-xs" data-testid="sites-layout-wide" aria-pressed={asWide} onClick={() => setParams({ layout: asWide ? '' : 'wide' })}>
          {asWide ? <><Table2 size={14} />{t('sites.table')}</> : <><TableProperties size={14} />{t('sites.wide')}</>}
        </button>
        <DensityToggle api={tbl} />
        <ColumnMenu api={tbl} label={label} />
        <ExportViewButton testid="sites-export-view" source="sites" filters={viewFilters} columns={SITE_COLUMNS} />
        <MoreMenu items={[
          { id: 'export', label: t('export.open'), icon: <Download size={16} />, testid: 'sites-export', onSelect: () => setExp(true) },
          { id: 'reset', label: t('table.reset'), icon: <RotateCcw size={16} />, testid: 'sites-reset-cols', onSelect: tbl.reset },
        ]} />
        </>} />
      <ActiveChips chips={chips} onClear={clearAll} />
      {dismantle ? (
        <Navigate to="/registers/dismantle" replace />
      ) : asBoard ? (
        // F5: the same filters as the list (the F3 tree included); stage, bucket and stream are list views and do not apply to the board
        <SitesBoard swimlane={lane} onSwimlane={(x) => setParams({ lane: x === 'none' ? '' : x })}
          query={{ q: f.q || undefined, region_id: f.region_id || undefined, scenario: f.scenario || undefined, overall_status: f.overall_status || undefined, ...extra }} />
      ) : asMap ? (
        // SC-10: the same map as the dashboard; a stream sub-menu shows the sites whose current stream it is
        <SiteMap testid="sites-map" height={560} outer={{ region_id: f.region_id, scenario: f.scenario, ...(real ? { stream } : {}) }} />
      ) : menu && layout === 'grid' ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-start gap-2">
            <textarea rows={2} className="input min-w-[240px] font-mono text-xs" value={siteIdsDraft} onChange={(e) => setSiteIdsDraft(e.target.value)} placeholder={t('site360.site_ids_placeholder')} aria-label={t('site360.site_ids')} data-testid="site360-site-ids" />
            <button type="button" className="btn" data-testid="site360-site-ids-apply" onClick={applySiteIds}>{t('site360.site_ids_apply')}</button>
          </div>
          {saveCell.isError && <p role="alert" className="text-sm text-red-600" data-testid="site360-cell-error">{errText(saveCell.error, t)}</p>}
          <div className="flex flex-wrap items-center gap-2" data-testid="site360-toolbar">
            <ExportViewButton testid="site360-export-view" source="sites" filters={viewFilters} columns={SITE_COLUMNS} />
            <Link className="btn px-2 py-1 text-xs" to="/templates" data-testid="site360-template-link">{t('site360.template_upload')}</Link>
            {canUnlock && gridSel.length > 0 && <>
              <button type="button" className="btn" data-testid="site360-locks-open" onClick={() => setLocksDlg(false)}>{t('locks.bulk_open')}</button>
              <button type="button" className="btn" data-testid="site360-locks-lock" onClick={() => setLocksDlg(true)}>{t('locks.bulk_lock')}</button>
            </>}
          </div>
          <Site360Grid menu={menu} testid="site360-grid" onSelectRows={setGridSel} total={gridTotal} filtered={gridFiltered} rows={grid360Rows} onOpenCell={(r, ord) => setSrcCell({ siteId: r.id, siteCode: r.site_code, ord })} onEditCell={(e) => saveCell.mutate({ task_id: e.target.task_id, version: e.target.version, field: e.target.field, values: e.target.values, value: e.value })} />
          {srcCell ? <Site360SourcePanel siteId={srcCell.siteId} siteCode={srcCell.siteCode} ord={srcCell.ord} onClose={() => setSrcCell(null)} /> : <p className="mt-1 text-xs text-mute" data-testid="site360-source-hint">{t('site360.src.hint')}</p>}
          {gridRowsQ.hasNextPage ? <button type="button" className="btn" data-testid="site360-more" disabled={gridRowsQ.isFetchingNextPage} onClick={() => void gridRowsQ.fetchNextPage()}>{t('site360.more')}</button> : null}
        </div>
      ) : asWide && menu ? (
        <div className="space-y-2">
          <SitesWideTable menu={menu} rows={mRows} sel={sel} height={viewport + 120} loaded={gridRowsQ.isSuccess} filtered={activeFilters > 0} onClear={clearAll} busy={saveCell.isPending}
            onEdit={(e) => saveCell.mutateAsync({ task_id: e.target.task_id, version: e.target.version, field: e.target.field, values: e.target.values, value: e.value })}
            picked={picked} onPick={flip} onPickAll={() => setPicked(allPicked ? new Set() : new Set(allCodes))}
            hasMore={!!gridRowsQ.hasNextPage} loadingMore={gridRowsQ.isFetchingNextPage} onMore={() => void gridRowsQ.fetchNextPage()} />
        </div>
      ) : menuList ? (
        <div className="card gx overflow-hidden" data-menu={menuKey} data-density={tbl.density} data-testid="site360-list">
          <div ref={scroller} data-testid="sites-scroll" className="relative overflow-auto" style={{ height: viewport }} onScroll={(e) => { v.onScroll(e); sessionStorage.setItem(scrollKey, String(e.currentTarget.scrollTop)); }}>
            <HeaderRow api={tbl} label={label} hint={hint} select={{ checked: allPicked, indeterminate: picked.size > 0, onChange: () => setPicked(allPicked ? new Set() : new Set(allCodes)), label: t('table.select_all'), testid: 'sites-select-all' }} />
            <div data-testid="sites-list" role="list" className="relative" style={{ height: v.total, minWidth: W }}>
              {mRows.slice(v.start, v.end).map((r, k) => {
                const on = picked.has(r.site_code), cur = sel === r.site_code;
                const g = gxRow(v.start + k, { picked: on, current: cur });
                return (
                  <div key={r.site_id} role="listitem" aria-selected={on || cur} data-selected={cur || undefined} data-zebra={g['data-zebra']} data-picked={g['data-picked']} className={`absolute inset-x-0 border-b border-line text-sm ${g.className}`} style={{ insetBlockStart: (v.start + k) * ROW, height: ROW }}>
                    <div className="sticky start-0 z-20 h-0 w-9"><span className="absolute start-0 top-0 flex w-9 items-center justify-center bg-inherit" style={{ height: ROW }}><SelectBox checked={on} onChange={() => flip(r.site_code)} label={t('table.select_row', { code: r.site_code })} testid={`site-select-${r.site_code}`} /></span></div>
                    <Link to={`/sites/${r.site_id}`} data-testid={`site-row-${r.site_code}`} onClick={() => setParams({ sel: r.site_code })} className="grid h-full items-center bg-inherit" style={{ gridTemplateColumns: tracks(cols, true) }}>
                      <span aria-hidden />
                      {cols.map((c) => { const p = pin(c, true, cols); const col = mCol(c.id); const txt = col ? mText(col.ord, r) : ''; return <span key={c.id} data-col={c.id} className={`min-w-0 px-2 ${p.className}`} style={p.style}>{col?.ord === 2 ? <b className="mono">{txt}</b> : col?.ord === 182 && txt ? <StatusChip tone={TONE[r.values['182'] ?? '']} text={txt}>{txt}</StatusChip> : txt ? <Trunc text={txt} /> : <Empty />}</span>; })}
                    </Link>
                  </div>
                );
              })}
              {gridRowsQ.isSuccess && !mRows.length && (activeFilters ? <NoResults testid="sites-empty" onClear={clearAll} /> : <EmptyState testid="sites-empty" title={t('sites.empty')} />)}
            </div>
          </div>
          {gridRowsQ.hasNextPage ? <button type="button" className="btn m-2" data-testid="site360-more" disabled={gridRowsQ.isFetchingNextPage} onClick={() => void gridRowsQ.fetchNextPage()}>{t('site360.more')}</button> : null}
        </div>
      ) : (
        <div className="card gx overflow-hidden" data-stream={stream || 'ALL'} data-density={tbl.density}>
          <div ref={scroller} data-testid="sites-scroll" className="relative overflow-auto" style={{ height: viewport }} onScroll={(e) => { v.onScroll(e); sessionStorage.setItem(scrollKey, String(e.currentTarget.scrollTop)); }}>
            <HeaderRow api={tbl} label={label} select={{ checked: allPicked, indeterminate: picked.size > 0, onChange: () => setPicked(allPicked ? new Set() : new Set(allCodes)), label: t('table.select_all'), testid: 'sites-select-all' }} />
            <div data-testid="sites-list" role="list" className="relative" style={{ height: v.total, minWidth: W }}>
              {items.slice(v.start, v.end).map((s, k) => {
                const st = statusOf(s.streams, stream);
                const na = real && st?.state === 'na', on = picked.has(s.site_code), cur = sel === s.site_code;
                const g = gxRow(v.start + k, { picked: on, current: cur, muted: na });
                return (
                  <div key={s.id} role="listitem" aria-selected={on || cur} data-selected={cur || undefined} data-zebra={g['data-zebra']} data-picked={g['data-picked']} className={`absolute inset-x-0 border-b border-line text-sm ${g.className}`} style={{ insetBlockStart: (v.start + k) * ROW, height: ROW }}>
                    {/* the checkbox cell is frozen with the identity columns; it has no height of its own, so the link below fills the row */}
                    <div className="sticky start-0 z-20 h-0 w-9"><span className="absolute start-0 top-0 flex w-9 items-center justify-center bg-inherit" style={{ height: ROW }}><SelectBox checked={on} onChange={() => flip(s.site_code)} label={t('table.select_row', { code: s.site_code })} testid={`site-select-${s.site_code}`} /></span></div>
                    <Link to={linkTo(s)} data-testid={`site-row-${s.site_code}`} data-stream-state={st?.state} onClick={() => setParams({ sel: s.site_code })} className="grid h-full items-center bg-inherit" style={{ gridTemplateColumns: tracks(cols, true) }}>
                      <span aria-hidden />
                      {cols.map((c) => { const p = pin(c, true, cols); return <span key={c.id} data-col={c.id} className={`min-w-0 px-2 ${p.className}`} style={p.style}>{cell(c.id, s)}</span>; })}
                    </Link>
                  </div>
                );
              })}
              {q.isSuccess && !items.length && (activeFilters ? <NoResults testid="sites-empty" onClear={clearAll} /> : <EmptyState testid="sites-empty" title={t('sites.empty')} />)}
            </div>
          </div>
        </div>
      )}
      <BulkBar testid="sites-bulk" count={picked.size} loaded={nRows} total={fromRows ? (gridFiltered ?? nRows) : total} onClear={() => setPicked(new Set())}>
        {picked.size === 1 && <button type="button" className="btn" data-testid="sites-bulk-open" onClick={() => { if (fromRows) { const r = mRows.find((x) => picked.has(x.site_code)); if (r) nav(`/sites/${r.site_id}`); return; } const s = items.find((x) => picked.has(x.site_code)); if (s) nav(linkTo(s)); }}>{t('table.open_selected')}</button>}
        {asWide && <button type="button" className="btn" data-testid="sites-bulk-edit" onClick={() => setBulkEdit(true)}><Pencil size={14} />{t('sites.wide_bulk_edit')}</button>}
        {canUnlock && <><button type="button" className="btn" data-testid="sites-bulk-locks-open" onClick={() => setLocksDlg(false)}>{t('locks.bulk_open')}</button>
          <button type="button" className="btn" data-testid="sites-bulk-locks-lock" onClick={() => setLocksDlg(true)}>{t('locks.bulk_lock')}</button></>}
        <button type="button" className="btn" data-testid="sites-bulk-copy" onClick={() => { void navigator.clipboard?.writeText([...picked].join('\n')); toast(t('table.copied', { count: picked.size })); }}>{t('table.copy_codes')}</button>
      </BulkBar>
      {bulkEdit && menu && <SitesBulkEdit menu={menu} rows={mRows.filter((r) => picked.has(r.site_code))} onRefresh={refreshRows}
        onClose={(failed) => { setBulkEdit(false); if (failed) setPicked(new Set(failed)); }} />}
      <ExportDialog open={exp} onClose={() => setExp(false)} />
      {locksDlg !== null && <LocksDialog target={{ site_ids: menu && layout === 'grid' ? gridSel.map((r) => r.id) : fromRows ? mRows.filter((x) => picked.has(x.site_code)).map((x) => x.site_id) : items.filter((x) => picked.has(x.site_code)).map((x) => x.id) }} locked={locksDlg} count={menu && layout === 'grid' ? gridSel.length : picked.size} testid="sites-locks-dialog"
        onClose={() => { setLocksDlg(null); setPicked(new Set()); }} />}
      {upSites && newTpl && <TemplateUploadDialog open onClose={() => setUpSites(false)} templateId={newTpl.template_id} templateName={`${(i18n.language === 'ar' && newTpl.name_ar) || newTpl.name_en} · v${newTpl.current_version}`}
        kind="sites" onDone={(b) => { setUpSites(false); toast(t('grid.uploaded')); nav(batchPath(b)); }} />}
    </div>
  );
}
