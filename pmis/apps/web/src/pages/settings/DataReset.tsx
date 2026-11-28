import { AlertOctagon, Archive, DatabaseBackup, Download, ShieldCheck, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { fmtDateTime } from '@/lib/time';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/api/client';
import {
  archiveMode, archiveOf, archiveReady, downloadDataResetArchive, useMakeDataResetArchive, type ArchiveMode,
  closureOf, narrowBody, narrowEmpty, requiresBackup, RUNNING, useDataResetNarrowOptions, useApproveDataReset, useCancelDataReset, useDataReset, useDataResetPlan, useDataResetRequest, useRequestDataReset, useRetryDataResetFiles,
  useRunDataReset, useSetDataResetSettings, type DataResetNarrow, type DataResetPart, type DataResetPlanTable, type DataResetRequest,
} from '@/api/dataReset';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { CategoryPicker, ConfirmDialog, ResultDialog, categoryRows, resultSeen } from './DataResetCategories';

type Dialog = 'approve' | 'cancel' | 'run' | 'retry' | 'settings' | null;

/**
 * Settings > Data > Data reset (owner decisions 2026-11-24, contract 0.15.62, migration 0146). The most destructive function of the system: a System Admin
 * requests the reset of the project data (reason, step-up, the typed phrase), a DIFFERENT System Admin approves it, then one of the two runs it once a
 * successful database backup of the last hours is recorded. The plan (what is deleted and what is kept, with counts) is the same list as the operator script.
 * The server decides every right; this screen only offers what the state allows. Contract 0.15.71 (migration 0152): the requester chooses the scope (the parts),
 * the parts that depend on a chosen part are added with a visible note (the server computes the same closure and stores it with its hash), and the approver
 * sees that scope read-only with its counts and approves exactly it. Contract 0.15.72 (migration 0154): the requester chooses whether the run needs a recent
 * backup (default) or runs without one (the typed phrase NO BACKUP); the choice is bound into the scope hash, shown with a red warning to the approver and
 * the runner, and only the backup check is skipped.
 */
export function DataReset() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useDataReset();
  const s = q.data;
  const open = s?.request ?? null;
  const live = useDataResetRequest(open?.id ?? null, !!open && (RUNNING.has(open.status) || archiveOf(open)?.status === 'building'));
  const req: DataResetRequest | null = live.data ?? open;
  const running = !!req && RUNNING.has(req.status);
  useEffect(() => { if (live.data && !RUNNING.has(live.data.status)) void qc.invalidateQueries({ queryKey: ['data-reset'] }); }, [live.data, qc]);

  const ask = useRequestDataReset(), approve = useApproveDataReset(), cancel = useCancelDataReset(), run = useRunDataReset();
  const retry = useRetryDataResetFiles(), setCfg = useSetDataResetSettings(), makeArchive = useMakeDataResetArchive();
  const [archive, setArchive] = useState<ArchiveMode>('download');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [confirming, setConfirming] = useState(false);
  const [resultClosed, setResultClosed] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [runTyped, setRunTyped] = useState('');
  const [cfg, setCfgForm] = useState<{ expiry: string; hours: string; cool: string; coolNum: string; coolUnit: 'hours' | 'days' } | null>(null);
  const [mode, setMode] = useState<'everything' | 'custom'>('everything');
  const [chosen, setChosen] = useState<string[]>([]);
  const [requireBackup, setRequireBackup] = useState(true);
  const [noBackupTyped, setNoBackupTyped] = useState('');
  const [narrow, setNarrow] = useState<DataResetNarrow>({});
  const requested = mode === 'custom' ? [...chosen].sort() : null;
  const narrowable = new Set((s?.plan.parts ?? []).filter((p) => p.narrowable).map((p) => p.code));
  // a narrowing is offered only when every chosen part can follow one record; it is dropped when the choice changes to something else
  const canNarrow = mode === 'custom' && chosen.length > 0 && chosen.every((c) => narrowable.has(c));
  const nb = canNarrow ? narrowBody(narrow) : undefined;
  const dry = useDataResetPlan(requested, mode === 'custom' && !!s && !open, nb);
  const when = (iso: string | null | undefined) => (iso ? fmtDateTime(iso, i18n.language === 'ar' ? 'ar' : 'en') || '—' : '—');
  const close = () => setDialog(null);

  if (q.isError) {
    const forbidden = q.error instanceof ApiError && q.error.status === 403;
    return <section className="card p-4" data-testid="page-data-reset"><p role="alert" className="text-lateInk" data-testid="dr-forbidden">{forbidden ? t('dr.admin_only') : t('errors.generic')}</p></section>;
  }
  if (!s) return <section className="card p-4" data-testid="page-data-reset">…</section>;

  const catalogue = s.plan.parts ?? [];
  const shown = mode === 'custom' && !req ? (dry.data ?? null) : s.plan;
  const tables = shown?.tables ?? [];
  const del = tables.filter((x) => x.delete > 0 && x.keep === 0 && x.table !== 'users');
  const mixed = tables.filter((x) => x.delete > 0 && x.keep > 0 && x.table !== 'users');
  const kept = tables.filter((x) => x.delete === 0);
  const scopeOk = mode === 'everything' || chosen.length > 0;
  const reasonOk = reason.trim().length >= 10;
  const phraseOk = typed === s.confirmation_phrase;
  const noBackupPhrase = s.no_backup_phrase ?? 'NO BACKUP';
  const noBackupOk = requireBackup || noBackupTyped === noBackupPhrase;
  const needBackup = requiresBackup(req);
  const last = s.last_request;
  const resultReq = req && (req.status === 'completed' || req.status === 'files_pending') ? req : (!req && last?.status === 'completed' ? last : null);

  return (
    <div className="space-y-4" data-testid="page-data-reset" data-status={req?.status ?? 'none'}>
      <section className="rounded-md border border-lateInk/40 bg-lateBg p-4 text-lateInk" role="alert" data-testid="dr-danger">
        <h2 className="flex items-center gap-2 text-lg font-bold"><AlertOctagon size={20} aria-hidden />{t('dr.title')}</h2>
        <p className="mt-1 text-sm">{t('dr.danger', { db: s.database })}</p>
        <ul className="mt-2 list-disc space-y-1 ps-5 text-sm">
          <li>{t('dr.rule_two_admins')}</li>
          <li>{t('dr.rule_backup', { hours: s.settings.backup_max_age_hours })}</li>
          <li>{t('dr.rule_backup_choice')}</li>
          <li>{t('dr.rule_sessions')}</li>
          <li>{t('dr.rule_files')}</li>
          <li>{t('dr.rule_expiry', { minutes: s.settings.request_expiry_minutes })}</li>
          <li>{t('dr.rule_cooloff', { wait: waitText(t, s.settings.cooloff_minutes) })}</li>
        </ul>
      </section>

      {s.single_admin && <p className="card p-3 text-sm" data-testid="dr-single-admin">{t('dr.single_admin')}</p>}
      {!s.storage.supported && <p className="card p-3 text-sm text-lateInk" data-testid="dr-storage">{t('dr.storage_s3')}</p>}
      {s.script_running && <p className="card p-3 text-sm" data-testid="dr-script">{t('dr.script_running')}</p>}

      <section className="card space-y-1 p-4" data-testid="dr-backup" data-ok={s.backup.ok ? 'true' : 'false'}>
        <h3 className="flex items-center gap-2 font-bold"><DatabaseBackup size={18} aria-hidden />{t('dr.backup')}</h3>
        {s.backup.last_success ? (
          <p className="text-sm" data-testid="dr-backup-last">{t('dr.backup_last', { when: when(s.backup.last_success.at), type: s.backup.last_success.type ?? '—', repo: s.backup.last_success.repository ?? '—' })}</p>
        ) : <p className="text-sm" data-testid="dr-backup-none">{t('dr.backup_none')}</p>}
        <p className={`text-sm font-semibold ${s.backup.ok ? 'text-doneInk' : 'text-lateInk'}`} data-testid="dr-backup-state">
          {s.backup.ok ? t('dr.backup_ok', { hours: s.backup.max_age_hours }) : t('dr.backup_missing', { hours: s.backup.max_age_hours })}
        </p>
        {s.backup.last_problem && <p className="text-sm text-lateInk" data-testid="dr-backup-problem">{t('dr.backup_problem', { when: when(s.backup.last_problem.at), message: s.backup.last_problem.message ?? '' })}</p>}
      </section>

      {s.plan.error && <p className="card p-3 text-sm text-lateInk" role="alert" data-testid="dr-plan-error">{t('dr.plan_error', { error: s.plan.error })}</p>}
      {!running && shown && tables.length > 0 && (
        <section className="card space-y-3 p-4" data-testid="dr-plan" data-scope={mode}>
          <h3 className="font-bold">{t('dr.plan')}</h3>
          <p className="text-sm text-mute" data-testid="dr-plan-note">{t('dr.plan_note', { rows: shown.delete_rows, files: shown.files })}{mode === 'custom' && !req ? ` ${t('dr.plan_scope_note')}` : ''}</p>
          {(shown.accounts_to_deactivate ?? 0) > 0 && <p className="text-sm font-semibold text-lateInk" data-testid="dr-plan-accounts">{t('dr.accounts_note', { count: shown.accounts_to_deactivate })}</p>}
          <div className="grid gap-4 md:grid-cols-2">
            <PlanTable testid="dr-plan-delete" title={t('dr.deleted')} rows={[...del, ...mixed]} col={(r) => (r.action === 'mixed' ? t('dr.mixed_cell', { del: r.delete, keep: r.keep }) : String(r.delete))} />
            <details className="rounded-md border border-line p-2" data-testid="dr-plan-keep">
              <summary className="cursor-pointer text-sm font-semibold">{t('dr.kept', { count: kept.length })}</summary>
              <PlanTable testid="dr-plan-keep-table" title="" rows={kept} col={(r) => String(r.keep)} />
            </details>
          </div>
        </section>
      )}

      {req ? (
        <section className="card space-y-3 p-4" data-testid="dr-request" data-status={req.status}>
          <h3 className="flex items-center gap-2 font-bold"><ShieldCheck size={18} aria-hidden />{t('dr.request')}</h3>
          <p className="font-semibold" data-testid="dr-request-status">{t(`dr.status_${req.status}`)}</p>
          <ScopeView r={req} catalogue={catalogue} />
          <BackupView r={req} hours={s.settings.backup_max_age_hours} />
          <CooloffView r={req} when={when} />
          <ArchivePanel r={req} canMake={!!s.can.start && req.status === 'approved'} making={makeArchive.isPending} error={makeArchive.isError ? errText(makeArchive.error, t) : null}
            onMake={() => { makeArchive.reset(); makeArchive.mutate({ id: req.id }); }} when={when} />
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
            <dt>{t('dr.requested_by')}</dt><dd data-testid="dr-requested-by"><bdi>{req.requested_by.display_name}</bdi> · <bdi>{when(req.requested_at)}</bdi></dd>
            <dt>{t('common.reason')}</dt><dd>{req.request_reason}</dd>
            {req.approved_by && <><dt>{t('dr.approved_by')}</dt><dd data-testid="dr-approved-by"><bdi>{req.approved_by.display_name}</bdi> · <bdi>{when(req.approved_at)}</bdi></dd></>}
            {(req.status === 'requested' || req.status === 'approved') && <><dt>{t('dr.expires')}</dt><dd data-testid="dr-expires"><bdi>{when(req.expires_at)}</bdi></dd></>}
            {req.run_by && <><dt>{t('dr.run_by')}</dt><dd><bdi>{req.run_by.display_name}</bdi> · <bdi>{when(req.run_started_at)}</bdi></dd></>}
          </dl>
          {req.status === 'requested' && !s.can.approve && <p className="text-sm text-mute" data-testid="dr-wait-other">{t('dr.wait_other')}</p>}
          {running && <p className="text-sm" data-testid="dr-progress">{req.status === 'running' ? t('dr.progress_db') : t('dr.progress_files', { done: req.files.moved + req.files.missing + req.files.refused, total: req.files.total })}</p>}
          {req.stalled && <p className="text-sm text-lateInk" data-testid="dr-stalled">{t('dr.stalled')}</p>}
          <div className="flex flex-wrap gap-2">
            {s.can.approve && <button className="btn btn-danger" data-testid="dr-approve" onClick={() => { approve.reset(); setDialog('approve'); }}>{t('dr.approve')}</button>}
            {s.can.start && <button className="btn btn-danger" data-testid="dr-run" disabled={(needBackup && !s.backup.ok) || !s.storage.supported || !archiveReady(req) || req.cooloff.active} onClick={() => { run.reset(); setRunTyped(''); setDialog('run'); }}>{t('dr.run')}</button>}
            {s.can.cancel && <button className="btn" data-testid="dr-cancel" onClick={() => { cancel.reset(); setDialog('cancel'); }}>{t('dr.cancel')}</button>}
            {req.status === 'files_pending' && s.can.retry_files && <button className="btn" data-testid="dr-retry-files" onClick={() => { retry.reset(); setDialog('retry'); }}>{t('dr.retry_files')}</button>}
          </div>
          {s.can.start && needBackup && !s.backup.ok && (
            <p className="text-sm text-lateInk" data-testid="dr-run-blocked">{t('dr.backup_missing', { hours: s.backup.max_age_hours })} {t('dr.backup_missing_new_request')}</p>
          )}
        </section>
      ) : (
        <section className="card space-y-3 p-4" data-testid="dr-form">
          <h3 className="font-bold">{t('dr.new_request')}</h3>
          <ScopePicker catalogue={catalogue} mode={mode} setMode={setMode} chosen={chosen} setChosen={setChosen} disabled={!s.can.request}
            closure={mode === 'everything' ? (s.everything ?? []) : (dry.data?.scope.parts ?? closureOf(chosen, catalogue))} />
          {mode === 'custom' && <p className="text-sm text-mute" data-testid="dr-narrow-whole">{t('dr.narrow_whole')}</p>}
          {canNarrow && <NarrowPicker part={chosen.length === 1 ? chosen[0] : null} narrow={narrow} setNarrow={setNarrow} disabled={!s.can.request} />}
          {mode === 'custom' && chosen.length > 0 && !canNarrow && !narrowEmpty(narrow) && <p className="text-sm text-lateInk" data-testid="dr-narrow-dropped">{t('dr.narrow_dropped')}</p>}
          <ArchiveChoice value={archive} setValue={setArchive} disabled={!s.can.request} />
          <BackupChoice requireBackup={requireBackup} setRequireBackup={(v) => { setRequireBackup(v); setNoBackupTyped(''); }} typed={noBackupTyped} setTyped={setNoBackupTyped}
            phrase={noBackupPhrase} hours={s.settings.backup_max_age_hours} disabled={!s.can.request} />
          <label className="block text-sm font-semibold">{t('dr.reason_label')}
            <textarea className="input mt-1 min-h-16 font-normal" data-testid="dr-reason" value={reason} onChange={(e) => setReason(e.target.value)} disabled={!s.can.request} />
          </label>
          <label className="block text-sm font-semibold">{t('dr.type_phrase', { phrase: s.confirmation_phrase })}
            <input className="input mt-1 font-normal" dir="ltr" data-testid="dr-phrase" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={!s.can.request} autoComplete="off" />
          </label>
          {ask.isError && <p role="alert" className="text-sm text-lateInk" data-testid="dr-form-error">{errText(ask.error, t)}</p>}
          <button className="btn btn-danger" data-testid="dr-submit" disabled={!s.can.request || !reasonOk || !phraseOk || !scopeOk || !noBackupOk || ask.isPending}
            onClick={() => { ask.reset(); setConfirming(true); }}>
            {t('dr.submit')}
          </button>
          {confirming && (
            <ConfirmDialog everything={mode === 'everything'} catalogue={catalogue} busy={ask.isPending} error={ask.isError ? errText(ask.error, t) : null}
              rows={categoryRows((mode === 'custom' ? dry.data?.parts : s.plan.parts) ?? [], mode === 'everything' ? (s.everything ?? []) : (dry.data?.scope.parts ?? closureOf(chosen, catalogue)), catalogue)}
              onClose={() => setConfirming(false)}
              onConfirm={() => ask.mutate({ reason: reason.trim(), confirm_text: typed, ...(requested ? { parts: requested } : {}), ...(nb ? { narrow: nb } : {}), archive,
                ...(requireBackup ? {} : { require_backup: false, no_backup_confirm: noBackupTyped }) },
                { onSuccess: () => { setConfirming(false); toast(t('dr.requested_toast')); setReason(''); setTyped(''); setMode('everything'); setChosen([]); setNarrow({}); setRequireBackup(true); setNoBackupTyped(''); setArchive('download'); } })} />
          )}
        </section>
      )}

      {last?.status === 'completed' && !req && <Result r={last} when={when} />}
      {last && last.status !== 'completed' && !req && (
        <p className="card p-3 text-sm text-mute" data-testid="dr-last">{t('dr.last', { status: t(`dr.status_${last.status}`), when: when(last.finished_at ?? last.requested_at) })}{last.error ? ` — ${last.error}` : ''}</p>
      )}
      {req && (req.status === 'files_pending') && <Result r={req} when={when} />}

      <section className="card space-y-2 p-4" data-testid="dr-settings">
        <h3 className="font-bold">{t('dr.settings')}</h3>
        <p className="text-sm" data-testid="dr-settings-values">{t('dr.settings_values', { minutes: s.settings.request_expiry_minutes, hours: s.settings.backup_max_age_hours })} <span data-testid="dr-settings-cooloff">{t('dr.cooloff_value', { wait: waitText(t, s.settings.cooloff_minutes) })}</span></p>
        <button className="btn" data-testid="dr-settings-edit" disabled={!!req} onClick={() => { setCfg.reset(); setCfgForm(cfgFormOf(s.settings)); setDialog('settings'); }}>{t('common.edit')}</button>
      </section>

      {resultReq && resultClosed !== resultReq.id && !resultSeen(resultReq.id) && <ResultDialog r={resultReq} catalogue={catalogue} onClose={() => setResultClosed(resultReq.id)} />}

      {dialog === 'approve' && req && (
        <ReasonDialog testid="dr-approve-dialog" title={t('dr.approve_title')} hint={`${t('dr.approve_hint')} ${t('dr.approve_scope')}`} min={10} busy={approve.isPending} error={approve.isError ? errText(approve.error, t) : null} onClose={close}
          onSubmit={(r) => approve.mutate({ id: req.id, version: req.version, reason: r, scope_hash: req.scope_hash }, { onSuccess: () => { toast(t('dr.approved_toast')); close(); } })}>
          <ScopeView r={req} catalogue={catalogue} />
          <BackupView r={req} hours={s.settings.backup_max_age_hours} testid="dr-approve-backup" />
          <p className="text-sm" data-testid="dr-approve-cooloff">{req.cooloff.minutes > 0 ? t('dr.cooloff_approve', { wait: waitText(t, req.cooloff.minutes) }) : t('dr.cooloff_approve_none')}</p>
        </ReasonDialog>
      )}
      {dialog === 'cancel' && req && (
        <FormDialog open onClose={close} testid="dr-cancel-dialog" title={t('dr.cancel_title')} busy={cancel.isPending} error={cancel.isError ? errText(cancel.error, t) : null}
          onSubmit={(r) => cancel.mutate({ id: req.id, version: req.version, reason: r }, { onSuccess: () => { toast(t('dr.cancelled_toast')); close(); } })} />
      )}
      {dialog === 'retry' && req && (
        <FormDialog open onClose={close} testid="dr-retry-dialog" title={t('dr.retry_files')} busy={retry.isPending} error={retry.isError ? errText(retry.error, t) : null}
          onSubmit={(r) => retry.mutate({ id: req.id, reason: r }, { onSuccess: close })} />
      )}
      {dialog === 'run' && req && (
        <FormDialog open onClose={close} testid="dr-run-dialog" title={t('dr.run_title')} withReason={false} submitLabel={t('dr.run')} busy={run.isPending}
          disabled={runTyped !== s.confirmation_phrase} error={run.isError ? errText(run.error, t) : null}
          onSubmit={() => run.mutate({ id: req.id, version: req.version, confirm_text: runTyped }, { onSuccess: () => { toast(t('dr.started_toast')); close(); } })}>
          <p className="text-sm text-lateInk">{t('dr.run_hint', { db: s.database })}</p>
          <BackupView r={req} hours={s.settings.backup_max_age_hours} testid="dr-run-backup" />
          <label className="block text-sm font-semibold">{t('dr.type_phrase', { phrase: s.confirmation_phrase })}
            <input className="input mt-1 font-normal" dir="ltr" data-testid="dr-run-phrase" value={runTyped} onChange={(e) => setRunTyped(e.target.value)} autoComplete="off" />
          </label>
        </FormDialog>
      )}
      {dialog === 'settings' && cfg && (
        <FormDialog open onClose={close} testid="dr-settings-dialog" title={t('dr.settings')} busy={setCfg.isPending} error={setCfg.isError ? errText(setCfg.error, t) : null}
          onSubmit={(r) => setCfg.mutate({ version: s.settings.version, reason: r, request_expiry_minutes: Number(cfg.expiry), backup_max_age_hours: Number(cfg.hours), cooloff_minutes: coolMinutes(cfg) }, { onSuccess: () => { toast(t('settings.audited')); close(); } })}>
          <label className="block text-sm font-semibold">{t('dr.expiry_label')}
            <input type="number" min={5} max={240} className="input mt-1 font-normal" data-testid="dr-expiry" value={cfg.expiry} onChange={(e) => setCfgForm({ ...cfg, expiry: e.target.value })} />
          </label>
          <label className="block text-sm font-semibold">{t('dr.hours_label')}
            <input type="number" min={1} max={72} className="input mt-1 font-normal" data-testid="dr-hours" value={cfg.hours} onChange={(e) => setCfgForm({ ...cfg, hours: e.target.value })} />
          </label>
          <label className="block text-sm font-semibold">{t('dr.cooloff_label')}
            <select className="input mt-1 font-normal" data-testid="dr-cooloff" value={cfg.cool} onChange={(e) => setCfgForm({ ...cfg, cool: e.target.value })}>
              <option value="0">{t('dr.cooloff_now')}</option>
              <option value="30">{t('dr.cd_minutes', { count: 30 })}</option>
              <option value="1440">{t('dr.cd_hours', { count: 24 })}</option>
              <option value="custom">{t('dr.cooloff_custom')}</option>
            </select>
          </label>
          {cfg.cool === 'custom' && (
            <div className="flex gap-2" data-testid="dr-cooloff-custom">
              <input type="number" min={1} max={cfg.coolUnit === 'days' ? 30 : 720} className="input w-28" data-testid="dr-cooloff-num" aria-label={t('dr.cooloff_custom')} value={cfg.coolNum} onChange={(e) => setCfgForm({ ...cfg, coolNum: e.target.value })} />
              <select className="input" data-testid="dr-cooloff-unit" aria-label={t('dr.cooloff_unit')} value={cfg.coolUnit} onChange={(e) => setCfgForm({ ...cfg, coolUnit: e.target.value as 'hours' | 'days' })}>
                <option value="hours">{t('dr.cooloff_hours')}</option>
                <option value="days">{t('dr.cooloff_days')}</option>
              </select>
            </div>
          )}
          <p className="text-xs text-mute">{t('dr.cooloff_hint')}</p>
        </FormDialog>
      )}
    </div>
  );
}

