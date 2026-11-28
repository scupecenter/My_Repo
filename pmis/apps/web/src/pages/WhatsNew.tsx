import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { WHATS_NEW } from '@/content/whatsNew';
import { loadPref, savePref } from '@/lib/localPref';

export const WHATS_NEW_SEEN_KEY = 'pmis.whatsnew.seen';
/** True when the newest note is newer than the one this browser last opened (a view preference kept locally, no data and no setting). */
export const hasUnseenWhatsNew = () => WHATS_NEW.length > 0 && loadPref<string>(WHATS_NEW_SEEN_KEY, '') < WHATS_NEW[0]!.date;

/** The small dot in the user menu while there are notes this browser has not opened (read when the menu opens). */
export function WhatsNewDot() {
  const { t } = useTranslation();
  return hasUnseenWhatsNew() ? <span className="ms-auto h-2 w-2 rounded-full bg-accent" data-testid="whats-new-dot" aria-label={t('top.whats_new_unseen')} /> : null;
}

/** The release notes: what changed, newest first, each pointing to its screen. Opening the page marks them seen on this browser. */
export function WhatsNew() {
  const { t } = useTranslation();
  useEffect(() => { if (WHATS_NEW[0]) savePref(WHATS_NEW_SEEN_KEY, WHATS_NEW[0].date); }, []);
  return (
    <main className="space-y-4 p-4" data-testid="page-whats-new">
      <h1 className="text-xl font-bold">{t('whatsNewPage.title')}</h1>
      <p className="text-sm text-mute">{t('whatsNewPage.note')}</p>
      <ol className="space-y-3">
        {WHATS_NEW.map((e) => (
          <li key={e.id} className="card p-3" data-testid={`whats-new-${e.id}`}>
            <div className="mono text-xs text-mute">{e.date}</div>
            <h2 className="font-bold">{t(`whatsNewItems.${e.id}.title`)}</h2>
            <p className="text-sm">{t(`whatsNewItems.${e.id}.text`)}</p>
            {e.to && <Link className="text-link text-sm hover:underline" to={e.to}>{t('whatsNewPage.open')}</Link>}
          </li>
        ))}
      </ol>
    </main>
  );
}
