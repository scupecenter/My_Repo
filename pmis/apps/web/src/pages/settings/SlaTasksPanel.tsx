import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useSetSlaNoSla, useSlaTasks } from '@/api/settings';
import type { SlaTaskItem } from '@/api/types';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { useErr } from './wf/useErr';

type Filter = 'all' | 'undecided' | 'set' | 'none' | 'draft';

/**
 * Settings > SLA > "Tasks and their SLA" (contract 0.15.85). One row per active task of the workflow in force and of the open draft, with its status:
 * SLA set, No SLA (an explicit choice with a reason) or Not decided. Undecided tasks are highlighted and counted. The "no SLA" choice is recorded and
 * undone here (audited, nothing deleted); the SLA itself is set in the rule set below (live tasks) or in the workflow editor (draft tasks).
 */
export function SlaTasksPanel() {
  const { t } = useTranslation();
  const toast = useToast();
  const err = useErr();
  const q = useSlaTasks();
  const save = useSetSlaNoSla();
  const [filter, setFilter] = useState<Filter>('all');
  const [dlg, setDlg] = useState<null | { task: SlaTaskItem; no_sla: boolean }>(null);
  const [why, setWhy] = useState('');
  const d = q.data;
  if (!d) return <section className="card p-4" data-testid="sla-tasks"><QueryFallback queries={[q]} testid="sla-tasks-loading" /></section>;
  const rows = d.items.filter((i) => filter === 'all' || (filter === 'draft' ? i.in_draft : i.mode === filter));
  const chip = (m: string) => (m === 'set' ? 'bg-doneBg text-doneInk' : m === 'none' ? 'bg-waitBg text-waitInk' : 'bg-lateBg text-lateInk');
  const submit = () => {
    if (!dlg) return;
    save.mutate({ task: dlg.task.task_code, no_sla: dlg.no_sla, reason: why.trim() }, {
      onSuccess: () => { setDlg(null); setWhy(''); },
      onError: (e) => toast(err(e)),
    });
  };
  return (
    <section className="card space-y-3 p-4" data-testid="sla-tasks">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="me-auto font-bold">{t('slaTasks.title')}</h2>
        <label className="flex items-center gap-2 text-sm">{t('slaTasks.filter')}
          <select className="input" data-testid="sla-tasks-filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            {(['all', 'undecided', 'set', 'none', 'draft'] as Filter[]).map((f) => <option key={f} value={f}>{t(`slaTasks.f_${f}`)}</option>)}
          </select>
        </label>
      </div>
      <p className="text-sm text-mute">{t('slaTasks.note')}</p>
      <p role="status" className={`chip ${d.counts.undecided > 0 ? 'bg-lateBg text-lateInk' : 'bg-doneBg text-doneInk'}`} data-testid="sla-tasks-banner" data-undecided={d.counts.undecided}>
        {d.counts.undecided > 0 ? t('slaTasks.banner_undecided', { n: d.counts.undecided }) : t('slaTasks.banner_ok')}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-mute"><tr>{['task', 'stage', 'where', 'status', 'sla', 'actions'].map((k) => <th key={k} className="p-2 text-start">{t(`slaTasks.col_${k}`)}</th>)}</tr></thead>
          <tbody data-testid="sla-tasks-rows">
            {rows.length === 0 && <tr><td className="p-2 text-mute" colSpan={6}>{t('slaTasks.empty')}</td></tr>}
            {rows.map((r) => (
              <tr key={`${r.workflow_version}-${r.task_code}`} className="border-t border-line" data-testid={`sla-task-${r.task_code}`} data-mode={r.mode} data-draft={r.in_draft}>
                <td className="p-2"><span className="font-mono">{r.task_code}</span> {r.name_en}</td>
                <td className="p-2">{r.stage_code}</td>
                <td className="p-2">{r.in_draft ? t('slaTasks.draft', { v: r.workflow_version }) : t('slaTasks.live')}</td>
                <td className="p-2"><span className={`chip ${chip(r.mode)}`} title={r.none_reason ?? undefined}>{t(`slaTasks.s_${r.mode}`)}</span></td>
                <td className="p-2 tabular-nums">{r.mode === 'set' ? `${r.min_working_days}-${r.max_working_days}` : ''}</td>
                <td className="flex flex-wrap gap-2 p-2">
                  {r.mode !== 'none' && r.mode !== 'set' && <button className="btn" data-testid={`sla-task-none-${r.task_code}`} onClick={() => { setWhy(''); setDlg({ task: r, no_sla: true }); }}>{t('slaTasks.mark_none')}</button>}
                  {r.mode === 'none' && <button className="btn" data-testid={`sla-task-clear-${r.task_code}`} onClick={() => { setWhy(''); setDlg({ task: r, no_sla: false }); }}>{t('slaTasks.clear_none')}</button>}
                  {r.in_draft ? <Link className="btn" to="/admin/workflow" data-testid={`sla-task-edit-${r.task_code}`}>{t('slaTasks.edit_draft')}</Link> : r.mode === 'undecided' && <span className="text-xs text-mute">{t('slaTasks.set_below')}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dlg && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="sla-tasks-dialog">
          <div className="card w-full max-w-md space-y-3 p-4">
            <h3 className="font-bold">{dlg.no_sla ? t('slaTasks.dialog_none') : t('slaTasks.dialog_clear')}: {dlg.task.task_code}</h3>
            <label className="block text-sm">{t('slaTasks.reason')}<input className="input mt-1 w-full" data-testid="sla-tasks-reason" value={why} onChange={(e) => setWhy(e.target.value)} /></label>
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={() => setDlg(null)}>{t('slaTasks.cancel')}</button>
              <button className="btn btn-accent" data-testid="sla-tasks-save" disabled={why.trim().length < 3 || save.isPending} onClick={submit}>{t('slaTasks.save')}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