type TFn = (k: string, o?: Record<string, unknown>) => string;
/** The waiting period as words: immediately, or whole days, whole hours, else minutes. */
function waitText(t: TFn, minutes: number): string {
  if (minutes <= 0) return t('dr.cooloff_now');
  if (minutes % 1440 === 0) return t('dr.cd_days', { count: minutes / 1440 });
  if (minutes % 60 === 0) return t('dr.cd_hours', { count: minutes / 60 });
  return t('dr.cd_minutes', { count: minutes });
}
function cfgFormOf(st: { request_expiry_minutes: number; backup_max_age_hours: number; cooloff_minutes: number }) {
  const m = st.cooloff_minutes;
  const preset = m === 0 || m === 30 || m === 1440;
  const days = !preset && m % 1440 === 0;
  return { expiry: String(st.request_expiry_minutes), hours: String(st.backup_max_age_hours), cool: preset ? String(m) : 'custom',
    coolNum: preset ? '2' : String(days ? m / 1440 : Math.max(1, Math.round(m / 60))), coolUnit: (days ? 'days' : 'hours') as 'hours' | 'days' };
}
function coolMinutes(c: { cool: string; coolNum: string; coolUnit: 'hours' | 'days' }): number {
  return c.cool === 'custom' ? Math.round(Number(c.coolNum) * (c.coolUnit === 'days' ? 1440 : 60)) : Number(c.cool);
}

