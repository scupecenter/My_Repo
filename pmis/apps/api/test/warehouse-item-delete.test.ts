import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes } from "node:crypto";
import type { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, superDb } from "./helpers";
import { G } from "./reg-helpers";
import { Actor, actor, plainAdmin } from "./wf-helpers";

/** Migration 0160: a real delete of a warehouse item with no data; an item with data can only be deactivated. */
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

describe("warehouse item delete", () => {
  it("deletes an item with no data, with a reason, a version and an audit row", async () => {
    const code = `DEL-${U}`;
    const it = await mk(code);
    const got = await admin.api.call("get", `/warehouse/items/${it.id}`);
    expect((got.body as { deletable: boolean }).deletable).toBe(true);
    expect((await viewer.api.call("delete", `/warehouse/items/${it.id}?reason=Not+allowed`, undefined, { "If-Match": `"${it.version}"` })).status).toBe(403);
    expect((await admin.api.call("delete", `/warehouse/items/${it.id}?reason=No+version`)).status).toBe(428);
    expect((await admin.api.call("delete", `/warehouse/items/${it.id}?reason=ab`, undefined, { "If-Match": `"${it.version}"` })).status).toBe(422);
    expect((await admin.api.call("delete", `/warehouse/items/${it.id}?reason=Old+version`, undefined, { "If-Match": `"${it.version + 5}"` })).status).toBe(412);
    const del = await admin.api.call("delete", `/warehouse/items/${it.id}?reason=Entered+by+mistake`, undefined, { "If-Match": `"${it.version}"` });
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ id: it.id, deleted: true });
    expect((await admin.api.call("get", `/warehouse/items/${it.id}`)).status).toBe(404);
    const audit = await db.query(`SELECT action, reason FROM audit_log WHERE entity_id = $1 ORDER BY id DESC LIMIT 1`, [it.id]);
    expect(audit.rows[0]).toMatchObject({ action: "warehouse_item_delete", reason: "Entered by mistake" });
  });

  it("refuses an item that has data (here an As-Built link) and keeps deactivate", async () => {
    const code = `DEL-${U}-B`;
    const it = await mk(code);
    await db.query(`INSERT INTO as_built_items (code, section, name_en, warehouse_item_id) VALUES ($1, 'cw', 'Link', $2::uuid)`, [`DEL_${U}`, it.id]);
    const got = await admin.api.call("get", `/warehouse/items/${it.id}`);
    expect((got.body as { deletable: boolean }).deletable).toBe(false);
    const del = await admin.api.call("delete", `/warehouse/items/${it.id}?reason=Try+to+delete`, undefined, { "If-Match": `"${it.version}"` });
    expect(del.status).toBe(409);
    expect((del.body as { code?: string }).code ?? "").toMatch(/item_in_use/);
    const off = await admin.api.call("patch", `/warehouse/items/${it.id}`, { is_active: false, reason: "Deactivate instead" }, { "If-Match": `"${it.version}"` });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ is_active: false });
  });
});
