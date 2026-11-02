import * as Popover from '@radix-ui/react-popover';
import { Ellipsis } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Tip } from './Tip';

/** Page header (plan T1): title + context chip, optional subtitle, then the page's own tabs go below it. */
export function PageHeader({ title, subtitle, context, testid }: { title: string; subtitle?: string; context?: ReactNode; testid?: string }) {
  return (
    <header className="mb-3" data-testid={testid}>
      <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-bold">{title}</h1>{context}</div>
      {subtitle && <p className="text-mute">{subtitle}</p>}
    </header>
  );
}

/** Toolbar (plan T1/T3/T5), fixed order: filters › active-filter count › count › primary action › secondary tools. Page, row and global actions stay in separate groups. */
export function Toolbar({ filters, activeFilters = 0, count, primary, tools, activeLabel }: { filters?: ReactNode; activeFilters?: number; count?: ReactNode; tools?: ReactNode; primary?: ReactNode; activeLabel?: string }) {
  return (
    <div role="toolbar" className="mb-3 flex flex-wrap items-center gap-2">
      {filters}
      {activeFilters > 0 && <span className="chip bg-accentSoft text-accentText" data-testid="toolbar-active-filters">{activeLabel ?? ''} {activeFilters}</span>}
      <span className="ms-auto flex flex-wrap items-center gap-2">
        {count}
        {primary}
        {tools}
      </span>
    </div>
  );
}

export type MoreItem = { id: string; label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean; testid: string };
/** "More" overflow (plan T3): secondary tools live here; the primary action never does. Items keep their own data-testid. */
export function MoreMenu({ items }: { items: MoreItem[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tip text={t('table.more')}>
        <Popover.Trigger asChild><button type="button" className="btn" data-testid="more-menu" aria-label={t('table.more')}><Ellipsis size={16} /></button></Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} role="menu" className="card z-50 min-w-48 p-1 shadow-lg" data-testid="more-panel">
          {items.map((i) => (
            <button key={i.id} type="button" role="menuitem" disabled={i.disabled} data-testid={i.testid} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-hover disabled:opacity-50" onClick={() => { setOpen(false); i.onSelect(); }}>{i.icon}{i.label}</button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
