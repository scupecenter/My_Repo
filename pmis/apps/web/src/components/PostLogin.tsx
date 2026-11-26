import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLoginPage } from '@/api/settings';

/**
 * The post-login transition (0185): a calm full-screen beat between a successful sign-in and the app, with the system
 * version (shown to signed-in users only). It never slows the way in: a click or any key skips it, the beat is 400 ms
 * and the app opens after 480 ms even when the version read is slow or fails. No motion for a visitor who prefers
 * reduced motion.
 */
export function PostLogin({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const q = useLoginPage();
  const done = useRef(onDone);
  useEffect(() => { done.current = onDone; }, [onDone]);
  const [beat, setBeat] = useState(false);
  useEffect(() => {
    const a = setTimeout(() => setBeat(true), 400);
    const b = setTimeout(() => done.current(), 480);
    const skip = () => done.current();
    window.addEventListener('pointerdown', skip);
    window.addEventListener('keydown', skip);
    return () => { clearTimeout(a); clearTimeout(b); window.removeEventListener('pointerdown', skip); window.removeEventListener('keydown', skip); };
  }, []);
  useEffect(() => { if (beat && !q.isPending) done.current(); }, [beat, q.isPending]);
  return (
    <div className="postlogin auth-shell grid min-h-screen place-items-center" data-testid="post-login" data-anim="1">
      <div className="auth-enter flex flex-col items-center gap-4 text-center">
        <span className="grid h-16 w-16 place-items-center rounded-2xl bg-accent text-2xl font-bold text-accentInk shadow-lg">G</span>
        <div>
          <p className="text-xl font-bold">{t('postLogin.title')}</p>
          <p className="mt-1 text-sm text-mute">{t('postLogin.note')}</p>
        </div>
        <div className="postlogin-bar relative h-1 w-56 overflow-hidden rounded-full bg-card2" aria-hidden>
          <i className="absolute top-0 h-full w-2/5 rounded-full bg-accent motion-reduce:hidden" />
        </div>
        <span className="sr-only" role="status">{t('postLogin.title')}</span>
        {q.data?.server_version && <p className="text-xs text-faint" data-testid="post-login-version">{t('postLogin.version', { v: q.data.server_version })}</p>}
      </div>
    </div>
  );
}
