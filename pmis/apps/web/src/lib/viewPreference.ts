import { useEffect, useRef } from 'react';
import { discardDraft, getDraft, saveDraft } from '@/api/views';

/**
 * The view (layout) a person picked last on a screen, kept on the server per user, so it follows them to any device. It uses the person's own
 * draft store (GET/PUT /me/drafts/{key}, key `form.viewpref.<screen>`), the same row security and the same limits as the other drafts: nothing here is a new
 * table or a new endpoint. Order on opening: the address (a shared link), then a saved view, then this preference, then the default.
 */
const keyOf = (screen: string) => `form.viewpref.${screen.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)}`;

const TOUCH_AFTER_MS = 7 * 86_400_000;

export const readViewPreference = async (screen: string): Promise<{ layout: string; version: number; saved_at: string } | null> => {
  const d = await getDraft(keyOf(screen));
  const layout = d && typeof d.payload?.layout === 'string' ? d.payload.layout : null;
  return d && layout !== null ? { layout, version: d.version, saved_at: d.saved_at } : null;
};

export const writeViewPreference = async (screen: string, layout: string): Promise<void> => {
  if (!layout) { await discardDraft(keyOf(screen)).catch(() => undefined); return; }
  const cur = await getDraft(keyOf(screen)).catch(() => null);
  await saveDraft(keyOf(screen), { layout }, cur ? cur.version : null);
};

/**
 * Applies the remembered layout once, when the address names none and no saved view decided (`blocked`). `apply` receives the layout key. Failures are
 * silent: a preference never blocks a screen.
 */
export function useRememberedView(screen: string, hasExplicit: boolean, valid: (layout: string) => boolean, apply: (layout: string) => void): (layout: string) => void {
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (done.current === screen) return;
    done.current = screen;
    if (hasExplicit) return;
    let live = true;
    void readViewPreference(screen).then((p) => {
      if (!live || !p || !valid(p.layout)) return;
      apply(p.layout);
      // drafts expire (30 days, from the last save): a preference that is still in use is saved again once a week, so it does not run out
      if (Date.now() - Date.parse(p.saved_at) > TOUCH_AFTER_MS) void saveDraft(keyOf(screen), { layout: p.layout }, p.version).catch(() => undefined);
    }).catch(() => undefined);
    // StrictMode runs effect, cleanup, effect: the cleanup cancels the read, so it must also release the guard or the second pass would return early
    return () => { live = false; done.current = null; };
    // the preference is read once per screen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);
  return (layout: string) => { void writeViewPreference(screen, layout).catch(() => undefined); };
}
