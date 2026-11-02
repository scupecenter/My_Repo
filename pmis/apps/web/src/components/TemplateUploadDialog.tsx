import * as Dialog from '@radix-ui/react-dialog';
import { FileUp } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useUploadBatch } from '@/api/registers';
import type { ImportBatch } from '@/api/types';
import { registerErrorMessage } from '@/lib/registerErrors';

/**
 * Upload dialog (contract 0.7.0): pick the filled template and send it. The server checks the hidden `_tpl` sheet, the version and the header row,
 * so a refusal comes back with its reason (an old version, a changed header, macros, too large) and is shown here, in the dialog, with the server's own words.
 * On success the caller opens the batch review.
 */
export function TemplateUploadDialog({ open, onClose, templateId, templateName, taskId, onDone }: {
  open: boolean; onClose: () => void; templateId: string; templateName: string; taskId?: string; onDone: (b: ImportBatch) => void;
}) {
  const { t } = useTranslation();
  const upload = useUploadBatch();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<{ text: string; detail?: string; reason?: string } | null>(null);
  const reset = () => { setFile(null); setError(null); upload.reset(); };
  const close = () => { reset(); onClose(); };
  const send = () => {
    if (!file) return;
    setError(null);
    upload.mutate({ file, template_id: templateId, task_id: taskId }, {
      onSuccess: (b) => { reset(); onDone(b); },
      onError: (e) => setError({
        text: registerErrorMessage(t, e),
        detail: e instanceof ApiError && e.problem.detail && e.code === 'template_rejected' ? e.problem.detail : undefined,
        reason: e instanceof ApiError ? String(e.problem.reason ?? '') : undefined,
      }),
    });
  };
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="template-upload-dialog" className="card fixed inset-x-0 top-[10vh] z-[70] mx-auto w-[min(520px,94vw)] space-y-3 p-5">
          <Dialog.Title className="text-lg font-bold">{t('tpl.upload_title', { name: templateName })}</Dialog.Title>
          <Dialog.Description className="text-mute">{t('tpl.upload_hint')}</Dialog.Description>
          <ul className="list-disc space-y-1 ps-5 text-sm text-mute">
            <li>{t('tpl.rule_same')}</li>
            <li>{t('tpl.rule_version')}</li>
            <li>{t('tpl.rule_xlsx')}</li>
            <li>{t('tpl.rule_flow')}</li>
          </ul>
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
