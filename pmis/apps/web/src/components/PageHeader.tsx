import * as Popover from '@radix-ui/react-popover';
import { Ellipsis } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useMe } from '@/api/hooks';
import type { ScreenKey } from '@/lib/screenSettings';
import { ICONS } from '@/lib/icons';
import { ScreenSettingsLink, useScreenSettings } from './ScreenSettingsLink';
import { Tip } from './Tip';

/** Page header (plan T1): title + context chip, optional subtitle, then the page's own tabs go below it. */
export function PageHeader({ title, subtitle, context, testid, settings }: { title: string; subtitle?: string; context?: ReactNode; testid?: string; settings?: ScreenKey }) {
  return (
    <header className="mb-3" data-testid={testid}>
      <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-bold">{title}</h1>{context}{settings && <span className="ms-auto flex items-center gap-2"><ScreenSettingsLink screen={settings} /></span>}</div>
      {subtitle && <p className="text-mute">{subtitle}</p>}
    </header>
  );
}

/** Toolbar (plan T1/T3/T5), fixed order: filters › active-filter count › count › primary action › secondary tools. Page, row and global actions stay in separate groups. */
export function Toolbar({ filters, activeFilters = 0, count, primary, tools, activeLabel, settings }: { settings?: ScreenKey; filters?: ReactNode; activeFilters?: number; count?: ReactNode; tools?: ReactNode; primary?: ReactNode; activeLabel?: string }) {
  return (
    <div role="toolbar" className="mb-3 flex flex-wrap items-center gap-2">
      {filters}
      {activeFilters > 0 && <span className="chip bg-accentSoft text-accentText" data-testid="toolbar-active-filters">{activeLabel ?? ''} {activeFilters}</span>}
      <span className="ms-auto flex flex-wrap items-center gap-2">
        {count}
        {primary}
        {tools}
        {settings && <ScreenSettingsLink screen={settings} />}
      </span>
    </div>
  );
}

export type MoreItem = { id: string; label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean; testid: string };
/** "More" overflow (plan T3): secondary tools live here; the primary action never does. Items keep their own data-testid. */
export function MoreMenu({ items, settings }: { items: MoreItem[]; settings?: ScreenKey }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const nav = useNavigate();
  // personal appearance dimension more_menu (list = default, grid = icon grid with search)
  const grid = (useMe(true).data?.user.appearance as { more_menu?: string } | undefined)?.more_menu === 'grid';
  const gear = useScreenSettings(settings ?? 'dashboard');
  const showGear = !!settings && gear.allowed;
  if (!items.length) return settings ? <ScreenSettingsLink screen={settings} /> : null;
  // settings gear: its own button right before the "..." trigger; on narrow headers the same link is the last item of the menu
  const Icon = ICONS.settings;
  const all: MoreItem[] = showGear ? [...items, { id: 'screen-settings', label: `${gear.title}: ${gear.dest}`, icon: <Icon size={16} aria-hidden />, testid: 'more-screen-settings', onSelect: () => nav(gear.to) }] : items;
  if (!all.length) return null;
  return (
    <>
    {settings && <ScreenSettingsLink screen={settings} narrowHidden />}
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tip text={t('table.more')}>
        <Popover.Trigger asChild><button type="button" className="btn" data-testid="more-menu" aria-label={t('table.more')}><Ellipsis size={16} /></button></Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} role="menu" className={`card z-50 p-1 shadow-lg ${grid ? 'w-[min(22rem,92vw)]' : 'min-w-48'}`} data-testid="more-panel" data-mode={grid ? 'grid' : 'list'}>
          {grid ? (
            <>
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('table.more_search')} aria-label={t('table.more_search')} className="input mb-1 w-full" data-testid="more-search" />
              <div className="grid grid-cols-3 gap-1">
                {all.filter((i) => i.label.toLowerCase().includes(q.trim().toLowerCase())).map((i) => (
                  <button key={i.id} type="button" role="menuitem" disabled={i.disabled} data-testid={i.testid} title={i.label} className="flex flex-col items-center gap-1 rounded px-1 py-2 text-center text-xs hover:bg-hover disabled:opacity-50" onClick={() => { setOpen(false); setQ(''); i.onSelect(); }}>
                    <span className="grid h-8 w-8 place-items-center rounded bg-accentSoft text-accentText" aria-hidden>{i.icon ?? i.label.slice(0, 1)}</span>
                    <span className="line-clamp-2 break-words">{i.label}</span>
                  </button>
                ))}
              </div>
              {!all.some((i) => i.label.toLowerCase().includes(q.trim().toLowerCase())) && <p className="p-2 text-center text-sm text-mute" data-testid="more-none">{t('table.more_none')}</p>}
            </>
          ) : (
            <>
          {all.map((i) => (
            <button key={i.id} type="button" role="menuitem" disabled={i.disabled} data-testid={i.testid} className={`${i.id === 'screen-settings' ? 'sm:hidden ' : ''}flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-hover disabled:opacity-50`} onClick={() => { setOpen(false); i.onSelect(); }}>{i.icon}{i.label}</button>
          ))}
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
    </>
  );
}
