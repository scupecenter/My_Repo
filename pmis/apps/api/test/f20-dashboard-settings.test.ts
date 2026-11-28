import type { NestExpressApplication } from "@nestjs/platform-express";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { q } from "./calc-helpers";
import { startApp, superDb } from "./helpers";
import { team, type Team } from "./reg-helpers";
import { plainAdmin } from "./wf-helpers";

/**
 * F20 (contract 0.15.24, migration 0108): the global dashboard settings. Reads need dashboard.view; the write needs admin.settings edit for all regions,
 * a reason, If-Match, and is audited. The rules (known KPI codes, green better than amber, known card codes, no duplicates) are checked by the database.
 * Uses its own database (TEST_DB_NAME=f20_settings_test, set by the run command), so no other suite sees its changes.
 */
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

const codesOf = (body: {
  errors?: { code: string; path?: string }[];
}): string[] => (body.errors ?? []).map((e) => `${e.path}:${e.code}`).sort();

describe("F20 dashboard settings (contract 0.15.24)", () => {
  it("reads the seed with the catalogue defaults, writes admin-only, validates, versions and audits", async () => {
    const admin = await plainAdmin(app, db);
    const g: Team = await team(app, db, "gecol", "gecol", 7);

    const cur = await admin.api.call("get", "/settings/dashboard");
    expect(cur.status).toBe(200);
    expect(cur.body.targets).toEqual({
      sites_per_batch: null,
      monthly_on_air: null,
    });
    expect(cur.body.thresholds.sla_breach).toEqual({ green: 5, amber: 10 });
    expect(cur.body.thresholds.vehicle_ready).toEqual({ green: 90, amber: 75 });
    expect(cur.body.tabs.pmo).toEqual({ order: [], hidden: [] });
    const kpis = (cur.body.catalogue.kpis as { code: string }[]).map(
      (k) => k.code,
    );
    expect(kpis).toContain("on_air_vs_target");
    const cards = (cur.body.catalogue.cards as { code: string }[]).map(
      (c) => c.code,
    );
    expect(cards).toEqual(
      expect.arrayContaining(["headline", "sla", "site_map"]),
    );
    const etag = cur.headers.etag as string;

    // a fresh copy of the current values for the body
    const body = (over: Record<string, unknown> = {}) => ({
      reason: "F20 test settings",
      targets: { sites_per_batch: 20, monthly_on_air: 15 },
      thresholds: Object.fromEntries(
        Object.entries(
          cur.body.thresholds as Record<
            string,
            { green: number; amber: number }
          >,
        ),
      ),
      tabs: {
        pmo: { order: ["headline", "sla"], hidden: ["regions"] },
        cw: { order: [], hidden: [] },
        te: { order: [], hidden: [] },
      },
      ...over,
    });

    // only admin.settings edit (for all regions) may write
    expect(
      (
        await g.entry.api.call("put", "/settings/dashboard", body(), {
          "If-Match": etag,
        })
      ).status,
    ).toBe(403);
    // If-Match is required; a stale version is refused
    expect(
      (await admin.api.call("put", "/settings/dashboard", body())).status,
    ).toBe(428);
    expect(
      (
        await admin.api.call("put", "/settings/dashboard", body(), {
          "If-Match": '"999"',
        })
      ).status,
    ).toBe(412);

    // field errors: an unknown KPI, green worse than amber, an unknown card, a card listed twice, an unknown key
    const bad = body({
      thresholds: {
        ...(body().thresholds as object),
        not_a_kpi: { green: 1, amber: 2 },
        sla_breach: { green: 12, amber: 10 },
      },
      tabs: {
        pmo: { order: ["headline", "headline", "nope"], hidden: [] },
        cw: { order: [], hidden: [] },
        te: { order: [], hidden: [] },
      },
    });
    const r422 = await admin.api.call("put", "/settings/dashboard", bad, {
      "If-Match": etag,
    });
    expect(r422.status).toBe(422);
    expect(codesOf(r422.body)).toEqual(
      expect.arrayContaining([
        "/thresholds/not_a_kpi:unknown_kpi",
        "/thresholds/sla_breach:invalid_order",
        "/tabs/pmo/order:duplicate",
        "/tabs/pmo/order:unknown_card",
      ]),
    );
    // a key the contract does not know is refused before the database (zod strict)
    expect(
      (
        await admin.api.call(
          "put",
          "/settings/dashboard",
          { ...body(), extra: 1 },
          { "If-Match": etag },
        )
      ).status,
    ).toBe(422);

    // a KPI without a threshold is refused
    const { on_air_vs_target: _drop, ...partial } = body().thresholds as Record<
      string,
      unknown
    >;
    expect(_drop).toBeDefined();
    const missing = await admin.api.call(
      "put",
      "/settings/dashboard",
      body({ thresholds: partial }),
      { "If-Match": etag },
    );
    expect(missing.status).toBe(422);
    expect(codesOf(missing.body)).toContain(
      "/thresholds/on_air_vs_target:missing_kpi",
    );

    try {
      const ok = await admin.api.call("put", "/settings/dashboard", body(), {
        "If-Match": etag,
      });
      expect(ok.status).toBe(200);
      expect(ok.body.version).toBe(cur.body.version + 1);
      expect(ok.body.targets).toEqual({
        sites_per_batch: 20,
        monthly_on_air: 15,
      });
      expect(ok.body.tabs.pmo).toEqual({
        order: ["headline", "sla"],
        hidden: ["regions"],
      });
      // the old version is now stale
      expect(
        (
          await admin.api.call("put", "/settings/dashboard", body(), {
            "If-Match": etag,
          })
        ).status,
      ).toBe(412);
      const au = await q(
        db,
        `SELECT 1 FROM audit_log WHERE action = 'dashboard_settings_update' AND entity_id = 'dashboard.settings'`,
      );
      expect(au.length).toBeGreaterThan(0);
    } finally {
      const now = await admin.api.call("get", "/settings/dashboard");
      await admin.api.call(
        "put",
        "/settings/dashboard",
        {
          reason: "test reset to the default",
          targets: { sites_per_batch: null, monthly_on_air: null },
          thresholds: cur.body.thresholds,
          tabs: {
            pmo: { order: [], hidden: [] },
            cw: { order: [], hidden: [] },
            te: { order: [], hidden: [] },
          },
        },
        { "If-Match": now.headers.etag as string },
      );
    }
  });

  it("health index bands (contract 0.15.435): reads the default, admin-only write, order and range rules, version, audit, history untouched", async () => {
    const admin = await plainAdmin(app, db);
    const g: Team = await team(app, db, "gecol", "gecol", 7);
    const cur = await admin.api.call("get", "/settings/dashboard/health-bands");
    expect(cur.status).toBe(200);
    expect(cur.body.green).toBe(85);
    expect(cur.body.amber).toBe(70);
    const v0 = cur.body.version as number;
    const etag = cur.headers.etag as string;
    const put = (b: object, h: Record<string, string> = { "If-Match": etag }) =>
      admin.api.call("put", "/settings/dashboard/health-bands", b, h);
    const ok = { green: 90, amber: 75, reason: "Owner raised the bands" };

    // a reader without admin.settings edit may read but not write
    expect((await g.entry.api.call("put", "/settings/dashboard/health-bands", ok, { "If-Match": etag })).status).toBe(403);
    // If-Match is required; a stale version is refused
    expect((await admin.api.call("put", "/settings/dashboard/health-bands", ok)).status).toBe(428);
    expect((await put(ok, { "If-Match": '"999"' })).status).toBe(412);
    // green must be above amber; ranges; a key the contract does not know is refused before the database
    const order = await put({ green: 70, amber: 70, reason: "Order test" });
    expect(order.status).toBe(422);
    expect(codesOf(order.body)).toContain("/green:invalid_order");
    expect((await put({ green: 101, amber: 70, reason: "Range test" })).status).toBe(422);
    expect((await put({ green: 90, amber: -1, reason: "Range test" })).status).toBe(422);
    expect((await put({ green: 90, amber: 75, reason: "Extra key", other: 1 })).status).toBe(422);
    expect((await put({ green: 90, amber: 75, reason: "" })).status).toBe(422);

    const snapBefore = await q(db, `SELECT count(*)::int AS n FROM site_snapshots`);
    try {
      const saved = await put(ok);
      expect(saved.status).toBe(200);
      expect(saved.body.green).toBe(90);
      expect(saved.body.amber).toBe(75);
      expect(saved.body.version).toBe(v0 + 1);
      // the same version cannot be used twice
      expect((await put(ok)).status).toBe(412);
      const au = await q(db, `SELECT 1 FROM audit_log WHERE action = 'health_bands_update' AND entity_id = 'dashboard.health_bands'`);
      expect(au.length).toBeGreaterThan(0);
      // the stored history is not rewritten
      const snapAfter = await q(db, `SELECT count(*)::int AS n FROM site_snapshots`);
      expect(snapAfter[0]!.n).toBe(snapBefore[0]!.n);
    } finally {
      const now = await admin.api.call("get", "/settings/dashboard/health-bands");
      await admin.api.call("put", "/settings/dashboard/health-bands", { green: 85, amber: 70, reason: "test reset to the default" }, { "If-Match": now.headers.etag as string });
    }
  });

  it("weekly snapshot day (contract 0.15.430): reads the default Thursday, admin-only write, range rule, audit, stored snapshots untouched", async () => {
    const admin = await plainAdmin(app, db);
    const g: Team = await team(app, db, "gecol", "gecol", 7);
    const cur = await admin.api.call("get", "/settings/dashboard/snapshot-schedule");
    expect(cur.status).toBe(200);
    expect(cur.body.weekday).toBe(4);
    const etag = cur.headers.etag as string;
    const put = (b: object, h: Record<string, string> = { "If-Match": etag }) =>
      admin.api.call("put", "/settings/dashboard/snapshot-schedule", b, h);
    const ok = { weekday: 0, reason: "Owner moved the snapshot to Sunday" };

    expect((await g.entry.api.call("put", "/settings/dashboard/snapshot-schedule", ok, { "If-Match": etag })).status).toBe(403);
    expect((await admin.api.call("put", "/settings/dashboard/snapshot-schedule", ok)).status).toBe(428);
    expect((await put(ok, { "If-Match": '"999"' })).status).toBe(412);
    const bad = await put({ weekday: 7, reason: "Range test" });
    expect(bad.status).toBe(422);
    expect(codesOf(bad.body).some((c) => c.startsWith("/weekday:"))).toBe(true);
    expect((await put({ weekday: -1, reason: "Range test" })).status).toBe(422);
    expect((await put({ weekday: 1.5, reason: "Range test" })).status).toBe(422);
    expect((await put({ weekday: 0, reason: "Extra key", every_days: 3 })).status).toBe(422);
    expect((await put({ weekday: 0, reason: "" })).status).toBe(422);

    const snapBefore = await q(db, `SELECT count(*)::int AS n FROM site_snapshots`);
    try {
      const saved = await put(ok);
      expect(saved.status).toBe(200);
      expect(saved.body.weekday).toBe(0);
      expect(saved.body.version).toBeGreaterThan(0);
      // the job reads the same setting
      const v = await q<{ v: unknown }>(db, `SELECT value AS v FROM settings WHERE key = 'dashboard.snapshot_weekday'`);
      expect(v[0]!.v).toBe(0);
      const au = await q(db, `SELECT 1 FROM audit_log WHERE action = 'snapshot_weekday_update' AND entity_id = 'dashboard.snapshot_weekday'`);
      expect(au.length).toBeGreaterThan(0);
      const snapAfter = await q(db, `SELECT count(*)::int AS n FROM site_snapshots`);
      expect(snapAfter[0]!.n).toBe(snapBefore[0]!.n);
    } finally {
      const now = await admin.api.call("get", "/settings/dashboard/snapshot-schedule");
      await admin.api.call("put", "/settings/dashboard/snapshot-schedule", { weekday: 4, reason: "test reset to the default" }, { "If-Match": now.headers.etag as string });
    }
  });
});
