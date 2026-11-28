import { Sparkles, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { loadPref, savePref } from '@/lib/localPref';

/**
 * A one-time "what's new" note for a feature at its launch. Each note has its own id; "Got it" hides it on this browser for good (a view preference,
 * kept locally like the sidebar state). It carries no data and no setting of the project.
 */
export function WhatsNewHint({ id, children }: { id: string; children: ReactNode }) {
  const { t } = useTranslation();
  const key = `pmis.whatsnew.${id}`;
  const [gone, setGone] = useState(() => loadPref<boolean>(key, false));
  if (gone) return null;
  return (
    <aside role="note" data-testid={`whatsnew-${id}`} className="flex items-start gap-3 rounded-md border border-accent/40 bg-accentSoft p-3 text-sm">
      <Sparkles size={18} className="mt-0.5 shrink-0 text-accentText" aria-hidden />
      <div className="min-w-0 flex-1"><b>{t('whatsnew.title')}</b> <span>{children}</span></div>
      <button type="button" className="btn shrink-0" data-testid={`whatsnew-${id}-dismiss`} onClick={() => { savePref(key, true); setGone(true); }}>{t('whatsnew.dismiss')}</button>
      <button type="button" className="shrink-0 p-1 text-mute hover:bg-hover" aria-label={t('whatsnew.dismiss')} onClick={() => { savePref(key, true); setGone(true); }}><X size={14} aria-hidden /></button>
    </aside>
  );
}
