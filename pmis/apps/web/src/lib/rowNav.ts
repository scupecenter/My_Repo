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

/** The row that holds the focus or the pointer target, if any. */
export function rowFrom(el: EventTarget | null): HTMLElement | null {
  return el instanceof Element ? (el.closest('.gx-row') as HTMLElement | null) : null;
}

/** Plain text of a row, one cell per tab, for "Copy row". */
export function rowText(row: HTMLElement): string {
  const cells = Array.from(row.querySelectorAll<HTMLElement>('[data-col]'));
  const src = cells.length ? cells : Array.from(row.children).filter((c): c is HTMLElement => c instanceof HTMLElement);
  return src.map((c) => (c.textContent ?? '').trim()).filter(Boolean).join('\t');
}
