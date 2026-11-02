/**
 * Matrix cells and the two fixed approval levels (owner decision 2026-11-01, contract 0.6.0, migration 0032).
 *
 * Every row (stage, register, Dismantle) has exactly two levels: L1 = Data Entry and L2 = Data Reviewer & Approver. The number of levels is not configurable.
 * L1 is stored in cell level 1 and L2 in cell level 3 (the engine reads the cells the same way). Cell level 2 is a leftover of the old 3-level model; it is kept
 * only for tasks and records already submitted on a 3-level snapshot (B7) and is never in use for new work.
 * A person (or role or group) can hold L1 only, L2 only, or both; holding both makes a submission the final approval (self-approval, B5).
 */
export type CellLevel = 1 | 2 | 3;
export type LevelKind = 'entry' | 'review' | 'approve';
export type LevelCode = 'L1' | 'L2';

/** The cell level of L1 (Data Entry) and of L2 (Data Reviewer & Approver). */
export const L1_CELL: CellLevel = 1;
export const L2_CELL: CellLevel = 3;
/** The cell levels in use: always L1 and L2. */
export const USED_LEVELS: readonly CellLevel[] = [L1_CELL, L2_CELL];

/** Cell levels in use for a row: always [1, 3]. */
export const usedLevels = (): CellLevel[] => [...USED_LEVELS];

/** L1 for cell level 1, L2 for the others (the middle cell is never in use). */
export const levelCode = (level: number): LevelCode => (level === 1 ? 'L1' : 'L2');

/**
 * The cell level of position `p` (1 = first) in a path of `n` levels: the last position is always the L2 / Approve cell (3).
 * `n` is 2 for everything submitted since migration 0032; 3 (or 1) only for a task or record submitted before and finishing on its frozen snapshot.
 */
export const cellLevel = (p: number, n: number): CellLevel => (p <= 1 ? 1 : p >= n ? 3 : 2);

/** The kind of a cell level. */
export const levelKind = (level: number): LevelKind => (level === 1 ? 'entry' : level === 2 ? 'review' : 'approve');

/** The kind of position `p` in a path of `n` levels (position 2 of 2 is Approve, not Review). */
export const positionKind = (p: number, n: number): LevelKind => levelKind(cellLevel(p, n));
