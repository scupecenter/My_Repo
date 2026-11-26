import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { GO_KEYS, goTarget, isTyping } from '@/lib/shortcuts';

/** "?" opens the shortcut list; "g" then d/s/w/a/i/m/l/r goes to a page. Ignored while typing or with Ctrl/Alt/Meta. Navigation only. */
export function ShortcutsHelp() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const seq = useRef<string | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || isTyping(e.target)) return;
      if (e.key === '?') { setOpen(true); seq.current = null; return; }
      const r = goTarget(seq.current, e.key);
      seq.current = r.next;
      window.clearTimeout(timer);
      if (r.next) timer = window.setTimeout(() => { seq.current = null; }, 1500);
      if (r.to) nav(r.to);
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); window.clearTimeout(timer); };
  }, [nav]);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="card fixed start-1/2 top-1/4 z-50 w-[min(92vw,28rem)] -translate-x-1/2 p-4 rtl:translate-x-1/2" data-testid="shortcuts-help" aria-describedby={undefined}>
          <Dialog.Title className="mb-2 text-lg font-semibold">{t('shortcuts.title')}</Dialog.Title>
          <ul className="space-y-1 text-sm">
            <li><kbd className="chip">Ctrl K</kbd> {t('shortcuts.palette')}</li>
            <li><kbd className="chip">?</kbd> {t('shortcuts.help')}</li>
            {Object.entries(GO_KEYS).map(([k, to]) => (
              <li key={k} data-testid={`shortcut-${k}`}><kbd className="chip">g {k}</kbd> {t(`shortcuts.go_${k}`)} <span className="text-mute" dir="ltr">{to}</span></li>
            ))}
          </ul>
          <button className="btn mt-3" data-testid="shortcuts-tour" onClick={() => { setOpen(false); window.dispatchEvent(new Event('gsdn:tour')); }}>{t('tour.start')}</button>
          <p className="mt-2 text-xs text-mute">{t('shortcuts.note')}</p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
