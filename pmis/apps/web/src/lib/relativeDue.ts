/** Whole calendar days from `today` to a yyyy-mm-dd date (negative = past). Calendar days, not 24 h blocks, so late evening does not shift the answer. */
export function daysUntil(date: string, today: Date = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!m) return null;
  const a = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((a - b) / 86_400_000);
}

export type DueTone = 'late' | 'soon' | 'near' | 'far';
/** Overdue is red, today to `soonDays` away amber, within a week blue, later quiet. */
export function dueTone(days: number, soonDays = 2): DueTone {
  return days < 0 ? 'late' : days <= soonDays ? 'soon' : days <= 7 ? 'near' : 'far';
}

/** "tomorrow", "in 3 days", "2 weeks ago" in the language (Arabic natively). */
export function relativeDue(days: number, lang: string): string {
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  const n = Math.abs(days);
  if (n <= 30) return rtf.format(days, 'day');
  if (n <= 90) return rtf.format(Math.round(days / 7), 'week');
  return rtf.format(Math.round(days / 30), 'month');
}
