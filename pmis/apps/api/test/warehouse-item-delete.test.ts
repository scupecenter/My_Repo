import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes } from "node:crypto";
import type { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, superDb } from "./helpers";
import { G } from "./reg-helpers";
import { Actor, actor, plainAdmin } from "./wf-helpers";

/** Migration 0565 (after 0160): DELETE items/:id hides the item, never deletes; entity locks of the item master. */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let viewer: Actor;
const U = randomBytes(3).toString("hex").toUpperCase();

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  viewer = await actor(app, db, { level: "entry", grants: G("warehouse", "view"), regions: [1], modules: null });
});
afterAll(async () => {
  await db.query(`DELETE FROM as_built_items WHERE code = $1`, [`DEL_${U}`]).catch(() => undefined);
  await app?.close();
  await db?.end();
});

const mk = async (code: string) => {
  const r = await admin.api.call("post", "/warehouse/items", { code, name_en: "Delete test", uom: "pcs", reason: "Delete test item" });
  expect(r.status).toBe(201);
  return r.body as { id: string; version: number; deletable: boolean };
};

describe("warehouse item hide (0565: hide, never delete) and entity locks", () => {
  it("hides an item with a reason, a version and an audit row; the item stays", async () => {
    const it = await mk(`DEL-${U}`);
    expect((await viewer.api.call("delete", `/warehouse/items/${it.id}?reason=Not+allowed`, undefined, { "If-Match": `"${it.version}"` })).status).toBe(403);
    expect((await admin.api.call("delete", `/warehouse/items/${it.id}?reason=No+version`)).status).toBe(428);
    expect((await admin.api.call("delete", `/warehouse/items/${it.id}?reason=ab`, undefined, { "If-Match": `"${it.version}"` })).status).toBe(422);
    expect((await admin.api.call("delete", `/warehouse/items/${it.id}?reason=Old+version`, undefined, { "If-Match": `"${it.version + 5}"` })).status).toBe(412);
    const del = await admin.api.call("delete", `/warehouse/items/${it.id}?reason=Entered+by+mistake`, undefined, { "If-Match": `"${it.version}"` });
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ id: it.id, deleted: true, hidden: true });
    const got = await admin.api.call("get", `/warehouse/items/${it.id}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ is_active: false });
    const audit = await db.query(`SELECT action, reason FROM audit_log WHERE entity_id = $1 ORDER BY id DESC LIMIT 1`, [it.id]);
    expect(audit.rows[0]).toMatchObject({ action: "warehouse_item_hide", reason: "Entered by mistake" });
  });

  it("hides an item that has data too (an As-Built link) and keeps the link", async () => {
    const it = await mk(`DEL-${U}-B`);
    await db.query(`INSERT INTO as_built_items (code, section, name_en, warehouse_item_id) VALUES ($1, 'cw', 'Link', $2::uuid)`, [`DEL_${U}`, it.id]);
    const del = await admin.api.call("delete", `/warehouse/items/${it.id}?reason=Hide+it`, undefined, { "If-Match": `"${it.version}"` });
    expect(del.status).toBe(200);
    const link = await db.query(`SELECT 1 FROM as_built_items WHERE code = $1`, [`DEL_${U}`]);
    expect(link.rowCount).toBe(1);
  });

  it("a locked item is listed and a System Admin stays exempt; unlock restores it; every change is audited", async () => {
    const it = await mk(`LCK-${U}`);
    const lock = await admin.api.call("post", `/entity-locks/wh_item/${it.id}`, { reason: "Frozen for audit" });
    expect(lock.status).toBe(200);
    expect(lock.body).toMatchObject({ kind: "wh_item", id: it.id, locked: true });
    expect((await admin.api.call("post", `/entity-locks/wh_item/${it.id}`, { reason: "Again" })).status).toBe(409);
    const list = await admin.api.call("get", "/entity-locks?kind=wh_item");
    expect((list.body as { records: { target_id: string }[] }).records.some((r) => r.target_id === it.id)).toBe(true);
    // a System Admin may still write: the lock does not stop the exempt role
    const ed = await admin.api.call("patch", `/warehouse/items/${it.id}`, { manufacturer: "Admin edit", reason: "Admin is exempt" }, { "If-Match": `"${it.version}"` });
    expect(ed.status).toBe(200);
    const un = await admin.api.call("delete", `/entity-locks/wh_item/${it.id}`, { reason: "Audit finished" });
    expect(un.status).toBe(200);
    const audit = await db.query(`SELECT action FROM audit_log WHERE entity_id = $1 AND action IN ('entity_lock','entity_unlock') ORDER BY id`, [it.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(["entity_lock", "entity_unlock"]);
    expect([401, 403]).toContain((await viewer.api.call("post", `/entity-locks/wh_item/${it.id}`, { reason: "Not allowed" })).status);
  });
});
