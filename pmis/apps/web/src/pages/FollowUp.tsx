import { AlertTriangle, ArrowRight, Bell, CheckCircle2, Circle, ClipboardCheck, Inbox, ListTodo } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useApprovals, useMe, useMyTasks, useNotifications } from '@/api/hooks';
import { useMyNotificationPrefs } from '@/api/notificationPersonal';
import { useMyProfile, type MyProfile } from '@/api/profile';
import { useMyPush } from '@/api/push';
import type { Notification, TaskSummary } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, LoadingSkeleton } from '@/components/States';
import { Tip } from '@/components/Tip';
import { sanitizeAppearance } from '@/lib/appearance';
import { fmtDateTime } from '@/lib/time';
import { notificationTarget } from '@/lib/x';

/** The kinds that are a reminder to act (an approval waiting, an idle or unowned task, a returned task), not news: the reminders block of the hub. */
export const REMINDER_KINDS: readonly string[] = ['approval_due', 'idle_task_alert', 'no_holder', 'task_returned', 'task_rejected', 'absence_alert'];
const SHOWN = 5;

export type ChecklistItem = { key: string; done: boolean; to: string };

/**
 * The profile-completion checklist: each item is true or false from data the person already reads (their profile, their notification choices, their
 * browsers) and links to the exact place that fixes it (a section of My profile). An item that does not apply to this person (a server without push,
 * a sign-in without a local password, notification choices switched off by the administrator) is not listed, so the list is never a trap.
 */
export function profileChecklist(p: MyProfile, opts: { notifications: { allowed: boolean; chosen: boolean }; push: { enabled: boolean; has: boolean } }): ChecklistItem[] {
  const looks = Object.keys(sanitizeAppearance(p.ui_prefs)).length > 0 || !!p.ui_brand;
  const items: ChecklistItem[] = [
    { key: 'phone', done: !!p.phone, to: '/profile#phone' },
    { key: 'appearance', done: looks, to: '/profile#appearance' },
  ];
  if (opts.notifications.allowed) items.push({ key: 'notifications', done: opts.notifications.chosen, to: '/profile#notifications' });
  if (opts.push.enabled) items.push({ key: 'push', done: opts.push.has, to: '/profile#push' });
  if (p.local_sign_in) items.push({ key: 'two_factor', done: p.two_factor.state !== 'off', to: '/profile#two-factor' });
  return items;
}

function TaskLine({ x }: { x: TaskSummary }) {
  const { i18n } = useTranslation();
  const name = i18n.language === 'ar' && x.name_ar ? x.name_ar : x.name_en;
  return (
    <li className="flex items-center gap-2 border-b border-line py-2 text-sm last:border-0" data-testid={`fup-task-${x.id}`}>
      <b className="mono" dir="ltr">{x.site_code}</b><span className="truncate">{x.task_code} {name}</span>
    </li>
  );
}

function Block({ id, icon, title, count, to, toLabel, empty, children }: { id: string; icon: React.ReactNode; title: string; count: number; to: string; toLabel: string; empty: string; children: React.ReactNode }) {
  return (
    <section className="card space-y-2 p-4" aria-labelledby={`fup-${id}-title`} data-testid={`fup-${id}`} data-count={count}>
      <h2 id={`fup-${id}-title`} className="flex items-center gap-2 text-lg font-bold">{icon}{title}<span className="chip border border-line" data-testid={`fup-${id}-count`}>{count}</span></h2>
      {count === 0 ? <p className="text-sm text-mute" data-testid={`fup-${id}-empty`}>{empty}</p> : <ul>{children}</ul>}
      <Link to={to} className="inline-flex items-center gap-1 text-sm text-link" data-testid={`fup-${id}-all`}>{toLabel}<ArrowRight size={14} aria-hidden className="rtl:rotate-180" /></Link>
    </section>
  );
}

/**
 * Item 11: the follow-up hub, one full-screen page with everything that waits for the person: the approvals waiting for them, the tasks assigned to
 * them (late, to do now, waiting), the reminders among their unread notices, and a checklist of the profile. It reads what the bell, My Work, Approvals
 * and My profile already read (no new route, no new permission); each block links to the screen that owns the action. The checklist shows or hides by
 * the appearance choice `followup_checklist` (Profile > Appearance, organization default in Settings > Identity).
 */
