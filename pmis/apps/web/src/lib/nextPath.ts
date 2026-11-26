/** The page to open after sign-in (authenticated share links). Only an internal path is accepted: it must start with a single "/",
 *  carry no scheme, backslash, control character or "//" (which a browser reads as another site), and not point back at the sign-in pages. */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2000) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (/^\/(login|forgot-password|reset-password)(\/|\?|#|$)/.test(raw)) return null;
  try {
    const u = new URL(raw, 'https://app.invalid');
    if (u.origin !== 'https://app.invalid') return null;
  } catch { return null; }
  return raw;
}
