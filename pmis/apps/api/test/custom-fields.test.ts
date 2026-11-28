import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Client as PgClient } from "pg";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { delegate, startApp, superDb } from "./helpers";
import { Actor, actor, plainAdmin } from "./wf-helpers";

/** GET /custom-fields and /custom-fields/{id} (contract 0.15.264): the definitions of the custom fields, with the field rules and the admin-only parts. */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let plain: Actor;
let fieldsDelegate: Actor;
const TAG = randomBytes(3).toString("hex");
const code = (s: string) => `cf_${s}_${TAG}`;
let active = "";
let inactive = "";
let hidden = "";
let roleId = "";

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db, true);
  plain = await actor(app, db, { level: "entry" });
  fieldsDelegate = await actor(app, db, { level: "entry" });
  await delegate(db, fieldsDelegate.user.id, [["fields", "edit"]]);
  const ins = async (
    c: string,
    active_: boolean,
    type = "list",
  ): Promise<string> =>
    (
      await db.query(
        `INSERT INTO field_definitions (entity_type, code, label_en, label_ar, data_type, is_active, in_list_filters) VALUES ('site', $1, $2, 'حقل', $3, $4, true) RETURNING id`,
        [c, `Field ${c}`, type, active_],
      )
    ).rows[0].id as string;
  active = await ins(code("active"), true);
  inactive = await ins(code("inactive"), false, "text");
  hidden = await ins(code("hidden"), true, "text");
  await db.query(
    `INSERT INTO field_list_values (field_id, code, label_en, label_ar, sort_order) VALUES ($1, 'b', 'Beta', 'بيتا', 2), ($1, 'a', 'Alpha', 'ألفا', 1)`,
    [active],
  );
  roleId = (
    await db.query(
      `INSERT INTO roles (code, name_en) VALUES ($1, 'Field door role') RETURNING id::text AS id`,
      [`cf_role_${TAG}`],
    )
  ).rows[0].id as string;
  await db.query(
    `INSERT INTO field_permissions (field_id, role_id, access) VALUES ($1, $2, 'edit')`,
    [active, roleId],
  );
  await db.query(
    `INSERT INTO field_permissions (field_id, role_id, access) SELECT $1, r.id, 'hidden' FROM roles r`,
    [hidden],
  );
});
afterAll(async () => {
  // the fields this file wrote stay in the shared test database: switch them off so no other suite meets a required field
  await db.query(
    `UPDATE field_definitions SET is_active = false, required = false WHERE code LIKE $1`,
    [`%${TAG}%`],
  );
  await db.end();
  await app.close();
});

describe("GET /custom-fields", () => {
  it("lists the active fields of an entity for a signed-in user, with their list values in order, and no admin parts", async () => {
    const res = await plain.api.call("get", "/custom-fields?entity_type=site");
    expect(res.status).toBe(200);
    const f = res.body.items.find((x: { id: string }) => x.id === active);
    expect(f).toMatchObject({
      entity_type: "site",
      code: code("active"),
      data_type: "list",
      label_ar: "حقل",
      in_list_filters: true,
      is_active: true,
    });
    expect(f.list_values.map((v: { value: string }) => v.value)).toEqual([
      "a",
      "b",
    ]);
    expect(f.visible_to_role_ids).toBeUndefined();
    expect(res.body.items.some((x: { id: string }) => x.id === inactive)).toBe(
      false,
    );
    expect(typeof res.body.field_set_version).toBe("number");
  });
  it("hides a field the caller's field rules hide", async () => {
    const res = await plain.api.call("get", "/custom-fields?entity_type=site");
    expect(res.body.items.some((x: { id: string }) => x.id === hidden)).toBe(
      false,
    );
    expect(
      (await plain.api.call("get", `/custom-fields/${hidden}`)).status,
    ).toBe(404);
  });
  it("an admin reads inactive fields and the role lists; a delegate of the custom fields too; a plain user gets 403 for inactive ones", async () => {
    for (const who of [admin, fieldsDelegate]) {
      const res = await who.api.call(
        "get",
        "/custom-fields?entity_type=site&include_inactive=true",
      );
      expect(res.status).toBe(200);
      expect(
        res.body.items.some((x: { id: string }) => x.id === inactive),
      ).toBe(true);
      expect(
        res.body.items.find((x: { id: string }) => x.id === active)
          .editable_by_role_ids,
      ).toContain(roleId);
    }
    expect(
      (await plain.api.call("get", "/custom-fields?include_inactive=true"))
        .status,
    ).toBe(403);
  });
  it("validates the query and answers one field with an ETag, 404 for an unknown or malformed id", async () => {
    expect(
      (await plain.api.call("get", "/custom-fields?entity_type=nonsense"))
        .status,
    ).toBe(422);
    expect(
      (
        await plain.api.call(
          "get",
          "/custom-fields?entity_type=site&task_code=",
        )
      ).status,
    ).toBe(422);
    const one = await plain.api.call("get", `/custom-fields/${active}`);
    expect(one.status).toBe(200);
    expect(one.headers.etag).toBe('"1"');
    expect(one.body.code).toBe(code("active"));
    expect(
      (
        await plain.api.call(
          "get",
          "/custom-fields/00000000-0000-4000-8000-000000000000",
        )
      ).status,
    ).toBe(404);
    expect(
      (await plain.api.call("get", "/custom-fields/not-a-uuid")).status,
    ).toBe(404);
    expect(
      (await plain.api.call("get", `/custom-fields/${inactive}`)).status,
    ).toBe(404);
    expect(
      (await admin.api.call("get", `/custom-fields/${inactive}`)).status,
    ).toBe(200);
  });
  it("is signed-in only", async () => {
    const res = await (
      await import("supertest")
    )
      .default(app.getHttpServer())
      .get("/api/v1/custom-fields");
    expect(res.status).toBe(401);
  });
});

