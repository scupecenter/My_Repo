/**
 * Field mode (contract 0.15.340): the queue of actions a site team did without a connection. Kept on the device in IndexedDB, one database per signed-in
 * user, and wiped on sign-out and on a change of user. Only what the user could already see and did on purpose is stored: a photo they took, a "submit
 * the fix" they pressed. Nothing here is a permission: the server checks the rights again when an action is sent.
 */

export type FieldActionKind = 'snag_photo' | 'snag_submit';
/** waiting: queued, sent on the next sync; attention: the server refused or the world changed, the person decides; done: sent (kept briefly for the list). */
export type FieldActionState = 'waiting' | 'attention' | 'done';

export interface FieldAction {
  /** Client id; also the Idempotency-Key of the request, so a replay after a lost answer returns the first answer. */
  id: string;
  kind: FieldActionKind;
  snagId: string;
  snagLabel: string;
  createdAt: string;
  state: FieldActionState;
  tries: number;
  /** Why it needs attention (a problem code of the server, or one of the client codes below). */
  reason?: string;
  /** Plain text for the person: what the server said. */
  message?: string;
  // photo
  blob?: Blob;
  fileName?: string;
  shotType?: string | null;
  /** The moment the photo was taken on the device, and where (taken at capture, never at sync). */
  capturedAt?: string;
  lat?: number | null;
  lon?: number | null;
  inAppCamera?: boolean;
}

/** Client side reasons of an action that needs attention. */
export const CLIENT_REASONS = ['earlier_failed', 'already_changed', 'photos_missing', 'retries_exhausted', 'too_large'] as const;

/** The last read of a list (my tasks, the snags of a site), kept so the screen still shows it without a connection. */
export interface FieldSnapshot { at: string; data: unknown }

export interface FieldStore {
  getSnapshot(key: string): Promise<FieldSnapshot | null>;
  putSnapshot(key: string, data: unknown, now?: Date): Promise<void>;
  list(): Promise<FieldAction[]>;
  put(a: FieldAction): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

/** In memory: used by the tests and where IndexedDB does not exist. */
export function memoryStore(): FieldStore {
  const m = new Map<string, FieldAction>();
  const snaps = new Map<string, FieldSnapshot>();
  return {
    getSnapshot: async (key) => snaps.get(key) ?? null,
    putSnapshot: async (key, data, now = new Date()) => { snaps.set(key, { at: now.toISOString(), data }); },
    list: async () => [...m.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)),
    put: async (a) => { m.set(a.id, { ...a }); },
    remove: async (id) => { m.delete(id); },
    clear: async () => { m.clear(); snaps.clear(); },
  };
}

const STORE = 'actions';
const SNAP = 'snapshots';

/** IndexedDB store of one user: the database name carries the user id, so two people on one device never see each other's queue. */
export function indexedDbStore(userId: string): FieldStore {
  const name = `gsdn-field-${userId}`;
  let opened: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => (opened ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: 'id' }); r.result.createObjectStore(SNAP, { keyPath: 'key' }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('indexeddb'));
  }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, store: string = STORE): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('indexeddb'));
      tx.onabort = () => reject(tx.error ?? new Error('indexeddb'));
    });
  };
  return {
    getSnapshot: async (key) => {
      const r = (await run('readonly', (st) => st.get(key), SNAP)) as ({ key: string } & FieldSnapshot) | undefined;
      return r ? { at: r.at, data: r.data } : null;
    },
    putSnapshot: async (key, data, now = new Date()) => { await run('readwrite', (st) => st.put({ key, at: now.toISOString(), data }), SNAP); },
    list: async () => ((await run('readonly', (s) => s.getAll())) as FieldAction[]).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)),
    put: async (a) => { await run('readwrite', (s) => s.put(a)); },
    remove: async (id) => { await run('readwrite', (s) => s.delete(id)); },
    clear: async () => { await run('readwrite', (s) => s.clear()); await run('readwrite', (s) => s.clear(), SNAP); },
  };
}

/** Removes every field database of this device (sign-out, change of user). Safe where IndexedDB lists no databases: the current store is cleared by the caller too. */
export async function wipeFieldDatabases(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const dbs = (await (indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }).databases?.().catch(() => [])) ?? [];
  await Promise.all(dbs.filter((d) => d.name?.startsWith('gsdn-field-')).map((d) => new Promise<void>((res) => {
    const r = indexedDB.deleteDatabase(d.name as string);
    r.onsuccess = r.onerror = r.onblocked = () => res();
  })));
}

export const newActionId = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `fa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

export type EnqueueResult = { ok: true; action: FieldAction } | { ok: false; reason: 'queue_full' | 'too_large' };

/** Queues an action when the limits of the setting allow it (the queue size counts what still waits or needs attention; the photo size is the device limit). */
export async function enqueue(store: FieldStore, a: Omit<FieldAction, 'id' | 'createdAt' | 'state' | 'tries'>, limits: { max_queue: number; max_photo_mb: number }, now: () => Date = () => new Date()): Promise<EnqueueResult> {
  const open = (await store.list()).filter((x) => x.state !== 'done').length;
  if (open >= limits.max_queue) return { ok: false, reason: 'queue_full' };
  if (a.blob && a.blob.size > limits.max_photo_mb * 1024 * 1024) return { ok: false, reason: 'too_large' };
  const action: FieldAction = { ...a, id: newActionId(), createdAt: now().toISOString(), state: 'waiting', tries: 0 };
  await store.put(action);
  return { ok: true, action };
}

/** True while a snapshot is younger than the cache hours of the setting (an older one is not shown: stale data is worse than none for a site decision). */
export const snapshotFresh = (s: FieldSnapshot | null, cacheHours: number, now: Date = new Date()): boolean => !!s && now.getTime() - new Date(s.at).getTime() <= cacheHours * 3_600_000;

/** How many actions of this person still wait or need attention on this device (asked before sign-out, which wipes them). */
export async function fieldPendingCount(userId: string | undefined): Promise<number> {
  if (!userId || typeof indexedDB === 'undefined') return 0;
  try { return (await indexedDbStore(userId).list()).filter((a) => a.state !== 'done').length; } catch { return 0; }
}
