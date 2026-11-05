import * as Dialog from '@radix-ui/react-dialog';
import { FileUp } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useUploadBatch } from '@/api/registers';
import { batchPath, type ImportBatch, type UploadedBatch } from '@/api/types';
import { registerErrorMessage } from '@/lib/registerErrors';

/**
 * Upload dialog (contract 0.7.0, 0.11.5): pick the filled template and send it. The server checks the hidden `_tpl` sheet, the version and the header row,
 * so a refusal comes back with its reason (an old version, a changed header, macros, too large) and is shown here, in the dialog, with the server's own words.
 * On success the caller opens the batch review. A TPL-MASTER file is split into one batch per part: the dialog lists the parts and the warnings first
 * (columns and sheets the PMIS does not own are ignored), then the caller opens the first batch.
 */
export function TemplateUploadDialog({ open, onClose, templateId, templateName, taskId, kind = 'register', onDone }: {
  open: boolean; onClose: () => void; templateId: string; templateName: string; taskId?: string; kind?: 'register' | 'stream' | 'master' | 'sites'; onDone: (b: ImportBatch) => void;
}) {
  const { t } = useTranslation();
  const upload = useUploadBatch();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'submit' | 'draft'>('submit');
  const [result, setResult] = useState<UploadedBatch | null>(null);
  const [error, setError] = useState<{ text: string; detail?: string; reason?: string } | null>(null);
  const reset = () => { setFile(null); setError(null); setResult(null); upload.reset(); };
  const close = () => { reset(); onClose(); };
  const send = () => {
    if (!file) return;
    setError(null);
    upload.mutate({ file, template_id: templateId, task_id: taskId, mode: kind === 'register' || kind === 'sites' ? 'submit' : mode }, {
      onSuccess: (b) => { if (b.parts?.length || b.warnings?.length) setResult(b); else { reset(); onDone(b); } },
      onError: (e) => setError({
        text: registerErrorMessage(t, e),
        detail: e instanceof ApiError && e.problem.detail && e.code === 'template_rejected' ? e.problem.detail : undefined,
        reason: e instanceof ApiError ? String(e.problem.reason ?? '') : undefined,
      }),
    });
  };
  const partName = (p: ImportBatch) => (p.stream ? t(`tpl.stream_${p.stream}`, { defaultValue: p.stream }) : p.part_sheet ?? p.register_key ?? p.template_id);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="template-upload-dialog" data-kind={kind} className="card fixed inset-x-0 top-[10vh] z-[70] mx-auto max-h-[80vh] w-[min(560px,94vw)] space-y-3 overflow-y-auto p-5">
          <Dialog.Title className="text-lg font-bold">{t('tpl.upload_title', { name: templateName })}</Dialog.Title>
          <Dialog.Description className="text-mute">{t('tpl.upload_hint')}</Dialog.Description>
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
              <div>
                <label htmlFor="tpl-file" className="text-sm font-semibold">{t('tpl.file')}</label>
                <input ref={input} id="tpl-file" type="file" accept=".xlsx" data-testid="template-upload-file" className="input mt-1" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} />
              </div>
              {error && (
                <div role="alert" data-testid="template-upload-error" data-reason={error.reason ?? ''} className="rounded-md bg-lateBg p-3 text-sm text-lateInk">
                  <p className="font-semibold">{error.text}</p>
                  {error.detail && <p className="mt-1" data-testid="template-upload-detail">{error.detail}</p>}
                  <p className="mt-1 text-xs">{t('tpl.rejection_logged')}</p>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button className="btn" onClick={close}>{t('common.cancel')}</button>
                <button className="btn btn-primary" data-testid="template-upload-submit" disabled={!file || upload.isPending} onClick={send}><FileUp size={16} />{t('tpl.upload')}</button>
              </div>
            </>
          )}
          {result && (
            <div className="space-y-3" data-testid="template-upload-result">
              {!!result.parts?.length && (
                <div>
                  <p className="font-semibold">{t('tpl.parts_title', { count: result.parts.length })}</p>
                  <ul className="mt-1 list-disc space-y-0.5 ps-5 text-sm" data-testid="template-upload-parts">
                    {result.parts.map((p) => (
                      <li key={p.id} data-testid={`upload-part-${p.id}`}>
                        <Link className="font-semibold underline" to={batchPath(p)} onClick={() => { reset(); onClose(); }}>{partName(p)}</Link>
                        <span className="text-mute"> · {p.part_sheet} · {t('batch.diff', { create: p.counts.create ?? 0, update: p.counts.update ?? 0, unchanged: p.counts.unchanged ?? 0 })}{!!p.counts.error && ` · ${t('batch.invalid', { count: p.counts.error })}`}{!!p.counts.held && ` · ${t('batch.held_count', { count: p.counts.held })}`}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {!!result.warnings?.length && (
                <div role="status" className="rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="template-upload-warnings">
                  <p className="font-semibold">{t('tpl.warnings_title', { count: result.warnings.length })}</p>
                  <ul className="mt-1 list-disc ps-5">
                    {result.warnings.map((w, i) => (
                      <li key={`${w.code}-${w.sheet ?? ''}-${w.column ?? ''}-${i}`} data-testid={`upload-warning-${w.code}`}>
                        {t(`tpl.warn_${w.code}`, { sheet: w.sheet ?? '', column: w.column ?? '', count: w.count ?? 0, defaultValue: w.message })}
                        {w.code === 'part_skipped' && <span className="block text-xs">{w.message}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
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
