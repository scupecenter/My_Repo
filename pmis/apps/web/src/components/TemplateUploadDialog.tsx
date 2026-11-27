import * as Dialog from '@radix-ui/react-dialog';
import { Check, Download, FileSpreadsheet, FileUp, UploadCloud } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useHistoricalOffer } from '@/api/historicalWaiver';
import { downloadErrorReport, downloadTemplate, useUploadBatch } from '@/api/registers';
import type { ImportBatch, UploadedBatch } from '@/api/types';
import { registerErrorMessage } from '@/lib/registerErrors';
import { HistoricalLoadOption, historicalReady, NO_HISTORICAL, type HistoricalChoice } from './HistoricalLoadOption';
import { UploadResult } from './UploadResult';
import { Tip } from './Tip';
import { pct } from './BatchProgress';

/** P4: the four stages of an upload, shown above the dialog body (file, check, review, in the flow). */
function UploadSteps({ step }: { step: 1 | 2 | 3 }) {
  const { t } = useTranslation();
  return (
    <ol className="flex items-center gap-2 text-xs" data-testid="template-upload-steps" aria-label={t('batch.steps')}>
      {([1, 2, 3] as const).map((n) => (
        <li key={n} data-step={n} aria-current={step === n ? 'step' : undefined} className="flex items-center gap-1">
          <span aria-hidden className={`grid h-5 w-5 place-items-center rounded-full font-bold ${step > n ? 'bg-done text-white' : step === n ? 'bg-accent text-white' : 'bg-card2 text-mute'}`}>{step > n ? <Check size={11} /> : n}</span>
          <span className={step === n ? 'font-semibold text-accentText' : 'text-mute'}>{t(`tpl.up_step_${n}`)}</span>
          {n < 3 && <span aria-hidden className="mx-1 h-px w-5 bg-line" />}
        </li>
      ))}
    </ol>
  );
}

/**
 * Upload dialog (contract 0.7.0, 0.11.5): pick the filled template and send it. The server checks the hidden `_tpl` sheet, the version and the header row,
 * so a refusal comes back with its reason (an old version, a changed header, macros, too large) and is shown here, in the dialog, with the server's own words.
 * On success the caller opens the batch review. A TPL-MASTER file is split into one batch per part: the dialog lists the parts and the warnings first
 * (columns and sheets GSDN Workspace does not own are ignored), then the caller opens the first batch.
 * 0.15.3: a big file is staged in the background: the answer is the upload in status `parsing`, so the dialog closes at once into the batch page, which shows
 * "Checking the file" with the real progress and then the batch (or the parts) the file produced. The same file while it is checked answers 409
 * `upload_processing`: the dialog offers to open the check in progress.
 */
