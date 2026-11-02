import * as Popover from '@radix-ui/react-popover';
import { AtSign, BellRing, CheckCheck, Clock3, ExternalLink, Eye, EyeOff, Info } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Notification } from '@/api/types';
import { useInbox, useNotificationOps, type InboxFilter } from '@/api/x';
import { errText } from '@/components/FormDialog';
import { PageHeader, Toolbar } from '@/components/PageHeader';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { TaskDrawer } from '@/components/TaskDrawer';
import { useToast } from '@/components/Toast';
import { fmtDateTime } from '@/lib/time';
import { tripoliToday } from '@/lib/today';
import { notificationTarget, snoozeDate } from '@/lib/x';

const KINDS = ['mention', 'followed_change', 'task_assigned', 'task_returned', 'task_rejected', 'task_approved', 'approval_due', 'reassigned', 'absence_alert', 'idle_task_alert', 'no_holder', 'system'] as const;

function SnoozeMenu({ n, onPick }: { n: Notification; onPick: (until: string | null) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const today = tripoliToday();
  const pick = (until: string | null) => { setOpen(false); onPick(until); };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild><button type="button" className="btn px-2 py-1 text-xs" data-testid={`inbox-snooze-${n.id}`}><Clock3 size={14} aria-hidden />{t('inbox.snooze')}</button></Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} data-testid={`inbox-snooze-menu-${n.id}`} className="card z-50 w-56 space-y-1 p-2">
          {(['tomorrow', 'next_sunday', 'in_a_week'] as const).map((c) => (
            <button key={c} type="button" className="btn w-full justify-start" data-testid={`inbox-snooze-${c}-${n.id}`} onClick={() => pick(snoozeDate(c, today))}>{t(`inbox.snooze_${c}`)}</button>
          ))}
          <label className="block text-xs text-mute">{t('inbox.snooze_date')}
            <input type="date" className="input mt-1" min={snoozeDate('tomorrow', today)} data-testid={`inbox-snooze-date-${n.id}`} value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <button type="button" className="btn w-full" data-testid={`inbox-snooze-pick-${n.id}`} disabled={!date || date < snoozeDate('tomorrow', today)} onClick={() => pick(date)}>{t('inbox.snooze_until_date')}</button>
          {n.snoozed_until && <button type="button" className="btn w-full" data-testid={`inbox-unsnooze-${n.id}`} onClick={() => pick(null)}>{t('inbox.unsnooze')}</button>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** X1: everything addressed to me in one place. Read and unread, snooze to a date, filter by kind. The server hides what the caller can no longer read. */
export function Inbox() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const filter: InboxFilter = { unread: sp.get('unread') === '1', snoozed: (['only', 'include'] as const).find((x) => x === sp.get('snoozed')) ?? 'hide', kind: sp.get('kind') ?? '' };
  const setF = (kv: Record<string, string>) => setSp((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(kv)) { if (v) n.set(k, v); else n.delete(k); } return n; }, { replace: true });
  const q = useInbox(filter);
  const ops = useNotificationOps();
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const unread = q.data?.pages[0]?.unread_count ?? 0;
  const taskId = sp.get('task');
  const fail = (e: unknown) => toast(errText(e, t), 'err');

  const open = (n: Notification) => {
    if (!n.read_at) ops.mark.mutate({ id: n.id, read: true });
    const to = notificationTarget(n);
    if (to) nav(to);
  };

  return (
    <div data-testid="page-inbox">
      <PageHeader title={t('inbox.title')} subtitle={t('inbox.subtitle')} context={<span className="chip bg-accentSoft text-accentText" data-testid="inbox-unread">{t('inbox.unread_n', { count: unread })}</span>} />
      <Toolbar
        filters={<>
          <div role="group" aria-label={t('inbox.show')} className="inline-flex overflow-hidden rounded-md border border-line">
            {([['', 'inbox.all'], ['1', 'inbox.unread']] as const).map(([v, k]) => (
              <button key={k} type="button" aria-pressed={(filter.unread ? '1' : '') === v} data-testid={`inbox-show-${v ? 'unread' : 'all'}`} onClick={() => setF({ unread: v })}
                className={`px-3 py-1.5 text-sm ${(filter.unread ? '1' : '') === v ? 'bg-accentSoft font-semibold text-accentText' : 'bg-card text-mute hover:bg-hover'}`}>{t(k)}</button>
            ))}
          </div>
          <select className="input w-auto" aria-label={t('inbox.snoozed')} data-testid="inbox-snoozed" value={filter.snoozed} onChange={(e) => setF({ snoozed: e.target.value === 'hide' ? '' : e.target.value })}>
            {(['hide', 'only', 'include'] as const).map((x) => <option key={x} value={x}>{t(`inbox.snoozed_${x}`)}</option>)}
          </select>
          <select className="input w-auto" aria-label={t('inbox.kind')} data-testid="inbox-kind" value={filter.kind} onChange={(e) => setF({ kind: e.target.value })}>
            <option value="">{t('inbox.all_kinds')}</option>
            {KINDS.map((k) => <option key={k} value={k}>{t(`inbox.kind_${k}`)}</option>)}
          </select>
        </>}
        primary={<button type="button" className="btn btn-primary" data-testid="inbox-read-all" disabled={unread === 0 || ops.readAll.isPending} onClick={() => ops.readAll.mutate(undefined, { onSuccess: () => toast(t('inbox.all_read')), onError: fail })}><CheckCheck size={16} aria-hidden />{t('top.mark_all_read')}</button>}
      />
      {q.isLoading ? <LoadingSkeleton testid="inbox-loading" />
        : q.isError ? <ErrorState onRetry={() => void q.refetch()} testid="inbox-error" />
        : !items.length ? <EmptyState testid="inbox-empty" title={t(filter.unread ? 'inbox.empty_unread' : 'inbox.empty')} hint={t('inbox.empty_hint')} />
        : (
          <ul className="card divide-y divide-line" data-testid="inbox-list">
            {items.map((n) => (
              <li key={n.id} data-testid={`inbox-item-${n.id}`} data-read={n.read_at ? 'true' : 'false'} data-kind={n.kind} className={`flex flex-wrap items-start gap-3 p-3 ${n.read_at ? '' : 'bg-accentSoft/30'}`}>
                <span className="mt-1 text-mute" aria-hidden>{n.kind === 'mention' ? <AtSign size={16} /> : n.kind === 'followed_change' ? <BellRing size={16} /> : <Info size={16} />}</span>
                <div className="min-w-60 flex-1">
                  <button type="button" className={`text-start ${n.read_at ? '' : 'font-semibold'}`} data-testid={`inbox-open-${n.id}`} onClick={() => open(n)}>{n.title}</button>
                  {n.body && <p className="text-sm text-mute">{n.body}</p>}
                  <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-mute">
                    <span className="chip bg-card2">{t(`inbox.kind_${n.kind}`, { defaultValue: n.kind })}</span>
                    <span>{fmtDateTime(n.created_at, i18n.language)}</span>
                    {n.snoozed_until && <span className="chip bg-waitBg text-waitInk" data-testid={`inbox-snoozed-chip-${n.id}`}>{t('inbox.snoozed_until', { date: fmtDateTime(n.snoozed_until, i18n.language) })}</span>}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {notificationTarget(n) && <button type="button" className="btn px-2 py-1 text-xs" data-testid={`inbox-go-${n.id}`} onClick={() => open(n)}><ExternalLink size={14} aria-hidden />{t('inbox.open')}</button>}
                  <button type="button" className="btn px-2 py-1 text-xs" data-testid={`inbox-toggle-${n.id}`} disabled={ops.mark.isPending} onClick={() => ops.mark.mutate({ id: n.id, read: !n.read_at }, { onError: fail })}>
                    {n.read_at ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}{t(n.read_at ? 'inbox.mark_unread' : 'inbox.mark_read')}
                  </button>
                  <SnoozeMenu n={n} onPick={(until) => ops.snooze.mutate({ id: n.id, until }, { onSuccess: () => toast(t(until ? 'inbox.snoozed_ok' : 'inbox.unsnoozed_ok')), onError: fail })} />
                </div>
              </li>
            ))}
          </ul>
        )}
      {q.hasNextPage && <div className="mt-3 text-center"><button className="btn" data-testid="inbox-more" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t('inbox.more')}</button></div>}
      <TaskDrawer taskId={taskId} onClose={() => setF({ task: '' })} />
    </div>
  );
}
