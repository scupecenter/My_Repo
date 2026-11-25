/**
 * Batch edit of register records (owner request, P4): the edits of the wide table are collected in a draft instead of being saved one by one. The draft
 * is kept in the per-user draft store (GET/PUT/DELETE /me/drafts/record.batch.<register>, the same limits and row security as every draft: no new write
 * path). Saving goes through the register's own record update, one record at a time, with the version the edit started from: a record that changed in
 * the meantime is a conflict and is left in the draft, never overwritten.
 */
export type BatchChange = { from: unknown; to: unknown };
export type BatchRecord = { version: number; label: string; set: Record<string, BatchChange> };
export type BatchDraft = { v: 1; saved_at: string; changes: Record<string, BatchRecord> };

export const BATCH_TTL_DAYS = 7;
export const BATCH_CONFIRM_ABOVE = 50;
export const batchKey = (register: string) => `record.batch.${register}`;

export const emptyBatch = (): BatchDraft => ({ v: 1, saved_at: new Date().toISOString(), changes: {} });
export const countChanges = (d: BatchDraft) => Object.values(d.changes).reduce((n, r) => n + Object.keys(r.set).length, 0);
export const isExpired = (d: BatchDraft, now = Date.now()) => now - Date.parse(d.saved_at) > BATCH_TTL_DAYS * 86_400_000;

/** Parses a stored payload; anything else (a foreign shape, an expired draft) is no draft. */
export function readBatch(payload: unknown, now = Date.now()): BatchDraft | null {
  const p = payload as Partial<BatchDraft> | null;
  if (!p || p.v !== 1 || typeof p.saved_at !== 'string' || !p.changes || typeof p.changes !== 'object') return null;
  const d: BatchDraft = { v: 1, saved_at: p.saved_at, changes: p.changes };
  return isExpired(d, now) ? null : d;
}

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

/** Adds one edit. Putting the original value back removes the edit, so the draft only holds real changes. */
export function setChange(d: BatchDraft, id: string, version: number, label: string, code: string, from: unknown, to: unknown): BatchDraft {
  const cur = d.changes[id] ?? { version, label, set: {} };
  const prev = cur.set[code];
  const origin = prev ? prev.from : from;
  const set = { ...cur.set };
  if (same(origin, to)) delete set[code]; else set[code] = { from: origin, to };
  const changes = { ...d.changes };
  if (Object.keys(set).length) changes[id] = { ...cur, set }; else delete changes[id];
  return { ...d, saved_at: new Date().toISOString(), changes };
}

export const dropRecord = (d: BatchDraft, id: string): BatchDraft => { const changes = { ...d.changes }; delete changes[id]; return { ...d, changes }; };
