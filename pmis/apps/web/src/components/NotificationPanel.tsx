import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, Check, GripVertical, Pin, PinOff, PictureInPicture2, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { notificationTitle } from '@/lib/notificationTitle';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '@/api/client';
import { useMe, useNotifications } from '@/api/hooks';
import { useMyProfile, useUpdateMyProfile } from '@/api/profile';
import { sanitizeAppearance } from '@/lib/appearance';
import { anchorFromPoint, anchorFromKey, ANCHOR_CLASS, type InboxAnchor } from '@/lib/floatingPanel';
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
  // Floating mode (appearance dimensions inbox_panel / inbox_anchor, per user): the same panel, opened without a backdrop, moved by drag or arrow keys and pinned (docked) at the inline-end edge.
  const me = useMe(true);
  const prof = useMyProfile();
  const saveProfile = useUpdateMyProfile();
  const look = me.data?.user.appearance as { inbox_panel?: string; inbox_anchor?: string } | undefined;
  const pmode = side && (look?.inbox_panel === 'floating' || look?.inbox_panel === 'docked') ? look.inbox_panel : 'overlay';
  // a move shows at once (the saved choice follows); a quick second key press builds on the first
  const [moved, setMoved] = useState<InboxAnchor | null>(null);
  const anchor = moved ?? (look?.inbox_anchor as InboxAnchor | undefined) ?? 'end-top';
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [live, setLive] = useState('');
  const dragFrom = useRef<{ dx: number; dy: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const persist = (patch: { inbox_panel?: string; inbox_anchor?: string }) => {
    if (!prof.data) return;
    saveProfile.mutate({ version: prof.data.version, patch: { ui_prefs: { ...sanitizeAppearance(prof.data.ui_prefs), ...patch } as never } });
  };
  const docked = pmode === 'docked' && open;
  useEffect(() => {
    // the docked panel gives the page room (styles/appearance.css), the floating one covers it
    if (docked) document.documentElement.setAttribute('data-inbox-docked', ''); else document.documentElement.removeAttribute('data-inbox-docked');
    return () => document.documentElement.removeAttribute('data-inbox-docked');
  }, [docked]);
  useEffect(() => {
    if (open && pmode !== 'overlay') panelRef.current?.focus();
  }, [open, pmode]);
  const closeFloating = () => { setOpen(false); bellRef.current?.focus(); };
  const onGripDown = (e: PointerEvent<HTMLButtonElement>) => {
    const box = panelRef.current?.getBoundingClientRect();
    if (!box) return;
    dragFrom.current = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ x: box.left, y: box.top });
  };
  const onGripMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (dragFrom.current) setDrag({ x: e.clientX - dragFrom.current.dx, y: e.clientY - dragFrom.current.dy });
  };
  const onGripUp = (e: PointerEvent<HTMLButtonElement>) => {
    if (!dragFrom.current) return;
    const box = panelRef.current?.getBoundingClientRect();
    dragFrom.current = null;
    setDrag(null);
    if (!box) return;
    const next = anchorFromPoint(e.clientX, e.clientY, window.innerWidth, window.innerHeight, document.documentElement.dir === 'rtl');
    if (next !== anchor) { setMoved(next); persist({ inbox_anchor: next }); setLive(t(`panel.anchor_${next}`)); }
  };
  const onGripKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const next = anchorFromKey(e.key, anchor, document.documentElement.dir === 'rtl');
    if (!next) return;
    e.preventDefault();
    if (next !== anchor) { setMoved(next); persist({ inbox_anchor: next }); setLive(t(`panel.anchor_${next}`)); }
  };
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
    <button ref={bellRef} className="btn relative" data-testid="topbar-bell" aria-label={count > 0 ? `${t('top.notifications')}: ${count}` : t('top.notifications')} aria-haspopup="dialog" aria-expanded={pmode !== 'overlay' ? open : undefined} onClick={side ? () => setOpen(pmode === 'overlay' ? true : !open) : undefined}>
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
            <Link to="/follow-up" data-testid="bell-open-followup" onClick={() => setOpen(false)} className="block rounded-md p-2 text-center text-xs text-link hover:bg-hover">{t('fup.open')}</Link>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  }
  if (pmode !== 'overlay') {
    const isDocked = pmode === 'docked';
    return (
      <>
        {trigger}
        {open && (
          <div ref={panelRef} role="dialog" aria-label={t('top.notifications')} tabIndex={-1} data-testid="bell-panel" data-mode={pmode} data-anchor={isDocked ? 'docked' : anchor}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeFloating(); } }}
            style={!isDocked && drag ? { left: drag.x, top: drag.y, right: 'auto', bottom: 'auto', insetInlineStart: 'auto', insetInlineEnd: 'auto' } : undefined}
            className={`card fixed z-50 flex max-w-full flex-col gap-2 p-3 shadow-xl ${WIDTH[ui.panel.width] ?? WIDTH.medium} ${isDocked ? 'inset-y-0 end-0 rounded-none' : `max-h-[70vh] ${ANCHOR_CLASS[anchor]}`}`}>
            <div className="flex items-center gap-2">
              {!isDocked && (
                <button type="button" className="btn cursor-grab touch-none px-1" data-testid="bell-drag" aria-label={t('panel.move')} title={t('panel.move_hint')}
                  onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} onKeyDown={onGripKey}><GripVertical size={14} /></button>
              )}
              <h2 className="flex-1 font-bold">{t('top.notifications')}</h2>
              <button className="btn" data-testid="bell-read-all" onClick={() => void readAll()}><Check size={14} />{t('top.mark_all_read')}</button>
              <button className="btn" data-testid="bell-pin" aria-pressed={isDocked} aria-label={t(isDocked ? 'panel.unpin' : 'panel.pin')} title={t(isDocked ? 'panel.unpin' : 'panel.pin')}
                onClick={() => persist({ inbox_panel: isDocked ? 'floating' : 'docked' })}>{isDocked ? <PinOff size={14} /> : <Pin size={14} />}</button>
              <button className="btn" data-testid="bell-close" aria-label={t('common.close')} title={t('common.close')} onClick={closeFloating}><X size={14} /></button>
            </div>
            {ui.panel.show_tabs && (
              <div role="tablist" className="flex gap-1" data-testid="bell-tabs">
                {TABS.map((x) => (
                  <button key={x} role="tab" aria-selected={tab === x} data-testid={`bell-tab-${x}`} onClick={() => setTab(x)} className={`btn ${tab === x ? 'btn-accent' : ''}`}>{t(`panel.tab_${x}`)}</button>
                ))}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">{list}</div>
            <Link to="/inbox" data-testid="bell-open-inbox" onClick={() => { if (!isDocked) setOpen(false); }} className="block rounded-md p-2 text-center text-sm font-semibold text-link hover:bg-hover">{t('top.open_inbox')}</Link>
            <Link to="/follow-up" data-testid="bell-open-followup" onClick={() => setOpen(false)} className="block rounded-md p-2 text-center text-xs text-link hover:bg-hover">{t('fup.open')}</Link>
            <span className="sr-only" role="status" aria-live="polite" data-testid="bell-live">{live}</span>
          </div>
        )}
      </>
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
            <button className="btn" data-testid="bell-float" aria-label={t('panel.float')} title={t('panel.float')} disabled={!prof.data || saveProfile.isPending} onClick={() => persist({ inbox_panel: 'floating' })}><PictureInPicture2 size={14} /></button>
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
            <Link to="/follow-up" data-testid="bell-open-followup" onClick={() => setOpen(false)} className="block rounded-md p-2 text-center text-xs text-link hover:bg-hover">{t('fup.open')}</Link>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
