import type { NestExpressApplication } from "@nestjs/platform-express";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { q } from "./calc-helpers";
import { startApp, superDb } from "./helpers";
import { team, type Team } from "./reg-helpers";
import { plainAdmin } from "./wf-helpers";

/**
 * Site health score (contract 0.15.591, migration 0714): the list and detail need dashboard.view, the weights are an admin.settings setting with a
 * reason, If-Match and an audit row, the colours come from the existing dashboard.health_bands, and the card is in the dashboard catalogue.
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

const codesOf = (body: { errors?: { code: string; path?: string }[] }): string[] => (body.errors ?? []).map((e) => `${e.path}:${e.code}`).sort();

describe("site health score (contract 0.15.591)", () => {
  it("lists scores with the bands and weights, validates the filters, and 404s an unknown site", async () => {
    const admin = await plainAdmin(app, db);
    const list = await admin.api.call("get", "/dashboard/site-health");
    expect(list.status).toBe(200);
    expect(list.body.bands).toEqual({ green: 85, amber: 70 });
    expect(list.body.weights).toMatchObject({ tasks: 40, docs: 20, snags: 25, delay: 15 });
    expect(list.body.counts).toEqual(expect.objectContaining({ green: expect.any(Number), amber: expect.any(Number), red: expect.any(Number), unscored: expect.any(Number) }));
    for (const it of list.body.items as { score: number | null; band: string | null; snags: number; delay: number }[]) {
      if (it.score !== null) {
        expect(it.score).toBeGreaterThanOrEqual(0);
        expect(it.score).toBeLessThanOrEqual(100);
        expect(it.band).toBe(it.score >= 85 ? "green" : it.score >= 70 ? "amber" : "red");
      }
      expect(it.snags).toBeLessThanOrEqual(100);
      expect(it.delay).toBeLessThanOrEqual(100);
    }
    const scored = (list.body.items as { score: number | null }[]).map((i) => i.score).filter((s): s is number => s !== null);
    expect([...scored].sort((a, b) => a - b)).toEqual(scored); // worst first
    expect((await admin.api.call("get", "/dashboard/site-health?band=purple")).status).toBe(422);
    expect((await admin.api.call("get", "/dashboard/site-health?limit=0")).status).toBe(422);
    expect((await admin.api.call("get", "/dashboard/site-health?band=red")).body.items.every((i: { band: string }) => i.band === "red")).toBe(true);
    expect((await admin.api.call("get", "/dashboard/site-health/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    if (list.body.items.length) {
      const first = list.body.items[0] as { site_id: string; score: number | null };
      const d = await admin.api.call("get", `/dashboard/site-health/${first.site_id}`);
      expect(d.status).toBe(200);
      expect(d.body.score).toBe(first.score);
      expect((d.body.factors as { code: string }[]).map((f) => f.code)).toEqual(["tasks", "docs", "snags", "delay"]);
    }
  });

  it("the weights: default, admin-only write, rules, version, audit, and the card is in the dashboard catalogue", async () => {
    const admin = await plainAdmin(app, db);
    const g: Team = await team(app, db, "gecol", "gecol", 7);
    const cur = await admin.api.call("get", "/settings/dashboard/site-health-weights");
    expect(cur.status).toBe(200);
    expect(cur.body).toMatchObject({ tasks: 40, docs: 20, snags: 25, delay: 15, version: 0 });
    const etag = cur.headers.etag as string;
    const put = (b: object, h: Record<string, string> = { "If-Match": etag }) => admin.api.call("put", "/settings/dashboard/site-health-weights", b, h);
    const ok = { tasks: 50, docs: 10, snags: 20, delay: 20, reason: "Owner weighs tasks higher" };

    expect((await g.entry.api.call("put", "/settings/dashboard/site-health-weights", ok, { "If-Match": etag })).status).toBe(403);
    expect((await admin.api.call("put", "/settings/dashboard/site-health-weights", ok)).status).toBe(428);
    expect((await put(ok, { "If-Match": '"999"' })).status).toBe(412);
    const zero = await put({ tasks: 0, docs: 0, snags: 0, delay: 0, reason: "All zero" });
    expect(zero.status).toBe(422);
    expect(codesOf(zero.body)).toContain("/tasks:all_zero");
    expect((await put({ ...ok, tasks: 101 })).status).toBe(422);
    expect((await put({ ...ok, other: 1 })).status).toBe(422);
    expect((await put({ ...ok, reason: "" })).status).toBe(422);

    try {
      const saved = await put(ok);
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ tasks: 50, docs: 10, snags: 20, delay: 20, version: 1 });
      const list = await admin.api.call("get", "/dashboard/site-health");
      expect(list.body.weights).toMatchObject({ tasks: 50, docs: 10 });
      const au = await q(db, `SELECT count(*)::int AS n FROM audit_log WHERE action = 'site_health_weights_update'`);
      expect(au[0]!.n).toBeGreaterThanOrEqual(1);
    } finally {
      const now = await admin.api.call("get", "/settings/dashboard/site-health-weights");
      await admin.api.call("put", "/settings/dashboard/site-health-weights", { tasks: 40, docs: 20, snags: 25, delay: 15, reason: "test reset to the default" }, { "If-Match": now.headers.etag as string });
    }

    const cards = ((await admin.api.call("get", "/settings/dashboard")).body.catalogue.cards as { code: string }[]).map((c) => c.code);
    expect(cards).toContain("site_health");
  });
});
