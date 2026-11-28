import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { loadPref, savePref } from '@/lib/localPref';

const STEPS = ['dashboard', 'sites', 'mywork', 'search', 'shortcuts'] as const;
export const tourKey = (userId: string): string => `tour.done.${userId}`;

/** A short tour (5 steps), opened from the shortcuts list (`?`). It does not open by itself. No server data. */
export function QuickTour({ userId, auto = false }: { userId: string; auto?: boolean }) {
  const { t } = useTranslation();
  // Item 12: opens by itself once, on first use, when the person's choice is `auto` (My profile > Appearance); as a card that does not block the page (no overlay, no focus trap).
  const [open, setOpen] = useState(false);
  const [replay, setReplay] = useState(false);
  useEffect(() => { if (auto && !loadPref<boolean>(tourKey(userId), false)) setOpen(true); }, [auto, userId]);
  const [i, setI] = useState(0);
  useEffect(() => {
    const on = () => { setI(0); setReplay(true); setOpen(true); };
    window.addEventListener('gsdn:tour', on);
    return () => window.removeEventListener('gsdn:tour', on);
  }, []);
  const close = () => { savePref(tourKey(userId), true); setOpen(false); setReplay(false); };
  const modal = replay;
  const last = i === STEPS.length - 1;
  return (
    <Dialog.Root open={open} modal={modal} onOpenChange={(v) => { if (!v) close(); }}>
      <Dialog.Portal>
        {modal && <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />}
        <Dialog.Content onOpenAutoFocus={(e) => { if (!modal) e.preventDefault(); }} onInteractOutside={(e) => { if (!modal) e.preventDefault(); }} className={modal ? 'card fixed start-1/2 top-1/4 z-50 w-[min(92vw,26rem)] -translate-x-1/2 p-4 rtl:translate-x-1/2' : 'card fixed bottom-20 end-3 z-50 w-[min(92vw,22rem)] p-4 shadow-lg md:bottom-4'} data-testid="quick-tour" data-mode={modal ? 'replay' : 'first-use'} aria-describedby={undefined}>
          <p className="text-xs text-mute" data-testid="tour-step">{t('tour.step', { i: i + 1, n: STEPS.length })}</p>
          <Dialog.Title className="mb-1 text-lg font-semibold">{t(`tour.${STEPS[i]}_t`)}</Dialog.Title>
          <p className="text-sm">{t(`tour.${STEPS[i]}_b`)}</p>
          <div className="mt-3 flex items-center gap-2">
            <button className="btn" data-testid="tour-skip" onClick={close}>{t('tour.skip')}</button>
            <span className="ms-auto" />
            {i > 0 && <button className="btn" data-testid="tour-back" onClick={() => setI(i - 1)}>{t('tour.back')}</button>}
            <button className="btn btn-accent" data-testid="tour-next" onClick={() => (last ? close() : setI(i + 1))}>{last ? t('tour.done') : t('tour.next')}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
