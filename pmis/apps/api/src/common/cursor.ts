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
