/**
 * Pure rules of GET /dashboard/ops (contract 0.15.96): the aging buckets of open PR/PO and the materials receive rate.
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
