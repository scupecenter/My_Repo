import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type ResetSummary = { rows: number; parts: { code: string; label: string; rows: number }[]; sessions: number; files: { moved: number; total: number; pending: number } };

/**
 * The result of a data reset: a dialog in the middle of the screen with a big check and what was deleted, closed only by its Close button (no timer,
 * no click outside, no Escape by accident: the person reads the numbers first). Shown once, when a run that was started on this screen finishes.
 */
export function ResetResultDialog({ open, summary, onClose }: { open: boolean; summary: ResetSummary; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={() => undefined}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/50" />
        <Dialog.Content data-testid="dr-done-dialog" aria-describedby="dr-done-desc" onEscapeKeyDown={(e) => e.preventDefault()} onPointerDownOutside={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}
          className="card fixed start-1/2 top-1/2 z-[70] max-h-[85vh] w-[min(92vw,30rem)] -translate-x-1/2 -translate-y-1/2 space-y-3 overflow-y-auto p-6 text-center rtl:translate-x-1/2">
          <CheckCircle2 size={72} aria-hidden className="mx-auto text-doneInk" data-testid="dr-done-check" />
          <Dialog.Title className="text-xl font-bold">{t('dr.done_title')}</Dialog.Title>
          <p id="dr-done-desc" className="text-sm text-mute" data-testid="dr-done-total">{t('dr.done_total', { rows: summary.rows, sessions: summary.sessions })}</p>
          {summary.parts.length > 0 && (
            <ul className="space-y-1 rounded-md bg-card2 p-3 text-start text-sm" data-testid="dr-done-parts">
              {summary.parts.map((p) => <li key={p.code} className="flex justify-between gap-2" data-testid={`dr-done-part-${p.code}`}><span>{p.label}</span><b>{p.rows}</b></li>)}
            </ul>
          )}
          <p className="text-sm" data-testid="dr-done-files">{t('dr.done_files', { moved: summary.files.moved, total: summary.files.total })}{summary.files.pending > 0 ? ` ${t('dr.done_files_pending', { count: summary.files.pending })}` : ''}</p>
          <button type="button" className="btn btn-accent w-full" data-testid="dr-done-close" onClick={onClose}>{t('dr.done_close')}</button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
