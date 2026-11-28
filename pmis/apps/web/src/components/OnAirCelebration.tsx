import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { celebrateOn, reachedOnAir } from '@/lib/celebrate';

const PIECES = Array.from({ length: 24 }, (_, i) => i);

/**
 * A short, calm celebration when the site on screen reaches On-Air while it is open (item 20). Off with the Settings switch; with reduced motion
 * (the operating system or Settings, Screens, Motion) the pieces do not move and only the message shows. It never blocks the screen, never plays on first load.
 */
export function OnAirCelebration({ onAir, code }: { onAir: boolean | undefined; code: string }) {
  const { t } = useTranslation();
  const prev = useRef<boolean | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (onAir === undefined) return;
    if (reachedOnAir(prev.current, onAir) && celebrateOn()) setShow(true);
    prev.current = onAir;
  }, [onAir]);
  useEffect(() => {
    if (!show) return;
    const id = window.setTimeout(() => setShow(false), 3600);
    return () => window.clearTimeout(id);
  }, [show]);
  if (!show) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden" data-testid="onair-celebration" role="status" aria-live="polite">
      <div className="celebrate-msg card motion-pop absolute start-1/2 top-16 -translate-x-1/2 px-5 py-3 text-center font-bold rtl:translate-x-1/2">{t('celebrate.message', { code })}</div>
      {PIECES.map((i) => (
        <i key={i} className="celebrate-piece" aria-hidden style={{ insetInlineStart: `${(i * 37) % 100}%`, animationDelay: `${(i % 6) * 90}ms`, background: `var(--${['accent', 'doneInk', 'waitInk', 'openInk'][i % 4]})` }} />
      ))}
    </div>
  );
}
