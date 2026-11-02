import type { Me } from '@/api/types';

/** Helpers of the phase 4b features X1 to X7 (inbox, follow, mentions, time in state, workload, blocked-by, status updates). Pure functions, no network. */

/**
 * Where a notification takes you. The server writes app-relative links: `/tasks/<id>` and `/registers/<key>/records/<id>`. The first has no page of its own
 * (a task opens in the drawer), so it becomes the inbox with the task open; the second is the register list with the record open. Anything else is used as it is,
 * but only when it is an app path: a link that is not (a scheme, `//host`) is ignored.
 */
export function notificationTarget(n: { link?: string | null; entity_type?: string | null; entity_id?: string | null }): string | null {
  const link = n.link ?? '';
  const task = /^\/tasks\/([0-9a-f-]{36})$/i.exec(link);
  if (task) return `/inbox?task=${task[1]}`;
  if (n.entity_type === 'task' && n.entity_id && !link) return `/inbox?task=${n.entity_id}`;
  const rec = /^\/registers\/([A-Za-z0-9_-]+)\/records\/([0-9a-f-]{36})$/i.exec(link);
  if (rec) return `/registers/${rec[1]}?record=${rec[2]}`;
  if (/^\/(?!\/)[A-Za-z0-9/_?=&.-]*$/.test(link)) return link;
  return null;
}

/** `3 d 4 h`, `5 h 20 min`, `12 min`, `< 1 min`; the unit words come from the caller's translation. */
export function fmtDuration(seconds: number, u: { d: string; h: string; min: string; lt: string }): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3_600), m = Math.floor((s % 3_600) / 60);
  if (d > 0) return h > 0 ? `${d} ${u.d} ${h} ${u.h}` : `${d} ${u.d}`;
  if (h > 0) return m > 0 ? `${h} ${u.h} ${m} ${u.min}` : `${h} ${u.h}`;
  if (m > 0) return `${m} ${u.min}`;
  return u.lt;
}

/** The text after the last `@` that is still being typed (at the end of the box), when it starts a word: `look at @sa` gives `sa`. */
export function mentionQuery(text: string): string | null {
  const m = /(?:^|[\s(])@([^\s@()]{0,30})$/.exec(text);
  return m ? (m[1] as string) : null;
}

/** Replaces the unfinished `@query` at the end of the text by `@<employee id> `, the token the server also understands. */
export function insertMention(text: string, employeeId: string): string {
  return text.replace(/(^|[\s(])@[^\s@()]{0,30}$/, `$1@${employeeId} `);
}

/** The 4-digit employee-ID tokens of a text, in order, without repeats (the server resolves the same ones). */
export function mentionTokens(text: string): string[] {
  return [...new Set([...text.matchAll(/(?:^|[\s(])@(\d{4})\b/g)].map((m) => m[1] as string))];
}

/** Splits a comment into plain parts and `@1234` tokens, so a token can be shown as a chip. */
export function splitMentions(text: string): { text: string; token: boolean }[] {
  const out: { text: string; token: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(/(^|[\s(])(@\d{4})\b/g)) {
    const start = (m.index ?? 0) + (m[1] as string).length;
    if (start > last) out.push({ text: text.slice(last, start), token: false });
    out.push({ text: m[2] as string, token: true });
    last = start + (m[2] as string).length;
  }
  if (last < text.length) out.push({ text: text.slice(last), token: false });
  return out;
}

/** The Sunday that opens the working week of a `YYYY-MM-DD` day (the weekend is Friday and Saturday, so the week runs Sunday to Saturday). */
export function weekStartOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

/** A snooze choice as the `until` of the API: a plain date, always in the future. `tomorrow`, `next_sunday` (start of the next working week), `in_a_week`. */
export function snoozeDate(choice: 'tomorrow' | 'next_sunday' | 'in_a_week', today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  if (choice === 'tomorrow') d.setUTCDate(d.getUTCDate() + 1);
  else if (choice === 'in_a_week') d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCDate(d.getUTCDate() + (7 - d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}

/**
 * A lead: holds the reassign right (stored as `overrides.reassign` with the action `administer`), or is a System Admin. It only decides whether the screen offers
 * the buttons; the server checks the right for the region on every write.
 */
export function canReassign(me?: Me | null): boolean {
  if (!me) return false;
  if (me.is_system_admin) return true;
  return me.effective.grants.some((g) => (g.module_key === 'overrides.reassign' && g.action === 'administer') || (g.action as string) === 'reassign');
}
