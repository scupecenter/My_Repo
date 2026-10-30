import { Check, Send, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useBatch, useBatchRows, useDecideBatch, useRegisterDefs, useSubmitBatch } from '@/api/registers';
import type { ImportRow } from '@/api/types';
import { RejectDialog } from '@/components/RejectDialog';
import { useToast } from '@/components/Toast';
import { registerErrorMessage } from '@/lib/registerErrors';

const ACTION_TONE: Record<string, string> = { create: 'bg-doneBg text-doneInk', update: 'bg-openBg text-openInk', unchanged: 'bg-lockBg text-lockInk', error: 'bg-lateBg text-lateInk' };
const DECISION_TONE: Record<string, string> = { approved: 'bg-doneBg text-doneInk', rejected: 'bg-lateBg text-lateInk', pending: 'bg-waitBg text-waitInk', pending_previous_approval: 'bg-lockBg text-lockInk' };

/** Batch review (RE-05, RE-06): valid rows, invalid rows with the reason, then approve row by row or all at once. */
export function RegisterBatch() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { key = '', batchId = '' } = useParams();
  const batch = useBatch(batchId);
  const b = batch.data;
  const rows = useBatchRows(batchId, !!b && b.status !== 'parsing');
  const submit = useSubmitBatch(), decide = useDecideBatch();
  const [show, setShow] = useState<'all' | 'valid' | 'invalid'>('all');
  const [rejecting, setRejecting] = useState(false);
  const def = useRegisterDefs().data?.find((d) => d.register_key === key);
  const fail = (e: unknown) => { const m = registerErrorMessage(t, e); if (m) toast(m, 'err'); };
  const all = rows.data?.items ?? [];
  const valid = all.filter((r) => r.action !== 'error'), invalid = all.filter((r) => r.action === 'error');
  const shown = show === 'valid' ? valid : show === 'invalid' ? invalid : all;
  const level = b?.status === 'in_review' ? 'review' : b?.status === 'in_approval' ? 'approve' : null;
  const open = valid.filter((r) => r.decision === 'pending');
  const back = <Link className="btn" data-testid="batch-back" to={`/registers/${key}`}>{t('registers.back')}</Link>;
  const colText = (r: ImportRow) => (r.errors ?? []).map((e) => `${e.column ? `${e.column}: ` : ''}${t(`regErrors.${e.code}`, { field: e.column ?? '', defaultValue: e.message ?? e.code })}`).join('; ');
  const decideRows = (r: ImportRow, decision: 'approved' | 'rejected') => b && level && decide.mutate({ batch: b, req: { action: level, scope: 'rows', rows: [{ row_id: r.id, decision }] } }, { onError: fail });
  const name = def ? ((i18n.language === 'ar' && def.name_ar) || def.name_en) : key;

  if (batch.isError) return <div data-testid="page-register-batch"><p role="alert" className="text-lateInk">{t('regErrors.not_found')}</p>{back}</div>;
  return (
    <div data-testid="page-register-batch" data-status={b?.status}>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex-1"><h1 className="text-2xl font-bold">{t('batch.title', { name })}</h1><p className="text-mute">{b?.file_name} {b && `· ${b.template_id} v${b.template_version}`}</p></div>
        {back}
      </div>
      {!b || b.status === 'parsing' ? <p className="card p-6 text-mute" data-testid="batch-parsing">{t('batch.parsing')}</p> : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="batch-counts">
            <span className="chip bg-lockBg text-lockInk" data-testid="batch-status">{t(`batchStatus.${b.status}`, { defaultValue: b.status })}</span>
            <span className="chip bg-doneBg text-doneInk" data-testid="batch-count-valid">{t('batch.valid', { count: valid.length })}</span>
            <span className="chip bg-lateBg text-lateInk" data-testid="batch-count-invalid">{t('batch.invalid', { count: invalid.length })}</span>
            <span className="chip bg-card2">{t('batch.diff', { create: b.counts.create ?? 0, update: b.counts.update ?? 0, unchanged: b.counts.unchanged ?? 0 })}</span>
            <div role="tablist" className="ms-auto flex gap-1">
              {(['all', 'valid', 'invalid'] as const).map((s) => <button key={s} role="tab" aria-selected={show === s} data-testid={`batch-show-${s}`} className={`btn px-3 py-1 text-xs ${show === s ? 'btn-primary' : ''}`} onClick={() => setShow(s)}>{t(`batch.show_${s}`)}</button>)}
            </div>
          </div>
          {b.status === 'validated' && (
            <div className="mb-3 flex items-center gap-3 rounded-md bg-card2 p-3 text-sm">
              <span className="flex-1">{valid.length ? t('batch.ready', { count: valid.length }) : t('batch.none_valid')}</span>
              <button className="btn btn-primary" data-testid="batch-submit" disabled={!valid.length || submit.isPending} onClick={() => submit.mutate(b, { onSuccess: () => toast(t('batch.sent')), onError: fail })}><Send size={16} />{t('batch.send')}</button>
            </div>
          )}
          {level && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md bg-card2 p-3 text-sm">
              <span className="flex-1">{t(level === 'review' ? 'batch.review_hint' : 'batch.approve_hint', { count: open.length })}</span>
              <button className="btn btn-danger" data-testid="batch-reject-all" disabled={decide.isPending} onClick={() => setRejecting(true)}><X size={16} />{t('batch.reject_all')}</button>
              <button className="btn btn-primary" data-testid="batch-approve-all" disabled={!open.length || decide.isPending} onClick={() => decide.mutate({ batch: b, req: { action: level, scope: 'all' } }, { onSuccess: () => toast(t('approvals.done')), onError: fail })}><Check size={16} />{t('batch.approve_all', { count: open.length })}</button>
            </div>
          )}
          {(b.status === 'applied' || b.status === 'approved') && <p className="mb-3 rounded-md bg-doneBg p-3 text-doneInk" data-testid="batch-done">{t('batch.done')}</p>}
          {b.status === 'rejected' && <p className="mb-3 rounded-md bg-lateBg p-3 text-lateInk" data-testid="batch-rejected">{t('batch.rejected')}</p>}
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm" data-testid="batch-table">
              <thead className="bg-card2 text-mute"><tr>{['row', 'key', 'result', 'reason', 'decision', ''].map((c) => <th key={c} className="p-2 text-start">{c ? t(`batch.col_${c}`) : ''}</th>)}</tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className="border-t border-line" data-testid={`batch-row-${r.row_no}`} data-action={r.action} data-decision={r.decision}>
                    <td className="mono p-2">{r.row_no}</td><td className="mono p-2 font-semibold">{r.key ?? '—'}</td>
                    <td className="p-2"><span className={`chip ${ACTION_TONE[r.action]}`}>{t(`batch.action_${r.action}`)}</span></td>
                    <td className="p-2 text-lateInk" data-testid={`batch-reason-${r.row_no}`}>{r.action === 'error' ? colText(r) : r.diff && Object.keys(r.diff).length ? Object.keys(r.diff).join(', ') : '—'}</td>
                    <td className="p-2">{r.action === 'error' ? '—' : <span className={`chip ${DECISION_TONE[r.decision]}`} data-testid={`batch-decision-${r.row_no}`}>{t(`batch.decision_${r.decision}`)}</span>}</td>
                    <td className="p-2">
                      {level && r.action !== 'error' && r.decision === 'pending' && (
                        <span className="flex gap-1">
                          <button className="btn px-2 py-0.5 text-xs" data-testid={`batch-row-approve-${r.row_no}`} disabled={decide.isPending} onClick={() => decideRows(r, 'approved')}><Check size={12} />{t(level === 'review' ? 'approvals.pass' : 'approvals.approve')}</button>
                          <button className="btn btn-danger px-2 py-0.5 text-xs" data-testid={`batch-row-reject-${r.row_no}`} disabled={decide.isPending} onClick={() => decideRows(r, 'rejected')}><X size={12} />{t('approvals.reject')}</button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.isSuccess && !shown.length && <p className="p-4 text-center text-mute">{t('registers.empty')}</p>}
          </div>
          <RejectDialog open={rejecting} title={t('batch.reject_all_title')} onClose={() => setRejecting(false)}
            onSend={(note) => { setRejecting(false); if (level) decide.mutate({ batch: b, req: { action: 'reject', scope: 'all', note } }, { onError: fail }); }} />
        </>
      )}
    </div>
  );
}