/** The waiting period of a request: inherited at the request, started by the approval, live countdown to the moment the run opens. */
function CooloffView({ r, when }: { r: DataResetRequest; when: (iso: string | null | undefined) => string }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!r.cooloff.active) return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, [r.cooloff.active]);
  if (r.cooloff.minutes <= 0) return <p className="text-sm" data-testid="dr-cooloff-view">{t('dr.cooloff_none')}</p>;
  const left = r.cooloff.run_after ? Math.max(0, Math.ceil((new Date(r.cooloff.run_after).getTime() - now) / 1000)) : null;
  const clock = left === null ? '' : `${Math.floor(left / 3600)}:${String(Math.floor((left % 3600) / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
  return (
    <div className="rounded border border-line p-2 text-sm" data-testid="dr-cooloff-view" data-active={r.cooloff.active ? 'true' : 'false'}>
      <p className="font-semibold">{t('dr.cooloff_wait', { wait: waitText(t, r.cooloff.minutes) })}</p>
      {r.status === 'requested' && <p className="text-mute">{t('dr.cooloff_starts')}</p>}
      {r.status === 'approved' && r.cooloff.run_after && (
        r.cooloff.active
          ? <p data-testid="dr-cooloff-left">{t('dr.cooloff_left')} <bdi dir="ltr" className="font-mono font-bold" data-testid="dr-cooloff-clock">{clock}</bdi> · {t('dr.cooloff_from')} <bdi>{when(r.cooloff.run_after)}</bdi> · {t('dr.cooloff_cancel_hint')}</p>
          : <p data-testid="dr-cooloff-over">{t('dr.cooloff_over')}</p>
      )}
    </div>
  );
}

function PlanTable({ rows, title, col, testid }: { rows: DataResetPlanTable[]; title: string; col: (r: DataResetPlanTable) => string; testid: string }) {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto">
      {title && <h4 className="mb-1 text-sm font-semibold">{title}</h4>}
      <table className="w-full text-sm" data-testid={testid}>
        <thead className="text-mute"><tr><th className="p-1 text-start">{t('dr.col_table')}</th><th className="p-1 text-end">{t('dr.col_rows')}</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.table} className="border-t border-line" data-testid={`dr-row-${r.table}`}><td className="mono p-1 text-xs" dir="ltr">{r.table}</td><td className="p-1 text-end">{col(r)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

/** The result of a run and how to restore what was there before (the database from the backup, the files from the quarantine). */
function Result({ r, when }: { r: DataResetRequest; when: (s: string | null | undefined) => string }) {
  const { t } = useTranslation();
  const res = (r.result ?? {}) as { audit_id?: number; sessions_ended?: number };
  const qd = r.quarantine_dir ?? '<STORAGE_DIR>/.pre-reset-<timestamp>';
  return (
    <section className="card space-y-2 p-4" data-testid="dr-result" data-status={r.status}>
      <h3 className="font-bold">{t('dr.result')}</h3>
      <ul className="list-disc space-y-1 ps-5 text-sm">
        <li data-testid="dr-result-when">{t('dr.result_when', { when: when(r.db_committed_at), audit: res.audit_id ?? '—' })}</li>
        <li data-testid="dr-result-sessions">{t('dr.result_sessions', { count: res.sessions_ended ?? 0 })}</li>
        <li data-testid="dr-result-files">{t('dr.result_files', { moved: r.files.moved, missing: r.files.missing, refused: r.files.refused, pending: r.files.pending, total: r.files.total })}</li>
        <li>{t('dr.result_quarantine')} <span className="mono text-xs" dir="ltr" data-testid="dr-result-quarantine">{qd}</span></li>
      </ul>
      {!requiresBackup(r) && <p role="alert" className="rounded-md border border-lateInk bg-lateBg p-2 text-sm font-semibold text-lateInk" data-testid="dr-result-no-backup">{t('dr.result_no_backup')}</p>}
      <h4 className="pt-2 text-sm font-semibold">{t('dr.restore')}</h4>
      <p className="text-sm text-mute">{t('dr.restore_note')}</p>
      <pre className="overflow-x-auto rounded-md bg-card2 p-3 text-xs" dir="ltr" data-testid="dr-restore">{[
        `# 1. ${t('dr.restore_db')}`,
        `sudo -u postgres /usr/local/lib/gsdn-pmis/db-restore.sh --pgdata /var/restore/pmis-pgdata --port 55433 --target-time '${r.run_started_at ?? '<before the reset>'}' --keep-running`,
        `# 2. ${t('dr.restore_swap')}`,
        `# 3. ${t('dr.restore_files')}`,
        `sudo -u gsdn-pmis cp -a -n ${qd}/. <STORAGE_DIR>/`,
      ].join('\n')}</pre>
    </section>
  );
}

