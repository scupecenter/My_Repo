import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes } from "node:crypto";
import type { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, superDb } from "./helpers";
import { G } from "./reg-helpers";
import { Actor, actor, plainAdmin } from "./wf-helpers";

/** Migration 0159 (P6): extra columns of the item master on the existing field_definitions engine, and their values in the item `custom`. */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let viewer: Actor;
const U = randomBytes(3).toString("hex");
const col = `p6_${U}`;
const numCol = `p6n_${U}`;
const code = `P6-${U.toUpperCase()}`;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  viewer = await actor(app, db, { level: "entry", grants: G("warehouse", "view"), regions: [1], modules: null });
});
afterAll(async () => {
  await db.query(`UPDATE warehouse_items SET custom = custom - $1 - $2 WHERE item_code = $3`, [col, numCol, code]).catch(() => undefined);
  await app?.close();
  await db?.end();
});

describe("item master extra columns", () => {
  it("creates, reads, edits values, hides and refuses the wrong things", async () => {
    const mk = await admin.api.call("post", "/warehouse/item-columns", { code: col, label_en: "Colour", data_type: "text", reason: "Need the colour" });
    expect(mk.status).toBe(201);
    expect(mk.body).toMatchObject({ code: col, data_type: "text", is_active: true, has_values: false });
    expect((await admin.api.call("post", "/warehouse/item-columns", { code: col, label_en: "Again", data_type: "text", reason: "Duplicate" })).status).toBe(409);
    expect((await admin.api.call("post", "/warehouse/item-columns", { code: numCol, label_en: "Weight", data_type: "number", reason: "Need the weight" })).status).toBe(201);
    expect((await admin.api.call("post", "/warehouse/item-columns", { code: `Bad ${U}`, label_en: "x", data_type: "text", reason: "Bad code" })).status).toBe(422);

    // a reader of the items sees the active columns; the hidden ones need the column admin
    const act = await viewer.api.call("get", "/warehouse/item-columns");
    expect(act.status).toBe(200);
    expect((act.body as { items: { code: string }[] }).items.map((c) => c.code)).toContain(col);
    expect((await viewer.api.call("get", "/warehouse/item-columns?include_inactive=true")).status).toBe(403);
    expect((await viewer.api.call("post", "/warehouse/item-columns", { code: `x${U}`, label_en: "x", data_type: "text", reason: "Not allowed" })).status).toBe(403);

    const item = await admin.api.call("post", "/warehouse/items", { code, name_en: "P6 item", uom: "pcs", reason: "P6 test item" });
    expect(item.status).toBe(201);
    expect((item.body as { custom: object }).custom).toEqual({});
    const id = (item.body as { id: string }).id;
    const ver = (item.body as { version: number }).version;
    const set = await admin.api.call("patch", `/warehouse/items/${id}`, { custom: { [col]: "Red", [numCol]: 12.5 }, reason: "Fill the extra columns" }, { "If-Match": `"${ver}"` });
    expect(set.status).toBe(200);
    expect((set.body as { custom: Record<string, unknown> }).custom).toEqual({ [col]: "Red", [numCol]: 12.5 });
    // a wrong type is refused by the database
    const badv = await admin.api.call("patch", `/warehouse/items/${id}`, { custom: { [numCol]: "heavy" }, reason: "Wrong type" }, { "If-Match": `"${(set.body as { version: number }).version}"` });
    expect([400, 422]).toContain(badv.status);
    // a name change and a value in one request
    const both = await admin.api.call("patch", `/warehouse/items/${id}`, { name_en: "P6 renamed", custom: { [col]: null }, reason: "Both" }, { "If-Match": `"${(set.body as { version: number }).version}"` });
    expect(both.status).toBe(200);
    expect(both.body).toMatchObject({ name_en: "P6 renamed" });
    expect((both.body as { custom: Record<string, unknown> }).custom).toEqual({ [numCol]: 12.5 });

    // hiding keeps the values; the type of a column that holds values cannot change
    const hide = await admin.api.call("patch", `/warehouse/item-columns/${numCol}`, { is_active: false, reason: "Hide it" }, { "If-Match": '"1"' });
    expect(hide.status).toBe(200);
    expect(hide.body).toMatchObject({ is_active: false, version: 2 });
    expect((await admin.api.call("patch", `/warehouse/item-columns/${numCol}`, { is_active: true, reason: "No If-Match" })).status).toBe(428);
    expect((await admin.api.call("patch", `/warehouse/item-columns/${numCol}`, { data_type: "text", reason: "Retype" }, { "If-Match": '"2"' })).status).toBe(422);
    const all = await admin.api.call("get", "/warehouse/item-columns?include_inactive=true");
    expect((all.body as { items: { code: string; is_active: boolean }[] }).items.find((c) => c.code === numCol)).toMatchObject({ is_active: false });
    const audit = await db.query(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id`, [`warehouse_item.${numCol}`]);
    expect(audit.rows.map((a) => a.action)).toEqual(["item_column_created", "item_column_hidden"]);
  });
});
