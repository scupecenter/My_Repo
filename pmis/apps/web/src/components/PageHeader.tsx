import type { ReactNode } from 'react';

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
