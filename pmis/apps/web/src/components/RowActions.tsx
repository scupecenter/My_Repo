import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTyping } from '@/lib/shortcuts';
import { cellOf, ctxControls, linkOf, rowFrom, rowsOf, rowText, stepRow, valueOf, CTX_ACTIONS } from '@/lib/rowNav';

type Menu = { x: number; y: number; row: HTMLElement; from: EventTarget | null } | null;
type Item = { key: string; label: string; run: () => void; keep?: boolean };

/**
 * One standard context menu for every list: grid rows (`.gx-row`), and any card, board item, Gantt bar or file tile that carries `data-ctx`.
 * Beyond open, select and copy it offers Copy link, Copy value (the cell under the pointer), and Edit, Assign, Change status, Duplicate and Delete when the element holds an enabled control marked `data-ctx-action`. Delete asks to confirm. The menu opens from the keyboard with Shift + F10 or the Menu key.
 * Item 4 (earlier): one place gives every grid (the rows that carry `.gx-row`) a right-click menu and J / K row movement. It only drives the controls the row already has
 * (open, its select box, its link), so what a person may do does not change: a row without a select box has no Select item, a read-only row opens as before.
 * Shift + right-click keeps the browser menu. Typing in a field is never touched. Menu: arrows, Home, End, Enter, Escape; opens inside the screen in both directions.
 */
export function RowActions() {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<Menu>(null);
  const [note, setNote] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
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
    const onMenuKeyOpen = (e: KeyboardEvent) => {
      if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) || e.ctrlKey || e.altKey || e.metaKey) return;
      if (isTyping(e.target) || document.querySelector('[role="menu"]')) return;
      const row = rowFrom(document.activeElement);
      if (!row) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      setConfirmDel(false); setMenu({ x: Math.round(r.left + 16), y: Math.round(r.top + r.height / 2), row, from: document.activeElement });
    };
    const onCtx = (e: MouseEvent) => {
      if (e.shiftKey) return;
      const tg = e.target as Element | null;
      if (tg?.closest('input,textarea,select,[contenteditable="true"]')) return;
      const row = rowFrom(tg);
      if (!row) return;
      e.preventDefault();
      setConfirmDel(false); setMenu({ x: e.clientX, y: e.clientY, row, from: tg });
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onMenuKeyOpen);
    window.addEventListener('contextmenu', onCtx);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keydown', onMenuKeyOpen); window.removeEventListener('contextmenu', onCtx); };
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
    const href = linkOf(row);
    const cell = cellOf(row, menu.from);
    const acts = ctxControls(row);
    const openEl = row.querySelector<HTMLElement>('[data-ctx-open]');
    const copy = (text: string, done: string) => { void navigator.clipboard?.writeText(text).then(() => setNote(done)); };
    items.push({ key: 'open', label: t('rowActions.open'), run: () => (openEl ?? row).click() });
    if (href) items.push({ key: 'tab', label: t('rowActions.open_tab'), run: () => window.open(href, '_blank', 'noopener') });
    if (pick) items.push({ key: 'select', label: pick.checked ? t('rowActions.unselect') : t('rowActions.select'), run: () => pick.click() });
    for (const name of CTX_ACTIONS) {
      const el = acts[name];
      if (!el || name === 'delete') continue;
      items.push({ key: name, label: t(`rowActions.act_${name}`), run: () => el.click() });
    }
    if (href) items.push({ key: 'link', label: t('rowActions.copy_link'), run: () => copy(href, t('rowActions.link_copied')) });
    if (cell) items.push({ key: 'value', label: t('rowActions.copy_value'), run: () => copy(valueOf(cell), t('rowActions.value_copied')) });
    items.push({ key: 'copy', label: t('rowActions.copy'), run: () => copy(rowText(row) || valueOf(row), t('rowActions.copied')) });
    const del = acts.delete;
    if (del) items.push(confirmDel
      ? { key: 'delete', label: t('rowActions.confirm_delete'), run: () => del.click() }
      : { key: 'delete', label: t('rowActions.act_delete'), keep: true, run: () => setConfirmDel(true) });
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
              className={`block w-full rounded px-3 py-2 text-start text-sm hover:bg-accentSoft ${it.key === 'delete' ? 'text-lateInk' : ''}  focus:bg-accentSoft focus:outline-none`}
              onClick={() => { if (it.keep) { it.run(); return; } const r = menu.row; setMenu(null); it.run(); if (it.key === 'select') r.focus(); }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
      <div role="status" aria-live="polite" className="sr-only" data-testid="row-menu-note">{note}</div>
    </>
  );
}
