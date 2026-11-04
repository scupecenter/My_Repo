import { AlertTriangle, History, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useAddScopeException, useApplyApplicability, useGateEvents, useRevokeScopeException, useSiteApplicability } from '@/api/scenario';
import type { SiteApplicability as Applicability } from '@/api/scenario';
import { errText, FormDialog } from './FormDialog';
import { useToast } from './Toast';

type Dlg = null | { kind: 'apply' } | { kind: 'exception'; task_code: string } | { kind: 'revoke'; id: string; task_code: string };
const SRC_TONE: Record<string, string> = { exception: 'bg-openBg text-openInk', scenario: 'bg-waitBg text-waitInk', flag: 'bg-card2', none: 'bg-lockBg text-lockInk' };

/**
 * Scope of a site (contract 0.12.0, owner answers Q15, Q3, Q2, Q9): which tasks apply by scenario, flags and approved scope exceptions, the
 * Site RFI decision beside the Master formula (comparison only), the conflicts that block applying the scope, and the gate history.
 * The admin applies the rules (step-up, reason) and approves or revokes scope exceptions; the server decides every rule.
 */
export function SiteApplicability({ siteId }: { siteId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useSiteApplicability(siteId), ev = useGateEvents(siteId);
  const apply = useApplyApplicability(siteId), add = useAddScopeException(siteId), revoke = useRevokeScopeException(siteId);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [err, setErr] = useState<string | null>(null);
  const a: Applicability | undefined = q.data;
  const close = () => { setDlg(null); setErr(null); };
  const fail = (e: unknown) => {
    // a step-up the user cancelled says nothing
    if (e instanceof ApiError && e.code === 'step_up_required') return close();
    setErr(errText(e, t));
  };
  if (q.isError) return <p role="alert" className="text-lateInk" data-testid="scope-error">{errText(q.error, t)}</p>;
  if (!a) return <p className="text-mute">{t('common.loading')}</p>;
  const naByScenario = a.tasks.filter((x) => x.source === 'scenario' && x.applies === false);
  const active = a.exceptions.filter((e) => !e.revoked_at);
  const pending = a.tasks.filter((x) => x.would_change);

  return (
    <div className="space-y-4" data-testid="site-scope">
      <section className="card p-4" data-testid="scope-rfi">
        <h3 className="mb-2 font-semibold">{t('scope.rfi_title')}</h3>
        <div className="flex flex-wrap gap-3 text-sm">
          <span>{t('scope.rfi_pmis')}: <b data-testid="scope-rfi-applies">{a.rfi.applies ? t('scope.applies') : t('scope.na')}</b></span>
          <span className="text-mute">{t('scope.rfi_master')}: <span data-testid="scope-rfi-master">{a.rfi.master_rfi ? t('scope.applies') : t('scope.na')}</span></span>
          {a.rfi.differs && <span className="chip bg-waitBg text-waitInk" data-testid="scope-rfi-differs">{t('scope.rfi_differs')}</span>}
        </div>
      </section>

      {a.conflicts.length > 0 && (
        <div role="alert" className="rounded-md bg-lateBg p-3 text-sm text-lateInk" data-testid="scope-conflicts">
          <p className="mb-1 flex items-center gap-1 font-semibold"><AlertTriangle size={16} />{t('scope.conflicts_title')}</p>
          <ul className="list-disc ps-5">{a.conflicts.map((c) => <li key={c.task_code} data-testid={`scope-conflict-${c.task_code}`}>{t('scope.conflict', { task: c.task_code, scenario: t(`scenario.${c.scenario}`), flag: c.flag_expr })}</li>)}</ul>
        </div>
      )}

      <section className="card p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="me-auto font-semibold">{t('scope.tasks_title')}</h3>
          <span className="text-sm text-mute" data-testid="scope-pending-count">{t('scope.would_change', { count: pending.length })}</span>
          <button className="btn btn-accent" data-testid="scope-apply" disabled={a.conflicts.length > 0} onClick={() => setDlg({ kind: 'apply' })}><ShieldCheck size={14} />{t('scope.apply')}</button>
        </div>
        <table className="w-full text-sm">
          <thead className="text-mute"><tr>{['task', 'state', 'applies', 'source', 'sla'].map((k) => <th key={k} className="p-1 text-start">{t(`scope.col_${k}`)}</th>)}<th /></tr></thead>
          <tbody data-testid="scope-tasks">
            {a.tasks.filter((x) => x.source !== 'none' || !x.sla_measured).map((x) => (
              <tr key={x.task_id} className="border-t border-line" data-testid={`scope-task-${x.task_code}`} data-applies={String(x.applies)}>
                <td className="mono p-1">{x.task_code}</td>
                <td className="p-1">{t(`taskState.${x.state}`, { defaultValue: x.state })}</td>
                <td className="p-1">{x.applies === null ? '–' : x.applies ? t('scope.applies') : t('scope.na')}{x.would_change ? <span className="chip ms-1 bg-openBg text-openInk">{t(`scope.will_${x.would_change}`)}</span> : null}</td>
                <td className="p-1"><span className={`chip ${SRC_TONE[x.source] ?? ''}`} title={x.reason ?? ''}>{t(`scope.src_${x.source}`)}</span></td>
                <td className="p-1">{x.sla_measured ? '' : <span className="chip bg-lockBg text-lockInk">{t('sla.not_measured')}</span>}</td>
                <td className="p-1 text-end">{x.source === 'scenario' && x.applies === false && <button className="btn px-2 py-0.5 text-xs" data-testid={`scope-exception-${x.task_code}`} onClick={() => setDlg({ kind: 'exception', task_code: x.task_code })}>{t('scope.add_exception')}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {naByScenario.length === 0 && active.length === 0 && <p className="mt-2 text-sm text-mute" data-testid="scope-no-scenario-na">{t('scope.none_by_scenario')}</p>}
      </section>

      {a.exceptions.length > 0 && (
        <section className="card p-4" data-testid="scope-exceptions">
          <h3 className="mb-2 font-semibold">{t('scope.exceptions_title')}</h3>
          <ul className="space-y-1 text-sm">
            {a.exceptions.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2" data-testid={`scope-exc-${e.id}`}>
                <span className="mono">{e.task_code}</span><span>{e.reason}</span>
                <span className="text-mute">{e.approved_by?.display_name}</span>
                {e.revoked_at ? <span className="chip bg-lockBg text-lockInk">{t('scope.revoked')}</span>
                  : <button className="btn btn-danger px-2 py-0.5 text-xs" data-testid={`scope-revoke-${e.id}`} onClick={() => setDlg({ kind: 'revoke', id: e.id, task_code: e.task_code })}>{t('scope.revoke')}</button>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card p-4" data-testid="gate-history">
        <h3 className="mb-2 flex items-center gap-1 font-semibold"><History size={14} />{t('scope.gate_history')}</h3>
        <ol className="space-y-1 text-sm">
          {(ev.data ?? []).map((g) => (
            <li key={g.id} data-testid={`gate-event-${g.id}`} data-event={g.event}>
              <span className="mono">{g.gate_code}</span> · {t(`scope.ev_${g.event}`)} · <span className="mono">{g.gate_date ?? g.previous_date ?? '–'}</span>
              {g.shifted ? ` · ${t('scope.shifted')}` : ''}{g.cause.length ? ` — ${g.cause.map((c) => c.message).join(' ')}` : ''}
            </li>
          ))}
          {ev.isSuccess && !ev.data.length && <li className="text-mute" data-testid="gate-history-empty">{t('scope.no_events')}</li>}
        </ol>
      </section>

      <FormDialog open={dlg?.kind === 'apply'} onClose={close} testid="scope-apply-dlg" title={t('scope.apply_title')} submitLabel={t('scope.apply')} busy={apply.isPending} error={err}
        onSubmit={(reason) => apply.mutate({ reason }, { onSuccess: (r) => { toast(t('scope.applied', { count: r.result.changed.length })); close(); }, onError: fail })}>
        <p className="text-sm text-mute">{t('scope.apply_note')}</p>
      </FormDialog>
      <FormDialog open={dlg?.kind === 'exception'} onClose={close} testid="scope-exc-dlg" title={t('scope.exception_title', { task: dlg?.kind === 'exception' ? dlg.task_code : '' })} submitLabel={t('scope.add_exception')} busy={add.isPending} error={err}
        onSubmit={(reason) => dlg?.kind === 'exception' && add.mutate({ task_code: dlg.task_code, reason }, { onSuccess: () => { toast(t('scope.exception_saved')); close(); }, onError: fail })}>
        <p className="text-sm text-mute">{t('scope.exception_note')}</p>
      </FormDialog>
      <FormDialog open={dlg?.kind === 'revoke'} onClose={close} testid="scope-revoke-dlg" title={t('scope.revoke_title', { task: dlg?.kind === 'revoke' ? dlg.task_code : '' })} submitLabel={t('scope.revoke')} busy={revoke.isPending} error={err}
        onSubmit={(reason) => dlg?.kind === 'revoke' && revoke.mutate({ id: dlg.id, reason }, { onSuccess: () => { toast(t('scope.exception_revoked')); close(); }, onError: fail })} />
    </div>
  );
}
