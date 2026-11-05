import { ArrowRight, Check, Send, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useBatch, useBatches, useBatchRows, useDecideBatch, useParseJob, useRegisterDefs, useSubmitBatch } from '@/api/registers';
import { batchPath, type ImportBatch, type ImportBatchOutcome, type ImportRow, type RegisterDefinition } from '@/api/types';
import { batchTotals, BatchProgress } from '@/components/BatchProgress';
import { useBatchValueFormat, type ShowValue } from '@/components/batchFormat';
import { RejectDialog } from '@/components/RejectDialog';
import { fieldLabel, showValue } from '@/components/RegisterFields';
import { useToast } from '@/components/Toast';
import { useVirtual } from '@/components/useVirtual';
import { registerErrorMessage } from '@/lib/registerErrors';

const ACTION_TONE: Record<string, string> = { create: 'bg-doneBg text-doneInk', update: 'bg-openBg text-openInk', unchanged: 'bg-lockBg text-lockInk', error: 'bg-lateBg text-lateInk' };
const DECISION_TONE: Record<string, string> = { approved: 'bg-doneBg text-doneInk', rejected: 'bg-lateBg text-lateInk', pending: 'bg-waitBg text-waitInk', pending_previous_approval: 'bg-lockBg text-lockInk', saved: 'bg-openBg text-openInk' };
const SENT = ['in_approval', 'partially_approved', 'approved', 'rejected', 'in_review'];
/** One file row of a stream batch gives one batch row per touched task, so a row is identified by its number and its task. */
export const rowId = (r: Pick<ImportRow, 'row_no' | 'task_code'>): string => (r.task_code ? `${r.row_no}-${r.task_code}` : String(r.row_no));
const humanize = (code: string) => { const s = code.replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };

