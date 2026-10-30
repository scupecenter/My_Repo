/**
 * Matrix cells and level counts (owner answer E1, contract 0.4.6).
 *
 * A cell of the Responsibility Matrix is level 1 = Entry, 2 = Review, 3 = Approve, whatever the number of levels of the row.
 * A row with 3 levels uses cells 1, 2 and 3; a row with 2 levels uses cells 1 and 3 (cell 2 is kept but not in use);
 * a row with 1 level uses cell 1 only. The engine reads the cells the same way.
 */
export type CellLevel = 1 | 2 | 3;
export type LevelKind = 'entry' | 'review' | 'approve';

/** Cell levels in use for a row with `n` levels. */
export const usedLevels = (n: number): CellLevel[] => (n <= 1 ? [1] : n === 2 ? [1, 3] : [1, 2, 3]);

/** The cell level of position `p` (1 = first) in a path of `n` levels: the last position is always the Approve cell (3). */
export const cellLevel = (p: number, n: number): CellLevel => (p <= 1 ? 1 : p >= n ? 3 : 2);

/** The kind of a cell level. */
export const levelKind = (level: number): LevelKind => (level === 1 ? 'entry' : level === 2 ? 'review' : 'approve');

/** The kind of position `p` in a path of `n` levels (position 2 of 2 is Approve, not Review). */
export const positionKind = (p: number, n: number): LevelKind => levelKind(cellLevel(p, n));
