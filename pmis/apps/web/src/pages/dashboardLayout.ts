/**
 * F20: the card order and visibility of one dashboard tab (contract 0.15.24). The stored layout lists the shown cards in order (`order`) and the hidden
 * ones (`hidden`); a card in neither list is shown at the end, so a card added later appears by default. Pure functions, unit tested.
 */

export interface TabLayout {
  order: string[];
  hidden: string[];
}

export interface CardRow {
  code: string;
  shown: boolean;
}

/** The rows of one tab in display order: shown cards first (as stored, then the unlisted ones), hidden cards last. Unknown codes are dropped. */
export function tabRows(
  layout: TabLayout | undefined,
  cards: string[],
): CardRow[] {
  const order = layout?.order ?? [];
  const hidden = layout?.hidden ?? [];
  const known = (c: string) => cards.includes(c);
  return [
    ...order.filter(known).map((code) => ({ code, shown: true })),
    ...cards
      .filter((c) => !order.includes(c) && !hidden.includes(c))
      .map((code) => ({ code, shown: true })),
    ...hidden
      .filter(known)
      .filter((c) => !order.includes(c))
      .map((code) => ({ code, shown: false })),
  ];
}

/** The stored layout of the rows: every card is listed once, in `order` if shown, in `hidden` otherwise. */
export function toLayout(rows: CardRow[]): TabLayout {
  return {
    order: rows.filter((r) => r.shown).map((r) => r.code),
    hidden: rows.filter((r) => !r.shown).map((r) => r.code),
  };
}

/** Moves the row at `index` one place up (`-1`) or down (`+1`); a move past either end changes nothing. */
export function moveRow(
  rows: CardRow[],
  index: number,
  step: -1 | 1,
): CardRow[] {
  const to = index + step;
  if (index < 0 || index >= rows.length || to < 0 || to >= rows.length)
    return rows;
  const next = [...rows];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** The card codes a tab shows, in display order. */
export function orderedVisible(
  layout: TabLayout | undefined,
  cards: string[],
): string[] {
  return tabRows(layout, cards)
    .filter((r) => r.shown)
    .map((r) => r.code);
}
