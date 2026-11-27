import { useSyncExternalStore } from 'react';
import { loadPref, savePref } from './localPref';

/**
 * Item 5: pinned and recently opened records (sites), and "changed since your last visit". Local to the browser like the menu favourites and recent pages
 * (lib/localPref). A record keeps a signature of what the person saw when it was last open; the sidebar compares it with the live record and shows a dot
 * when status, milestone, late or waiting counts, data gaps or locks differ. Nothing here widens access: the sidebar reads the same site endpoint the Site page uses.
 */
export type RecRef = { kind: 'site'; id: string; code: string; name: string; path: string };
type Memory = { pins: RecRef[]; recent: RecRef[]; seen: Record<string, string> };

const K = { pins: 'pmis.records.pins', recent: 'pmis.records.recent', seen: 'pmis.records.seen' };
export const RECENT_RECORDS_MAX = 6;
export const PINNED_RECORDS_MAX = 8;
const SEEN_MAX = 60;

const read = (): Memory => ({ pins: loadPref<RecRef[]>(K.pins, []), recent: loadPref<RecRef[]>(K.recent, []), seen: loadPref<Record<string, string>>(K.seen, {}) });
let mem: Memory = read();
const subs = new Set<() => void>();
const commit = (next: Memory) => {
  mem = next;
  savePref(K.pins, next.pins); savePref(K.recent, next.recent); savePref(K.seen, next.seen);
  subs.forEach((f) => f());
};

/** What the person would notice on a site: change any part and the dot shows. Pure. */
export function siteSignature(s: { overall_status?: string; current_milestone?: string | null; late_task_count?: number; waiting_approval_count?: number; data_gaps?: number; workflow_locks?: boolean }): string {
  return [s.overall_status ?? '', s.current_milestone ?? '', s.late_task_count ?? 0, s.waiting_approval_count ?? 0, s.data_gaps ?? 0, s.workflow_locks === false ? 'u' : 'l'].join('|');
}

/** Open a record: moves it to the top of the recent list and remembers what it looked like. */
export function visitRecord(ref: RecRef, signature: string): void {
  if (mem.seen[ref.id] === signature && mem.recent[0]?.id === ref.id && mem.recent[0].name === ref.name) return;
  const recent = [ref, ...mem.recent.filter((r) => r.id !== ref.id)].slice(0, RECENT_RECORDS_MAX);
  const pins = mem.pins.map((p) => (p.id === ref.id ? ref : p));
  const keep = new Set([...recent, ...pins].map((r) => r.id));
  const seen = Object.fromEntries(Object.entries({ ...mem.seen, [ref.id]: signature }).filter(([k]) => keep.has(k)).slice(-SEEN_MAX));
  commit({ pins, recent, seen });
}

export function togglePinRecord(ref: RecRef, signature: string): void {
  const on = mem.pins.some((p) => p.id === ref.id);
  if (on) return commit({ ...mem, pins: mem.pins.filter((p) => p.id !== ref.id) });
  if (mem.pins.length >= PINNED_RECORDS_MAX) return;
  commit({ ...mem, pins: [...mem.pins, ref], seen: { ...mem.seen, [ref.id]: mem.seen[ref.id] ?? signature } });
}

export function clearRecentRecords(): void { commit({ ...mem, recent: [] }); }

/** Test helper: start from a clean memory. */
export function resetRecordMemory(): void { commit({ pins: [], recent: [], seen: {} }); }

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const useRecordMemory = (): Memory => useSyncExternalStore(subscribe, () => mem);
export const recordChanged = (m: Memory, id: string, live: string): boolean => id in m.seen && m.seen[id] !== live;