describe("POST and PATCH /custom-fields (admin_save_field)", () => {
  const R = "Studio test of the field door";
  let created = "";
  let version = 0;
  const body = (over: Record<string, unknown> = {}) => ({
    entity_type: "site",
    code: `w_${TAG}`,
    label_en: "Written field",
    label_ar: "حقل",
    data_type: "text",
    reason: R,
    ...over,
  });

  it("is refused for a plain user, and for an admin without step-up", async () => {
    expect(
      (await plain.api.call("post", "/custom-fields", body())).status,
    ).toBe(403);
    const noStep = await plainAdmin(app, db, false);
    expect(
      (await noStep.api.call("post", "/custom-fields", body())).status,
    ).toBeGreaterThanOrEqual(400);
  });
  it("creates a field, audited, with its ETag and the contract names", async () => {
    const res = await admin.api.call(
      "post",
      "/custom-fields",
      body({
        data_type: "yes_no",
        code: `w_${TAG}`,
        in_list_filters: true,
        sort_order: 7,
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      entity_type: "site",
      code: `w_${TAG}`,
      data_type: "yes_no",
      in_list_filters: true,
      sort_order: 7,
      is_active: true,
      version: 1,
    });
    expect(res.headers.etag).toBe('"1"');
    created = res.body.id;
    version = res.body.version;
    const a = await db.query(
      `SELECT action, reason FROM audit_log WHERE entity_id = $1`,
      [created],
    );
    expect(a.rows[0]).toMatchObject({
      action: "custom_field_create",
      reason: R,
    });
    expect(
      (await plain.api.call("get", `/custom-fields/${created}`)).status,
    ).toBe(200);
  });
  it("refuses a duplicate code, a bad code, a list without options, an unknown key and a missing reason", async () => {
    const dup = await admin.api.call("post", "/custom-fields", body());
    expect(dup.status).toBe(422);
    expect(JSON.stringify(dup.body.errors)).toContain("duplicate");
    expect(
      (
        await admin.api.call(
          "post",
          "/custom-fields",
          body({ code: "Bad Code" }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await admin.api.call(
          "post",
          "/custom-fields",
          body({ code: `l_${TAG}`, data_type: "list" }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await admin.api.call(
          "post",
          "/custom-fields",
          body({ code: `u_${TAG}`, nonsense: 1 }),
        )
      ).status,
    ).toBe(422);
    const noReason: Record<string, unknown> = body({ code: `r_${TAG}` });
    delete noReason.reason;
    expect(
      (await admin.api.call("post", "/custom-fields", noReason)).status,
    ).toBe(422);
  });
  it("edits with If-Match, bumps the version, audits before and after, and refuses a stale version and a missing header", async () => {
    const res = await admin.api.call(
      "patch",
      `/custom-fields/${created}`,
      { label_en: "Renamed", required: true, reason: R },
      { "If-Match": `"${version}"` },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      label_en: "Renamed",
      required: true,
      version: version + 1,
    });
    const stale = await admin.api.call(
      "patch",
      `/custom-fields/${created}`,
      { label_en: "Again", reason: R },
      { "If-Match": `"${version}"` },
    );
    expect(stale.status).toBe(412);
    expect(
      (
        await admin.api.call("patch", `/custom-fields/${created}`, {
          label_en: "Again",
          reason: R,
        })
      ).status,
    ).toBe(428);
    const a = await db.query(
      `SELECT before, after FROM audit_log WHERE entity_id = $1 AND action = 'custom_field_update'`,
      [created],
    );
    expect(a.rows[0].before.label_en).toBe("Written field");
    expect(a.rows[0].after.label_en).toBe("Renamed");
    version = res.body.version;
    // The field is a Site field in the shared database: while it is required, every other suite that inserts a site (the probe of the New sites check, makeSite)
    // fails with 'field "w_..." is required'. Switch the requirement off again now; the right of the PATCH was proven above.
    version = (await db.query(`UPDATE field_definitions SET required = false WHERE id = $1 RETURNING version`, [created])).rows[0].version;
  });
  it("does not change entity, code or type on update, and never deletes: deactivating hides it from a plain user", async () => {
    const bad = await admin.api.call(
      "patch",
      `/custom-fields/${created}`,
      { code: "other_code", reason: R },
      { "If-Match": `"${version}"` },
    );
    expect(bad.status).toBe(422);
    const off = await admin.api.call(
      "patch",
      `/custom-fields/${created}`,
      { is_active: false, reason: R },
      { "If-Match": `"${version}"` },
    );
    expect(off.status).toBe(200);
    expect(off.body.is_active).toBe(false);
    expect(
      (await plain.api.call("get", `/custom-fields/${created}`)).status,
    ).toBe(404);
    expect(
      (await admin.api.call("get", `/custom-fields/${created}`)).status,
    ).toBe(200);
    expect(
      (
        await admin.api.call(
          "patch",
          "/custom-fields/00000000-0000-4000-8000-000000000000",
          { label_en: "x", reason: R },
          { "If-Match": '"1"' },
        )
      ).status,
    ).toBe(404);
  });
  it("writes list options in order, switches off the ones no longer sent, and writes the role rules", async () => {
    const res = await admin.api.call(
      "post",
      "/custom-fields",
      body({
        code: `lst_${TAG}`,
        data_type: "list",
        list_values: [
          { value: "x", label_en: "X" },
          { value: "y", label_en: "Y", label_ar: "واي" },
        ],
        visible_to_role_ids: [roleId],
        editable_by_role_ids: [roleId],
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.list_values.map((v: { value: string }) => v.value)).toEqual(
      ["x", "y"],
    );
    expect(res.body.visible_to_role_ids).toEqual([roleId]);
    expect(res.body.editable_by_role_ids).toEqual([roleId]);
    expect(
      (await plain.api.call("get", `/custom-fields/${res.body.id}`)).status,
    ).toBe(404); // the plain user's role is not the listed one
    const upd = await admin.api.call(
      "patch",
      `/custom-fields/${res.body.id}`,
      {
        list_values: [
          { value: "y", label_en: "Y" },
          { value: "z", label_en: "Z" },
        ],
        reason: R,
      },
      { "If-Match": `"${res.body.version}"` },
    );
    expect(upd.status).toBe(200);
    const byValue = Object.fromEntries(
      upd.body.list_values.map((v: { value: string; is_active: boolean }) => [
        v.value,
        v.is_active,
      ]),
    );
    expect(byValue).toEqual({ y: true, z: true, x: false });
    const clear = await admin.api.call(
      "patch",
      `/custom-fields/${res.body.id}`,
      { visible_to_role_ids: [], editable_by_role_ids: [], reason: R },
      { "If-Match": `"${upd.body.version}"` },
    );
    expect(clear.body.visible_to_role_ids).toEqual([]);
    expect(
      (await plain.api.call("get", `/custom-fields/${res.body.id}`)).status,
    ).toBe(200);
  });
});