/** The per-cell diff of one row: the field (by its label), what it was and what the file makes it. A new row lists the values it brings. */
export function RowDiff({ row, def, site, fmt }: { row: ImportRow; def?: RegisterDefinition; site?: boolean; fmt?: ShowValue }) {
  const { t, i18n } = useTranslation();
  const entries = Object.entries(row.diff ?? {});
  if (!entries.length) return <span className="text-mute">—</span>;
  return (
    <ul className="space-y-0.5" data-testid={`batch-diff-${rowId(row)}`}>
      {entries.map(([code, v]) => {
        const f = def?.fields.find((x) => x.code === code);
        // the label in the current language (region name, Yes / No / N/A, scenario, list label); the code stays in the title
        const show = (x: unknown) => { if (fmt) return fmt(code, x).text; return f ? showValue(f, x, i18n.language, t) : x === null || x === undefined || x === '' ? '—' : String(x); };
        const tip = (x: unknown) => (fmt ? fmt(code, x).raw ?? undefined : undefined);
        // a task row: the three dates of the task, or a key of its values (the label of the field when the app has one)
        const label = f ? fieldLabel(f, i18n.language) : row.task_code ? t(`batch.task_field.${code}`, { defaultValue: humanize(code) }) : site ? t(`newSite.field.${code}`, { defaultValue: humanize(code) }) : code;
        return (
          <li key={code} className="flex flex-wrap items-baseline gap-1" data-testid={`batch-diff-${rowId(row)}-${code}`}>
            <span className="font-semibold">{label}</span>
            {row.action === 'create' ? <span className="mono" title={tip(v.new)}>{show(v.new)}</span> : (
              <>
                <span className="mono text-mute line-through" title={tip(v.old)} data-testid={`batch-diff-old-${rowId(row)}-${code}`}>{show(v.old)}</span>
                <ArrowRight size={12} className="rtl:rotate-180" aria-hidden />
                <span className="mono" title={tip(v.new)} data-testid={`batch-diff-new-${rowId(row)}-${code}`}>{show(v.new)}</span>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The reasons per cell of an invalid row: the header of the column, then the plain sentence (the server's own words when the app has none). */
export function RowErrors({ row, site }: { row: ImportRow; site?: boolean }) {
  const { t } = useTranslation();
  return (
    <ul className="space-y-0.5" data-testid={`batch-reason-${rowId(row)}`}>
      {(row.errors ?? []).map((e, i) => (
        <li key={`${e.code}-${i}`} data-testid={`batch-cell-error-${rowId(row)}-${e.field ?? e.code}`}>
          {e.column && <b>{e.column}: </b>}{site ? t(`newSite.err.${e.code}`, { defaultValue: e.message ?? e.code }) : t(`regErrors.${e.code}`, { field: e.column ?? '', defaultValue: e.message ?? e.code })}
        </li>
      ))}
    </ul>
  );
}

/** The warnings of a task row (never blocking): an SLA that is negative or late, a calculated column that was not read, a row that waits for a predecessor. */
export function RowWarnings({ row }: { row: ImportRow }) {
  const { t } = useTranslation();
  if (!row.warnings?.length) return null;
  return (
    <ul className="space-y-0.5 text-waitInk" data-testid={`batch-warnings-${rowId(row)}`}>
      {row.warnings.map((w, i) => (
        <li key={`${w.code}-${i}`} data-testid={`batch-warning-${rowId(row)}-${w.code}`}>
          {w.column && <b>{w.column}: </b>}{t(`batchWarn.${w.code}`, { defaultValue: w.message ?? w.code })}
        </li>
      ))}
    </ul>
  );
}

const STEP_OF: Record<string, number> = { validated: 1, processing: 2, in_approval: 2, partially_approved: 2, in_review: 2, approved: 3, rejected: 3, discarded: 3, applied: 3 };

/** Batch review (RE-05, RE-06): the preview with the diff per cell and the reasons per cell, then send it into the flow, and L2 approves row by row or all at once. */
export function RegisterBatch() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { key: keyParam = '', batchId = '' } = useParams();
  const batch = useBatch(batchId);
  const b = batch.data;
  const key = keyParam || b?.register_key || '';
  const stream = b?.stream ?? null;
  const siteBatch = b?.entity === 'site'; // a New sites batch (contract 0.14.0): its rows are site drafts, and a site is created when L2 approves a row
  const rows = useBatchRows(batchId, !!b);
  const submit = useSubmitBatch(), decide = useDecideBatch();
  const [show, setShow] = useState<'all' | 'valid' | 'invalid' | 'held'>('all');
  const [returning, setReturning] = useState<'all' | string | null>(null);
  const [outcome, setOutcome] = useState<(ImportBatchOutcome & { held: NonNullable<ImportBatchOutcome['held']>; failed: NonNullable<ImportBatchOutcome['failed']> }) | null>(null);
  const def = useRegisterDefs().data?.find((d) => d.register_key === key);
  const fail = (e: unknown) => { const m = registerErrorMessage(t, e); if (m) toast(m, 'err'); };
  const job = useParseJob(b);
  const fmt = useBatchValueFormat(def);
  const all = rows.items;
  // every number on the page comes from the server counts of the batch, never from the rows that happen to be loaded (the filters below only filter the loaded rows)
  const c = batchTotals(b?.counts ?? {});
  const validN = c.valid, invalidN = c.error, heldN = c.held, decidableN = c.create + c.update, openN = c.pending;
  const held = all.filter((r) => (r.action === 'create' || r.action === 'update') && r.decision === 'pending_previous_approval');
  const shown = show === 'valid' ? all.filter((r) => r.action !== 'error') : show === 'invalid' ? all.filter((r) => r.action === 'error') : show === 'held' ? held : all;
  const sent = !!b && SENT.includes(b.status);
  // a big batch (a New sites file of ~500 rows) is windowed: only the rows in view are drawn
  const BIG = 300, ROW_H = 76, virtual = shown.length > BIG;
  const viewport = typeof window === 'undefined' ? 640 : Math.max(360, window.innerHeight - 320);
  const v = useVirtual(shown.length, ROW_H, viewport);
  const visible = virtual ? shown.slice(v.start, v.end) : shown;
  const totalRows = c.rows;
  const group = useBatches({ status: '', template_id: '', register_key: '', group_id: b?.group_id ?? '' }, !!b?.group_id);
  const back = <Link className="btn" data-testid="batch-back" to={siteBatch ? '/sites' : stream ? '/templates' : `/registers/${key}`}>{siteBatch ? t('newSite.back') : stream ? t('tpl.back') : t('registers.back')}</Link>;
  const name = siteBatch ? t('batch.site_name') : stream ? t(`tpl.stream_${stream}`, { defaultValue: stream }) : def ? ((i18n.language === 'ar' && def.name_ar) || def.name_en) : key;
  const ok = (r: ImportBatchOutcome | undefined) => { if (r) setOutcome({ ...r, held: r.held ?? [], failed: r.failed ?? [] }); };
  // 0.14.4: a big New sites batch answers 202 `processing`: the page polls and the bar follows the background run
  const send = (x: ImportBatch) => submit.mutate(x, { onSuccess: (r) => { ok(r.outcome); toast(r.status === 'processing' ? t('batch.processing_started') : t('batch.sent')); }, onError: fail });
  const act = (x: ImportBatch, req: Parameters<typeof decide.mutate>[0]['req'], done?: string) =>
    decide.mutate({ batch: x, req }, { onSuccess: (r) => { ok(r.outcome); if (r.status === 'processing') toast(t('batch.processing_started')); else if (done) toast(done); }, onError: fail });

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
          {!!b.group_id && !!group.data?.items.length && (
            <nav className="mb-3 flex flex-wrap items-center gap-2 text-sm" data-testid="batch-group" aria-label={t('batch.group')}>
              <span className="text-mute">{t('batch.group_hint')}</span>
              {[...group.data.items].sort((x, y) => (x.part_sheet ?? '').localeCompare(y.part_sheet ?? '', 'en') || x.template_id.localeCompare(y.template_id, 'en')).map((p) => (
                <Link key={p.id} to={batchPath(p)} aria-current={p.id === b.id ? 'page' : undefined} data-testid={`batch-group-${p.id}`}
                  className={`chip ${p.id === b.id ? 'bg-accentSoft text-accentText' : 'bg-card2'}`}>{p.stream ? t(`tpl.stream_${p.stream}`, { defaultValue: p.stream }) : p.part_sheet ?? p.register_key ?? p.template_id} · {t(`batchStatus.${p.status}`, { defaultValue: p.status })}</Link>
              ))}
            </nav>
          )}
          <ol className="mb-3 flex flex-wrap gap-2 text-sm" data-testid="batch-steps" aria-label={t('batch.steps')}>
            {[1, 2, 3].map((n) => (
              <li key={n} aria-current={step === n ? 'step' : undefined} data-step={n} className={`chip ${step === n ? 'bg-accentSoft text-accentText' : step > n ? 'bg-doneBg text-doneInk' : 'bg-card2 text-mute'}`}>{n}. {t(`batch.step_${n}`)}</li>
            ))}
          </ol>
          <BatchProgress batch={b} job={job} site={siteBatch} />
          <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="batch-counts">
            <span className="chip bg-lockBg text-lockInk" data-testid="batch-status">{t(`batchStatus.${b.status}`, { defaultValue: b.status })}</span>
            <span className="chip bg-doneBg text-doneInk" data-testid="batch-count-valid">{t('batch.valid', { count: validN })}</span>
            <span className="chip bg-lateBg text-lateInk" data-testid="batch-count-invalid">{t('batch.invalid', { count: invalidN })}</span>
            <span className="chip bg-card2" data-testid="batch-count-diff">{t('batch.diff', { create: b.counts.create ?? 0, update: b.counts.update ?? 0, unchanged: b.counts.unchanged ?? 0 })}</span>
            {!!heldN && <span className="chip bg-lockBg text-lockInk" data-testid="batch-count-held">{t('batch.held_count', { count: heldN })}</span>}
            {rows.loadingMore && <span className="chip bg-card2 text-mute" role="status" data-testid="batch-loading-rows">{t('batchProgress.loading_rows', { loaded: all.length, total: totalRows })}</span>}
            {b.historical_load && <span className="chip bg-waitBg text-waitInk" data-testid="batch-historical" title={b.historical_load.reason}>{t('hw.batch_chip', { cutoff: b.historical_load.cutoff_date })}</span>}
            <div role="tablist" className="ms-auto flex gap-1">
              {(['all', 'valid', 'invalid', ...(heldN ? ['held'] : [])] as const).map((s) => <button key={s} role="tab" aria-selected={show === s} data-testid={`batch-show-${s}`} className={`btn px-3 py-1 text-xs ${show === s ? 'btn-primary' : ''}`} onClick={() => setShow(s as typeof show)}>{t(`batch.show_${s}`)}</button>)}
            </div>
          </div>
          {b.status === 'validated' && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md bg-card2 p-3 text-sm">
              <span className="flex-1">{decidableN ? t('batch.ready', { count: decidableN }) : t('batch.none_valid')}</span>
              <button className="btn" data-testid="batch-discard" disabled={decide.isPending} onClick={() => act(b, { action: 'discard', scope: 'all' }, t('batch.discarded_toast'))}><Trash2 size={16} />{t('batch.discard')}</button>
              <button className="btn btn-primary" data-testid="batch-submit" disabled={!decidableN || submit.isPending} onClick={() => send(b)}><Send size={16} />{t('batch.send')}</button>
            </div>
          )}
          {b.status === 'processing' && (
            // 0.14.4: nothing can be sent or decided while the background run works; the buttons come back when it ends
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md bg-card2 p-3 text-sm" data-testid="batch-processing">
              <span className="flex-1" role="status">{t('batchStatus.processing')}</span>
              <button className="btn btn-primary" data-testid="batch-processing-busy" disabled aria-disabled="true"><Send size={16} />{t('batch.processing_busy')}</button>
            </div>
          )}
          {sent && (b.status === 'in_approval' || b.status === 'partially_approved') && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md bg-card2 p-3 text-sm">
              <span className="flex-1" data-testid="batch-approve-hint">{t('batch.approve_hint', { count: openN })}</span>
              {!!heldN && <button className="btn" data-testid="batch-resend" disabled={submit.isPending} onClick={() => send(b)}><Send size={16} />{t('batch.resend')}</button>}
              <button className="btn btn-danger" data-testid="batch-reject-all" disabled={decide.isPending || (!openN && !heldN)} onClick={() => setReturning('all')}><Undo2 size={16} />{t('batch.reject_all')}</button>
              <button className="btn btn-primary" data-testid="batch-approve-all" disabled={!openN || decide.isPending} onClick={() => act(b, { action: 'approve', scope: 'all' }, t('approvals.done'))}><Check size={16} />{t('batch.approve_all', { count: openN })}</button>
            </div>
          )}
          {!!heldN && (
            <div className="mb-3 rounded-md bg-lockBg p-3 text-sm text-lockInk" data-testid="batch-held">
              <p className="font-semibold">{stream ? t('batch.held_title_task', { count: heldN }) : t('batch.held_title', { count: heldN })}</p>
              <p>{stream ? t('batch.held_body_task') : t('batch.held_body')}</p>
              <ul className="mt-1 list-disc ps-5">{held.map((r) => <li key={r.id} data-testid={`batch-held-${rowId(r)}`}><span className="mono">{r.key}</span> {t('batch.row_no', { n: r.row_no })}{r.hold_reason && r.hold_reason !== 'open_version' ? ` · ${t(`batch.hold_${r.hold_reason}`)}` : ''}</li>)}</ul>
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
          <div className={`card overflow-x-auto ${virtual ? 'max-h-[70vh] overflow-y-auto' : ''}`} data-testid="batch-scroller" data-loaded={all.length} data-total={totalRows} onScroll={virtual ? v.onScroll : undefined}>
            <table className="w-full min-w-[820px] text-sm" data-testid="batch-table">
              <thead className="bg-card2 text-mute"><tr>{['row', 'key', 'result', 'changes', 'reason', 'decision', ''].map((c) => <th key={c} className="p-2 text-start">{c ? t(`batch.col_${c}`) : ''}</th>)}</tr></thead>
              <tbody>
                {virtual && v.start > 0 && <tr aria-hidden style={{ height: v.start * ROW_H }} />}
                {visible.map((r) => {
                  const canDecide = sent && (b.status === 'in_approval' || b.status === 'partially_approved') && (r.action === 'create' || r.action === 'update');
                  return (
                    <tr key={r.id} className="border-t border-line align-top" data-testid={`batch-row-${rowId(r)}`} data-action={r.action} data-decision={r.decision} data-source={r.source_ref ?? ''}>
                      <td className="mono p-2">{r.source_ref && b.group_id ? r.source_ref : r.row_no}</td>
                      <td className="mono p-2 font-semibold">{r.key ?? '—'}</td>
                      <td className="p-2"><span className={`chip ${ACTION_TONE[r.action]}`}>{t(`batch.action_${r.action}`)}</span></td>
                      <td className="p-2">{r.action === 'error' ? <span className="text-mute">—</span> : <RowDiff row={r} def={def} site={siteBatch} fmt={fmt} />}</td>
                      <td className="p-2 text-lateInk">
                        {r.action === 'error' ? <RowErrors row={r} site={siteBatch} /> : r.note ? <span className="text-mute" data-testid={`batch-note-${rowId(r)}`}>{r.note}</span> : !r.warnings?.length ? '—' : null}
                        <RowWarnings row={r} />
                      </td>
                      <td className="p-2">{r.action === 'error' ? '—' : r.action === 'unchanged' ? <span className="text-mute">{t('batch.skipped')}</span>
                        : <span className={`chip ${DECISION_TONE[r.decision]}`} data-testid={`batch-decision-${rowId(r)}`}>{r.decision === 'pending_previous_approval' && r.hold_reason && r.hold_reason !== 'open_version' ? t(`batch.hold_${r.hold_reason}`) : t(`batch.decision_${r.decision}`)}</span>}</td>
                      <td className="p-2">
                        <span className="flex flex-wrap gap-1">
                          {r.record_id && <Link className="btn px-2 py-0.5 text-xs" data-testid={`batch-open-record-${rowId(r)}`} to={`/registers/${key}?record=${r.record_id}`}>{t('batch.open_record')}</Link>}
                          {siteBatch && r.site_id && <Link className="btn px-2 py-0.5 text-xs" data-testid={`batch-open-site-${rowId(r)}`} to={`/sites/${r.site_id}`}>{t('batch.open_site')}</Link>}
                          {r.task_id && r.site_id && <Link className="btn px-2 py-0.5 text-xs" data-testid={`batch-open-task-${rowId(r)}`} to={`/sites/${r.site_id}?task=${r.task_id}`}>{t('batch.open_task')}</Link>}
                          {canDecide && r.decision === 'pending' && (r.record_id || stream || siteBatch) && (
                            <>
                              <button className="btn px-2 py-0.5 text-xs" data-testid={`batch-row-approve-${rowId(r)}`} disabled={decide.isPending} onClick={() => act(b, { action: 'approve', scope: 'rows', rows: [{ row_id: r.id, decision: 'approved' }] }, t('approvals.done'))}><Check size={12} />{t('approvals.approve')}</button>
                              <button className="btn btn-danger px-2 py-0.5 text-xs" data-testid={`batch-row-reject-${rowId(r)}`} disabled={decide.isPending} onClick={() => setReturning(r.id)}><Undo2 size={12} />{t('batch.return')}</button>
                            </>
                          )}
                          {canDecide && r.decision === 'pending_previous_approval' && (
                            <button className="btn btn-danger px-2 py-0.5 text-xs" data-testid={`batch-row-reject-${rowId(r)}`} disabled={decide.isPending} onClick={() => setReturning(r.id)}><Undo2 size={12} />{t('batch.return')}</button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {virtual && v.end < shown.length && <tr aria-hidden style={{ height: (shown.length - v.end) * ROW_H }} />}
              </tbody>
            </table>
            {rows.complete && !shown.length && <p className="p-4 text-center text-mute">{t('registers.empty')}</p>}
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
