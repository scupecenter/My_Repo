import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, Check, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { notificationTitle } from '@/lib/notificationTitle';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '@/api/client';
import { useNotifications } from '@/api/hooks';
import { useUiFeatures } from '@/api/uiFeatures';
import { inTab, isPriority } from '@/lib/inboxPriority';
import { notificationTarget } from '@/lib/x';

/** Item 8: the bell opens the small popover (as before) or a panel that slides in from the inline-end edge (ui.features panel). The panel mirrors in RTL. */
type PanelTab = 'all' | 'unread' | 'priority';
const TABS: PanelTab[] = ['all', 'unread', 'priority'];
const WIDTH: Record<string, string> = { narrow: 'w-80', medium: 'w-[26rem]', wide: 'w-[34rem]' };

type Row = { id: string; title: string; kind: string; read_at?: string | null; link?: string | null; entity_type?: string | null; entity_id?: string | null };

export function NotificationBell({ count }: { count: number }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const n = useNotifications(true);
  const nav = useNavigate();
  const ui = useUiFeatures();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>('all');
  const side = ui.panel.mode === 'side_panel';
  const readAll = () => api.post<void>('/notifications/read-all').then(() => qc.invalidateQueries({ queryKey: ['notifications'] }));
  const go = (x: Row) => {
    setOpen(false);
    if (!x.read_at) void api.post(`/notifications/${x.id}/read`).then(() => qc.invalidateQueries({ queryKey: ['notifications'] }), () => {});
    const to = notificationTarget(x);
    if (to) nav(to);
  };
  const all = (n.data?.items ?? []) as Row[];
  const shown = side && ui.panel.show_tabs
    ? all.filter((x) => (tab === 'all' ? true : tab === 'unread' ? !x.read_at : inTab('priority', x.kind, ui.inbox.priority_kinds)))
    : all;
  const rows = shown.slice(0, side ? 30 : 8);
  const trigger = (
    <button className="btn relative" data-testid="topbar-bell" aria-label={count > 0 ? `${t('top.notifications')}: ${count}` : t('top.notifications')} aria-haspopup="dialog" onClick={side ? () => setOpen(true) : undefined}>
      <Bell size={16} />
      {count > 0 && <span data-testid="bell-count" className="absolute -top-2 -end-2 grid h-5 min-w-5 place-items-center rounded-full bg-late px-1 text-xs text-lateOn">{count}</span>}
    </button>
  );
  const list = (
    <>
      {rows.length === 0 && <p className="p-2 text-mute" data-testid="bell-empty">{t('top.no_notifications')}</p>}
      {rows.map((x) => (
        <button key={x.id} data-testid={`bell-item-${x.id}`} onClick={() => go(x)} className={`flex w-full items-center gap-2 rounded-md p-2 text-start text-sm hover:bg-hover ${x.read_at ? 'text-mute' : 'font-semibold'}`}>
          {!x.read_at && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden />}
          <span className="min-w-0 flex-1">{notificationTitle(x.title, i18n.language, t)}</span>
          {isPriority(x.kind, ui.inbox.priority_kinds) && <span className="chip px-1.5 py-0 text-[10px]" data-testid={`bell-priority-${x.id}`}>{t('inbox.tab_priority')}</span>}
        </button>
      ))}
    </>
  );
  if (!side) {
    return (
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>{trigger}</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="end" sideOffset={6} data-testid="bell-panel" className="card z-50 w-80 p-2">
            <button className="btn mb-2 w-full" onClick={() => void readAll()}><Check size={14} />{t('top.mark_all_read')}</button>
            {list}
            <Link to="/inbox" data-testid="bell-open-inbox" onClick={() => setOpen(false)} className="mt-1 block rounded-md p-2 text-center text-sm font-semibold text-link hover:bg-hover">{t('top.open_inbox')}</Link>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  }
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      {trigger}
      <Dialog.Portal>
        <Dialog.Overlay className="motion-overlay fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content data-testid="bell-panel" data-mode="side_panel" aria-describedby={undefined}
          className={`motion-slide-in card fixed inset-y-0 end-0 z-50 flex max-w-full flex-col gap-2 rounded-none p-3 ${WIDTH[ui.panel.width] ?? WIDTH.medium}`}>
          <div className="flex items-center gap-2">
            <Dialog.Title className="flex-1 font-bold">{t('top.notifications')}</Dialog.Title>
            <button className="btn" data-testid="bell-read-all" onClick={() => void readAll()}><Check size={14} />{t('top.mark_all_read')}</button>
            <Dialog.Close asChild><button className="btn" data-testid="bell-close" aria-label={t('common.close')}><X size={14} /></button></Dialog.Close>
          </div>
          {ui.panel.show_tabs && (
            <div role="tablist" className="flex gap-1" data-testid="bell-tabs">
              {TABS.map((x) => (
                <button key={x} role="tab" aria-selected={tab === x} data-testid={`bell-tab-${x}`} onClick={() => setTab(x)} className={`btn ${tab === x ? 'btn-accent' : ''}`}>{t(`panel.tab_${x}`)}</button>
              ))}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">{list}</div>
          <Link to="/inbox" data-testid="bell-open-inbox" onClick={() => setOpen(false)} className="block rounded-md p-2 text-center text-sm font-semibold text-link hover:bg-hover">{t('top.open_inbox')}</Link>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
