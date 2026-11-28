import * as Popover from '@radix-ui/react-popover';
import { AtSign, BellRing, CheckCheck, Clock3, ExternalLink, Eye, EyeOff, Flag, Info, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { notificationTitle } from '@/lib/notificationTitle';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Notification } from '@/api/types';
import { useInbox, useNotificationOps, type InboxFilter } from '@/api/x';
import { errText } from '@/components/FormDialog';
import { PageHeader, Toolbar } from '@/components/PageHeader';
import { SavedViews } from '@/components/SavedViews';
import { EmptyState, ErrorState, LoadingSkeleton } from '@/components/States';
import { TaskDrawer } from '@/components/TaskDrawer';
import { useToast } from '@/components/Toast';
import { fmtDateTime } from '@/lib/time';
import { tripoliToday } from '@/lib/today';
import { useUiFeatures } from '@/api/uiFeatures';
import { byPriority, INBOX_TABS, inTab, isPriority, type InboxTab } from '@/lib/inboxPriority';
import { notificationTarget, snoozeDate } from '@/lib/x';
import { DateInput } from '@/components/DateInput';


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
            <DateInput className="input mt-1" min={snoozeDate('tomorrow', today)} data-testid={`inbox-snooze-date-${n.id}`} value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <button type="button" className="btn w-full" data-testid={`inbox-snooze-pick-${n.id}`} disabled={!date || date < snoozeDate('tomorrow', today)} onClick={() => pick(date)}>{t('inbox.snooze_until_date')}</button>
          {n.snoozed_until && <button type="button" className="btn w-full" data-testid={`inbox-unsnooze-${n.id}`} onClick={() => pick(null)}>{t('inbox.unsnooze')}</button>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** P6: one Show select replaces the All/Unread buttons and the snoozed select (the kind select duplicated the tabs and is gone; a kind from a saved view shows as a removable chip). */
const SHOW = {
  all: { unread: false, snoozed: 'hide' },
  unread: { unread: true, snoozed: 'hide' },
  snoozed: { unread: false, snoozed: 'only' },
  unread_snoozed: { unread: true, snoozed: 'only' },
  all_incl: { unread: false, snoozed: 'include' },
  unread_incl: { unread: true, snoozed: 'include' },
} as const;
type ShowKey = keyof typeof SHOW;
const showKeyOf = (unread: boolean, snoozed: string): ShowKey => (Object.keys(SHOW) as ShowKey[]).find((k) => SHOW[k].unread === unread && SHOW[k].snoozed === snoozed) ?? 'all';

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
  const { inbox: cfg } = useUiFeatures();
  const pk = cfg.priority_kinds;
  const tabParam = sp.get('tab');
  const tab: InboxTab = !cfg.tabs_enabled ? (sp.get('priority') === '1' ? 'priority' : 'all')
    : (INBOX_TABS as readonly string[]).includes(tabParam ?? '') ? (tabParam as InboxTab) : sp.get('priority') === '1' ? 'priority' : cfg.default_tab;
  const priorityOnly = tab === 'priority';
  const showValue = showKeyOf(filter.unread, filter.snoozed);
  const loaded = q.data?.pages.flatMap((p) => p.items) ?? [];
  const priorityCount = loaded.filter((n) => isPriority(n.kind, pk)).length;
  const items = tab === 'all' ? byPriority(loaded, pk) : loaded.filter((n) => inTab(tab, n.kind, pk));
  const pickTab = (x: InboxTab) => setF({ tab: x === cfg.default_tab ? '' : x, priority: '' });
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
      <PageHeader title={t('inbox.title')} subtitle={t('inbox.subtitle')} context={<><span className="chip bg-accentSoft text-accentText" data-testid="inbox-unread">{t('inbox.unread_n', { count: unread })}</span><Link to="/follow-up" className="btn px-2 py-1 text-xs" data-testid="inbox-go-followup">{t('fup.open')}</Link></>} />
      {cfg.tabs_enabled && (
        <div role="group" aria-label={t('inbox.tabs')} className="mb-2 flex flex-wrap gap-1" data-testid="inbox-tabs">
          {INBOX_TABS.map((x) => {
            const n = x === 'all' ? loaded.length : loaded.filter((m) => inTab(x, m.kind, pk)).length;
            return (
              <button key={x} type="button" aria-pressed={tab === x} data-testid={x === 'priority' ? 'inbox-priority-only' : `inbox-tab-${x}`} onClick={() => (x === 'priority' && tab === 'priority' ? pickTab('all') : pickTab(x))}
                className={`btn px-3 py-1.5 text-sm ${tab === x ? 'bg-accentSoft font-semibold text-accentText' : ''}`}>
                {x === 'priority' && <Flag size={14} aria-hidden />}{t(`inbox.tab_${x}`)}
                {n > 0 && <span className="chip bg-card2" data-testid={`inbox-tab-count-${x}`}>{n}</span>}
              </button>
            );
          })}
        </div>
      )}
      <Toolbar
        settings="inbox"
        filters={<>
          <SavedViews<Record<string, unknown>> screen="inbox" value={{ unread: filter.unread ? '1' : '', snoozed: filter.snoozed === 'hide' ? '' : filter.snoozed, kind: filter.kind, tab: tabParam ?? '' }} empty={{ unread: '', snoozed: '', kind: '', tab: '' }}
            onApply={(v) => setF({ unread: String(v.unread ?? ''), snoozed: String(v.snoozed ?? ''), kind: String(v.kind ?? ''), tab: String(v.tab ?? ''), priority: '' })} />
          <label className="flex items-center gap-1 text-sm"><span className="text-mute">{t('inbox.show')}</span>
            <select className="input w-auto" data-testid="inbox-show" value={showValue} onChange={(e) => { const m = SHOW[e.target.value as ShowKey]; setF({ unread: m.unread ? '1' : '', snoozed: m.snoozed === 'hide' ? '' : m.snoozed }); }}>
              {(Object.keys(SHOW) as ShowKey[]).map((k) => <option key={k} value={k}>{t(`inbox.show_${k}`)}</option>)}
            </select>
          </label>
          {!cfg.tabs_enabled && <button type="button" className={`btn ${priorityOnly ? 'bg-accentSoft font-semibold text-accentText' : ''}`} aria-pressed={priorityOnly} data-testid="inbox-priority-only" onClick={() => setF({ priority: priorityOnly ? '' : '1' })}>
            <Flag size={14} aria-hidden />{t('inbox.priority_only')}{priorityCount > 0 && <span className="chip bg-card2" data-testid="inbox-priority-count">{priorityCount}</span>}
          </button>}
          {filter.kind && <span className="chip bg-accentSoft text-accentText" data-testid="inbox-kind-chip">{t('inbox.kind')}: {t(`inbox.kind_${filter.kind}`, { defaultValue: filter.kind })}<button type="button" className="ms-1" aria-label={t('inbox.kind_clear')} data-testid="inbox-kind-clear" onClick={() => setF({ kind: '' })}><X size={12} aria-hidden /></button></span>}
        </>}
        primary={<button type="button" className="btn btn-primary" data-testid="inbox-read-all" disabled={unread === 0 || ops.readAll.isPending} onClick={() => ops.readAll.mutate(undefined, { onSuccess: () => toast(t('inbox.all_read')), onError: fail })}><CheckCheck size={16} aria-hidden />{t('top.mark_all_read')}</button>}
      />
      {q.isLoading ? <LoadingSkeleton testid="inbox-loading" />
        : q.isError ? <ErrorState onRetry={() => void q.refetch()} testid="inbox-error" />
        : !items.length ? <EmptyState testid="inbox-empty" title={t(priorityOnly ? 'inbox.empty_priority' : tab !== 'all' ? 'inbox.empty_tab' : filter.unread ? 'inbox.empty_unread' : 'inbox.empty')} hint={t('inbox.empty_hint')} />
        : (
          <ul className="card divide-y divide-line" data-testid="inbox-list">
            {items.map((n) => (
              <li key={n.id} data-testid={`inbox-item-${n.id}`} data-read={n.read_at ? 'true' : 'false'} data-kind={n.kind} className={`flex flex-wrap items-start gap-3 p-3 ${n.read_at ? '' : 'bg-accentSoft/30'}`}>
                <span className="mt-1 text-mute" aria-hidden>{n.kind === 'mention' ? <AtSign size={16} /> : n.kind === 'followed_change' ? <BellRing size={16} /> : <Info size={16} />}</span>
                <div className="min-w-60 flex-1">
                  <button type="button" className={`text-start ${n.read_at ? '' : 'font-semibold'}`} data-testid={`inbox-open-${n.id}`} onClick={() => open(n)}>{notificationTitle(n.title, i18n.language, t)}</button>
                  {n.body && <p className="text-sm text-mute">{n.body}</p>}
                  <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-mute">
                    {isPriority(n.kind, pk) && <span className="chip bg-lateBg text-lateInk" data-testid={`inbox-priority-${n.id}`}><Flag size={12} aria-hidden />{t('inbox.priority')}</span>}
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
