import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The quarantine move of the project data reset in Settings (migration 0146), with the rules of infra/scripts/reset-project-data-quarantine.sh:
 * a stored file of a deleted row is moved (a rename on the same filesystem), never deleted. A key is refused when it is empty, absolute, has an empty, "." or
 * ".." component or does not match the storage key format; when any path component under the store is a symbolic link; when the target is not a regular
 * file; or when its resolved path is not inside the resolved store. A refused or missing key is left where it is and reported, never deleted.
 *
 * The quarantine directory is inside the store (`<STORAGE_DIR>/.pre-reset-<timestamp>`): the API may write only the store (systemd ReadWritePaths, the
 * data root is root 0755), the move stays a rename on one filesystem, and no storage key can name it (a key never starts with a dot).
 */
export const STORAGE_KEY_RE = /^[a-z0-9]+(\/[a-z0-9-]+)+$/;
export const QUARANTINE_PREFIX = '.pre-reset-';

export type FileOutcome = { storage_key: string; outcome: 'moved' | 'missing' | 'refused'; detail: string | null };

const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;

async function lstatOrNull(p: string) {
  try {
    return await fs.lstat(p);
  } catch (e) {
    if (code(e) === 'ENOENT' || code(e) === 'ENOTDIR') return null;
    throw e;
  }
}

/** UTC timestamp of the quarantine name, as the script's date +%Y%m%d-%H%M%S. */
export function quarantineStamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
}

/** The store as it must be: a real directory (not a symbolic link). Returns its resolved path. */
export async function checkStore(store: string): Promise<string> {
  const st = await lstatOrNull(store);
  if (!st) throw new Error(`the document store ${store} does not exist`);
  if (st.isSymbolicLink()) throw new Error(`the document store ${store} is a symbolic link; set STORAGE_DIR to the real directory`);
  if (!st.isDirectory()) throw new Error(`the document store ${store} is not a directory`);
  return fs.realpath(store);
}

/**
 * Makes the quarantine directory (0700, exclusive: it must not exist) inside the store and checks it is a plain directory on the store's filesystem.
 * Returns its absolute path.
 */
export async function makeQuarantine(store: string, stamp = quarantineStamp()): Promise<string> {
  const real = await checkStore(store);
  const dir = join(real, `${QUARANTINE_PREFIX}${stamp}`);
  await fs.mkdir(dir, { mode: 0o700 });
  const [d, s] = await Promise.all([fs.lstat(dir), fs.stat(real)]);
  if (!d.isDirectory() || d.isSymbolicLink()) throw new Error(`${dir} is not a plain directory`);
  if (d.dev !== s.dev) throw new Error(`${dir} is not on the filesystem of the store (a move would be a copy)`);
  return dir;
}

/** Why a key is refused ('' = acceptable), or 'missing'. Mirrors quar_check of the script. */
async function check(storeReal: string, store: string, key: string): Promise<string> {
  if (!key) return 'empty key';
  if (key.startsWith('/')) return 'absolute path';
  if (key.includes('//') || key.endsWith('/')) return 'empty path component';
  const parts = key.split('/');
  if (parts.some((c) => c === '' || c === '.' || c === '..')) return 'empty, . or .. path component';
  if (!STORAGE_KEY_RE.test(key)) return 'not a storage key';
  let p = store;
  for (const c of parts) {
    p = join(p, c);
    const st = await lstatOrNull(p);
    if (st?.isSymbolicLink()) return `symbolic link at ${p.slice(store.length + 1)}`;
    if (!st) return 'missing';
  }
  const st = await fs.lstat(p);
  if (!st.isFile()) return 'not a regular file';
  let real: string;
  try {
    real = await fs.realpath(p);
  } catch {
    return 'cannot resolve';
  }
  if (!real.startsWith(`${storeReal}/`)) return 'resolves outside the store';
  return '';
}

/**
 * Moves each key from the store to the same relative path under the quarantine directory. A key already in the quarantine (a move interrupted before its
 * outcome was recorded) counts as moved. Appends MOVED / MISSING / REFUSED lines to `<quarantine>.manifest` (next to it, inside the store).
 */
export async function quarantineFiles(store: string, qdir: string, keys: string[]): Promise<FileOutcome[]> {
  const storeReal = await checkStore(store);
  const q = resolve(qdir);
  if (dirname(q) !== storeReal || !q.slice(storeReal.length + 1).startsWith(QUARANTINE_PREFIX)) {
    throw new Error(`the quarantine ${qdir} is not a ${QUARANTINE_PREFIX}* directory of the store`);
  }
  const qst = await lstatOrNull(q);
  if (!qst) await fs.mkdir(q, { mode: 0o700 });
  else if (qst.isSymbolicLink() || !qst.isDirectory()) throw new Error(`the quarantine ${qdir} is not a plain directory`);
  const out: FileOutcome[] = [];
  const lines: string[] = [];
  for (const key of keys) {
    let why: string;
    try {
      why = await check(storeReal, storeReal, key);
    } catch (e) {
      why = `cannot check (${code(e) ?? 'error'})`;
    }
    if (why === 'missing') {
      const there = STORAGE_KEY_RE.test(key) ? await lstatOrNull(join(q, key)) : null;
      if (there?.isFile() && !there.isSymbolicLink()) {
        out.push({ storage_key: key, outcome: 'moved', detail: 'found in the quarantine' });
        lines.push(`MOVED ${key}`);
      } else {
        out.push({ storage_key: key, outcome: 'missing', detail: null });
        lines.push(`MISSING ${key}`);
      }
      continue;
    }
    if (why) {
      out.push({ storage_key: key, outcome: 'refused', detail: `${why}: left in place` });
      lines.push(`REFUSED ${key} (${why}): left in place`);
      continue;
    }
    const src = join(storeReal, key);
    const dst = join(q, key);
    try {
      await fs.mkdir(dirname(dst), { recursive: true, mode: 0o700 });
      // never over an existing file (mv -n): the target must not exist
      if (await lstatOrNull(dst)) throw Object.assign(new Error('target exists'), { code: 'EEXIST' });
      await fs.rename(src, dst);
      const [a, b] = await Promise.all([lstatOrNull(dst), lstatOrNull(src)]);
      if (!a?.isFile() || b) throw new Error('not moved');
      out.push({ storage_key: key, outcome: 'moved', detail: null });
      lines.push(`MOVED ${key}`);
    } catch (e) {
      out.push({ storage_key: key, outcome: 'refused', detail: `the move failed (${code(e) ?? 'error'}): left in place` });
      lines.push(`REFUSED ${key} (the move failed): left in place`);
    }
  }
  if (lines.length > 0) await fs.appendFile(`${q}.manifest`, `${lines.join('\n')}\n`, { mode: 0o600 });
  return out;
}
