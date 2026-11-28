import { loadPref, savePref } from '@/lib/localPref';

/** The On-Air celebration (improvement list item 20). One switch per browser, on by default; Settings, Screens, Motion turns it off. */
export const CELEBRATE_KEY = 'pmis.celebrate';
export const celebrateOn = (): boolean => loadPref<boolean>(CELEBRATE_KEY, true) !== false;
export const setCelebrate = (on: boolean): void => savePref(CELEBRATE_KEY, on);

/** True only when a site that was open and not On-Air has just become On-Air: the first read of a site never celebrates. */
export function reachedOnAir(prev: boolean | null, now: boolean): boolean {
  return prev === false && now === true;
}
