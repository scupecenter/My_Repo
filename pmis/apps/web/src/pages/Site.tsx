import { SiteActivity } from '@/components/SiteActivity';
import { SiteCompare } from '@/components/SiteCompare';
import { SiteStageTimes } from '@/components/StageTimes';
import { LayoutPanel } from '@/components/LayoutPanel';
import { ScreenSettingsLink } from '@/components/ScreenSettingsLink';
import { SiteGantt } from '@/components/SiteGantt';
import { SiteSummaryStrip } from '@/components/SiteSummaryStrip';
import type { TasksExportColumnCode } from '@/api/types';
import { ArrowLeft, CalendarRange, Layers, Table2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useRegions, useSite, useSiteTasks } from '@/api/sites';
import { FollowButton } from '@/components/FollowButton';
import { SiteAdminEdit } from '@/components/SiteAdminEdit';
import { SiteDocuments } from '@/components/SiteDocuments';
import { SiteFields } from '@/components/SiteFields';
import { SiteIdentity } from '@/components/SiteIdentity';
import { SitePendingChanges } from '@/components/SitePendingChanges';
import { SiteDismantle } from '@/components/SiteDismantle';
import { SiteSnags } from '@/components/SiteSnags';
import { SiteMasterSources } from '@/components/SiteMasterSource';
import { SiteApplicability } from '@/components/SiteApplicability';
import { SiteDispatchPanel } from '@/components/SiteDispatch';
import { useSiteDispatch } from '@/api/warehouse';
import { RecordPin } from '@/components/RecordPin';
import { siteSignature } from '@/lib/recordMemory';
import { SitePhaseTabs } from '@/components/SitePhaseTabs';
import { DataGapsChip, LocksChip } from '@/components/WorkflowLocks';
import { Pipeline } from '@/components/Pipeline';
import { TaskDrawer } from '@/components/TaskDrawer';
import { ExportViewButton } from '@/components/ExportDialog';
import { TaskGrid, taskMatches } from '@/components/TaskGrid';
import { SavedViews } from '@/components/SavedViews';
import { UnifiedFilter } from '@/components/UnifiedFilter';
import { decodeFilter, encodeFilter, type FilterTree } from '@/api/views';
import { TaskRow } from '@/components/TaskRow';
import { displayAttrs, SearchBox, TableCount, TableToolbar } from '@/components/TableStandard';
import { useTablePrefs } from '@/components/TableKit';
import { loadPref, savePref } from '@/lib/localPref';
import { phaseEmpty, phaseFromUrl, phaseQuery, sitePhases, type SitePhase } from '@/lib/sitePhases';
import { statusOf } from '@/lib/streams';

const TONE: Record<string, string> = { completed: 'bg-doneBg text-doneInk', in_progress: 'bg-openBg text-openInk', on_hold: 'bg-waitBg text-waitInk', not_started: 'bg-lockBg text-lockInk', cancelled: 'bg-lateBg text-lateInk' };
const STREAM_TONE: Record<string, string> = { done: 'bg-doneBg text-doneInk', in_progress: 'bg-openBg text-openInk', not_started: 'bg-lockBg text-lockInk', na: 'bg-lockBg text-lockInk' };

// ExportColumnCode values (stable codes of the `tasks` part).
// per-viewer choice (W8 item 3): the list like the Site Master lists (default) or the Timeline (the task-as-column row of 2026-11-08), remembered
const LAYOUT_KEY = 'pmis.site.layout';
const NO_COLS: never[] = [];
const TIMELINE_VIEW_EMPTY = { tq: '' };
const TASK_COLUMNS: TasksExportColumnCode[] = ['site_code', 'task_code', 'task_name', 'task_state', 'due_date', 'sla_status'];

