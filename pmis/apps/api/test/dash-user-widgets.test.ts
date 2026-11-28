import type { NestExpressApplication } from "@nestjs/platform-express";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, superDb } from "./helpers";
import { G } from "./reg-helpers";
import { actor } from "./wf-helpers";

/**
 * Per-user dashboard widgets (contract 0.15.585, migration 0713): the caller's own card order, hidden cards and layout templates. Personal and
 * permission-neutral: dashboard.view is the only grant needed, each caller sees and changes only their own rows, the card codes are the F20 catalogue,
 * a stale version answers 412, and nothing is audited.
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

const viewer = () => actor(app, db, { level: "entry", grants: G("dashboard", "view"), regions: [7], modules: null });

describe("per-user dashboard widgets (contract 0.15.585)", () => {
  it("stores the caller's own layout per tab with a version, validates it and keeps it personal", async () => {
    const a = await viewer();
    const b = await viewer();
    const none = await actor(app, db, { level: "entry", grants: G("sites", "view"), regions: [7], modules: null });

    expect((await a.api.call("get", "/me/dashboard-layout")).body).toEqual({ tabs: {} });
    expect((await none.api.call("get", "/me/dashboard-layout")).status).toBe(403);

    const save = (v: number, over: Record<string, unknown> = {}) =>
      a.api.call("put", "/me/dashboard-layout/pmo", { order: ["sla", "headline"], hidden: ["regions"], version: v, ...over });
    const first = await save(0);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ tab: "pmo", order: ["sla", "headline"], hidden: ["regions"], version: 1 });
    // a stale version (or 0 once the tab exists) is refused; the stored layout stays
    expect((await save(0)).status).toBe(412);
    const second = await save(1, { order: ["headline"], hidden: [] });
    expect(second.body.version).toBe(2);

    // unknown card, a card listed twice, a card in both lists, an unknown tab, an unknown key
    const unknown = await save(2, { order: ["nope"] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors.map((e: { code: string }) => e.code)).toContain("unknown_card");
    expect((await save(2, { order: ["sla", "sla"], hidden: [] })).status).toBe(422);
    expect((await save(2, { order: ["sla"], hidden: ["sla"] })).status).toBe(422);
    expect((await a.api.call("put", "/me/dashboard-layout/xx", { order: [], hidden: [], version: 0 })).status).toBe(422);
    expect((await save(2, { extra: 1 })).status).toBe(422);

    // personal: another caller sees none of it, and the global settings are untouched
    expect((await b.api.call("get", "/me/dashboard-layout")).body).toEqual({ tabs: {} });
    const mine = (await a.api.call("get", "/me/dashboard-layout")).body.tabs;
    expect(mine.pmo).toEqual({ order: ["headline"], hidden: [], version: 2 });
    expect((await a.api.call("get", "/settings/dashboard")).body.tabs.pmo).toEqual({ order: [], hidden: [] });

    // no audit row for a personal display preference
    const au = await db.query(`SELECT 1 FROM audit_log WHERE entity_id = $1 AND action ILIKE '%dashboard%'`, [a.user.id]);
    expect(au.rowCount).toBe(0);

    // reset: back to the global layout, and idempotent
    expect((await a.api.call("delete", "/me/dashboard-layout/pmo")).body).toEqual({ tab: "pmo", reset: true });
    expect((await a.api.call("get", "/me/dashboard-layout")).body).toEqual({ tabs: {} });
    expect((await a.api.call("delete", "/me/dashboard-layout/pmo")).status).toBe(200);
  });

  it("keeps named templates of the three tab layouts, applies them and never touches another caller's", async () => {
    const a = await viewer();
    const b = await viewer();
    const layouts = { pmo: { order: ["sla"], hidden: ["regions"] }, te: { order: [], hidden: ["counters"] } };
    const made = await a.api.call("post", "/me/dashboard-templates", { name: "  Field view ", layouts });
    expect(made.status).toBe(201);
    expect(made.body.name).toBe("Field view");
    // the same name is replaced, not duplicated
    const again = await a.api.call("post", "/me/dashboard-templates", { name: "Field view", layouts: { cw: { order: ["streams"], hidden: [] } } });
    expect(again.body.id).toBe(made.body.id);
    expect((await a.api.call("get", "/me/dashboard-templates")).body.items).toHaveLength(1);
    expect((await a.api.call("post", "/me/dashboard-templates", { name: "Field view", layouts })).status).toBe(201);

    // validation: empty name, unknown card, unknown tab
    expect((await a.api.call("post", "/me/dashboard-templates", { name: " ", layouts })).status).toBe(422);
    expect((await a.api.call("post", "/me/dashboard-templates", { name: "x", layouts: { pmo: { order: ["nope"], hidden: [] } } })).status).toBe(422);
    expect((await a.api.call("post", "/me/dashboard-templates", { name: "x", layouts: { zz: { order: [], hidden: [] } } })).status).toBe(422);

    // another caller neither sees, applies nor deletes it
    expect((await b.api.call("get", "/me/dashboard-templates")).body.items).toEqual([]);
    expect((await b.api.call("post", `/me/dashboard-templates/${made.body.id}/apply`)).status).toBe(404);
    await b.api.call("delete", `/me/dashboard-templates/${made.body.id}`);
    expect((await a.api.call("get", "/me/dashboard-templates")).body.items).toHaveLength(1);

    // apply: each tab the template holds replaces the caller's layout of that tab (version moves on); a tab it omits is untouched
    await a.api.call("put", "/me/dashboard-layout/cw", { order: ["headline"], hidden: [], version: 0 });
    const ap = await a.api.call("post", `/me/dashboard-templates/${made.body.id}/apply`);
    expect(ap.status).toBe(200);
    expect(ap.body.tabs.pmo).toEqual({ order: ["sla"], hidden: ["regions"], version: 1 });
    expect(ap.body.tabs.te).toEqual({ order: [], hidden: ["counters"], version: 1 });
    expect(ap.body.tabs.cw).toEqual({ order: ["headline"], hidden: [], version: 1 });
    expect((await a.api.call("post", `/me/dashboard-templates/${made.body.id}/apply`)).body.tabs.pmo.version).toBe(2);

    // a card the catalogue no longer has is dropped when an old template is applied
    await db.query(`UPDATE dash_user_templates SET layouts = jsonb_build_object('pmo', jsonb_build_object('order', jsonb_build_array('sla', 'gone_card'), 'hidden', '[]'::jsonb)) WHERE id = $1`, [made.body.id]);
    expect((await a.api.call("post", `/me/dashboard-templates/${made.body.id}/apply`)).body.tabs.pmo.order).toEqual(["sla"]);

    // delete
    expect((await a.api.call("delete", `/me/dashboard-templates/${made.body.id}`)).body).toEqual({ id: made.body.id, deleted: true });
    expect((await a.api.call("get", "/me/dashboard-templates")).body.items).toEqual([]);
  });

  it("allows at most 20 templates per caller", async () => {
    const a = await viewer();
    for (let i = 1; i <= 20; i++) {
      expect((await a.api.call("post", "/me/dashboard-templates", { name: `T${i}`, layouts: {} })).status).toBe(201);
    }
    const over = await a.api.call("post", "/me/dashboard-templates", { name: "T21", layouts: {} });
    expect(over.status).toBe(422);
    expect(over.body.errors.map((e: { code: string }) => e.code)).toContain("too_many");
    // replacing an existing name is still fine at the limit
    expect((await a.api.call("post", "/me/dashboard-templates", { name: "T5", layouts: {} })).status).toBe(201);
  });
});
