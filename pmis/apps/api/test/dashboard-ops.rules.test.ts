import { describe, expect, it } from "vitest";
import {
  ptwCheckGaps,
  PTW_CHECK_KEYS,
  AGE_BUCKETS,
  ageBucket,
  bucketAges,
  receivePct,
  scorecardSummary,
  compareContractors,
  approvalsByRole,
  changesSummary,
  actionsSummary,
  financeSummary,
  firstPassPct,
  meanDays,
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

describe("item 6 rules: quality (0.15.203)", () => {
  it("meanDays averages to one decimal and is null on an empty list", () => {
    expect(meanDays([])).toBeNull();
    expect(meanDays([4])).toBe(4);
    expect(meanDays([1, 2])).toBe(1.5);
    expect(meanDays([1, 2, 2])).toBe(1.7);
  });

  it("firstPassPct is Pass over Pass + Fail, one decimal, null when nothing is decided", () => {
    expect(firstPassPct(0, 0)).toBeNull();
    expect(firstPassPct(9, 1)).toBe(90);
    expect(firstPassPct(1, 2)).toBe(33.3);
    expect(firstPassPct(3, 0)).toBe(100);
  });
});

describe("item 7 rules: pending approvals by role (0.15.204)", () => {
  const row = (role_id: string | null, days: number, state: string, name_en = "PM") => ({
    role_id,
    name_en: role_id ? name_en : null,
    name_ar: null,
    days,
    state,
  });

  it("groups the waiting tasks by role, most waiting first, and counts the unassigned", () => {
    const r = approvalsByRole([
      row("r1", 3, "in_review", "PM"),
      row("r1", 40, "in_approval", "PM"),
      row("r2", 9, "in_review", "QC"),
      row(null, 20, "in_review"),
    ]);
    expect(r.total).toBe(4);
    expect(r.review).toBe(3);
    expect(r.approve).toBe(1);
    expect(r.unassigned).toBe(1);
    expect(r.by_role.map((x) => x.role_id)).toEqual(["r1", "r2"]);
    expect(r.by_role[0]?.count).toBe(2);
    expect(r.by_role[0]?.oldest_days).toBe(40);
    expect(r.by_role[0]?.buckets.find((b) => b.key === "over_30")?.count).toBe(1);
    expect(r.waiting.total).toBe(4);
    expect(r.waiting.oldest_days).toBe(40);
  });

  it("answers an empty shape when nothing waits", () => {
    const r = approvalsByRole([]);
    expect(r.total).toBe(0);
    expect(r.review).toBe(0);
    expect(r.approve).toBe(0);
    expect(r.unassigned).toBe(0);
    expect(r.by_role).toEqual([]);
    expect(r.waiting.total).toBe(0);
    expect(r.waiting.oldest_days).toBeNull();
  });
});

describe("item 8 rules: change requests and meeting actions (0.15.205)", () => {
  it("counts the pending change requests per kind with their ages and the approved ones not yet applied", () => {
    const r = changesSummary([
      { kind: "scope_change", status: "requested", days: 3 },
      { kind: "scope_change", status: "requested", days: 40 },
      { kind: "date_change", status: "requested", days: 10 },
      { kind: "date_change", status: "approved", days: 90 },
      { kind: "other", status: "rejected", days: 5 },
      { kind: "other", status: "applied", days: 5 },
    ]);
    expect(r.pending).toBe(3);
    expect(r.approved_not_applied).toBe(1);
    expect(r.by_kind).toEqual([
      { kind: "scope_change", count: 2 },
      { kind: "date_change", count: 1 },
    ]);
    expect(r.pending_aging.oldest_days).toBe(40);
    expect(r.pending_aging.buckets.find((b) => b.key === "over_30")?.count).toBe(1);
  });

  it("counts the open meeting actions, the overdue ones with their days late, and those without a due date", () => {
    const r = actionsSummary([
      { status: "open", days_overdue: 5 },
      { status: "in_progress", days_overdue: 35 },
      { status: "open", days_overdue: -3 },
      { status: "open", days_overdue: null },
      { status: "closed", days_overdue: 50 },
      { status: "na", days_overdue: 50 },
    ]);
    expect(r.open).toBe(4);
    expect(r.overdue).toBe(2);
    expect(r.no_due_date).toBe(1);
    expect(r.overdue_aging.oldest_days).toBe(35);
  });

  it("answers empty shapes when there is nothing", () => {
    expect(changesSummary([]).pending).toBe(0);
    expect(changesSummary([]).pending_aging.oldest_days).toBeNull();
    expect(actionsSummary([]).overdue).toBe(0);
  });
});

describe("item 9 rules: restricted financial summary (0.15.206)", () => {
  const adv = (over: Partial<Parameters<typeof financeSummary>[0][number]>) => ({
    state: "disbursed",
    approved: 1000,
    disbursed: 800,
    returned: 0,
    days_since_disbursed: 10,
    assignment_id: "a1",
    assignment_done: false,
    amounts_hidden: false,
    ...over,
  });

  it("sums the amounts, ages the open advances and splits the disbursed amount by assignment completion", () => {
    const r = financeSummary([
      adv({}),
      adv({ assignment_id: "a2", assignment_done: true, disbursed: 500, days_since_disbursed: 45 }),
      adv({ state: "settled", assignment_id: "a2", assignment_done: true, disbursed: 200, returned: 50 }),
    ]);
    expect(r.advances).toEqual({ total: 3, open: 2, hidden_amounts: 0 });
    expect(r.amounts).toEqual({ approved: 3000, disbursed: 1500, returned: 50, open_disbursed: 1300 });
    expect(r.open_aging.total).toBe(2);
    expect(r.open_aging.oldest_days).toBe(45);
    expect(r.achievement.assignments).toBe(2);
    expect(r.achievement.completed).toBe(1);
    expect(r.achievement.completion_pct).toBe(50);
    expect(r.achievement.disbursed_on_completed).toBe(700);
    expect(r.achievement.disbursed_on_open_work).toBe(800);
  });

  it("counts a record with hidden amounts but adds no amount of it", () => {
    const r = financeSummary([adv({ amounts_hidden: true, disbursed: 9999 }), adv({})]);
    expect(r.advances.hidden_amounts).toBe(1);
    expect(r.advances.total).toBe(2);
    expect(r.amounts.disbursed).toBe(800);
  });

  it("answers an empty shape and no completion rate without assignments", () => {
    const r = financeSummary([]);
    expect(r.advances.total).toBe(0);
    expect(r.amounts.disbursed).toBe(0);
    expect(r.achievement.completion_pct).toBeNull();
  });
});

describe('compareContractors (0.15.207, item 10)', () => {
  const it1 = (n: string, over: Record<string, unknown> = {}) => ({
    party_id: n, name: n, type: 'contractor', delay_days: 3, issues_open: 0,
    snags: { total: 10, open: 4, overdue: 2, returned: 1 }, quality: { total: 20, failed: 1 }, level: 'amber' as const, ...over,
  });
  it('keeps the report order, shows the figures and no amounts', () => {
    const r = compareContractors([it1('A'), it1('B', { quality: { total: 0, failed: 0 } })]);
    expect(r.map((x) => x.name)).toEqual(['A', 'B']);
    expect(r[0]).toMatchObject({ snags_open: 4, snags_overdue: 2, quality_failed: 1, quality_fail_pct: 5 });
    expect(r[1]?.quality_fail_pct).toBeNull();
    expect(Object.keys(r[0]).some((k) => /amount|value|cost/.test(k))).toBe(false);
  });
  it('is capped at the limit', () => {
    const many = Array.from({ length: 15 }, (_, i) => it1(`P${i}`));
    expect(compareContractors(many)).toHaveLength(10);
    expect(compareContractors(many, 3)).toHaveLength(3);
    expect(compareContractors([])).toEqual([]);
  });
});
