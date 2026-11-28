import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes } from "node:crypto";
import type { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, superDb } from "./helpers";
import { G } from "./reg-helpers";
import { Actor, actor, plainAdmin } from "./wf-helpers";

/** Migration 0413, contract 0.15.342: reorder limits (admin only, audited, versioned) and supplier returns (RMA: warehouse create right, tracking only). */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let viewer: Actor;
let itemId: string;
const CODE = `RL-${randomBytes(3).toString("hex").toUpperCase()}`;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  viewer = await actor(app, db, { level: "view", grants: G("warehouse", "view"), regions: [1], modules: null });
  const r = await db.query("INSERT INTO warehouse_items (item_code, item_group, name, name_ar) VALUES ($1, 'WL', 'Reorder probe', 'اختبار') RETURNING id", [CODE]);
  itemId = r.rows[0].id;
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe("Reorder limits", () => {
  it("an admin sets a limit with a reason (audited), a viewer reads it and cannot save, a negative level is refused, null clears it", async () => {
    const bad = await admin.api.call("put", `/warehouse/reorder-limits/${itemId}`, { reorder_level: -1, reorder_qty: null, reason: "Bad level" });
    expect(bad.status).toBe(422);
    const ok = await admin.api.call("put", `/warehouse/reorder-limits/${itemId}`, { reorder_level: 5, reorder_qty: 20, reason: "Keep a buffer" });
    expect(ok.status).toBe(200);
    expect(ok.body.reorder_level).toBe(5);
    const rows = await db.query("SELECT after FROM audit_log WHERE action = 'warehouse_reorder_limit_save' ORDER BY id DESC LIMIT 1");
    expect(rows.rows[0]?.after?.reorder_qty).toBe(20);
    const list = await viewer.api.call("get", "/warehouse/reorder-limits?below=true");
    expect(list.status).toBe(200);
    const mine = list.body.items.find((x: { item_id: string }) => x.item_id === itemId);
    expect(mine?.below_reorder).toBe(true);
    expect((await viewer.api.call("put", `/warehouse/reorder-limits/${itemId}`, { reorder_level: 1, reorder_qty: null, reason: "No" })).status).toBe(403);
    const clear = await admin.api.call("put", `/warehouse/reorder-limits/${itemId}`, { reorder_level: null, reorder_qty: null, reason: "Remove the limit" });
    expect(clear.status).toBe(200);
    const after = await viewer.api.call("get", "/warehouse/reorder-limits");
    expect(after.body.items.some((x: { item_id: string }) => x.item_id === itemId)).toBe(false);
  });
});

describe("Supplier returns (RMA)", () => {
  it("is created with a number, moves sent to replaced to closed, refuses a wrong step, and is refused without the create right", async () => {
    expect((await viewer.api.call("post", "/warehouse/rma", { item_id: itemId, qty: 1, supplier: "Vendor A", reason: "Faulty" })).status).toBe(403);
    const none = await admin.api.call("post", "/warehouse/rma", { item_id: itemId, qty: 0, supplier: "Vendor A", reason: "Faulty" });
    expect(none.status).toBe(422);
    const made = await admin.api.call("post", "/warehouse/rma", { item_id: itemId, qty: 2, supplier: "Vendor A", reason: "Faulty on arrival" });
    expect(made.status).toBe(201);
    expect(made.body.rma_no).toMatch(/^RMA-\d{5}$/);
    expect(made.body.status).toBe("sent");
    const id = made.body.id as string;
    expect((await admin.api.call("post", `/warehouse/rma/${id}/status`, { status: "closed" })).status).toBe(422);
    expect((await admin.api.call("post", `/warehouse/rma/${id}/status`, { status: "replaced", note: "New unit received" })).status).toBe(200);
    const closed = await admin.api.call("post", `/warehouse/rma/${id}/status`, { status: "closed" });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe("closed");
    expect((await admin.api.call("post", `/warehouse/rma/${id}/status`, { status: "credited" })).status).toBe(422);
    const list = await viewer.api.call("get", "/warehouse/rma?status=closed");
    expect(list.body.items.some((x: { id: string }) => x.id === id)).toBe(true);
    const stock = await db.query("SELECT count(*)::int AS n FROM wh_movements WHERE created_at > now() - interval '1 minute' AND kind = 'quarantine_exit'");
    expect(stock.rows[0].n).toBe(0);
  });
});
