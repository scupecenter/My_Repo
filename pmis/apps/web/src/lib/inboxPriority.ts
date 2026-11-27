/**
 * Item 6: inbox priority. Snooze to a date and read/unread already exist, so this finishes the set. Priority is derived from the kind, not stored: what needs
 * the person to act (a mention, an approval waiting, a returned or rejected task, an idle or unowned task, an absence with work behind it) is priority; the
 * rest is information. No new column, so nothing to migrate and nothing to widen. Pure.
 */
export const PRIORITY_KINDS: readonly string[] = ['mention', 'approval_due', 'task_returned', 'task_rejected', 'idle_task_alert', 'no_holder', 'absence_alert'];

export const isPriority = (kind: string): boolean => PRIORITY_KINDS.includes(kind);

/** Priority first, the order inside each group kept (the list arrives newest first). */
export function byPriority<T extends { kind: string }>(items: T[]): T[] {
  return [...items.filter((n) => isPriority(n.kind)), ...items.filter((n) => !isPriority(n.kind))];
}
