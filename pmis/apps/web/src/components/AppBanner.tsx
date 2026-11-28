import { Download, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { loadPref, savePref } from '@/lib/localPref';
import { Tip } from './Tip';

export const bannerKey = (userId: string): string => `banner.dismissed.${userId}`;
type InstallEvent = Event & { prompt: () => Promise<void> };

/**
 * Item 12: a thin banner on small screens that offers the app on the home screen. It never blocks the page: it sits in the flow under the top bar, is
 * dismissed with one tap and stays dismissed on this device (per person). Where the browser offers an install prompt the button runs it; elsewhere the
 * text says how to add the page to the home screen. Off by the appearance choice `app_banner` (My profile > Appearance, organization default in Settings).
 */
export function AppBanner({ userId, enabled }: { userId: string; enabled: boolean }) {
  const { t } = useTranslation();
  const [gone, setGone] = useState(() => loadPref<boolean>(bannerKey(userId), false));
  const [ev, setEv] = useState<InstallEvent | null>(null);
  useEffect(() => {
    const on = (e: Event) => { e.preventDefault(); setEv(e as InstallEvent); };
    window.addEventListener('beforeinstallprompt', on);
    return () => window.removeEventListener('beforeinstallprompt', on);
  }, []);
  const standalone = typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches ?? false);
  if (!enabled || gone || standalone) return null;
  const dismiss = () => { savePref(bannerKey(userId), true); setGone(true); };
  return (
    <div role="region" aria-label={t('mobile.banner_label')} data-testid="app-banner" className="flex items-center gap-2 border-b border-line bg-accentSoft px-3 py-2 text-sm text-accentText md:hidden">
      <Download size={16} aria-hidden className="shrink-0" />
      <span className="min-w-0 flex-1">{ev ? t('mobile.banner_install') : t('mobile.banner_hint')}</span>
      {ev && <button type="button" className="btn btn-accent px-2 py-1 text-xs" data-testid="app-banner-install" onClick={() => { void ev.prompt().finally(() => setEv(null)); }}>{t('mobile.install')}</button>}
      <Tip text={t('mobile.banner_dismiss')}><button type="button" className="btn min-h-8 min-w-8 px-1" data-testid="app-banner-dismiss" aria-label={t('mobile.banner_dismiss')} onClick={dismiss}><X size={14} aria-hidden /></button></Tip>
    </div>
  );
}
