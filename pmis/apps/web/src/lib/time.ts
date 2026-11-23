/** Date and time as the project sees it (Africa/Tripoli), in the language of the screen. */
export function fmtDateTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-LY-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Tripoli' }).format(d);
}

/** Codes of `errors[]` of a failed call (for example `no_recipients`, `manager_loop`). */
export function errorCodes(e: unknown): string[] {
  const list = (e as { problem?: { errors?: { code: string }[] } } | null)?.problem?.errors;
  return Array.isArray(list) ? list.map((x) => x.code) : [];
}

/** A date value (YYYY-MM-DD, or a date-time) as a plain date in the language of the screen; any other text is returned as it is. */
export function fmtDate(v: string | null | undefined, locale: string): string {
  if (!v) return '';
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(v)) return v;
  const d = new Date(`${v.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return v;
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-LY-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
}
