import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTyping } from '@/lib/shortcuts';
import { rowFrom, rowsOf, rowText, stepRow } from '@/lib/rowNav';

type Menu = { x: number; y: number; row: HTMLElement } | null;
type Item = { key: string; label: string; run: () => void };

/**
 * Item 4: one place gives every grid (the rows that carry `.gx-row`) a right-click menu and J / K row movement. It only drives the controls the row already has
 * (open, its select box, its link), so what a person may do does not change: a row without a select box has no Select item, a read-only row opens as before.
 * Shift + right-click keeps the browser menu. Typing in a field is never touched. Menu: arrows, Home, End, Enter, Escape; opens inside the screen in both directions.
 */
export function RowActions() {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<Menu>(null);
  const [note, setNote] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || isTyping(e.target) || document.querySelector('[role="dialog"]')) return;
      const k = e.key.toLowerCase();
      if (k !== 'j' && k !== 'k') return;
      const here = rowFrom(document.activeElement);
      const any = document.querySelector<HTMLElement>('.gx-row');
      const next = here ? stepRow(rowsOf(here), here, k === 'j' ? 1 : -1) : any ? stepRow(rowsOf(any), null, k === 'j' ? 1 : -1) : null;
      if (!next) return;
      e.preventDefault();
      if (next.tabIndex < 0 && !next.hasAttribute('tabindex')) next.tabIndex = -1;
      next.focus();
      next.scrollIntoView?.({ block: 'nearest' });
    };
    const onCtx = (e: MouseEvent) => {
      if (e.shiftKey) return;
      const tg = e.target as Element | null;
      if (tg?.closest('input,textarea,select,[contenteditable="true"]')) return;
      const row = rowFrom(tg);
      if (!row) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, row });
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('contextmenu', onCtx);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('contextmenu', onCtx); };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) close(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [menu]);

  const items: Item[] = [];
  if (menu) {
    const { row } = menu;
    const pick = row.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:disabled)');
    const link = row.querySelector<HTMLAnchorElement>('a[href]');
    items.push({ key: 'open', label: t('rowActions.open'), run: () => row.click() });
    if (link) items.push({ key: 'tab', label: t('rowActions.open_tab'), run: () => window.open(link.href, '_blank', 'noopener') });
    if (pick) items.push({ key: 'select', label: pick.checked ? t('rowActions.unselect') : t('rowActions.select'), run: () => pick.click() });
    items.push({ key: 'copy', label: t('rowActions.copy'), run: () => { void navigator.clipboard?.writeText(rowText(row)).then(() => setNote(t('rowActions.copied'))); } });
  }
  useEffect(() => { if (!note) return; const id = window.setTimeout(() => setNote(''), 1800); return () => window.clearTimeout(id); }, [note]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const els = Array.from(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = els.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { e.preventDefault(); els[(i + els.length) % els.length]?.focus(); };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(els.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); const r = menu?.row; setMenu(null); r?.focus(); }
    else if (e.key === 'Tab') setMenu(null);
  };

  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
  const W = 224;
  const left = menu ? Math.max(8, Math.min(menu.x - (rtl ? W : 0), window.innerWidth - W - 8)) : 0;
  const top = menu ? Math.max(8, Math.min(menu.y, window.innerHeight - (items.length * 36 + 16) - 8)) : 0;
  return (
    <>
      {menu && (
        <div ref={box} role="menu" aria-label={t('rowActions.label')} data-testid="row-menu" onKeyDown={onMenuKey}
          style={{ position: 'fixed', left, top, width: W }} className="card motion-pop z-50 p-1 shadow-lg">
          {items.map((it) => (
            <button key={it.key} type="button" role="menuitem" data-testid={`row-menu-${it.key}`}
              className="block w-full rounded px-3 py-2 text-start text-sm hover:bg-accentSoft focus:bg-accentSoft focus:outline-none"
              onClick={() => { const r = menu.row; setMenu(null); it.run(); if (it.key === 'select') r.focus(); }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
      <div role="status" aria-live="polite" className="sr-only" data-testid="row-menu-note">{note}</div>
    </>
  );
}
