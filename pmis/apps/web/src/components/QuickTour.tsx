import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { savePref } from '@/lib/localPref';

const STEPS = ['dashboard', 'sites', 'mywork', 'search', 'shortcuts'] as const;
export const tourKey = (userId: string): string => `tour.done.${userId}`;

/** A short tour (5 steps), opened from the shortcuts list (`?`). It does not open by itself. No server data. */
export function QuickTour({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false); // never opens by itself: a modal on first sign-in would block the page for tests and for people in a hurry
  const [i, setI] = useState(0);
  useEffect(() => {
    const on = () => { setI(0); setOpen(true); };
    window.addEventListener('gsdn:tour', on);
    return () => window.removeEventListener('gsdn:tour', on);
  }, []);
  const close = () => { savePref(tourKey(userId), true); setOpen(false); };
  const last = i === STEPS.length - 1;
  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="card fixed start-1/2 top-1/4 z-50 w-[min(92vw,26rem)] -translate-x-1/2 p-4 rtl:translate-x-1/2" data-testid="quick-tour" aria-describedby={undefined}>
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
