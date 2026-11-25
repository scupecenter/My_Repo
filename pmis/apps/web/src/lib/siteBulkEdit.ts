import { ApiError } from '@/api/client';
import type { SiteMasterCellSave } from '@/api/siteMaster';
import type { SiteMasterCellTarget } from '@/components/SiteMasterGrid';

/**
 * Bulk edit of one Site Master column for the selected sites (owner request 2026-11-22, contract 0.15.50). No new right and no new endpoint: every eligible
 * cell is saved by the same call as a single inline edit (PATCH /tasks/{task_id}, If-Match the version), so the rights, the task locks, the gate rules and the
 * validation of the server decide each cell. This file holds the pure parts: the editor kind, the options of a dependent list, the plan (what changes and what
 * is skipped, with the reason) and the runner with a small concurrency.
 */
export type BulkInput = 'date' | 'number' | 'list' | 'text' | 'boolean';
export type BulkValue = string | number | boolean;
export type BulkOption = { value: string; label_en: string; label_ar: string | null; parent?: string | null };

export interface BulkRow { site_id: string; site_code: string; values: Record<string, string | null>; cells?: Record<string, SiteMasterCellTarget> }

/** Why a site is skipped before anything is sent. A missing right is only known to the server, so it shows later as a failure. */
export type SkipReason = 'not_editable' | 'locked' | 'unchanged' | 'not_allowed' | 'already_empty';
export const SKIP_REASONS: SkipReason[] = ['not_editable', 'locked', 'unchanged', 'not_allowed', 'already_empty'];

const isTrue = (x: string) => /^(true|yes|1)$/i.test(x);

/** The editor of a cell: the API's `input_type`, else a date for a date key or a date-shaped value, else text (an older answer without it). */
export function inputKind(target: SiteMasterCellTarget, stored: string): BulkInput {
  if (target.input_type) return target.input_type;
  return target.field || /^\d{4}-\d{2}-\d{2}$/.test(stored) ? 'date' : 'text';
}

/**
 * The options of a list cell for one site. A list of a dependent catalogue (`parent_ord`) offers only the children of the parent value held by the same row;
 * with no parent value yet it offers none. A list without a parent column in the menu offers every option.
 */
export function optionsOf(target: SiteMasterCellTarget, values: Record<string, string | null>): BulkOption[] {
  const all = target.options ?? [];
  if (target.parent_ord === undefined || target.parent_ord === null) return all;
  const parent = values[String(target.parent_ord)] ?? '';
  return parent ? all.filter((o) => o.parent === parent) : [];
}

/** The columns (ord) of the menu that at least one of the rows backs with a task cell, the ones a bulk edit can offer. */
export function editableOrds(rows: BulkRow[], ords: number[]): number[] {
  return ords.filter((ord) => rows.some((r) => r.cells?.[String(ord)]));
}

/** The editor kind of a column over the rows (every row of a column has the same field, so the first cell decides). */
export function columnKind(rows: BulkRow[], ord: number): BulkInput | null {
  for (const r of rows) { const t = r.cells?.[String(ord)]; if (t) return inputKind(t, r.values[String(ord)] ?? ''); }
  return null;
}

/** The options of a list column over the rows: the union of the options of every row, one entry per value, in the order first met. */
export function columnOptions(rows: BulkRow[], ord: number): BulkOption[] {
  const seen = new Map<string, BulkOption>();
  for (const r of rows) {
    const t = r.cells?.[String(ord)];
    if (!t) continue;
    for (const o of t.options ?? []) if (!seen.has(o.value)) seen.set(o.value, o);
  }
  return [...seen.values()];
}

/** True when the dependent list of some row has no parent value yet, so the hint "some sites have no parent value" is useful. */
export function anyMissingParent(rows: BulkRow[], ord: number): boolean {
  return rows.some((r) => { const t = r.cells?.[String(ord)]; return !!t && t.parent_ord !== undefined && t.parent_ord !== null && !(r.values[String(t.parent_ord)] ?? ''); });
}

/** A typed draft to the value that is sent: a number as a JSON number, a yes or no as a boolean, the rest as text. Null when the draft is not usable yet. */
export function toValue(kind: BulkInput, draft: string): BulkValue | null {
  if (draft === '') return null;
  if (kind === 'number') { const n = Number(draft); return Number.isFinite(n) ? n : null; }
  if (kind === 'boolean') return draft === 'true';
  return draft;
}

const same = (kind: BulkInput, stored: string, value: BulkValue): boolean => {
  if (kind === 'boolean') return isTrue(stored) === (value === true);
  if (kind === 'number') return stored !== '' && Number(stored) === value;
  return stored === value;
};

export interface BulkChange { row: BulkRow; target: SiteMasterCellTarget }
export interface BulkPlan { change: BulkChange[]; skipped: { row: BulkRow; reason: SkipReason }[] }

/**
 * What a bulk edit of column `ord` to `value` would do for each row: the cells to save, and the rows that are skipped with the reason. A `null` value clears the
 * cell (0.15.51): a cell that is already empty is skipped (`already_empty`), and the options of a list are not checked. The server decides whether a required field may be empty.
 */
export function planBulk(rows: BulkRow[], ord: number, kind: BulkInput, value: BulkValue | null): BulkPlan {
  const plan: BulkPlan = { change: [], skipped: [] };
  for (const row of rows) {
    const target = row.cells?.[String(ord)];
    if (!target) { plan.skipped.push({ row, reason: 'not_editable' }); continue; }
    if (!target.editable) { plan.skipped.push({ row, reason: 'locked' }); continue; }
    if (value === null) {
      if ((row.values[String(ord)] ?? '') === '') plan.skipped.push({ row, reason: 'already_empty' }); else plan.change.push({ row, target });
      continue;
    }
    if (kind === 'list' && !optionsOf(target, row.values).some((o) => o.value === value)) { plan.skipped.push({ row, reason: 'not_allowed' }); continue; }
    if (same(kind, row.values[String(ord)] ?? '', value)) { plan.skipped.push({ row, reason: 'unchanged' }); continue; }
    plan.change.push({ row, target });
  }
  return plan;
}

export type BulkOutcome = { code: string; status: 'saved' } | { code: string; status: 'failed'; error: unknown; http: number | null };

/**
 * Saves the cells of a plan, `concurrency` at a time (default 4), and reports each outcome in the order of the plan. A failure of one site never stops the
 * others. `save` is the single-cell save path; `onProgress` gets the number of finished cells.
 */
export async function runBulk(
  changes: BulkChange[], value: BulkValue | null, save: (v: SiteMasterCellSave) => Promise<unknown>,
  { concurrency = 4, onProgress }: { concurrency?: number; onProgress?: (done: number) => void } = {},
): Promise<BulkOutcome[]> {
  const out: BulkOutcome[] = new Array(changes.length);
  let next = 0, done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= changes.length) return;
      const { row, target } = changes[i]!;
      try {
        await save({ task_id: target.task_id, version: target.version, field: target.field, values: target.values, value });
        out[i] = { code: row.site_code, status: 'saved' };
      } catch (e) {
        out[i] = { code: row.site_code, status: 'failed', error: e, http: e instanceof ApiError ? e.status : null };
      }
      done += 1;
      onProgress?.(done);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, changes.length)) }, worker));
  return out;
}
