/**
 * Pure rules of GET /dashboard/ops (contract 0.15.98): the aging buckets of open PR/PO and the materials receive rate.
 * No database access here, so the buckets and the percentage are unit tested on their own.
 */

export type AgeBucketKey = "d0_7" | "d8_14" | "d15_30" | "over_30";

/** The aging buckets of an open PR or PO (calendar days since its date): 0-7, 8-14, 15-30, over 30. */
export const AGE_BUCKETS: readonly {
  key: AgeBucketKey;
  min: number;
  max: number | null;
}[] = [
  { key: "d0_7", min: 0, max: 7 },
  { key: "d8_14", min: 8, max: 14 },
  { key: "d15_30", min: 15, max: 30 },
  { key: "over_30", min: 31, max: null },
];

/** The bucket of an age in whole calendar days, or null for a negative or non-finite age (a future or broken date is not counted). */
export function ageBucket(days: number): AgeBucketKey | null {
  if (!Number.isFinite(days) || days < 0) return null;
  const b = AGE_BUCKETS.find(
    (x) => days >= x.min && (x.max === null || days <= x.max),
  );
  return b ? b.key : null;
}

export interface AgeBuckets {
  buckets: { key: AgeBucketKey; count: number }[];
  total: number;
  oldest_days: number | null;
}

/** The bucket counts of a list of ages (whole days), every bucket listed once, plus the total and the oldest age. */
export function bucketAges(ages: number[]): AgeBuckets {
  const counts = new Map<AgeBucketKey, number>();
  let oldest: number | null = null;
  for (const a of ages) {
    const k = ageBucket(a);
    if (k === null) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (oldest === null || a > oldest) oldest = a;
  }
  return {
    buckets: AGE_BUCKETS.map((b) => ({
      key: b.key,
      count: counts.get(b.key) ?? 0,
    })),
    total: [...counts.values()].reduce((x, y) => x + y, 0),
    oldest_days: oldest,
  };
}

/** The receive rate: dispatched against required, capped at 100%, one decimal; null when nothing is required. */
export function receivePct(
  required: number,
  dispatched: number,
): number | null {
  if (!(required > 0)) return null;
  const capped = Math.max(0, Math.min(dispatched, required));
  return Math.round((capped * 1000) / required) / 10;
}

// ---------------------------------------------------------------- item 3 (0.15.200): permits and HSE

/** The six PTW safety checks (the permits_hse fields jsa_tra to rescue_plan), in display order. */
export const PTW_CHECK_KEYS = [
  "jsa_tra",
  "toolbox_talk",
  "work_at_height",
  "lifting_plan",
  "loto",
  "rescue_plan",
] as const;
export type PtwCheckKey = (typeof PTW_CHECK_KEYS)[number];

/**
 * The PTW safety checks a permit still misses: a check counts as covered only when its value is "Done" or "N/A";
 * a missing, pending or free value is a gap (the permits form lists exactly these values).
 */
export function ptwCheckGaps(
  checks: Record<string, unknown> | null,
): PtwCheckKey[] {
  return PTW_CHECK_KEYS.filter((k) => {
    const v = checks?.[k];
    return v !== "Done" && v !== "N/A";
  });
}

/** The scorecard levels of the contractor performance report (migration 0180). */
export type ScorecardLevel = "ok" | "amber" | "red" | "insufficient";

/** The report item fields the dashboard scorecard reads (a subset of the contractor performance report item). */
export interface ScorecardItem {
  party_id: string;
  name: string;
  type: string;
  delay_days: number;
  issues_open: number;
  snags: { total: number; open: number; overdue: number; returned: number };
  quality: { total: number; failed: number };
  level: ScorecardLevel;
}

export interface ScorecardSummary {
  parties: number;
  by_level: Record<ScorecardLevel, number>;
  /** The mean delay days over the parties that have any delay, one decimal; null when nobody is delayed. */
  avg_delay_days: number | null;
  /** The share of snags not overdue (the on-time rectification rate), one decimal; null when there are no snags. */
  on_time_pct: number | null;
  /** The share of failed quality inspections (the rejection / NCR rate), one decimal; null when there are no inspections. */
  quality_fail_pct: number | null;
  snags: { total: number; open: number; overdue: number; returned: number };
  quality: { total: number; failed: number };
  /** The five worst parties (the report order is worst first): no amounts, the party and its worst figures only. */
  worst: {
    party_id: string;
    name: string;
    type: string;
    level: ScorecardLevel;
    delay_days: number;
    snags_overdue: number;
    quality_failed: number;
  }[];
}

/**
 * The scorecard section of the dashboard (0.15.202, item 5): the aggregate of the contractor performance report, so
 * the card and the performance screen never disagree. On-time completion, the average delay and the rejection rate,
 * with no amounts anywhere.
 */
export function scorecardSummary(items: ScorecardItem[]): ScorecardSummary {
  const by_level: Record<ScorecardLevel, number> = { ok: 0, amber: 0, red: 0, insufficient: 0 };
  const snags = { total: 0, open: 0, overdue: 0, returned: 0 };
  const quality = { total: 0, failed: 0 };
  let delaySum = 0;
  let delayed = 0;
  for (const it of items) {
    by_level[it.level] += 1;
    snags.total += it.snags.total;
    snags.open += it.snags.open;
    snags.overdue += it.snags.overdue;
    snags.returned += it.snags.returned;
    quality.total += it.quality.total;
    quality.failed += it.quality.failed;
    if (it.delay_days > 0) {
      delaySum += it.delay_days;
      delayed += 1;
    }
  }
  const pct = (part: number, total: number): number | null =>
    total > 0 ? Math.round((part * 1000) / total) / 10 : null;
  return {
    parties: items.length,
    by_level,
    avg_delay_days: delayed > 0 ? Math.round((delaySum * 10) / delayed) / 10 : null,
    on_time_pct: pct(snags.total - snags.overdue, snags.total),
    quality_fail_pct: pct(quality.failed, quality.total),
    snags,
    quality,
    worst: items.slice(0, 5).map((it) => ({
      party_id: it.party_id,
      name: it.name,
      type: it.type,
      level: it.level,
      delay_days: it.delay_days,
      snags_overdue: it.snags.overdue,
      quality_failed: it.quality.failed,
    })),
  };
}

// ---------------------------------------------------------------- item 6 (0.15.203): quality, snags and NCR

/** The mean of a list of day counts, one decimal; null when the list is empty. */
export function meanDays(days: number[]): number | null {
  if (days.length === 0) return null;
  const sum = days.reduce((x, y) => x + y, 0);
  return Math.round((sum / days.length) * 10) / 10;
}

/** The first-time acceptance rate: pass against pass + fail, one decimal; null when nothing is decided. */
export function firstPassPct(pass: number, fail: number): number | null {
  const decided = pass + fail;
  if (!(decided > 0)) return null;
  return Math.round((pass * 1000) / decided) / 10;
}
