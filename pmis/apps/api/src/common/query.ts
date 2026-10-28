import { problems } from './problem';

export type Query = Record<string, unknown>;

/** A single string query value (a repeated parameter is a 422). */
export function oneParam(q: Query, key: string): string | undefined {
  const v = q[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw problems.validation([{ path: `/${key}`, code: 'invalid', message: `${key} must be a single value.` }]);
  return v;
}

export function boolParam(q: Query, key: string): boolean | undefined {
  const v = oneParam(q, key);
  if (v === undefined) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw problems.validation([{ path: `/${key}`, code: 'invalid', message: `${key} is true or false.` }]);
}

/** An instant as text with microseconds (UTC), for keyset cursors: a JS Date would lose the last three digits. */
export const TS_TEXT = (col: string): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
