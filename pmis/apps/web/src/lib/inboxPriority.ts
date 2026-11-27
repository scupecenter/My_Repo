/**
 * Item 6: inbox priority. Snooze to a date and read/unread already exist, so this finishes the set. Priority is derived from the kind, not stored: what needs
 * the person to act (a mention, an approval waiting, a returned or rejected task, an idle or unowned task, an absence with work behind it) is priority; the
 * rest is information. No new column, so nothing to migrate and nothing to widen. Pure.
 */
export const PRIORITY_KINDS: readonly string[] = ['mention', 'approval_due', 'task_returned', 'task_rejected', 'idle_task_alert', 'no_holder', 'absence_alert'];

/** The kinds that count as priority: the list from Settings > Screens > Interface (ui.features inbox), the built-in list until it loads. */
export const isPriority = (kind: string, kinds: readonly string[] = PRIORITY_KINDS): boolean => kinds.includes(kind);

/** Inbox tabs (ui.features inbox.tabs_enabled): each tab is a set of notification kinds. Priority comes from the setting, All has no filter. */
export const INBOX_TABS = ['all', 'priority', 'mentions', 'tasks', 'approvals', 'system'] as const;
export type InboxTab = (typeof INBOX_TABS)[number];
export const TAB_KINDS: Record<Exclude<InboxTab, 'all' | 'priority'>, readonly string[]> = {
  mentions: ['mention', 'followed_change'],
  tasks: ['task_assigned', 'task_returned', 'task_rejected', 'task_approved', 'reassigned', 'idle_task_alert', 'no_holder'],
  approvals: ['approval_due'],
  system: ['absence_alert', 'system'],
};
export const inTab = (tab: InboxTab, kind: string, priorityKinds: readonly string[]): boolean =>
  tab === 'all' ? true : tab === 'priority' ? isPriority(kind, priorityKinds) : TAB_KINDS[tab].includes(kind);

/** Priority first, the order inside each group kept (the list arrives newest first). */
export function byPriority<T extends { kind: string }>(items: T[], kinds: readonly string[] = PRIORITY_KINDS): T[] {
  return [...items.filter((n) => isPriority(n.kind, kinds)), ...items.filter((n) => !isPriority(n.kind, kinds))];
}
