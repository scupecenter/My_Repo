import type { TasksExportColumnCode } from '@/api/types';
import { ArrowLeft, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useRegions, useSite, useSiteTasks } from '@/api/sites';
import { Pipeline } from '@/components/Pipeline';
import { TaskDrawer } from '@/components/TaskDrawer';
import { ExportViewButton } from '@/components/ExportDialog';
import { TaskGrid } from '@/components/TaskGrid';
import { DISMANTLE_CODE, isRealStream, statusOf, streamName, withDismantle } from '@/lib/streams';

const TONE: Record<string, string> = { completed: 'bg-doneBg text-doneInk', in_progress: 'bg-openBg text-openInk', on_hold: 'bg-waitBg text-waitInk', not_started: 'bg-lockBg text-lockInk', cancelled: 'bg-lateBg text-lateInk' };
const STREAM_TONE: Record<string, string> = { done: 'bg-doneBg text-doneInk', in_progress: 'bg-openBg text-openInk', not_started: 'bg-lockBg text-lockInk', na: 'bg-lockBg text-lockInk' };

// ExportColumnCode values (stable codes of the `tasks` part).
const TASK_COLUMNS: TasksExportColumnCode[] = ['site_code', 'task_code', 'task_name', 'task_state', 'due_date', 'sla_status'];

export function Site() {
  const { t, i18n } = useTranslation();
  const { siteId = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const stream = sp.get('stream') ?? '';
  const site = useSite(siteId), regions = useRegions();
  const s = site.data;
  const tabs = withDismantle(s?.streams);
  const real = !!stream && isRealStream(stream, s?.streams);
  const dismantle = stream === DISMANTLE_CODE && !real;
  const grid = useSiteTasks(siteId, real ? stream : null, !dismantle);
  const stage = sp.get('stage');
  const taskId = sp.get('task');
  const setParam = (k: string, v: string | null) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const setStream = (code: string) => setSp((p) => { const n = new URLSearchParams(p); n.delete('stage'); if (code) n.set('stream', code); else n.delete('stream'); return n; }, { replace: true });
  const region = regions.data?.find((r) => r.id === s?.region_id);
  const cp = s?.cluster_progress;
  if (site.isError) return <p role="alert" data-testid="site-error" className="text-lateInk">{t('site.not_found')}</p>;
  const stages = (grid.data?.stages ?? []).filter((x) => !stage || x.code === stage);
  const st = real ? statusOf(s?.streams, stream) : undefined;
  // the pipeline shows the milestones of the chosen stream only (stage code = milestone code)
  const streamCodes = new Set((grid.data?.stages ?? []).map((x) => x.code));
  const nodes = (s?.pipeline ?? []).filter((n) => !real || (n.kind === 'milestone' ? streamCodes.has(n.code) : false));

  return (
    <div data-testid="page-site">
      <Link to={`/sites${stream ? `?stream=${stream}` : ''}`} className="mb-2 inline-flex items-center gap-1 text-sm text-link"><ArrowLeft size={14} className="rtl:rotate-180" />{t('site.back')}</Link>
      {s && (
        <>
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex-1">
              <h1 className="text-2xl font-bold" data-testid="site-title"><span className="mono">{s.site_code}</span> {s.name}</h1>
              <p className="text-mute" data-testid="site-meta">{(i18n.language === 'ar' && region?.name_ar) || region?.name_en} · {s.delivery_scenario ? t(`scenario.${s.delivery_scenario}`) : ''}{s.cluster_code ? ` · ${s.cluster_code}` : ''}</p>
            </div>
            <span className={`chip ${TONE[s.overall_status]}`} data-testid="site-status">{t(`status.${s.overall_status}`)}</span>
          </div>
          {cp && <div className="my-3 flex items-center gap-2 rounded-lg bg-openBg p-3 text-openInk" data-testid="cluster-progress"><Layers size={16} />{t('site.cluster', { code: cp.cluster_code, at: cp.sites_at_te_pac, total: cp.sites_total })}</div>}
          <div role="tablist" aria-label={t('site.streams')} className="mb-3 mt-3 flex flex-wrap gap-1 border-b border-line" data-testid="site-stream-tabs">
            {[{ code: '', label: t('sites.stream_all'), na: false }, ...tabs.map((x) => ({ code: x.code, label: streamName(t, i18n.language, x), na: statusOf(s.streams, x.code)?.state === 'na' }))].map((x) => (
              <button key={x.code || 'ALL'} role="tab" aria-selected={stream === x.code} data-testid={`site-stream-tab-${x.code || 'ALL'}`} onClick={() => setStream(x.code)}
                className={`px-4 py-2 text-sm font-semibold ${stream === x.code ? 'border-b-2 border-accent text-accentText' : 'text-mute hover:text-ink'} ${x.na ? 'opacity-60' : ''}`}>{x.label}</button>
            ))}
          </div>
          {st && (
            <div className="mb-3 flex flex-wrap items-center gap-3 text-sm" data-testid="site-stream-summary" data-state={st.state}>
              <span className={`chip ${STREAM_TONE[st.state]}`}>{t(`streamState.${st.state}`)}</span>
              {st.current_stage && <span>{t('sites.current_stage')}: <b>{t(`stage.${st.current_stage}`, { defaultValue: st.current_stage })}</b></span>}
              <span className="mono">{t('site.stream_summary', { done: st.done_tasks, total: st.total_tasks })}</span>
              {st.late_count > 0 && <span className="chip bg-lateBg text-lateInk">{t('site.late_n', { count: st.late_count })}</span>}
              {st.milestone_date && <span className="mono">{t('site.milestone_date', { date: st.milestone_date })}</span>}
            </div>
          )}
          <div className="card mb-4 p-3"><Pipeline nodes={nodes} selected={stage} onSelect={(c) => setParam('stage', stage === c ? null : c)} /></div>
        </>
      )}
      <div className="mb-2 flex items-center gap-2"><h2 className="me-auto font-semibold">{t('site.tasks')}{stage && <button className="btn ms-2 px-2 py-0.5 text-xs" data-testid="stage-clear" onClick={() => setParam('stage', null)}>{t('site.all_stages')}</button>}</h2>
        <ExportViewButton testid="grid-export-view" source="tasks" filters={{ site_id: siteId, ...(stage ? { stage_code: stage } : {}) }} columns={TASK_COLUMNS} /></div>
      {dismantle ? <p className="card p-6 text-mute" data-testid="site-dismantle-todo">{t('site.dismantle_todo')}</p>
        : st?.state === 'na' ? <p className="card p-6 text-mute" data-testid="site-stream-na">{t('site.stream_na')}</p>
        : grid.isLoading ? <p className="text-mute">{t('common.loading')}</p>
        : <TaskGrid key={`${stream}|${stage ?? 'all'}`} siteId={siteId} stages={stages} onOpen={(id) => setParam('task', id)} />}
      <p className="mt-2 text-xs text-mute">{t('grid.keys')}</p>
      <TaskDrawer taskId={taskId} onClose={() => setParam('task', null)} />
    </div>
  );
}
