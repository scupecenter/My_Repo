import { useEffect, useState } from 'react';
import { discardDraft, getDraft, saveDraft } from '@/api/views';

/**
 * Where a register record opens when its row is clicked (decision V5): in the side drawer (the default) or on its own full page.
 * A personal choice, kept on the server in the person's own draft store (GET/PUT /me/drafts/form.viewpref.open-record), with the
 * same row security and the same limits as the remembered view of a screen: nothing here is a new table or a new endpoint, and the
 * choice follows the person to any device. Drafts expire after 30 days without a save, so a choice that is still in use is saved
 * again once a week (the same renewal the remembered view uses).
 */
export type OpenRecordMode = 'drawer' | 'page';

const KEY = 'form.viewpref.open-record';
const TOUCH_AFTER_MS = 7 * 86_400_000;

let cache: OpenRecordMode | null = null;
const listeners = new Set<(m: OpenRecordMode) => void>();
const announce = (m: OpenRecordMode) => { cache = m; listeners.forEach((f) => f(m)); };

async function pull(): Promise<OpenRecordMode> {
  const d = await getDraft(KEY).catch(() => null);
  const mode: OpenRecordMode = d?.payload?.mode === 'page' ? 'page' : 'drawer';
  if (d && Date.now() - Date.parse(d.saved_at) > TOUCH_AFTER_MS)
    void saveDraft(KEY, { mode }, d.version).catch(() => undefined);
  return mode;
}

/**
 * The person's current choice, and a setter that writes it. The drawer is the answer until the store has answered once (and when
 * it cannot be read), so a screen never waits on the preference before it can be used. Saving `drawer` discards the stored row:
 * the default needs no record.
 */
export function useOpenRecordMode(): [OpenRecordMode, (m: OpenRecordMode) => void] {
  const [mode, setMode] = useState<OpenRecordMode>(cache ?? 'drawer');
  useEffect(() => {
    let live = true;
    const hear = (m: OpenRecordMode) => { if (live) setMode(m); };
    listeners.add(hear);
    void pull().then(announce);
    return () => { live = false; listeners.delete(hear); };
  }, []);
  const set = (m: OpenRecordMode) => {
    announce(m);
    if (m === 'drawer') void discardDraft(KEY).catch(() => undefined);
    else void getDraft(KEY).then((cur) => saveDraft(KEY, { mode: m }, cur ? cur.version : null)).catch(() => undefined);
  };
  return [mode, set];
}