export function FollowUp() {
  const { t, i18n } = useTranslation();
  const me = useMe(true);
  const prof = useMyProfile();
  const approvals = useApprovals('all', '');
  const late = useMyTasks('late'), doNow = useMyTasks('do_now'), waiting = useMyTasks('waiting');
  const notes = useNotifications(true);
  const prefs = useMyNotificationPrefs();
  const push = useMyPush(null);
  const reminders = useMemo(() => (notes.data?.items ?? []).filter((n: Notification) => !n.read_at && REMINDER_KINDS.includes(n.kind)), [notes.data]);
  const hide = (prof.data?.appearance as { followup_checklist?: string } | undefined)?.followup_checklist === 'hide';
  if (me.isLoading || prof.isLoading) return <LoadingSkeleton />;
  if (prof.isError || !prof.data) return <ErrorState onRetry={() => void prof.refetch()} />;
  const list = profileChecklist(prof.data, {
    notifications: { allowed: prefs.data ? prefs.data.org.allow_personal !== false : false, chosen: (prefs.data?.version ?? 0) > 0 },
    push: { enabled: !!push.data?.enabled, has: (push.data?.count ?? 0) > 0 },
  });
  const done = list.filter((i) => i.done).length;
  const assigned = [...(late.data?.items ?? []), ...(doNow.data?.items ?? []), ...(waiting.data?.items ?? [])];
  const appr = approvals.data?.items ?? [];
  return (
    <div className="space-y-4" data-testid="page-follow-up">
      <PageHeader title={t('fup.title')} subtitle={t('fup.subtitle', { name: me.data?.user.display_name.split(' ')[0] ?? '' })} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Block id="approvals" icon={<ClipboardCheck size={18} aria-hidden />} title={t('fup.approvals')} count={approvals.data?.counts?.total ?? appr.length} to="/approvals" toLabel={t('fup.open_approvals')} empty={t('fup.none_approvals')}>
          {appr.slice(0, SHOWN).map((i) => <TaskLine key={i.task.id} x={i.task as TaskSummary} />)}
        </Block>
        <Block id="assigned" icon={<ListTodo size={18} aria-hidden />} title={t('fup.assigned')} count={assigned.length} to="/my-work" toLabel={t('fup.open_my_work')} empty={t('fup.none_assigned')}>
          {assigned.slice(0, SHOWN).map((x) => <TaskLine key={x.id} x={x} />)}
        </Block>
        <Block id="reminders" icon={<Bell size={18} aria-hidden />} title={t('fup.reminders')} count={reminders.length} to="/inbox" toLabel={t('fup.open_inbox')} empty={t('fup.none_reminders')}>
          {reminders.slice(0, SHOWN).map((n) => {
            const to = notificationTarget(n);
            return (
              <li key={n.id} className="flex items-center gap-2 border-b border-line py-2 text-sm last:border-0" data-testid={`fup-reminder-${n.id}`}>
                <AlertTriangle size={14} aria-hidden className="shrink-0 text-waitInk" />
                {to ? <Link to={to} className="truncate text-link">{n.title}</Link> : <span className="truncate">{n.title}</span>}
                <span className="ms-auto text-xs text-mute">{fmtDateTime(n.created_at, i18n.language)}</span>
              </li>
            );
          })}
        </Block>
        {!hide && (
          <section className="card space-y-2 p-4" aria-labelledby="fup-checklist-title" data-testid="fup-checklist" data-done={done} data-total={list.length}>
            <h2 id="fup-checklist-title" className="flex items-center gap-2 text-lg font-bold"><CheckCircle2 size={18} aria-hidden />{t('fup.checklist')}<span className="chip border border-line" data-testid="fup-checklist-progress">{t('fup.progress', { done, total: list.length })}</span></h2>
            <div className="h-2 overflow-hidden rounded-full bg-card2" role="progressbar" aria-valuemin={0} aria-valuemax={list.length} aria-valuenow={done} aria-label={t('fup.checklist')}>
              <div className="h-full bg-doneInk" style={{ width: `${list.length ? (done / list.length) * 100 : 100}%` }} />
            </div>
            <ul>
              {list.map((i) => (
                <li key={i.key} className="flex items-center gap-2 border-b border-line py-2 text-sm last:border-0" data-testid={`fup-check-${i.key}`} data-done={i.done ? '1' : '0'}>
                  {i.done ? <CheckCircle2 size={16} aria-hidden className="text-doneInk" /> : <Circle size={16} aria-hidden className="text-mute" />}
                  <span className="flex-1">{t(`fup.check_${i.key}`)}<span className="sr-only"> {t(i.done ? 'fup.done' : 'fup.todo')}</span></span>
                  {!i.done && <Tip text={t(`fup.check_${i.key}_hint`)}><Link to={i.to} className="btn px-2 py-1 text-xs" data-testid={`fup-check-${i.key}-go`} aria-label={`${t(`fup.check_${i.key}`)}: ${t('fup.go')}`}>{t('fup.go')}</Link></Tip>}
                </li>
              ))}
            </ul>
            <p className="text-xs text-mute">{t('fup.hide_note')} <Link to="/profile#appearance" className="text-link" data-testid="fup-hide-link">{t('fup.hide_link')}</Link></p>
          </section>
        )}
      </div>
      <p className="text-xs text-mute"><Inbox size={12} className="me-1 inline" aria-hidden />{t('fup.note')}</p>
    </div>
  );
}
