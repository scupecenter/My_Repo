/** Row navigation for every grid (item 4): J and K move between rows, the usual list-navigation keys. Pure helpers, DOM in and out. */

/** The grid a row belongs to: its closest ancestor that holds more than the row itself. */
export function rowsOf(row: HTMLElement): HTMLElement[] {
  const parent = row.parentElement;
  if (!parent) return [row];
  return Array.from(parent.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains('gx-row'));
}

/** The row to focus after `from` in direction `dir` (1 next, -1 previous). Stops at the ends, no wrap. With no current row: first for J, last for K. */
export function stepRow(rows: HTMLElement[], from: HTMLElement | null, dir: 1 | -1): HTMLElement | null {
  if (!rows.length) return null;
  const at = from ? rows.indexOf(from) : -1;
  if (at < 0) return dir === 1 ? rows[0]! : rows[rows.length - 1]!;
  return rows[Math.min(rows.length - 1, Math.max(0, at + dir))] ?? null;
}

/** What the menu attaches to: grid rows, marked cards and bars, table body rows, list items and ARIA rows. Not the navigation, the headers or anything marked `data-no-ctx`. */
export const CTX_TARGET = '.gx-row,[data-ctx],tbody tr,li[data-testid],[role="listitem"],[role="row"]';

function excluded(el: Element): boolean {
  return !!el.closest('nav,header,thead,[data-no-ctx],[role="menu"],[role="menubar"],[role="listbox"],[role="tablist"]') && !el.matches('[data-ctx]');
}

/** The row that holds the focus or the pointer target, if any. */
export function rowFrom(el: EventTarget | null): HTMLElement | null {
  if (!(el instanceof Element)) return null;
  const t = el.closest(CTX_TARGET);
  return t && !excluded(t) ? (t as HTMLElement) : null;
}

/** Plain text of a row, one cell per tab, for "Copy row". */
export function rowText(row: HTMLElement): string {
  const cells = Array.from(row.querySelectorAll<HTMLElement>('[data-col]'));
  const src = cells.length ? cells : Array.from(row.children).filter((c): c is HTMLElement => c instanceof HTMLElement);
  return src.map((c) => (c.textContent ?? '').trim()).filter(Boolean).join('\t');
}

/** The actions a menu may offer, in menu order. An item exists only when the row, card or bar already holds an enabled control marked `data-ctx-action="<name>"`, so rights and locks stay where they are. */
export const CTX_ACTIONS = ['edit', 'assign', 'status', 'duplicate', 'delete'] as const;
export type CtxAction = (typeof CTX_ACTIONS)[number];

/** Enabled controls of a target by action name. A disabled or aria-disabled control gives no item. */
export function ctxControls(target: HTMLElement): Partial<Record<CtxAction, HTMLElement>> {
  const out: Partial<Record<CtxAction, HTMLElement>> = {};
  const live = (el: HTMLElement | null) => !!el && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true' && !el.hidden;
  for (const name of CTX_ACTIONS) {
    const marked = target.querySelector<HTMLElement>(`[data-ctx-action="${name}"]`);
    if (marked) { if (live(marked)) out[name] = marked; continue; }
    // screens that do not mark their controls: a button of the row whose test id names the action
    const found = Array.from(target.querySelectorAll<HTMLElement>('button[data-testid]')).find((b) => NAMED[name].test(b.getAttribute('data-testid') ?? ''));
    if (found && live(found)) out[name] = found;
  }
  return out;
}

const NAMED: Record<CtxAction, RegExp> = {
  edit: /(^|-)(edit|rename)(-|$)/i,
  assign: /(^|-)assign(-|$)/i,
  status: /(^|-)(change-status|set-status|status-change)(-|$)/i,
  duplicate: /(^|-)(duplicate|clone)(-|$)/i,
  delete: /(^|-)(delete|remove|archive)(-|$)/i,
};

/** The cell under the pointer or focus, for "Copy value": the closest marked cell inside the target. */
export function cellOf(target: HTMLElement, from: EventTarget | null): HTMLElement | null {
  if (!(from instanceof Element)) return null;
  const c = from.closest('[data-ctx-value],[data-col],td,th,[role="gridcell"]');
  return c instanceof HTMLElement && target.contains(c) && c !== target ? c : null;
}

/** Absolute link of a target: its own `data-ctx-link` path, else its first link. */
export function linkOf(target: HTMLElement): string | null {
  const own = target.getAttribute('data-ctx-link');
  if (own) return new URL(own, window.location.origin).href;
  const a = target.matches('a[href]') ? (target as HTMLAnchorElement) : target.querySelector<HTMLAnchorElement>('a[href]');
  return a ? a.href : null;
}

/** Text of one cell or of a whole card: `data-ctx-value` wins. */
export function valueOf(el: HTMLElement): string {
  return (el.getAttribute('data-ctx-value') ?? el.textContent ?? '').trim();
}
