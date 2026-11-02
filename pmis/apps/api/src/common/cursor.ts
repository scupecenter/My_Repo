import { problems } from './problem';

export function encodeCursor(parts: string[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined, arity: number): string[] | null {
  if (!cursor) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === arity && v.every((x) => typeof x === 'string')) return v as string[];
  } catch {
    /* fall through */
  }
  throw problems.badRequest('The cursor is not valid.');
}

export function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === '') return 50;
  const n = typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw problems.validation([{ path: '/limit', code: 'invalid', message: 'limit is an integer from 1 to 200.' }]);
  }
  return n;
}

export function likePattern(q: string): string {
  return '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A cursor whose parts have the shape the keyset query casts them to (`ts` instant, `date`, `uuid`); anything else is 400, never a database error. */
export function decodeTypedCursor(cursor: string | undefined, kinds: ('ts' | 'date' | 'uuid')[]): string[] | null {
  const parts = decodeCursor(cursor, kinds.length);
  if (!parts) return null;
  const ok = parts.every((p, i) => {
    const k = kinds[i];
    return k === 'ts' ? TS_RE.test(p) && !Number.isNaN(Date.parse(p)) : k === 'date' ? DATE_RE.test(p) && !Number.isNaN(Date.parse(`${p}T00:00:00Z`)) : UUID_RE.test(p);
  });
  if (!ok) throw problems.badRequest('The cursor is not valid.');
  return parts;
}
