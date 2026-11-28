import { describe, expect, it } from "vitest";
import { invoicesSummary, staleSummary, warehousePending } from "../src/dashboard/dashboard-ops.rules";

describe("L4 dashboard rules", () => {
  it("invoices: late, due soon, no due date and ages", () => {
    const r = invoicesSummary([
      { days_to_due: -3, age_days: 40 },
      { days_to_due: -40, age_days: 80 },
      { days_to_due: 0, age_days: 5 },
      { days_to_due: 7, age_days: 1 },
      { days_to_due: 20, age_days: 2 },
      { days_to_due: null, age_days: null },
    ]);
    expect(r).toMatchObject({ open: 6, overdue: 2, due_soon: 2, no_due_date: 1 });
    expect(r.overdue_aging.oldest_days).toBe(40);
    expect(r.age_aging.total).toBe(5);
  });
  it("warehouse: only entry, review and approval, in flow order", () => {
    const r = warehousePending([
      { state: "in_review", days: 3 },
      { state: "entry", days: 10 },
      { state: "entry", days: null },
      { state: "approved", days: 90 },
    ]);
    expect(r.pending).toBe(3);
    expect(r.by_state).toEqual([{ state: "entry", count: 2 }, { state: "in_review", count: 1 }]);
    expect(r.aging.oldest_days).toBe(10);
  });
  it("stale: 30 days or more, per register", () => {
    const r = staleSummary([
      { register_key: "risks", days_idle: 30 },
      { register_key: "risks", days_idle: 29 },
      { register_key: "issues", days_idle: 100 },
      { register_key: "issues", days_idle: null },
      { register_key: "other", days_idle: 500 },
    ]);
    expect(r.risks).toEqual({ open: 2, stale: 1 });
    expect(r.issues).toEqual({ open: 2, stale: 1 });
    expect(r.idle_aging.total).toBe(2);
  });
});
