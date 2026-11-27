/**
 * Rollout of new features beside the old way (item 14): a feature that now sits next to an older way to do the same thing shows a small "New" badge for the
 * number of days set in Settings > Screens > Interface, counted from its release date. Add a line here when a feature ships; no server data per feature.
 */
export const NEW_FEATURES = {
  'interface-settings': '2026-11-27',
} as const satisfies Record<string, string>;
export type NewFeatureKey = keyof typeof NEW_FEATURES;

/** Whole days between two YYYY-MM-DD dates (a later `today` gives a positive number). */
export function daysBetween(from: string, today: string): number {
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** True while the badge shows: switched on, released on or before today, and not older than `days`. */
export function isNew(released: string | undefined, today: string, cfg: { enabled: boolean; days: number }): boolean {
  if (!cfg.enabled || !released) return false;
  const age = daysBetween(released, today);
  return age >= 0 && age < cfg.days;
}
