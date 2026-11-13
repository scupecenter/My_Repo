import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Migration 0087 (owner decision 1 of 2026-11-12): the System Admin approves every open row of a task-stream batch as it is. The reason is mandatory (3 characters,
 * the same check as the server's 422); the step-up is asked by the API client when the server answers 401 step_up_required, then the request is sent again.
 */
export function AdminApproveDialog({ open, count, busy, onClose, onSend }: { open: boolean; count: number; busy?: boolean; onClose: () => void; onSend: (reason: string) => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="admin-approve-dialog" className="card fixed inset-x-0 top-1/4 z-[70] mx-auto w-[min(500px,92vw)] space-y-3 p-5">
          <Dialog.Title className="font-bold">{t('batch.admin_title')}</Dialog.Title>
          <Dialog.Description className="text-sm text-mute">{t('batch.admin_body', { count })}</Dialog.Description>
          <label htmlFor="admin-approve-reason" className="text-sm font-semibold">{t('batch.admin_reason')}</label>
          <textarea id="admin-approve-reason" data-testid="admin-approve-reason" className="input min-h-24" value={reason} onChange={(e) => { setReason(e.target.value); setErr(false); }} />
          {err && <p role="alert" data-testid="admin-approve-error" className="text-lateInk">{t('batch.admin_reason_required')}</p>}
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn btn-primary" data-testid="admin-approve-submit" disabled={busy} onClick={() => (reason.trim().length >= 3 ? onSend(reason.trim()) : setErr(true))}>{t('batch.admin_send')}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
