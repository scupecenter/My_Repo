import { History, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { discardDraft, getDraft, saveDraft, type Draft } from '@/api/views';

export const AUTOSAVE_MS = 1500;

/**
 * Server-side draft of unsaved input (P10, owner answer Q115). Nothing goes to localStorage: while the form is dirty its content is saved on the
 * server for this user only, a moment after the last change, and the screen shows when it was last saved. A draft is never a submission, an
 * approval or an input of any calculation. When the form opens and a draft exists, the user may restore it or discard it. Closing the tab with
 * unsaved input asks first (leave guard).
 */
export function useDraft<T extends Record<string, unknown>>(key: string | null, value: T, dirty: boolean, enabled = true) {
  // state is tagged with its key, so a form that moves to another record never shows the previous record's draft
  const [offerOf, setOfferOf] = useState<{ k: string; d: Draft } | null>(null);
  const [savedOf, setSavedOf] = useState<{ k: string; at: string } | null>(null);
  const offer = offerOf && offerOf.k === key ? offerOf.d : null, savedAt = savedOf && savedOf.k === key ? savedOf.at : null;
  const [error, setError] = useState(false);
  const base = useRef<number | null>(null);
  const on = enabled && !!key;

  useEffect(() => {
    base.current = null;
    if (!on) return;
    let live = true;
    getDraft(key).then((d) => { if (live && d) { base.current = d.version; setOfferOf({ k: key, d }); } }, () => { /* no draft offer when the server cannot answer */ });
    return () => { live = false; };
  }, [key, on]);

  const json = JSON.stringify(value);
  useEffect(() => {
    if (!on || !dirty) return;
    const timer = setTimeout(() => {
      saveDraft(key, value, base.current).then((d) => { base.current = d.version; setSavedOf({ k: key, at: d.saved_at }); setError(false); setOfferOf(null); }, (e: unknown) => {
        setError(true);
        if (e instanceof ApiError && e.status === 412) getDraft(key).then((d) => { base.current = d?.version ?? null; }, () => undefined);
      });
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [json, dirty, on, key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  /** After a real save (or when the user discards it): the draft is no longer needed. */
  const clear = useCallback(() => {
    setOfferOf(null); setSavedOf(null); base.current = null;
    if (on) void discardDraft(key).catch(() => undefined);
  }, [key, on]);
  return { offer: offer ? (offer.payload as T | undefined) ?? null : null, offerAt: offer?.saved_at ?? null, savedAt, error, clear, dismiss: () => setOfferOf(null) };
}

const time = (iso: string, lang: string) => new Date(iso).toLocaleString(lang === 'ar' ? 'ar-LY' : 'en-GB', { timeZone: 'Africa/Tripoli', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });

/** "Last saved" indicator and the optional restore of a draft. */
export function DraftBar<T extends Record<string, unknown>>({ draft, onRestore }: { draft: ReturnType<typeof useDraft<T>>; onRestore: (v: T) => void }) {
  const { t, i18n } = useTranslation();
  if (draft.offer && draft.offerAt) {
    const v = draft.offer;
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-waitBg p-2 text-sm text-waitInk" role="status" data-testid="draft-offer">
        <History size={14} aria-hidden />
        <span>{t('draft.found', { at: time(draft.offerAt, i18n.language) })}</span>
        <button type="button" className="btn px-2 py-0.5 text-xs" data-testid="draft-restore" onClick={() => { onRestore(v); draft.dismiss(); }}>{t('draft.restore')}</button>
        <button type="button" className="btn px-2 py-0.5 text-xs" data-testid="draft-discard" onClick={draft.clear}><X size={12} aria-hidden />{t('draft.discard')}</button>
      </div>
    );
  }
  if (draft.error) return <p className="text-xs text-lateInk" role="status" data-testid="draft-error">{t('draft.error')}</p>;
  if (draft.savedAt) return <p className="text-xs text-mute" role="status" data-testid="draft-saved">{t('draft.saved_at', { at: time(draft.savedAt, i18n.language) })}</p>;
  return null;
}
