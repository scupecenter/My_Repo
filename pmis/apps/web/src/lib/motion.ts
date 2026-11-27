/** The motion preference of this browser (item 2): `auto` follows the operating system, `reduced` turns every transition and animation off. */
export type MotionPref = 'auto' | 'reduced';
export const MOTION_KEY = 'pmis.motion';

export function currentMotion(): MotionPref {
  return localStorage.getItem(MOTION_KEY) === 'reduced' ? 'reduced' : 'auto';
}

/** Saves the choice and sets `data-motion` on the page, which styles/motion.css reads. */
export function applyMotion(p: MotionPref) {
  localStorage.setItem(MOTION_KEY, p);
  if (p === 'reduced') document.documentElement.setAttribute('data-motion', 'reduced');
  else document.documentElement.removeAttribute('data-motion');
}

/** True when animation should be avoided now (the user's choice or the system setting). Charts and maps ask this. */
export function motionReduced(): boolean {
  if (currentMotion() === 'reduced') return true;
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
