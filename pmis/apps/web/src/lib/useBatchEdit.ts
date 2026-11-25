import { useCallback, useEffect, useRef, useState } from 'react';
import { discardDraft, getDraft, saveDraft } from '@/api/views';
import { batchKey, countChanges, dropRecord, emptyBatch, readBatch, setChange, type BatchDraft } from '@/lib/batchDraft';
import type { BatchResult } from '@/components/BatchEditBar';

/**
 * State of the batch edit of one register: the draft, its copy in the per-user draft store (restored on open, written 700 ms after the last edit,
 * removed when empty), the warning when the page is left with edits waiting, and the partial save. `save` is the register's own record update.
 */
export function useBatchEdit<R extends { id: string; version: number }>(register: string, enabled: boolean, onRestored: () => void) {
  const key = batchKey(register);
  const [on, setOn] = useState(false);
  const [draft, setDraft] = useState<BatchDraft>(emptyBatch());
  const [results, setResults] = useState<BatchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const base = useRef<number | null>(null);
  const loaded = useRef(false);
  const n = countChanges(draft);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void getDraft(key).then((d) => {
      if (!alive) return;
      loaded.current = true;
      if (!d) return;
      base.current = d.version;
      const b = readBatch(d.payload);
      if (b && countChanges(b) > 0) { setDraft(b); setOn(true); onRestored(); } else void discardDraft(key).catch(() => undefined);
    }).catch(() => { loaded.current = true; });
    return () => { alive = false; };
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!loaded.current) return;
    const h = setTimeout(() => {
      if (n === 0) { if (base.current !== null) { base.current = null; void discardDraft(key).catch(() => undefined); } return; }
      void saveDraft(key, draft as unknown as Record<string, unknown>, base.current).then((d) => { base.current = d.version; }).catch(() => undefined);
    }, 700);
    return () => clearTimeout(h);
  }, [draft, n, key]);

  useEffect(() => {
    if (n === 0) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [n]);

  const edit = useCallback((r: R, label: string, code: string, from: unknown, to: unknown) => setDraft((d) => setChange(d, r.id, r.version, label, code, from, to)), []);
  const discard = useCallback(() => { setDraft(emptyBatch()); setResults([]); }, []);

  /** Saves the records one at a time with the version the edit started from; a record that moved on is a conflict and stays in the draft. */
  const saveAll = useCallback(async (current: (id: string) => R | undefined, save: (r: R, data: Record<string, unknown>) => Promise<unknown>, errorText: (e: unknown) => string) => {
    setBusy(true);
    const out: BatchResult[] = [];
    let d = draft;
    for (const [id, rec] of Object.entries(draft.changes)) {
      const live = current(id);
      if (!live || live.version !== rec.version) { out.push({ id, label: rec.label, status: 'conflict' }); continue; }
      try {
        await save(live, Object.fromEntries(Object.entries(rec.set).map(([c, v]) => [c, v.to ?? null])));
        d = dropRecord(d, id);
        out.push({ id, label: rec.label, status: 'saved' });
      } catch (e) { out.push({ id, label: rec.label, status: 'failed', message: errorText(e) }); }
    }
    setDraft(d); setResults(out); setBusy(false);
    return out;
  }, [draft]);

  return { on, setOn, draft, n, edit, discard, results, busy, saveAll };
}
