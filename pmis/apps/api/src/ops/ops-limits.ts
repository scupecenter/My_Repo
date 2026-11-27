/**
 * Operational limits (migration 0402, setting ops.limits): the numbers that used to sit in the code. `limit(key)` is synchronous and reads a process cache that
 * OpsLimitsService refreshes from the database (on start, every 30 seconds, and right after a save). Until the first refresh, and when the database cannot be read,
 * the default applies, which is the number the code used before. The same defaults are in ops_limits_catalogue() in SQL; a test compares them.
 */
export const OPS_LIMIT_DEFAULTS = {
  'session.idle_hours': 8,
  'session.absolute_hours': 12,
  'stepup.seconds': 300,
  'assignments.max_rows': 2000,
  'import.max_rows': 2000,
  'master_import.max_rows': 5000,
  'register_import.max_rows': 5000,
  'prefill.max_rows': 5000,
  'prefill.max_sites': 5000,
  'export.max_rows': 100_000,
  'idempotency.max_entries': 5000,
  'login.ip_attempts': 10,
  'login.ip_window_seconds': 900,
  'login.ip_base_seconds': 2,
  'login.ip_max_seconds': 60,
  'login.identifier_attempts': 5,
} as const;

export type OpsLimitKey = keyof typeof OPS_LIMIT_DEFAULTS;

let current: Partial<Record<OpsLimitKey, number>> = {};

/** The installer and tests may still set PMIS_IMPORT_MAX_ROWS; it is the default for import.max_rows until an admin saves a value. */
function defaultFor(key: OpsLimitKey): number {
  if (key === 'import.max_rows') {
    const v = Number(process.env.PMIS_IMPORT_MAX_ROWS);
    if (Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return OPS_LIMIT_DEFAULTS[key];
}

export function limit(key: OpsLimitKey): number {
  return current[key] ?? defaultFor(key);
}

/** Replaces the cache with the values the database returned (`explicit` only: a key that was never set keeps the code default, so the environment override still applies). */
export function applyLimits(values: Record<string, unknown>, explicit: string[]): void {
  const next: Partial<Record<OpsLimitKey, number>> = {};
  for (const k of explicit) {
    const v = values[k];
    if ((k as OpsLimitKey) in OPS_LIMIT_DEFAULTS && typeof v === 'number' && Number.isFinite(v)) next[k as OpsLimitKey] = v;
  }
  current = next;
}

export function resetLimits(): void {
  current = {};
}

/** The sign-in rate-limit numbers (migration 0521). The longest wait is never shorter than the first wait, whatever is stored. */
export function loginLimits(): { perIp: number; windowMs: number; baseSeconds: number; maxSeconds: number; perIdentifier: number } {
  const base = limit('login.ip_base_seconds');
  return { perIp: limit('login.ip_attempts'), windowMs: limit('login.ip_window_seconds') * 1000, baseSeconds: base, maxSeconds: Math.max(limit('login.ip_max_seconds'), base), perIdentifier: limit('login.identifier_attempts') };
}
