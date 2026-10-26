import { ArrowLeft, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useRegions, useSite, useSiteTasks } from '@/api/sites';
import { Pipeline } from '@/components/Pipeline';
import { TaskDrawer } from '@/components/TaskDrawer';
import { ExportViewButton } from '@/components/ExportDialog';
import { TaskGrid } from '@/components/TaskGrid';

const TONE: Record<string, string> = { completed: 'bg-doneBg text-doneInk', in_progress: 'bg-openBg text-openInk', on_hold: 'bg-waitBg text-waitInk', not_started: 'bg-lockBg text-lockInk', cancelled: 'bg-lateBg text-lateInk' };

// ExportColumnCode values (stable codes of the `tasks` part).
const TASK_COLUMNS = ['site_code', 'task_code', 'task_name', 'task_state', 'planned_date', 'actual_date', 'sla_due_date'];

export function Site() {
  const { t, i18n } = useTranslation();
  const { siteId = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const site = useSite(siteId), grid = useSiteTasks(siteId), regions = useRegions();
  const s = site.data;
  const stage = sp.get('stage');
  const taskId = sp.get('task');
  const setParam = (k: string, v: string | null) => setSp((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const region = regions.data?.find((r) => r.id === s?.region_id);
  const cp = s?.cluster_progress;
  if (site.isError) return <p role="alert" data-testid="site-error" className="text-lateInk">{t('site.not_found')}</p>;
  const stages = (grid.data?.stages ?? []).filter((x) => !stage || x.code === stage);

  return (
    <div data-testid="page-site">
      <Link to="/sites" className="mb-2 inline-flex items-center gap-1 text-sm text-link"><ArrowLeft size={14} className="rtl:rotate-180" />{t('nav.sites')}</Link>
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
          <div className="card mb-4 p-3"><Pipeline nodes={s.pipeline} selected={stage} onSelect={(c) => setParam('stage', stage === c ? null : c)} /></div>
        </>
      )}
      <div className="mb-2 flex items-center gap-2"><h2 className="me-auto font-semibold">{t('site.tasks')}{stage && <button className="btn ms-2 px-2 py-0.5 text-xs" data-testid="stage-clear" onClick={() => setParam('stage', null)}>{t('site.all_stages')}</button>}</h2>
        <ExportViewButton testid="grid-export-view" source="tasks" filters={{ site_id: siteId, ...(stage ? { stage_code: stage } : {}) }} columns={TASK_COLUMNS} /></div>
      {grid.isLoading ? <p className="text-mute">{t('common.loading')}</p> : <TaskGrid key={stage ?? 'all'} siteId={siteId} stages={stages} onOpen={(id) => setParam('task', id)} />}
      <p className="mt-2 text-xs text-mute">{t('grid.keys')}</p>
      <TaskDrawer taskId={taskId} onClose={() => setParam('task', null)} />
    </div>
  );
}
