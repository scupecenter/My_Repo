/** Keyboard shortcuts (navigation only: a route that the person may not open still refuses them itself). */
export const GO_KEYS: Record<string, string> = {
  d: '/dashboard',
  s: '/sites',
  w: '/my-work',
  a: '/approvals',
  i: '/inbox',
  m: '/messages',
  l: '/workload',
  r: '/status-updates',
};

/** True when the key press comes from a field where the person is typing. */
export function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/** Pure state step of the "g then key" sequence: returns the route to open, or null. */
export function goTarget(prev: string | null, key: string): { next: string | null; to: string | null } {
  if (prev === 'g') return { next: null, to: GO_KEYS[key.toLowerCase()] ?? null };
  return { next: key === 'g' ? 'g' : null, to: null };
}
