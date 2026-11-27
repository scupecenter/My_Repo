import { describe, expect, it } from "vitest";
import {
  ptwCheckGaps,
  PTW_CHECK_KEYS,
  AGE_BUCKETS,
  ageBucket,
  bucketAges,
  receivePct,
  scorecardSummary,
  ScorecardItem,
} from "../src/dashboard/dashboard-ops.rules";

describe("dashboard ops: PR/PO aging buckets (0.15.98)", () => {
  it("the buckets are 0-7, 8-14, 15-30 and over 30 calendar days, in order", () => {
    expect(AGE_BUCKETS.map((b) => b.key)).toEqual([
      "d0_7",
      "d8_14",
      "d15_30",
      "over_30",
    ]);
    expect(ageBucket(0)).toBe("d0_7");
    expect(ageBucket(7)).toBe("d0_7");
    expect(ageBucket(8)).toBe("d8_14");
    expect(ageBucket(14)).toBe("d8_14");
    expect(ageBucket(15)).toBe("d15_30");
    expect(ageBucket(30)).toBe("d15_30");
    expect(ageBucket(31)).toBe("over_30");
    expect(ageBucket(400)).toBe("over_30");
  });

  it("a negative or non-finite age (a future or broken date) is not counted", () => {
    expect(ageBucket(-1)).toBeNull();
    expect(ageBucket(Number.NaN)).toBeNull();
    expect(ageBucket(Infinity)).toBeNull();
  });

  it("bucketAges lists every bucket once, with the total and the oldest age", () => {
    const r = bucketAges([1, 3, 9, 9, 20, 45, -2]);
    expect(r.buckets).toEqual([
      { key: "d0_7", count: 2 },
      { key: "d8_14", count: 2 },
      { key: "d15_30", count: 1 },
      { key: "over_30", count: 1 },
    ]);
    expect(r.total).toBe(6);
    expect(r.oldest_days).toBe(45);
    expect(bucketAges([])).toEqual({
      buckets: [
        { key: "d0_7", count: 0 },
        { key: "d8_14", count: 0 },
        { key: "d15_30", count: 0 },
        { key: "over_30", count: 0 },
      ],
      total: 0,
      oldest_days: null,
    });
  });
});

describe("dashboard ops: the materials receive rate (0.15.98)", () => {
  it("is dispatched against required, one decimal; nothing required gives null", () => {
    expect(receivePct(10, 5)).toBe(50);
    expect(receivePct(3, 1)).toBe(33.3);
    expect(receivePct(0, 5)).toBeNull();
  });

  it("is capped at 100% and never negative", () => {
    expect(receivePct(10, 12)).toBe(100);
    expect(receivePct(10, -4)).toBe(0);
  });
});

describe("dashboard ops: PTW safety-check gaps (0.15.200)", () => {
  it("lists every check that is not Done or N/A, in display order", () => {
    expect(
      ptwCheckGaps({
        jsa_tra: "Done",
        toolbox_talk: "N/A",
        work_at_height: "Pending",
        loto: null,
      }),
    ).toEqual(["work_at_height", "lifting_plan", "loto", "rescue_plan"]);
  });

  it("treats no checks at all as six gaps and a full house as none", () => {
    expect(ptwCheckGaps(null)).toHaveLength(6);
    const full = Object.fromEntries(
      PTW_CHECK_KEYS.map((k) => [k, "Done"]),
    ) as Record<string, unknown>;
    expect(ptwCheckGaps(full)).toEqual([]);
  });
});

describe("dashboard ops: contractor and supplier scorecard (0.15.202)", () => {
  const item = (
    name: string,
    level: "ok" | "amber" | "red" | "insufficient",
    delay_days: number,
    snags: { total: number; open: number; overdue: number; returned: number },
    quality: { total: number; failed: number },
  ): ScorecardItem => ({
    party_id: name,
    name,
    type: "contractor",
    delay_days,
    issues_open: 0,
    snags,
    quality,
    level,
  });

  it("counts the levels, averages the delay over the delayed parties only, and keeps the report order for the worst five", () => {
    const items = [
      item("A", "red", 20, { total: 10, open: 4, overdue: 4, returned: 1 }, { total: 8, failed: 2 }),
      item("B", "amber", 10, { total: 10, open: 3, overdue: 2, returned: 0 }, { total: 6, failed: 0 }),
      item("C", "ok", 0, { total: 5, open: 1, overdue: 0, returned: 0 }, { total: 4, failed: 0 }),
      item("D", "insufficient", 0, { total: 0, open: 0, overdue: 0, returned: 0 }, { total: 0, failed: 0 }),
      item("E", "ok", 0, { total: 0, open: 0, overdue: 0, returned: 0 }, { total: 2, failed: 0 }),
      item("F", "ok", 0, { total: 0, open: 0, overdue: 0, returned: 0 }, { total: 0, failed: 0 }),
    ];
    const s = scorecardSummary(items);
    expect(s.parties).toBe(6);
    expect(s.by_level).toEqual({ ok: 3, amber: 1, red: 1, insufficient: 1 });
    expect(s.avg_delay_days).toBe(15);
    expect(s.on_time_pct).toBe(76);
    expect(s.quality_fail_pct).toBe(10);
    expect(s.snags).toEqual({ total: 25, open: 8, overdue: 6, returned: 1 });
    expect(s.quality).toEqual({ total: 20, failed: 2 });
    expect(s.worst.map((w) => w.name)).toEqual(["A", "B", "C", "D", "E"]);
    expect(s.worst[0]).toEqual({
      party_id: "A", name: "A", type: "contractor", level: "red",
      delay_days: 20, snags_overdue: 4, quality_failed: 2,
    });
  });

  it("answers nulls, not zeros, when there is nothing to average or divide", () => {
    const s = scorecardSummary([]);
    expect(s.parties).toBe(0);
    expect(s.avg_delay_days).toBeNull();
    expect(s.on_time_pct).toBeNull();
    expect(s.quality_fail_pct).toBeNull();
    expect(s.worst).toEqual([]);
  });

  it("rounds the rates to one decimal", () => {
    const s = scorecardSummary([
      item("A", "ok", 0, { total: 3, open: 0, overdue: 1, returned: 0 }, { total: 3, failed: 1 }),
    ]);
    expect(s.on_time_pct).toBe(66.7);
    expect(s.quality_fail_pct).toBe(33.3);
  });
});
