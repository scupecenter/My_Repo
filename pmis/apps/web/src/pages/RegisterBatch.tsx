import { ArrowRight, Check, Send, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useBatch, useBatchRows, useDecideBatch, useRegisterDefs, useSubmitBatch } from '@/api/registers';
import type { ImportBatch, ImportBatchOutcome, ImportRow, RegisterDefinition } from '@/api/types';
import { RejectDialog } from '@/components/RejectDialog';
import { fieldLabel, showValue } from '@/components/RegisterFields';
import { useToast } from '@/components/Toast';
import { registerErrorMessage } from '@/lib/registerErrors';

const ACTION_TONE: Record<string, string> = { create: 'bg-doneBg text-doneInk', update: 'bg-openBg text-openInk', unchanged: 'bg-lockBg text-lockInk', error: 'bg-lateBg text-lateInk' };
const DECISION_TONE: Record<string, string> = { approved: 'bg-doneBg text-doneInk', rejected: 'bg-lateBg text-lateInk', pending: 'bg-waitBg text-waitInk', pending_previous_approval: 'bg-lockBg text-lockInk' };
const SENT = ['in_approval', 'partially_approved', 'approved', 'rejected', 'in_review'];

/** The per-cell diff of one row: the field (by its label), what it was and what the file makes it. A new row lists the values it brings. */
export function RowDiff({ row, def }: { row: ImportRow; def?: RegisterDefinition }) {
  const { t, i18n } = useTranslation();
  const entries = Object.entries(row.diff ?? {});
  if (!entries.length) return <span className="text-mute">—</span>;
  return (
    <ul className="space-y-0.5" data-testid={`batch-diff-${row.row_no}`}>
      {entries.map(([code, v]) => {
        const f = def?.fields.find((x) => x.code === code);
        const show = (x: unknown) => (f ? showValue(f, x, i18n.language, t) : x === null || x === undefined || x === '' ? '—' : String(x));
        return (
          <li key={code} className="flex flex-wrap items-baseline gap-1" data-testid={`batch-diff-${row.row_no}-${code}`}>
            <span className="font-semibold">{f ? fieldLabel(f, i18n.language) : code}</span>
            {row.action === 'create' ? <span className="mono">{show(v.new)}</span> : (
              <>
                <span className="mono text-mute line-through" data-testid={`batch-diff-old-${row.row_no}-${code}`}>{show(v.old)}</span>
                <ArrowRight size={12} className="rtl:rotate-180" aria-hidden />
                <span className="mono" data-testid={`batch-diff-new-${row.row_no}-${code}`}>{show(v.new)}</span>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The reasons per cell of an invalid row: the header of the column, then the plain sentence (the server's own words when the app has none). */
export function RowErrors({ row }: { row: ImportRow }) {
  const { t } = useTranslation();
  return (
    <ul className="space-y-0.5" data-testid={`batch-reason-${row.row_no}`}>
      {(row.errors ?? []).map((e, i) => (
        <li key={`${e.code}-${i}`} data-testid={`batch-cell-error-${row.row_no}-${e.field ?? e.code}`}>
          {e.column && <b>{e.column}: </b>}{t(`regErrors.${e.code}`, { field: e.column ?? '', defaultValue: e.message ?? e.code })}
        </li>
      ))}
    </ul>
  );
}

const STEP_OF: Record<string, number> = { validated: 1, in_approval: 2, partially_approved: 2, in_review: 2, approved: 3, rejected: 3, discarded: 3, applied: 3 };

/** Batch review (RE-05, RE-06): the preview with the diff per cell and the reasons per cell, then send it into the flow, and L2 approves row by row or all at once. */
export function RegisterBatch() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { key = '', batchId = '' } = useParams();
  const batch = useBatch(batchId);
  const b = batch.data;
  const rows = useBatchRows(batchId, !!b);
  const submit = useSubmitBatch(), decide = useDecideBatch();
  const [show, setShow] = useState<'all' | 'valid' | 'invalid' | 'held'>('all');
  const [returning, setReturning] = useState<'all' | string | null>(null);
  const [outcome, setOutcome] = useState<(ImportBatchOutcome & { held: NonNullable<ImportBatchOutcome['held']>; failed: NonNullable<ImportBatchOutcome['failed']> }) | null>(null);
  const def = useRegisterDefs().data?.find((d) => d.register_key === key);
  const fail = (e: unknown) => { const m = registerErrorMessage(t, e); if (m) toast(m, 'err'); };
  const all = rows.data?.items ?? [];
  const valid = all.filter((r) => r.action !== 'error'), invalid = all.filter((r) => r.action === 'error');
  const decidable = all.filter((r) => r.action === 'create' || r.action === 'update');
  const held = decidable.filter((r) => r.decision === 'pending_previous_approval');
  const shown = show === 'valid' ? valid : show === 'invalid' ? invalid : show === 'held' ? held : all;
  const sent = !!b && SENT.includes(b.status);
  const open = decidable.filter((r) => r.decision === 'pending' && r.record_id);
  const back = <Link className="btn" data-testid="batch-back" to={`/registers/${key}`}>{t('registers.back')}</Link>;
  const name = def ? ((i18n.language === 'ar' && def.name_ar) || def.name_en) : key;
  const ok = (r: ImportBatchOutcome | undefined) => { if (r) setOutcome({ ...r, held: r.held ?? [], failed: r.failed ?? [] }); };
  const send = (x: ImportBatch) => submit.mutate(x, { onSuccess: (r) => { ok(r.outcome); toast(t('batch.sent')); }, onError: fail });
  const act = (x: ImportBatch, req: Parameters<typeof decide.mutate>[0]['req'], done?: string) =>
    decide.mutate({ batch: x, req }, { onSuccess: (r) => { ok(r.outcome); if (done) toast(done); }, onError: fail });

  if (batch.isError) return <div data-testid="page-register-batch"><p role="alert" className="text-lateInk">{t('regErrors.not_found')}</p>{back}</div>;
  const step = b ? (STEP_OF[b.status] ?? 1) : 1;
  return (
    <div data-testid="page-register-batch" data-status={b?.status}>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex-1"><h1 className="text-2xl font-bold">{t('batch.title', { name })}</h1><p className="text-mute">{b?.file_name} {b && `· ${b.template_id} v${b.template_version}`}</p></div>
        {back}
      </div>
      {!b ? <p className="card p-6 text-mute" data-testid="batch-parsing">{t('batch.parsing')}</p> : (
        <>
          <ol className="mb-3 flex flex-wrap gap-2 text-sm" data-testid="batch-steps" aria-label={t('batch.steps')}>
            {[1, 2, 3].map((n) => (
              <li key={n} aria-current={step === n ? 'step' : undefined} data-step={n} className={`chip ${step === n ? 'bg-accentSoft text-accentText' : step > n ? 'bg-doneBg text-doneInk' : 'bg-card2 text-mute'}`}>{n}. {t(`batch.step_${n}`)}</li>
            ))}
          </ol>
          <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="batch-counts">
            <span className="chip bg-lockBg text-lockInk" data-testid="batch-status">{t(`batchStatus.${b.status}`, { defaultValue: b.status })}</span>
            <span className="chip bg-doneBg text-doneInk" data-testid="batch-count-valid">{t('batch.valid', { count: valid.length })}</span>
            <span className="chip bg-lateBg text-lateInk" data-testid="batch-count-invalid">{t('batch.invalid', { count: invalid.length })}</span>
            <span className="chip bg-card2" data-testid="batch-count-diff">{t('batch.diff', { create: b.counts.create ?? 0, update: b.counts.update ?? 0, unchanged: b.counts.unchanged ?? 0 })}</span>
            {!!held.length && <span className="chip bg-lockBg text-lockInk" data-testid="batch-count-held">{t('batch.held_count', { count: held.length })}</span>}
            <div role="tablist" className="ms-auto flex gap-1">
              {(['all', 'valid', 'invalid', ...(held.length ? ['held'] : [])] as const).map((s) => <button key={s} role="tab" aria-selected={show === s} data-testid={`batch-show-${s}`} className={`btn px-3 py-1 text-xs ${show === s ? 'btn-primary' : ''}`} onClick={() => setShow(s as typeof show)}>{t(`batch.show_${s}`)}</button>)}
            </div>
          </div>
          {b.status === 'validated' && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md bg-card2 p-3 text-sm">
              <span className="flex-1">{decidable.length ? t('batch.ready', { count: decidable.length }) : t('batch.none_valid')}</span>
              <button className="btn" data-testid="batch-discard" disabled={decide.isPending} onClick={() => act(b, { action: 'discard', scope: 'all' }, t('batch.discarded_toast'))}><Trash2 size={16} />{t('batch.discard')}</button>
              <button className="btn btn-primary" data-testid="batch-submit" disabled={!decidable.length || submit.isPending} onClick={() => send(b)}><Send size={16} />{t('batch.send')}</button>
            </div>
          )}
          {sent && (b.status === 'in_approval' || b.status === 'partially_approved') && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md bg-card2 p-3 text-sm">
              <span className="flex-1" data-testid="batch-approve-hint">{t('batch.approve_hint', { count: open.length })}</span>
              {!!held.length && <button className="btn" data-testid="batch-resend" disabled={submit.isPending} onClick={() => send(b)}><Send size={16} />{t('batch.resend')}</button>}
              <button className="btn btn-danger" data-testid="batch-reject-all" disabled={decide.isPending || (!open.length && !held.length)} onClick={() => setReturning('all')}><Undo2 size={16} />{t('batch.reject_all')}</button>
              <button className="btn btn-primary" data-testid="batch-approve-all" disabled={!open.length || decide.isPending} onClick={() => act(b, { action: 'approve', scope: 'all' }, t('approvals.done'))}><Check size={16} />{t('batch.approve_all', { count: open.length })}</button>
            </div>
          )}
          {!!held.length && (
            <div className="mb-3 rounded-md bg-lockBg p-3 text-sm text-lockInk" data-testid="batch-held">
              <p className="font-semibold">{t('batch.held_title', { count: held.length })}</p>
              <p>{t('batch.held_body')}</p>
              <ul className="mt-1 list-disc ps-5">{held.map((r) => <li key={r.id} data-testid={`batch-held-${r.row_no}`}><span className="mono">{r.key}</span> {t('batch.row_no', { n: r.row_no })}</li>)}</ul>
            </div>
          )}
          {outcome && !!outcome.failed.length && (
            <div role="alert" className="mb-3 rounded-md bg-lateBg p-3 text-sm text-lateInk" data-testid="batch-outcome-failed">
              <p className="font-semibold">{t('batch.failed_title', { count: outcome.failed.length })}</p>
              <ul className="mt-1 list-disc ps-5">{outcome.failed.map((f) => <li key={f.row_id}><span className="mono">{f.key}</span>: {t(`regErrors.${f.code}`, { field: '', defaultValue: f.message ?? f.code })}</li>)}</ul>
            </div>
          )}
          {outcome && !!outcome.held.length && b.status !== 'validated' && (
            <p className="mb-3 rounded-md bg-lockBg p-3 text-sm text-lockInk" data-testid="batch-outcome-held">{t('batch.outcome_held', { count: outcome.held.length })}</p>
          )}
          {b.status === 'approved' && <p className="mb-3 rounded-md bg-doneBg p-3 text-doneInk" data-testid="batch-done">{t('batch.done')}</p>}
          {b.status === 'rejected' && <p className="mb-3 rounded-md bg-lateBg p-3 text-lateInk" data-testid="batch-rejected">{t('batch.rejected')}{b.note ? ` ${b.note}` : ''}</p>}
          {b.status === 'discarded' && <p className="mb-3 rounded-md bg-card2 p-3 text-mute" data-testid="batch-discarded">{t('batch.discarded')}</p>}
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm" data-testid="batch-table">
              <thead className="bg-card2 text-mute"><tr>{['row', 'key', 'result', 'changes', 'reason', 'decision', ''].map((c) => <th key={c} className="p-2 text-start">{c ? t(`batch.col_${c}`) : ''}</th>)}</tr></thead>
              <tbody>
                {shown.map((r) => {
                  const canDecide = sent && (b.status === 'in_approval' || b.status === 'partially_approved') && (r.action === 'create' || r.action === 'update');
                  return (
                    <tr key={r.id} className="border-t border-line align-top" data-testid={`batch-row-${r.row_no}`} data-action={r.action} data-decision={r.decision}>
                      <td className="mono p-2">{r.row_no}</td>
                      <td className="mono p-2 font-semibold">{r.key ?? '—'}</td>
                      <td className="p-2"><span className={`chip ${ACTION_TONE[r.action]}`}>{t(`batch.action_${r.action}`)}</span></td>
                      <td className="p-2">{r.action === 'error' ? <span className="text-mute">—</span> : <RowDiff row={r} def={def} />}</td>
                      <td className="p-2 text-lateInk">{r.action === 'error' ? <RowErrors row={r} /> : r.note ? <span className="text-mute" data-testid={`batch-note-${r.row_no}`}>{r.note}</span> : '—'}</td>
                      <td className="p-2">{r.action === 'error' ? '—' : r.action === 'unchanged' ? <span className="text-mute">{t('batch.skipped')}</span> : <span className={`chip ${DECISION_TONE[r.decision]}`} data-testid={`batch-decision-${r.row_no}`}>{t(`batch.decision_${r.decision}`)}</span>}</td>
                      <td className="p-2">
                        <span className="flex flex-wrap gap-1">
                          {r.record_id && <Link className="btn px-2 py-0.5 text-xs" data-testid={`batch-open-record-${r.row_no}`} to={`/registers/${key}?record=${r.record_id}`}>{t('batch.open_record')}</Link>}
                          {canDecide && r.decision === 'pending' && r.record_id && (
                            <>
                              <button className="btn px-2 py-0.5 text-xs" data-testid={`batch-row-approve-${r.row_no}`} disabled={decide.isPending} onClick={() => act(b, { action: 'approve', scope: 'rows', rows: [{ row_id: r.id, decision: 'approved' }] }, t('approvals.done'))}><Check size={12} />{t('approvals.approve')}</button>
                              <button className="btn btn-danger px-2 py-0.5 text-xs" data-testid={`batch-row-reject-${r.row_no}`} disabled={decide.isPending} onClick={() => setReturning(r.id)}><Undo2 size={12} />{t('batch.return')}</button>
                            </>
                          )}
                          {canDecide && r.decision === 'pending_previous_approval' && (
                            <button className="btn btn-danger px-2 py-0.5 text-xs" data-testid={`batch-row-reject-${r.row_no}`} disabled={decide.isPending} onClick={() => setReturning(r.id)}><Undo2 size={12} />{t('batch.return')}</button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.isSuccess && !shown.length && <p className="p-4 text-center text-mute">{t('registers.empty')}</p>}
          </div>
          <RejectDialog open={returning !== null} title={returning === 'all' ? t('batch.reject_all_title') : t('batch.return_row_title')} onClose={() => setReturning(null)}
            onSend={(note) => {
              const target = returning; setReturning(null);
              if (!target) return;
              act(b, target === 'all' ? { action: 'reject', scope: 'all', note } : { action: 'reject', scope: 'rows', rows: [{ row_id: target, decision: 'rejected', note }], note });
            }} />
        </>
      )}
    </div>
  );
}
