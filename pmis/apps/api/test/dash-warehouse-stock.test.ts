import type { NestExpressApplication } from "@nestjs/platform-express";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, superDb } from "./helpers";
import { G } from "./reg-helpers";
import { actor, plainAdmin } from "./wf-helpers";

/** Dashboard warehouse stock card (contract 0.15.593, migration 0716): per item group received, issued, returned (period) and on hand, available (today). */
let app: NestExpressApplication;
let db: PgClient;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe("dashboard warehouse stock (contract 0.15.593)", () => {
  it("returns the groups with the totals, agrees with Warehouse > Stock on hand, validates the period and needs both rights", async () => {
    const admin = await plainAdmin(app, db);
    const r = await admin.api.call("get", "/dashboard/warehouse-stock");
    expect(r.status).toBe(200);
    expect(r.body.from <= r.body.to).toBe(true);
    const groups = r.body.groups as { group: string; on_hand: number; reserved: number; available: number; received: number; issued: number; returned: number; by_region: unknown[] }[];
    for (const g of groups) {
      expect(g.available).toBeCloseTo(g.on_hand - g.reserved, 3);
      expect(g.received).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(g.by_region)).toBe(true);
    }
    expect(r.body.totals.on_hand).toBeCloseTo(groups.reduce((n, g) => n + g.on_hand, 0), 3);
    expect(r.body.totals.issued).toBeCloseTo(groups.reduce((n, g) => n + g.issued, 0), 3);
    // on hand is today's figure: the period never changes it
    const wide = await admin.api.call("get", "/dashboard/warehouse-stock?from=2000-01-01&to=2100-01-01");
    expect(wide.status).toBe(200);
    expect(wide.body.totals.on_hand).toBeCloseTo(r.body.totals.on_hand, 3);
    expect(wide.body.totals.received).toBeGreaterThanOrEqual(r.body.totals.received);
    // the same stock as Warehouse > Stock (central, all items)
    const stock = await admin.api.call("get", "/warehouse/stock?limit=200");
    if (stock.status === 200 && !stock.body.page.next_cursor) {
      const sum = (stock.body.items as { on_hand: number }[]).reduce((n, i) => n + i.on_hand, 0);
      expect(r.body.totals.on_hand).toBeCloseTo(sum, 3);
    }
    const bad = await admin.api.call("get", "/dashboard/warehouse-stock?from=2026-11-10&to=2026-11-01");
    expect(bad.status).toBe(422);
    expect((bad.body.errors as { code: string }[]).map((e) => e.code)).toContain("invalid_range");
    expect((await admin.api.call("get", "/dashboard/warehouse-stock?from=yesterday")).status).toBe(422);
    const onlyDash = await actor(app, db, { level: "entry", grants: G("dashboard", "view"), regions: [7], modules: null });
    expect((await onlyDash.api.call("get", "/dashboard/warehouse-stock")).status).toBe(403);
    const onlyWh = await actor(app, db, { level: "entry", grants: G("warehouse", "view"), regions: [7], modules: null });
    expect((await onlyWh.api.call("get", "/dashboard/warehouse-stock")).status).toBe(403);
  });
});
