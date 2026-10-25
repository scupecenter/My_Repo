import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Return-with-note dialog: the note is mandatory (client check mirrors the server's 422 note_required). */
export function RejectDialog({ open, title, onClose, onSend }: { open: boolean; title: string; onClose: () => void; onSend: (note: string) => void }) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [err, setErr] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-scrim/60" />
        <Dialog.Content data-testid="reject-dialog" className="card fixed inset-x-0 top-1/4 z-[70] mx-auto w-[min(460px,92vw)] space-y-3 p-5">
          <Dialog.Title className="font-bold">{title}</Dialog.Title>
          <Dialog.Description className="sr-only">{t('approvals.note_required')}</Dialog.Description>
          <label htmlFor="reject-note" className="text-sm font-semibold">{t('approvals.note')}</label>
          <textarea id="reject-note" data-testid="reject-note" className="input min-h-24" value={note} onChange={(e) => { setNote(e.target.value); setErr(false); }} />
          {err && <p role="alert" data-testid="reject-error" className="text-lateInk">{t('approvals.note_required')}</p>}
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn btn-danger" data-testid="reject-submit" onClick={() => (note.trim() ? onSend(note.trim()) : setErr(true))}>{t('approvals.send')}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
