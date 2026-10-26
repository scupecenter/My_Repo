import { ApiError } from '@/api/client';
import type { MeT } from './perm';

/** Field-level errors of a 422: `{ '/thresholds/rate_cap_per_hour': 'out_of_range' }`. */
export function fieldErrors(e: unknown): Record<string, string> {
  const list = e instanceof ApiError ? ((e.problem as { errors?: { path: string; code: string }[] }).errors ?? []) : [];
  return Object.fromEntries(list.map((x) => [x.path, x.code]));
}
export type { MeT };
