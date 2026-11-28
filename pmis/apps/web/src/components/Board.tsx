import { AlertTriangle } from 'lucide-react';
import type { DragEvent, ReactNode } from 'react';
import type { CardSize } from '@/lib/tablePrefs';

/** V6 (0.15.574): the card size of the board (Display option of the screen): the cell air and the card list's spacing and base text. */
export const CARD_SIZE_CLASS: Record<CardSize, { cell: string; list: string }> = {
  sm: { cell: 'p-0.5', list: 'space-y-0.5 text-xs' },
  md: { cell: 'p-1', list: 'space-y-1 text-sm' },
  lg: { cell: 'p-2', list: 'space-y-2 text-base' },
};

/** A column of a board: its key, its name, the number of cards in it (all of them, not only the cards drawn) and an optional WIP limit. */
export interface BoardColumn { key: string; name: string; count: number; wip?: { limit: number; over: boolean; text: string } | null }
/** A swimlane: its key, its name and its number of cards. With one lane and `lanes` off, no lane title is drawn. */
export interface BoardLane { key: string; name: string; count: number }
/** The cards of one column in one lane, and a link or a button to the rest when the board drew only part of them. */
export interface BoardCell<C> { cards: C[]; more?: ReactNode }

/**
 * The board layout (F5 of contract 0.15.32, shared by Site Master and every register since W2 of plan 2026-11-23-next-ui-cleanup): one column
 * per status, the count in the column header, optional swimlanes, and the cards of each cell. Read only: nothing is dragged, a card opens its
 * record (a site, a register record), so a card moves only through the record's own actions. The screen gives the columns, the lanes, the
 * cells and how a card is drawn.
 */
export function BoardGrid<C>({ columns, lanes, showLanes, cell, card, cardKey, testid, empty, emptyTestid, label, total: totalIn, onDropTo, size = 'md' }: {
  /** Optional: a card dropped on a cell (the column key, the lane key). Without it nothing can be dropped, as before. */
  onDropTo?: (column: string, lane: string, e: DragEvent) => void;
  /** V6: the card size (Display option of the screen, default comfortable) */
  size?: CardSize;
  columns: BoardColumn[];
  /** every card of the board (default: the sum of the column counts) */
  total?: number;
  lanes: BoardLane[];
  /** draw the lane titles (a swimlane is chosen) */
  showLanes: boolean;
  cell: (column: string, lane: string) => BoardCell<C> | undefined;
  card: (c: C) => ReactNode;
  cardKey: (c: C) => string;
  /** the test id of the scroller */
  testid: string;
  /** what an empty board says (no card in any column) */
  empty?: ReactNode;
  emptyTestid: string;
  /** the accessible name of a cell's card list */
  label: (column: BoardColumn, lane: BoardLane) => string;
}) {
  const total = totalIn ?? columns.reduce((n, c) => n + c.count, 0);
  return (
    <div className="overflow-auto" data-testid={testid} data-card-size={size}>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, minmax(220px, 1fr))` }}>
        {columns.map((c) => (
          <div key={c.key} data-testid={`board-col-${c.key}`} data-over-wip={c.wip?.over || undefined}
            className={`sticky top-0 z-10 rounded-md border p-2 text-sm ${c.wip?.over ? 'border-waitInk bg-waitBg' : 'border-line bg-card2'}`}>
            <div className="flex items-center gap-2 font-semibold"><span className="truncate">{c.name}</span><span className="chip ms-auto border border-line" data-testid={`board-col-count-${c.key}`}>{c.count}</span></div>
            {c.wip && (
              <div className={`mt-1 flex items-center gap-1 text-xs ${c.wip.over ? 'text-waitInk' : 'text-mute'}`} data-testid={`board-col-wip-${c.key}`} role={c.wip.over ? 'note' : undefined}>
                {c.wip.over && <AlertTriangle size={12} aria-hidden />}{c.wip.text}
              </div>
            )}
          </div>
        ))}
        {lanes.map((l) => (
          <div key={l.key} className="contents" data-testid={`board-lane-${l.key}`}>
            {showLanes && <h3 className="col-span-full mt-2 border-b border-line pb-1 text-sm font-bold" data-testid={`board-lane-title-${l.key}`}>{l.name} <span className="font-normal text-mute">({l.count})</span></h3>}
            {columns.map((c) => {
              const x = cell(c.key, l.key);
              return (
                <div key={c.key} className={`min-h-12 rounded-md bg-card2/40 ${CARD_SIZE_CLASS[size].cell}`} data-testid={`board-cell-${c.key}-${l.key}`}
                  {...(onDropTo ? { onDragOver: (e: DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }, onDrop: (e: DragEvent) => { e.preventDefault(); onDropTo(c.key, l.key, e); } } : {})}>
                  <ul className={CARD_SIZE_CLASS[size].list} aria-label={label(c, l)}>
                    {x?.cards.map((k) => <li key={cardKey(k)}>{card(k)}</li>)}
                  </ul>
                  {x?.more}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {total === 0 && empty && <p className="p-6 text-center text-mute" data-testid={emptyTestid}>{empty}</p>}
    </div>
  );
}
