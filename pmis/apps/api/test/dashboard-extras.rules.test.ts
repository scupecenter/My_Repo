import { describe, expect, it } from "vitest";
import {
  aggregateGaps,
  buildRiskMatrix,
  decisionTag,
  riskBand,
  riskScore,
  roundDays,
  sharePct,
  sortRisksForTop,
  targetPct,
} from "../src/dashboard/dashboard-extras.rules";

describe("dashboard extras: F20 counter rules (migration 0113)", () => {
  it("the On-Air share is against the monthly target; no target or a zero target gives null", () => {
    expect(targetPct(12, 15)).toBe(80);
    expect(targetPct(3, 2)).toBe(150);
    expect(targetPct(5, null)).toBeNull();
    expect(targetPct(5, 0)).toBeNull();
  });

  it("the time in state is rounded to one decimal; no interval gives null", () => {
    expect(roundDays(12.34)).toBe(12.3);
    expect(roundDays(0)).toBe(0);
    expect(roundDays(null)).toBeNull();
    expect(roundDays(Number.NaN)).toBeNull();
  });

  it("a share with no base is null, so a counter with nothing to count is pending", () => {
    expect(sharePct(1, 0)).toBeNull();
    expect(sharePct(1, 4)).toBe(25);
  });
});

describe("dashboard extras: risk bands (F13 item 3)", () => {
  it("bands follow the owner default: low 1-4, medium 5-9, high 10-16, critical 20-25", () => {
    expect(riskBand(1)).toBe("low");
    expect(riskBand(4)).toBe("low");
    expect(riskBand(5)).toBe("medium");
    expect(riskBand(9)).toBe("medium");
    expect(riskBand(10)).toBe("high");
    expect(riskBand(16)).toBe("high");
    expect(riskBand(20)).toBe("critical");
    expect(riskBand(25)).toBe("critical");
  });

  it("no product of 1 to 5 falls in the gaps (17 to 19 do not occur), and out-of-range scores have no band", () => {
    expect(riskBand(0)).toBeNull();
    expect(riskBand(26)).toBeNull();
    expect(riskBand(17)).toBeNull();
  });

  it("score is probability times impact, and null for values outside 1 to 5 or not whole", () => {
    expect(riskScore(3, 4)).toBe(12);
    expect(riskScore(0, 4)).toBeNull();
    expect(riskScore(6, 1)).toBeNull();
    expect(riskScore(2.5, 2)).toBeNull();
  });

  it("a decision is act now only for high or critical, watch otherwise", () => {
    expect(decisionTag("critical")).toBe("act_now");
    expect(decisionTag("high")).toBe("act_now");
    expect(decisionTag("medium")).toBe("watch");
    expect(decisionTag("low")).toBe("watch");
  });
});

describe("dashboard extras: the 5x5 matrix", () => {
  it("returns 25 cells, counts open risks per cell and leaves out invalid ones", () => {
    const m = buildRiskMatrix([
      { probability: 5, impact: 5 },
      { probability: 5, impact: 5 },
      { probability: 1, impact: 2 },
      { probability: 7, impact: 1 },
    ]);
    expect(m.cells).toHaveLength(25);
    expect(
      m.cells.find((c) => c.probability === 5 && c.impact === 5),
    ).toMatchObject({ score: 25, band: "critical", count: 2 });
    expect(
      m.cells.find((c) => c.probability === 1 && c.impact === 2),
    ).toMatchObject({ score: 2, band: "low", count: 1 });
    expect(m.invalid_total).toBe(1);
    const total = m.cells.reduce((n, c) => n + c.count, 0);
    expect(total).toBe(3);
  });

  it("band totals add up to the counted risks", () => {
    const m = buildRiskMatrix([
      { probability: 2, impact: 2 },
      { probability: 4, impact: 4 },
      { probability: 3, impact: 3 },
    ]);
    expect(m.bands.map((b) => b.count)).toEqual([1, 1, 1, 0]);
  });
});

describe("dashboard extras: top open risks", () => {
  it("sorts by score, highest first, then by code", () => {
    const sorted = sortRisksForTop([
      { risk_code: "R-2", score: 8 },
      { risk_code: "R-1", score: 8 },
      { risk_code: "R-9", score: 20 },
    ]);
    expect(sorted.map((r) => r.risk_code)).toEqual(["R-9", "R-1", "R-2"]);
  });
});

describe("dashboard extras: data quality totals", () => {
  it("counts sites with gaps, the gaps in total and groups them by kind and field", () => {
    const agg = aggregateGaps([
      {
        count: 2,
        items: [
          { kind: "missing_actual_date" },
          { kind: "missing_field", field: "delivery_scenario" },
        ],
      },
      { count: 0, items: [] },
      { count: 1, items: [{ kind: "missing_actual_date" }] },
    ]);
    expect(agg.sites_checked).toBe(3);
    expect(agg.sites_with_gaps).toBe(2);
    expect(agg.gaps_total).toBe(3);
    expect(agg.by_kind[0]).toEqual({
      kind: "missing_actual_date",
      field: null,
      count: 2,
    });
    expect(agg.by_kind[1]).toEqual({
      kind: "missing_field",
      field: "delivery_scenario",
      count: 1,
    });
  });
});
