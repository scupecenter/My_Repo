import { describe, expect, it } from "vitest";
import {
  ptwCheckGaps,
  PTW_CHECK_KEYS,
  AGE_BUCKETS,
  ageBucket,
  bucketAges,
  receivePct,
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
