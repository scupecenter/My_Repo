import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes } from "node:crypto";
import type { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, superDb } from "./helpers";
import { G } from "./reg-helpers";
import { Actor, actor, plainAdmin } from "./wf-helpers";

/** Migration 0567: History of a warehouse item and of a plan day (audit-fed), claim and triage of a plan day (region + date). */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let viewer: Actor;
const U = randomBytes(3).toString("hex").toUpperCase();
// own plan day, far from the other daily-plan tests (they share one database)
const DAY = `2031-0${1 + (parseInt(U.slice(0, 2), 16) % 9)}-1${parseInt(U.slice(2, 4), 16) % 9}`;
const BASE = `/daily-plans/${DAY}/regions/1`;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  viewer = await actor(app, db, { level: "entry", grants: G("warehouse", "view"), regions: [1], modules: null });
});
afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe("item history", () => {
  it("lists the edits with the field changes, and restores through the normal writer", async () => {
    const mk = await admin.api.call("post", "/warehouse/items", { code: `HIS-${U}`, name_en: "First name", uom: "pcs", reason: "History test item" });
    expect(mk.status).toBe(201);
    const it = mk.body as { id: string; version: number };
    const ed = await admin.api.call("patch", `/warehouse/items/${it.id}`, { name_en: "Second name", reason: "Rename for the test" }, { "If-Match": `"${it.version}"` });
    expect(ed.status).toBe(200);
    const h = await admin.api.call("get", `/warehouse/items/${it.id}/history`);
    expect(h.status).toBe(200);
    const rows = h.body as { action: string; changes: { field: string; from: unknown; to: unknown }[] }[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]!.changes).toContainEqual(expect.objectContaining({ field: "name_en", from: "First name", to: "Second name" }));
    expect((await viewer.api.call("get", `/warehouse/items/${it.id}/history`)).status).toBe(403);
    const cur = await admin.api.call("get", `/warehouse/items/${it.id}`);
    const back = await admin.api.call("patch", `/warehouse/items/${it.id}`, { name_en: "First name", reason: "Restore the earlier name" }, { "If-Match": `"${(cur.body as { version: number }).version}"` });
    expect(back.status).toBe(200);
    expect(((await admin.api.call("get", `/warehouse/items/${it.id}`)).body as { name_en: string }).name_en).toBe("First name");
  });
});

describe("plan day claim and triage", () => {
  it("claims, refuses a non-L2 user, validates the decision, defers with a note and keeps the trail", async () => {
    expect((await viewer.api.call("post", `${BASE}/claim`)).status).toBe(403);
    const c = await admin.api.call("post", `${BASE}/claim`);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ region_id: 1, plan_date: DAY });
    expect((c.body as { claimed_by: unknown }).claimed_by).toBeTruthy();
    expect((await admin.api.call("post", `${BASE}/triage`, { state: "rejected", note: "No such state" })).status).toBe(422);
    expect((await admin.api.call("post", `${BASE}/triage`, { state: "deferred", note: "ab" })).status).toBe(422);
    const d = await admin.api.call("post", `${BASE}/triage`, { state: "deferred", note: "Wait for the region lead" });
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ triage_state: "deferred", triage_note: "Wait for the region lead" });
    expect((await admin.api.call("get", `${BASE}/triage`)).body).toMatchObject({ triage_state: "deferred" });
    const h = await admin.api.call("get", `${BASE}/history`);
    expect(h.status).toBe(200);
    expect((h.body as { action: string }[]).map((x) => x.action)).toContain("daily_plan.triage_deferred");
  });
});