function ReasonDialog({ testid, title, hint, min, busy, error, onClose, onSubmit, children }: {
  testid: string; title: string; hint: string; min: number; busy: boolean; error: string | null; onClose: () => void; onSubmit: (reason: string) => void; children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [r, setR] = useState('');
  return (
    <FormDialog open onClose={onClose} testid={testid} title={title} withReason={false} busy={busy} error={error} disabled={r.trim().length < min} submitLabel={title}
      onSubmit={() => onSubmit(r.trim())}>
      <p className="text-sm text-mute">{hint}</p>
      {children}
      <label className="block text-sm font-semibold">{t('dr.reason_label')}
        <textarea className="input mt-1 min-h-16 font-normal" data-testid={`${testid}-reason`} value={r} onChange={(e) => setR(e.target.value)} />
      </label>
    </FormDialog>
  );
}

const IDENTITY = new Set(['users', 'roles', 'staff']);
const GROUPS = ['project', 'registers', 'identity'] as const;
const label = (p: Pick<DataResetPart, 'label_en' | 'label_ar'> | undefined, code: string, lang: string) => (p ? (lang === 'ar' ? p.label_ar : p.label_en) : code);

/**
 * The scope picker: "Everything (as today)" or grouped checkboxes. Ticking a part shows the parts that depend on it as ticked and marked "added" with a note
 * (the closure); they cannot be unticked while what takes them along is chosen. The identity parts carry a red warning.
 */
function ScopePicker({ catalogue, mode, setMode, chosen, setChosen, closure, disabled }: {
  catalogue: DataResetPart[]; mode: 'everything' | 'custom'; setMode: (m: 'everything' | 'custom') => void; chosen: string[]; setChosen: (c: string[]) => void;
  closure: string[]; disabled: boolean;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const inScope = new Set(closure);
  const added = mode === 'custom' ? catalogue.filter((p) => inScope.has(p.code) && !chosen.includes(p.code)) : [];
  const identity = catalogue.filter((p) => IDENTITY.has(p.code) && inScope.has(p.code));
  const toggle = (code: string) => setChosen(chosen.includes(code) ? chosen.filter((c) => c !== code) : [...chosen, code]);
  const count = (p: DataResetPart) => (p.code === 'users' ? t('dr.accounts', { count: p.rows }) : t('dr.rows', { count: p.rows }));
  return (
    <fieldset className="space-y-2 rounded-md border border-line p-3" data-testid="dr-scope" data-mode={mode} disabled={disabled}>
      <legend className="px-1 text-sm font-semibold">{t('dr.scope')}</legend>
      <p className="text-sm text-mute">{t('dr.scope_hint')}</p>
      <label className="flex items-start gap-2 text-sm">
        <input type="radio" name="dr-scope-mode" className="mt-1" data-testid="dr-scope-everything" checked={mode === 'everything'} onChange={() => setMode('everything')} />
        <span><span className="font-semibold">{t('dr.everything')}</span><span className="block text-mute">{t('dr.everything_hint')}</span></span>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="radio" name="dr-scope-mode" data-testid="dr-scope-custom" checked={mode === 'custom'} onChange={() => setMode('custom')} />
        <span className="font-semibold">{t('dr.custom')}</span>
      </label>
      {mode === 'custom' && <div className="ps-6"><CategoryPicker catalogue={catalogue} chosen={chosen} setChosen={setChosen} /></div>}
      {mode === 'custom' && (
        <details className="ps-6" data-testid="dr-by-part">
        <summary className="cursor-pointer text-sm font-semibold">{t('dr.by_part')}</summary>
        <div className="mt-2 grid gap-3 md:grid-cols-3">
          {GROUPS.map((g) => (
            <div key={g} className={`space-y-1 rounded-md p-2 ${g === 'identity' ? 'border border-lateInk/40 bg-lateBg' : 'bg-card2'}`} data-testid={`dr-scope-group-${g}`}>
              <h4 className={`text-sm font-semibold ${g === 'identity' ? 'text-lateInk' : ''}`}>{t(`dr.group_${g}`)}</h4>
              {catalogue.filter((p) => p.group === g).map((p) => {
                const isAdded = inScope.has(p.code) && !chosen.includes(p.code);
                return (
                  <label key={p.code} className="flex items-start gap-2 text-sm" data-testid={`dr-part-row-${p.code}`} data-selected={inScope.has(p.code) ? 'true' : 'false'} data-added={isAdded ? 'true' : 'false'}>
                    <input type="checkbox" className="mt-1" data-testid={`dr-part-${p.code}`} checked={inScope.has(p.code)} disabled={isAdded} onChange={() => toggle(p.code)} />
                    <span className="min-w-0">
                      <span className={IDENTITY.has(p.code) ? 'font-semibold text-lateInk' : ''}>{label(p, p.code, lang)}</span>
                      {isAdded && <span className="ms-1 rounded bg-lateBg px-1 text-xs text-lateInk" data-testid={`dr-part-added-${p.code}`}>{t('dr.added_badge')}</span>}
                      <span className="block text-xs text-mute" data-testid={`dr-part-count-${p.code}`}>{count(p)}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          ))}
        </div>
        </details>
      )}
      {mode === 'custom' && chosen.length === 0 && <p className="text-sm text-lateInk" data-testid="dr-scope-none">{t('dr.none_chosen')}</p>}
      {added.length > 0 && (
        <p role="status" className="rounded-md border border-lateInk/40 bg-lateBg p-2 text-sm text-lateInk" data-testid="dr-scope-added">
          {t('dr.added_note', { parts: added.map((p) => label(p, p.code, lang)).join(', ') })}
        </p>
      )}
      {identity.length > 0 && (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-lateInk bg-lateBg p-2 text-sm font-semibold text-lateInk" data-testid="dr-scope-identity">
          <AlertOctagon size={16} className="mt-0.5 shrink-0" aria-hidden />
          {t('dr.identity_warning', { parts: identity.map((p) => label(p, p.code, lang)).join(', ') })}
        </p>
      )}
    </fieldset>
  );
}

/** The scope of a request, read-only (requester, approver, runner): the parts with their rows when requested, what the dependencies added, the hash. */
function ScopeView({ r, catalogue }: { r: DataResetRequest; catalogue: DataResetPart[] }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const sc = r.scope;
  const byCode = new Map(catalogue.map((p) => [p.code, p]));
  const order = (c: string) => { const i = catalogue.findIndex((p) => p.code === c); return i < 0 ? catalogue.length : i; };
  const rows = ((r.plan_at_request ?? {}) as { parts?: Record<string, number> }).parts ?? {};
  const parts = sc?.parts ?? [];
  const added = new Set(sc?.added ?? []);
  const identity = (sc?.identity ?? []).map((c) => label(byCode.get(c), c, lang));
  return (
    <div className="space-y-1 rounded-md border border-line p-2 text-sm" data-testid="dr-request-scope" data-everything={sc?.everything ? 'true' : 'false'}>
      <h4 className="font-semibold">{t('dr.scope_title')}</h4>
      {sc?.legacy ? <p data-testid="dr-request-scope-legacy">{t('dr.scope_legacy')}</p> : (
        <>
          {sc?.everything && identity.length === 0 && <p className="font-semibold" data-testid="dr-request-scope-everything">{t('dr.scope_everything')}</p>}
          <ul className="flex flex-wrap gap-1">
            {[...parts].sort((a, b) => order(a) - order(b)).map((c) => (
              <li key={c} data-testid={`dr-request-scope-part-${c}`} className={`rounded px-1.5 py-0.5 text-xs ${IDENTITY.has(c) ? 'bg-lateBg font-semibold text-lateInk' : 'bg-card2'}`}>
                {label(byCode.get(c), c, lang)}{c in rows ? ` · ${c === 'users' ? t('dr.accounts', { count: rows[c] }) : t('dr.rows', { count: rows[c] })}` : ''}
                {added.has(c) && <span className="ms-1 text-lateInk">({t('dr.added_badge')})</span>}
              </li>
            ))}
          </ul>
          {sc?.narrow && <NarrowView narrow={sc.narrow} />}
          {identity.length > 0 && <p role="alert" className="font-semibold text-lateInk" data-testid="dr-request-scope-identity">{t('dr.identity_warning', { parts: identity.join(', ') })}</p>}
          {r.scope_hash && <p className="text-xs text-mute">{t('dr.scope_hash')}: <span className="mono" dir="ltr" data-testid="dr-request-scope-hash">{r.scope_hash.slice(0, 12)}</span></p>}
        </>
      )}
    </div>
  );
}

/**
 * The backup choice of a new request (contract 0.15.72): "Require a recent backup (recommended)", the default, or "Run without a backup", which shows the
 * red warning and asks for the typed phrase NO BACKUP. The reason of the request is the reason of the choice.
 */
function BackupChoice({ requireBackup, setRequireBackup, typed, setTyped, phrase, hours, disabled }: {
  requireBackup: boolean; setRequireBackup: (v: boolean) => void; typed: string; setTyped: (v: string) => void; phrase: string; hours: number; disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="space-y-2 rounded-md border border-line p-3" data-testid="dr-backup-choice" data-require={requireBackup ? 'true' : 'false'} disabled={disabled}>
      <legend className="px-1 text-sm font-semibold">{t('dr.backup_choice')}</legend>
      <label className="flex items-start gap-2 text-sm">
        <input type="radio" name="dr-backup-choice" className="mt-1" data-testid="dr-backup-require" checked={requireBackup} onChange={() => setRequireBackup(true)} />
        <span><span className="font-semibold">{t('dr.require_backup')}</span><span className="block text-mute">{t('dr.require_backup_hint', { hours })}</span></span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="radio" name="dr-backup-choice" className="mt-1" data-testid="dr-backup-none-option" checked={!requireBackup} onChange={() => setRequireBackup(false)} />
        <span><span className="font-semibold text-lateInk">{t('dr.no_backup')}</span><span className="block text-mute">{t('dr.no_backup_hint')}</span></span>
      </label>
      {!requireBackup && (
        <div className="space-y-2 ps-6">
          <p role="alert" className="flex items-start gap-2 rounded-md border border-lateInk bg-lateBg p-2 text-sm font-semibold text-lateInk" data-testid="dr-no-backup-warning">
            <AlertOctagon size={16} className="mt-0.5 shrink-0" aria-hidden />{t('dr.no_backup_warning')}
          </p>
          <label className="block text-sm font-semibold">{t('dr.no_backup_type', { phrase })}
            <input className="input mt-1 font-normal" dir="ltr" data-testid="dr-no-backup-phrase" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </label>
          <p className="text-xs text-mute">{t('dr.no_backup_reason_note')}</p>
        </div>
      )}
    </fieldset>
  );
}

/** The backup choice of a request, read-only (requester, approver, runner); a request without a backup carries the red warning. */
function BackupView({ r, hours, testid = 'dr-request-backup' }: { r: DataResetRequest; hours: number; testid?: string }) {
  const { t } = useTranslation();
  const need = requiresBackup(r);
  return need ? (
    <p className="text-sm" data-testid={testid} data-require="true"><span className="font-semibold">{t('dr.backup_requirement')}:</span> {t('dr.backup_required_value')} ({t('dr.require_backup_hint', { hours })})</p>
  ) : (
    <p role="alert" className="flex items-start gap-2 rounded-md border border-lateInk bg-lateBg p-2 text-sm font-bold text-lateInk" data-testid={testid} data-require="false">
      <AlertOctagon size={16} className="mt-0.5 shrink-0" aria-hidden />
      <span><span>{t('dr.backup_requirement')}: {t('dr.backup_not_required_value')}.</span> <span>{t('dr.no_backup_warning')}</span></span>
    </p>
  );
}

const dayText = (d: string | undefined, lang: string) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(lang === 'ar' ? 'ar' : 'en-GB', { dateStyle: 'medium' }) : '');

/**
 * Contract 0.15.265 (migration 0370): narrow the chosen register parts to regions, import batches and a first-created period (every given filter must match).
 * The dry run above recounts with the filter; the filter is part of the scope the approver sees and the hash they approve.
 */
function NarrowPicker({ part, narrow, setNarrow, disabled }: { part: string | null; narrow: DataResetNarrow; setNarrow: (n: DataResetNarrow) => void; disabled: boolean }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const opt = useDataResetNarrowOptions(part);
  const regions = opt.data?.regions ?? [], batches = opt.data?.batches ?? [];
  const toggle = <K extends 'regions' | 'batches'>(key: K, v: NonNullable<DataResetNarrow[K]>[number]) => {
    const cur = ((narrow[key] ?? []) as (typeof v)[]);
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    setNarrow({ ...narrow, [key]: next });
  };
  return (
    <fieldset className="space-y-2 rounded-md border border-line p-3" data-testid="dr-narrow" disabled={disabled}>
      <legend className="px-1 text-sm font-semibold">{t('dr.narrow_title')}</legend>
      <p className="text-sm text-mute">{t('dr.narrow_hint')}</p>
      {opt.isError && <p role="alert" className="text-sm text-lateInk" data-testid="dr-narrow-error">{t('errors.generic')}</p>}
      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-1 rounded-md bg-card2 p-2" data-testid="dr-narrow-regions">
          <h4 className="text-sm font-semibold">{t('dr.narrow_regions')}</h4>
          {regions.map((r) => (
            <label key={r.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" data-testid={`dr-narrow-region-${r.id}`} checked={(narrow.regions ?? []).includes(r.id)} onChange={() => toggle('regions', r.id)} />
              <span>{lang === 'ar' && r.name_ar ? r.name_ar : r.name_en}</span>
            </label>
          ))}
        </div>
        <div className="space-y-1 rounded-md bg-card2 p-2" data-testid="dr-narrow-batches">
          <h4 className="text-sm font-semibold">{t('dr.narrow_batches')}</h4>
          {batches.length === 0 && <p className="text-xs text-mute">{t('dr.narrow_no_batches')}</p>}
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {batches.map((b) => (
              <label key={b.id} className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" data-testid={`dr-narrow-batch-${b.id}`} checked={(narrow.batches ?? []).includes(b.id)} onChange={() => toggle('batches', b.id)} />
                <span className="min-w-0"><span className="mono break-all text-xs" dir="ltr">{b.file_name}</span>
                  <span className="block text-xs text-mute">{t('dr.narrow_batch_meta', { rows: b.rows_total, when: dayText(b.created_at.slice(0, 10), lang) })}</span></span>
              </label>
            ))}
          </div>
        </div>
        <div className="space-y-2 rounded-md bg-card2 p-2" data-testid="dr-narrow-period">
          <h4 className="text-sm font-semibold">{t('dr.narrow_period')}</h4>
          <label className="block text-sm">{t('dr.narrow_from')}
            <input type="date" className="input mt-1" data-testid="dr-narrow-from" value={narrow.from ?? ''} max={narrow.to ?? undefined} onChange={(e) => setNarrow({ ...narrow, from: e.target.value || undefined })} />
          </label>
          <label className="block text-sm">{t('dr.narrow_to')}
            <input type="date" className="input mt-1" data-testid="dr-narrow-to" value={narrow.to ?? ''} min={narrow.from ?? undefined} onChange={(e) => setNarrow({ ...narrow, to: e.target.value || undefined })} />
          </label>
        </div>
      </div>
      {!narrowEmpty(narrow) && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-line p-2 text-sm" data-testid="dr-narrow-active">
          <span>{t('dr.narrow_active')}</span>
          <button type="button" className="btn btn-ghost p-1" data-testid="dr-narrow-clear" aria-label={t('dr.narrow_clear')} onClick={() => setNarrow({})}><X size={16} aria-hidden /></button>
        </div>
      )}
    </fieldset>
  );
}

/** The narrowing of a request, read-only (requester, approver, runner). */
function NarrowView({ narrow }: { narrow: DataResetNarrow }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const needNames = !!narrow.regions?.length;
  const opt = useDataResetNarrowOptions(null, needNames || !!narrow.batches?.length);
  const rname = (id: number) => { const r = opt.data?.regions.find((x) => x.id === id); return r ? (lang === 'ar' && r.name_ar ? r.name_ar : r.name_en) : `#${id}`; };
  const bname = (id: string) => opt.data?.batches.find((x) => x.id === id)?.file_name ?? id.slice(0, 8);
  const bits: string[] = [];
  if (narrow.regions?.length) bits.push(`${t('dr.narrow_regions')}: ${narrow.regions.map(rname).join(', ')}`);
  if (narrow.batches?.length) bits.push(`${t('dr.narrow_batches')}: ${narrow.batches.map(bname).join(', ')}`);
  if (narrow.from || narrow.to) bits.push(`${t('dr.narrow_period')}: ${dayText(narrow.from, lang) || '…'} – ${dayText(narrow.to, lang) || '…'}`);
  return (
    <p className="rounded-md border border-lateInk/40 bg-lateBg p-2 font-semibold text-lateInk" data-testid="dr-request-narrow">
      {t('dr.narrow_view')} {bits.join(' · ')}
    </p>
  );
}

/** Contract 0.15.266 (migration 0371, Data entry proposal P2): the archive made before the delete. Restore is the template upload again. */
function ArchiveChoice({ value, setValue, disabled }: { value: ArchiveMode; setValue: (v: ArchiveMode) => void; disabled: boolean }) {
  const { t } = useTranslation();
  const opts: { v: ArchiveMode; id: string }[] = [{ v: 'download', id: 'dr-archive-download' }, { v: 'keep_90', id: 'dr-archive-keep' }, { v: 'none', id: 'dr-archive-none-option' }];
  return (
    <fieldset className="space-y-2 rounded-md border border-line p-3" data-testid="dr-archive-choice" data-mode={value} disabled={disabled}>
      <legend className="flex items-center gap-1 px-1 text-sm font-semibold"><Archive size={14} aria-hidden />{t('dr.archive_choice')}</legend>
      {opts.map((o) => (
        <label key={o.v} className="flex items-start gap-2 text-sm">
          <input type="radio" name="dr-archive-choice" className="mt-1" data-testid={o.id} checked={value === o.v} onChange={() => setValue(o.v)} />
          <span><span className={`font-semibold ${o.v === 'none' ? 'text-lateInk' : ''}`}>{t(`dr.archive_${o.v}`)}</span><span className="block text-mute">{t(`dr.archive_${o.v}_hint`)}</span></span>
        </label>
      ))}
      <p className="text-xs text-mute" data-testid="dr-archive-restore-note">{t('dr.archive_restore_note')}</p>
    </fieldset>
  );
}

/** The archive of a request: its mode (read-only), its state, the make and download buttons (a System Admin, step-up asked by the request layer). */
function ArchivePanel({ r, canMake, making, error, onMake, when }: {
  r: DataResetRequest; canMake: boolean; making: boolean; error: string | null; onMake: () => void; when: (s: string | null | undefined) => string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const [dl, setDl] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const mode = archiveMode(r), a = archiveOf(r);
  if (mode === 'none') return <p className="text-sm" data-testid="dr-request-archive" data-mode="none"><span className="font-semibold">{t('dr.archive_label')}:</span> {t('dr.archive_none_value')}</p>;
  const open = r.status === 'requested' || r.status === 'approved';
  const download = async () => {
    setDl({ busy: true, error: null });
    try {
      const name = await downloadDataResetArchive(r.id);
      toast(t('dr.archive_downloaded', { name }));
      setDl({ busy: false, error: null });
      void qc.invalidateQueries({ queryKey: ['data-reset'] });
    } catch (e) {
      setDl({ busy: false, error: errText(e, t) });
    }
  };
  const needDownload = mode === 'download' && a?.status === 'ready' && (a.downloads ?? 0) === 0;
  return (
    <div className="space-y-2 rounded-md border border-line p-2 text-sm" data-testid="dr-request-archive" data-mode={mode} data-status={a?.status ?? 'none'}>
      <p className="flex items-center gap-1 font-semibold"><Archive size={14} aria-hidden />{t('dr.archive_label')}: {t(`dr.archive_${mode}_value`)}</p>
      {!a && open && <p className="text-mute" data-testid="dr-archive-state">{r.status === 'approved' ? t('dr.archive_not_made') : t('dr.archive_after_approval')}</p>}
      {a?.status === 'building' && <p role="status" data-testid="dr-archive-state">{t('dr.archive_building')}</p>}
      {a?.status === 'failed' && <p role="alert" className="text-lateInk" data-testid="dr-archive-state">{t('dr.archive_failed', { error: a.error ?? '—' })}</p>}
      {a?.status === 'purged' && <p className="text-mute" data-testid="dr-archive-state">{t('dr.archive_purged')}</p>}
      {a?.status === 'ready' && (
        <p data-testid="dr-archive-state">{t('dr.archive_ready', { size: Math.max(1, Math.round((a.bytes ?? 0) / 1024)), until: when(a.keep_until), count: a.downloads ?? 0 })}</p>
      )}
      {a?.status === 'ready' && a.sha256 && <p className="text-xs text-mute"><bdi dir="ltr">SHA-256</bdi> <span className="mono" dir="ltr" data-testid="dr-archive-sha">{a.sha256.slice(0, 12)}</span></p>}
      {needDownload && <p className="text-lateInk" data-testid="dr-archive-need-download">{t('dr.archive_need_download')}</p>}
      <div className="flex flex-wrap gap-2">
        {canMake && (!a || a.status === 'failed') && (
          <button className="btn" data-testid="dr-archive-make" disabled={making} aria-label={t('dr.archive_make')} title={t('dr.archive_make_hint')} onClick={onMake}>
            <Archive size={14} aria-hidden /> {t('dr.archive_make')}
          </button>
        )}
        {a?.status === 'ready' && (
          <button className="btn" data-testid="dr-archive-download-btn" disabled={dl.busy} aria-label={t('dr.archive_download_btn')} title={t('dr.archive_download_btn_hint')} onClick={() => void download()}>
            <Download size={14} aria-hidden /> {t('dr.archive_download_btn')}
          </button>
        )}
      </div>
      {(error || dl.error) && <p role="alert" className="text-lateInk" data-testid="dr-archive-error">{error ?? dl.error}</p>}
      <p className="text-xs text-mute">{t('dr.archive_restore_note')}</p>
    </div>
  );
}
