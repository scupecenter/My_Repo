/**
 * "Remember me" on the sign-in page. It remembers only what was typed in the ID box, on this device, for 30 days, and only when the person ticked it.
 * It never stores a password, a token or anything that signs in, and it does not touch the session, its cookie, the idle and absolute limits or two-factor.
 */
export const REMEMBER_KEY = 'pmis.login.remember';
export const REMEMBER_DAYS = 30;
const DAY_MS = 86_400_000;

interface Saved { id: string; until: number }

export function readRememberedId(now = Date.now()): string {
  try {
    const raw = globalThis.localStorage?.getItem(REMEMBER_KEY);
    if (!raw) return '';
    const v = JSON.parse(raw) as Partial<Saved>;
    if (typeof v.id === 'string' && typeof v.until === 'number' && v.until > now && v.id.length <= 254) return v.id;
    globalThis.localStorage?.removeItem(REMEMBER_KEY);
  } catch { /* blocked storage or a damaged value: nothing is remembered */ }
  return '';
}

export function writeRememberedId(id: string, now = Date.now()): void {
  try {
    const t = id.trim();
    if (!t) return;
    globalThis.localStorage?.setItem(REMEMBER_KEY, JSON.stringify({ id: t, until: now + REMEMBER_DAYS * DAY_MS } satisfies Saved));
  } catch { /* storage may be blocked */ }
}

export function clearRememberedId(): void {
  try { globalThis.localStorage?.removeItem(REMEMBER_KEY); } catch { /* storage may be blocked */ }
}
