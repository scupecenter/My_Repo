import { loadPref, savePref } from '@/lib/localPref';

/** Swipe gestures on cards (improvement list item 17). One switch per browser, on by default, touch screens only. */
export const SWIPE_KEY = 'pmis.swipe';
export const swipeOn = (): boolean => loadPref<boolean>(SWIPE_KEY, true) !== false;
export const setSwipe = (on: boolean): void => savePref(SWIPE_KEY, on);

export const SWIPE_MIN = 64;

/** `forward` = toward the end of the line (right in English, left in Arabic), `back` = toward the start. Null when the move is short or mostly vertical. */
export function swipeOf(dx: number, dy: number, rtl: boolean): 'forward' | 'back' | null {
  if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * 2) return null;
  const toEnd = rtl ? dx < 0 : dx > 0;
  return toEnd ? 'forward' : 'back';
}
