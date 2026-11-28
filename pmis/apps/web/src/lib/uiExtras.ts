import { useSyncExternalStore } from 'react';
import { loadPref, savePref } from './localPref';

/**
 * Small display features a person can switch off for themselves (Settings > Screens > Interface > "On this device"). Stored on the device like the other view prefs,
 * so no data and no permission is involved. Each feature adds its key here and one line of text in `ui.extra_*`.
 */
export const UI_EXTRAS = ['copy_link', 'copy_toast'] as const;
export type UiExtra = (typeof UI_EXTRAS)[number];

const subs = new Set<() => void>();
const key = (k: UiExtra) => `pmis.extra.${k}`;
export const getExtra = (k: UiExtra): boolean => loadPref<boolean>(key(k), true);
export function setExtra(k: UiExtra, on: boolean): void { savePref(key(k), on); subs.forEach((f) => f()); }
export function useExtra(k: UiExtra): boolean {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); window.addEventListener('storage', cb); return () => { subs.delete(cb); window.removeEventListener('storage', cb); }; },
    () => getExtra(k), () => true);
}

/** True while copyText's own fallback copy runs: the caller shows its own notice, so the global one stays quiet. */
let programmatic = false;
export const isProgrammaticCopy = () => programmatic;

/** Copies text to the clipboard; falls back to a hidden textarea where the clipboard API is missing (older webviews, plain http). */
export async function copyText(text: string): Promise<boolean> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    programmatic = true;
    const ok = document.execCommand('copy');
    programmatic = false;
    ta.remove();
    return ok;
  } catch { return false; }
}