export function TemplateUploadDialog({ open, onClose, templateId, templateName, taskId, kind = 'register', onDone }: {
  open: boolean; onClose: () => void; templateId: string; templateName: string; taskId?: string; kind?: 'register' | 'stream' | 'master' | 'sites'; onDone: (b: ImportBatch) => void;
}) {
  const { t } = useTranslation();
  const upload = useUploadBatch();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'submit' | 'draft'>('submit');
  // Q462 (0.14.3): "historical load: accept without documents", for a System Admin while the waiver is open, on a stream file in submit mode
  const offer = useHistoricalOffer(open && kind === 'stream' && mode === 'submit');
  const [hist, setHist] = useState<HistoricalChoice>(NO_HISTORICAL);
  const [result, setResult] = useState<UploadedBatch | null>(null);
  const [error, setError] = useState<{ text: string; detail?: string; reason?: string; uploadId?: string } | null>(null);
  const [over, setOver] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const reset = () => { setFile(null); setError(null); setResult(null); setHist(NO_HISTORICAL); setOver(false); upload.reset(); };
  const pick = (f: File | undefined | null) => { setFile(f ?? null); setError(null); };
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) pick(f); };
  const close = () => { reset(); onClose(); };
  const send = () => {
    if (!file) return;
    setError(null);
    upload.mutate({ file, template_id: templateId, task_id: taskId, mode: kind === 'register' || kind === 'sites' ? 'submit' : mode, ...(offer && hist.on ? { historical_load_reason: hist.reason.trim() } : {}) }, {
      // 0.15.3: a big file answers `parsing`: the batch page follows its progress
      // P4: a file with refused rows shows its check here first (valid, duplicates, rejected, the error report); a clean file opens the review at once, as before
      onSuccess: (b) => { if (b.status !== 'parsing' && (b.parts?.length || b.warnings?.length)) setResult(b); else { reset(); onDone(b); } },
      onError: (e) => setError({
        text: registerErrorMessage(t, e),
        detail: e instanceof ApiError && e.problem.detail && e.code === 'template_rejected' ? e.problem.detail : undefined,
        reason: e instanceof ApiError ? String(e.problem.reason ?? '') : undefined,
        uploadId: e instanceof ApiError && e.code === 'upload_processing' && typeof e.problem.upload_id === 'string' ? e.problem.upload_id : undefined,
      }),
    });
  };
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="template-upload-dialog" data-kind={kind} className="card fixed inset-x-0 top-[10vh] z-[70] mx-auto max-h-[80vh] w-[min(560px,94vw)] space-y-3 overflow-y-auto p-5">
          <Dialog.Title className="text-lg font-bold">{t('tpl.upload_title', { name: templateName })}</Dialog.Title>
          <Dialog.Description className="text-mute">{t('tpl.upload_hint')}</Dialog.Description>
          <UploadSteps step={result ? 3 : upload.isPending ? 2 : 1} />
          {!result && (
            <>
              <ul className="list-disc space-y-1 ps-5 text-sm text-mute">
                <li>{t('tpl.rule_same')}</li>
                <li>{t('tpl.rule_version')}</li>
                <li>{t('tpl.rule_xlsx')}</li>
                <li>{t('tpl.rule_flow')}</li>
                {kind !== 'register' && kind !== 'sites' && <li data-testid="template-upload-rule-tasks">{t('tpl.rule_tasks')}</li>}
                {kind === 'sites' && <li data-testid="template-upload-rule-sites">{t('tpl.rule_sites')}</li>}
                {kind === 'master' && <li data-testid="template-upload-rule-master">{t('tpl.rule_master')}</li>}
              </ul>
              {kind !== 'register' && kind !== 'sites' && (
                <fieldset className="space-y-1 text-sm" data-testid="template-upload-mode">
                  <legend className="font-semibold">{t('tpl.mode')}</legend>
                  {(['submit', 'draft'] as const).map((m) => (
                    <label key={m} className="flex items-start gap-2">
                      <input type="radio" name="tpl-mode" value={m} data-testid={`template-upload-mode-${m}`} checked={mode === m} onChange={() => setMode(m)} />
                      <span><span className="font-semibold">{t(`tpl.mode_${m}`)}</span><span className="block text-mute">{t(`tpl.mode_${m}_hint`)}</span></span>
                    </label>
                  ))}
                </fieldset>
              )}
              {offer && <HistoricalLoadOption waiver={offer} value={hist} onChange={setHist} testid="hl" />}
              <div>
                <label htmlFor="tpl-file" className="text-sm font-semibold">{t('tpl.file')}</label>
                <label htmlFor="tpl-file" data-testid="template-upload-zone" data-over={over ? 'true' : 'false'} data-has-file={file ? 'true' : 'false'}
                  onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
                  className={`mt-1 flex cursor-pointer flex-col items-center gap-1 rounded-lg border-2 border-dashed p-5 text-center text-sm ${over ? 'border-accent bg-accentSoft' : file ? 'border-done bg-doneBg' : 'border-line bg-card2'}`}>
                  {file ? <FileSpreadsheet size={28} aria-hidden className="text-doneInk" /> : <UploadCloud size={28} aria-hidden className="text-mute" />}
                  {file
                    ? <><span className="font-semibold" data-testid="template-upload-file-name">{file.name}</span><span className="text-xs text-mute">{t('tpl.up_size', { kb: Math.max(1, Math.round(file.size / 1024)) })} · {t('tpl.up_replace')}</span></>
                    : <><span className="font-semibold">{t('tpl.up_drop')}</span><span className="text-xs text-mute">{t('tpl.up_or_browse')}</span></>}
                </label>
                <input ref={input} id="tpl-file" type="file" accept=".xlsx" data-testid="template-upload-file" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
              </div>
              {error && (
                <div role="alert" data-testid="template-upload-error" data-reason={error.reason ?? ''} className="rounded-md bg-lateBg p-3 text-sm text-lateInk">
                  <p className="font-semibold">{error.text}</p>
                  {error.detail && <p className="mt-1" data-testid="template-upload-detail">{error.detail}</p>}
                  {error.uploadId
                    ? <Link className="mt-1 inline-block font-semibold underline" data-testid="template-upload-open-running" to={`/templates/batches/${error.uploadId}`} onClick={close}>{t('tpl.open_running')}</Link>
                    : <p className="mt-1 text-xs">{t('tpl.rejection_logged')}</p>}
                  {error.reason === 'outdated_version' && (
                    <button type="button" className="btn mt-2 px-2 py-1 text-xs" data-testid="template-upload-download-current" onClick={() => void downloadTemplate(templateId)}>{t('tpl.download_current')}</button>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button className="btn" onClick={close}>{t('common.cancel')}</button>
                <button className="btn btn-primary" data-testid="template-upload-submit" disabled={!file || upload.isPending || (!!offer && !historicalReady(hist))} onClick={send}><FileUp size={16} />{t('tpl.upload')}</button>
              </div>
            </>
          )}
          {result && (
            <div className="space-y-3" data-testid="template-upload-result">
              {(result.counts.error ?? 0) > 0 && <CheckSummary batch={result} busy={reportBusy} onReport={() => { setReportBusy(true); downloadErrorReport(result.id).catch(() => undefined).finally(() => setReportBusy(false)); }} />}
              <UploadResult result={result} onOpen={() => { reset(); onClose(); }} />
              <div className="flex justify-end gap-2">
                <button className="btn btn-primary" data-testid="template-upload-open" onClick={() => { const b = result; reset(); onDone(b); }}>{t('tpl.open_first')}</button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** P4: the check of the file inside the dialog: a stacked bar (valid, duplicate, rejected) with the numbers, and the error report. */
function CheckSummary({ batch: b, busy, onReport }: { batch: UploadedBatch; busy: boolean; onReport: () => void }) {
  const { t } = useTranslation();
  const err = b.counts.error ?? 0, dup = Math.min(b.counts.duplicate ?? 0, err), over = Math.min(b.counts.overridden ?? 0, err - dup), bad = err - dup - over;
  const valid = (b.counts.create ?? 0) + (b.counts.update ?? 0) + (b.counts.unchanged ?? 0), total = valid + err;
  const segs = [{ key: 'valid', n: valid, tone: 'bg-done', label: t('batchReview.kpi_valid') }, { key: 'duplicate', n: dup, tone: 'bg-wait', label: t('batchReview.kpi_duplicate') }, { key: 'overridden', n: over, tone: 'bg-lock', label: t('batchReview.kpi_overridden') }, { key: 'invalid', n: bad, tone: 'bg-late', label: t('batchReview.kpi_invalid') }];
  return (
    <div className="space-y-2" data-testid="template-upload-check">
      <p className="font-semibold">{t('tpl.up_checked', { total, valid })}</p>
      <div role="img" aria-label={segs.map((x) => `${x.label} ${x.n}`).join(', ')} className="flex h-3 w-full overflow-hidden rounded-full bg-card2">
        {segs.filter((x) => x.n > 0).map((x) => <span key={x.key} className={x.tone} style={{ width: `${(x.n * 100) / Math.max(total, 1)}%` }} data-testid={`template-upload-check-${x.key}`} data-count={x.n} />)}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">{segs.map((x) => <li key={x.key} className="flex items-center gap-1"><i aria-hidden className={`inline-block h-2.5 w-2.5 rounded-sm ${x.tone}`} />{x.label} {x.n} ({pct(x.n, total)}%)</li>)}</ul>
      <p className="text-xs text-mute">{t('tpl.up_report_note')}</p>
      <Tip text={t('batchReview.report_hint')}><button type="button" className="btn" data-testid="template-upload-error-report" disabled={busy} aria-label={t('batchReview.report')} onClick={onReport}><Download size={16} aria-hidden />{t('batchReview.report')}</button></Tip>
    </div>
  );
}