export function Site() {
  const { t, i18n } = useTranslation();
  const { siteId = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const stream = sp.get('stream') ?? '';
  const view = sp.get('view') ?? '';
  const site = useSite(siteId), regions = useRegions();
  const s = site.data;
  // W1 (2026-11-23): one phase row, its phases taken from the site's published workflow version (streams and views, in their configured order);
  // old `stream=` and `view=` links open the matching phase
  const phases = sitePhases(s?.streams, s?.views);
  const phase = phaseFromUrl(phases, stream, view);
  const pq = phaseQuery(phase);
  const dismantle = !!phase?.placeholder;
  const grid = useSiteTasks(siteId, pq.stream, !!s && !dismantle, pq.view, sp.get('tadv') || null);
  // a view-only phase (O&M) is disabled when none of its tasks applies: that needs the unfiltered grid (the same query as All)
  const allGrid = useSiteTasks(siteId, null, !!s && phases.some((p) => !p.stream && !p.placeholder), null);
  const empty = (p: SitePhase) => phaseEmpty(p, s?.streams, allGrid.data);
  const stage = sp.get('stage');
  // the Warehouse section (D6) shows only to a caller who may view the Warehouse of the site's region
  const dispatch = useSiteDispatch(siteId);
  const tabs2 = ['master', 'documents', 'snags', 'scope', 'activity', 'stages', 'compare', ...(dispatch.isSuccess ? ['warehouse'] : [])];
  const section = tabs2.includes(sp.get('tab') ?? '') ? (sp.get('tab') as 'master' | 'documents' | 'snags' | 'scope' | 'activity' | 'stages' | 'compare' | 'warehouse') : '';
  const docsTab = section !== ''; // a section other than the task grid
  const taskId = sp.get('task');
  const [ids, setIds] = useState<string[]>([]);
  // the Timeline keeps its own Display options (per user and per screen)
  const timeline = useTablePrefs('task-timeline', NO_COLS);
  const [layout, setLayout] = useState<'row' | 'list'>(() => (['row', 'timeline'].includes(loadPref<string>(LAYOUT_KEY, 'list')) ? 'row' : 'list'));
  const setParam = (k: string, v: string | null) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  // a stream phase is written as `stream=`, a view-only phase as `view=`, so the links of the Site Master list keep working
  const setPhase = (x: SitePhase | null) => setSp((p) => { const n = new URLSearchParams(p); n.delete('stage'); n.delete('stream'); n.delete('view'); if (x) n.set(x.stream || x.placeholder ? 'stream' : 'view', x.code); return n; }, { replace: true });
  const region = regions.data?.find((r) => r.id === s?.region_id);
  const cp = s?.cluster_progress;
  if (site.isError) return <p role="alert" data-testid="site-error" className="text-lateInk">{t('site.not_found')}</p>;
  const stages = (grid.data?.stages ?? []).filter((x) => !stage || x.code === stage);
  // the stream summary shows for the selected phase when that phase is a stream
  const st = phase?.stream ? statusOf(s?.streams, phase.code) : undefined;
  const off = !!phase && !phase.placeholder && empty(phase);
  // the pipeline shows the milestones of the chosen phase only (stage code = milestone code)
  const filtered = !!phase && !phase.placeholder;
  const phaseCodes = new Set((grid.data?.stages ?? []).filter((x) => !pq.view || x.tasks.length > 0).map((x) => x.code));
  const nodes = (s?.pipeline ?? []).filter((n) => !filtered || (n.kind === 'milestone' ? phaseCodes.has(n.code) : false));

  const taskTotal = stages.reduce((n, x) => n + x.tasks.length, 0);
  // W8: the Timeline takes the same search (tq) and + Filter tree (tadv, on the server) as the list
  const tq = sp.get('tq') ?? '';
  const tadvTree = decodeFilter(sp.get('tadv') ?? '');
  const rowStages = tq ? stages.map((x) => ({ ...x, tasks: x.tasks.filter((k) => taskMatches(k, tq, (i18n.language === 'ar' && k.name_ar) || k.name_en)) })) : stages;
  // W8 item 3: List (default) or Timeline, remembered per user; both live in the unified Layout panel with the Display options (decision V1)
  const layoutViews = {
    value: layout === 'row' ? 'timeline' : 'list',
    options: [
      { id: 'list', label: t('tstd.layout_list'), hint: t('view.list_hint'), icon: <Table2 size={14} />, testid: 'site-layout-list' },
      { id: 'timeline', label: t('tstd.layout_timeline'), hint: t('timeline.view_hint'), icon: <CalendarRange size={14} />, testid: 'site-layout-timeline' },
    ],
    onChange: (id: string) => { const l = id === 'timeline' ? 'row' : 'list'; setLayout(l); savePref(LAYOUT_KEY, id); },
  };
  const exporter = <ExportViewButton testid="grid-export-view" source="tasks" filters={{ site_id: siteId, ...(stage ? { stage_code: stage } : {}), ...(pq.stream ? { stream: pq.stream } : {}), ...(pq.view ? { view: pq.view } : {}), ...(sp.get('tadv') ? { filter: sp.get('tadv') } : {}) }} columns={TASK_COLUMNS} />;

  return (
    <div data-testid="page-site">
      <Link to={`/sites${new URLSearchParams([...(stream ? [['stream', stream]] : []), ...(view ? [['view', view]] : [])]).toString().replace(/^(?=.)/, '?')}`} className="mb-2 inline-flex items-center gap-1 text-sm text-link"><ArrowLeft size={14} className="rtl:rotate-180" />{t('site.back')}</Link>
      {s && (
        <>
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex-1">
              <div className="flex items-center gap-2"><h1 className="text-2xl font-bold" data-testid="site-title"><span className="mono">{s.site_code}</span> {s.name}</h1><ScreenSettingsLink screen="site" /></div>
              {s.name_ar && <p dir="rtl" lang="ar" className="text-lg text-mute" data-testid="site-name-ar">{s.name_ar}</p>}
              <p className="text-mute" data-testid="site-meta">{(i18n.language === 'ar' && region?.name_ar) || region?.name_en} · {s.delivery_scenario ? t(`scenario.${s.delivery_scenario}`) : ''}{s.cluster_code ? ` · ${s.cluster_code}` : ''}</p>
            </div>
            {/* 0.15.4 (migration 0085): the workflow locks of the site (chip and, for an authorized user, the switch) and its data gaps */}
            <LocksChip siteId={s.id} locked={s.workflow_locks !== false} canManage={!!s.workflow_locks_info?.can_manage} />
            <DataGapsChip count={s.data_gaps ?? 0} items={s.data_gap_items} />
            <FollowButton target={{ kind: 'site', id: s.id }} entityId={s.id} />
            <RecordPin rec={{ kind: 'site', id: s.id, code: s.site_code, name: s.name, path: `/sites/${s.id}` }} signature={siteSignature(s)} />
            <span className={`chip ${TONE[s.overall_status]}`} data-testid="site-status">{t(`status.${s.overall_status}`)}</span>
          </div>
          <SiteSummaryStrip site={s} />
          <SiteGantt site={s} />
          <SiteIdentity site={s} />
          <SitePendingChanges siteId={s.id} />
          <SiteAdminEdit site={s} />
          <SiteFields site={s} />
          {cp && <div className="my-3 flex items-center gap-2 rounded-lg bg-openBg p-3 text-openInk" data-testid="cluster-progress"><Layers size={16} />{t('site.cluster', { code: cp.cluster_code, at: cp.sites_at_te_pac, total: cp.sites_total })}</div>}
          <div role="tablist" aria-label={t('site.sections')} className="mt-3 flex gap-1" data-testid="site-section-tabs">
            {([['', t('site.tasks')], ['master', t('siteMaster.src.tab')], ['documents', t('docs.tab')], ['snags', t('snags.tab')], ['scope', t('scope.tab')], ['activity', t('siteActivity.tab')], ['stages', t('stageTimes.tab')], ['compare', t('siteCompare.tab')], ...(dispatch.isSuccess ? [['warehouse', t('wh.site_tab')] as const] : [])] as const).map(([k, label]) => (
              <button key={k || 'tasks'} role="tab" aria-selected={k === section} data-testid={`site-section-${k || 'tasks'}`} onClick={() => setParam('tab', k || null)}
                className={`rounded-md px-3 py-1 text-sm font-semibold ${k === section ? 'bg-accentSoft text-accentText' : 'text-mute hover:text-ink'}`}>{label}{k === 'snags' && (s.counts?.open_snags ?? 0) > 0 ? ` (${s.counts?.open_snags})` : ''}</button>
            ))}
          </div>
          {section === 'master' && <div className="mt-3"><SiteMasterSources siteId={siteId} /></div>}
          {section === 'documents' && <div className="mt-3"><SiteDocuments siteId={siteId} stages={s.pipeline ?? []} /></div>}
          {section === 'snags' && <div className="mt-3"><SiteSnags siteId={siteId} /></div>}
          {section === 'compare' && <div className="mt-3"><SiteCompare siteId={siteId} /></div>}
          {section === 'stages' && <div className="mt-3"><SiteStageTimes siteId={siteId} /></div>}
          {section === 'activity' && <div className="mt-3"><SiteActivity siteId={siteId} siteCode={s.site_code} /></div>}
          {section === 'scope' && <div className="mt-3"><SiteApplicability siteId={siteId} /></div>}
          {section === 'warehouse' && <div className="mt-3"><SiteDispatchPanel siteId={siteId} /></div>}
          {!docsTab && <>
          <SitePhaseTabs phases={phases} value={phase?.code ?? ''} empty={empty} onChange={setPhase} />
          {st && (
            <div className="mb-3 flex flex-wrap items-center gap-3 text-sm" data-testid="site-stream-summary" data-state={st.state}>
              <span className={`chip ${STREAM_TONE[st.state]}`}>{t(`streamState.${st.state}`)}</span>
              {st.current_stage && <span>{t('sites.current_stage')}: <b>{t(`stage.${st.current_stage}`, { defaultValue: st.current_stage })}</b></span>}
              <span className="mono">{t('site.stream_summary', { done: st.done_tasks, total: st.total_tasks })}</span>
              {st.late_count > 0 && <span className="chip bg-lateBg text-lateInk">{t('site.late_n', { count: st.late_count })}</span>}
              {st.milestone_date && <span className="mono">{t('site.milestone_date', { date: st.milestone_date })}</span>}
            </div>
          )}
          <div className="card mb-4 p-3"><Pipeline nodes={nodes} variant={s?.pipeline_variant ?? 'A'} selected={stage} onSelect={(c) => setParam('stage', stage === c ? null : c)} /></div>
          </>}
        </>
      )}
      {!docsTab && <>
      <div className="mb-2 flex items-center gap-2"><h2 className="me-auto font-semibold">{t('site.tasks')}{stage && <button className="btn ms-2 px-2 py-0.5 text-xs" data-testid="stage-clear" onClick={() => setParam('stage', null)}>{t('site.all_stages')}</button>}</h2></div>
      {layout === 'row' && !dismantle && <TableToolbar testid="task-row-toolbar" kind="list"
        views={<SavedViews screen="site-tasks" sharedScreen value={{ tq, ...(tadvTree ? { advanced: tadvTree } : {}) }} empty={TIMELINE_VIEW_EMPTY} table={timeline}
          onApply={(x) => { const r = x as Record<string, unknown>; setSp((p) => { const n = new URLSearchParams(p); const v = String(r.tq ?? ''); if (v) n.set('tq', v); else n.delete('tq'); const enc = encodeFilter(r.advanced as FilterTree | undefined); if (enc) n.set('tadv', enc); else n.delete('tadv'); return n; }, { replace: true }); }} />}
        search={<SearchBox testid="task-row-search" value={tq} onChange={(x) => setParam('tq', x || null)} placeholder={t('tstd.search_tasks')} />}
        filter={<UnifiedFilter screen="site-tasks" value={tadvTree} onChange={(tree) => setParam('tadv', encodeFilter(tree) || null)} onClearAll={() => setSp((p) => { const n = new URLSearchParams(p); n.delete('tq'); n.delete('tadv'); return n; }, { replace: true })} />}
        count={<TableCount testid="task-row-count" noun="tasks" total={taskTotal} filtered={rowStages.reduce((n, x) => n + x.tasks.length, 0)} active={!!(tq || tadvTree)} onClear={() => setSp((p) => { const n = new URLSearchParams(p); n.delete('tq'); n.delete('tadv'); return n; }, { replace: true })} />}
        layout={<LayoutPanel testid="site-layout" views={layoutViews} table={timeline} />} exporter={exporter} />}
      {dismantle ? <SiteDismantle siteId={siteId} />
        : off ? <p className="card p-6 text-mute" data-testid="site-stream-na">{t('site.stream_na')}</p>
        : grid.isLoading || !s ? <p className="text-mute">{t('common.loading')}</p>
        : layout === 'row' ? <div {...displayAttrs(timeline.display)} data-testid="task-row-display"><TaskRow stages={rowStages} selected={taskId ?? sp.get('row')} onVisible={setIds} onOpen={(id) => setSp((p) => { const n = new URLSearchParams(p); n.set('task', id); n.set('row', id); return n; }, { replace: true })} /></div>
        : <TaskGrid key={`${phase?.code ?? ''}|${stage ?? 'all'}`} siteId={siteId} stages={stages} layoutTestid="site-layout" views={layoutViews} exporter={exporter} selected={taskId ?? sp.get('row')} onVisible={setIds} onOpen={(id) => setSp((p) => { const n = new URLSearchParams(p); n.set('task', id); n.set('row', id); return n; }, { replace: true })} />}
      {layout === 'list' && <p className="mt-2 text-xs text-mute">{t('grid.keys')}</p>}
      </>}
      <TaskDrawer nav={{ ids, onGo: (id) => setSp((p) => { const n = new URLSearchParams(p); n.set('task', id); n.set('row', id); return n; }, { replace: true }) }} registerFields={grid.data?.stages.flatMap((x) => x.tasks).find((x) => x.id === taskId)?.register_fields} taskId={taskId} onClose={() => setParam('task', null)} />
    </div>
  );
}
