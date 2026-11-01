import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, superDb } from "./helpers";
import { G, approveAll, patch, post, recPath, team } from "./reg-helpers";
import { actor, plainAdmin } from "./wf-helpers";

/**
 * Migrations 0021 and 0022: Dismantle on the generic register framework. Two parts per site (record types cw and te), the RFD first, work start
 * not before the RFD, work end not before work start, no future actual dates, a closed part needs its RN reference and gets no new version (Q101). Regions 3 and 4 are used by this suite only
 * (the registers suite writes the cells of regions 6 and 7), so the suites can run in parallel on one database.
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

const R = 4;
const KEY = "dismantle";
const RFD = { rfd_date: "2026-02-01" };

describe("enable and list", () => {
  it("is enabled with the parts cw and te and only the fields Dismantle owns, and a caller without the module is refused", async () => {
    const admin = await plainAdmin(app, db);
    const res = await admin.api.call("get", "/registers");
    expect(res.status).toBe(200);
    const d = res.body.items.find(
      (i: { register_key: string }) => i.register_key === KEY,
    );
    expect(d).toMatchObject({
      register_key: KEY,
      module_key: "dismantle",
      site_scoped: true,
      approval_levels: 3,
      record_types: ["cw", "te"],
    });
    expect(d.fields.map((f: { code: string }) => f.code)).toEqual([
      "rfd_date",
      "rfd_document_ref",
      "dismantle_reason",
      "supervising_engineer",
      "work_start_date",
      "work_end_date",
      "closing_rn_ref",
      "closed",
    ]);
    expect(
      d.fields.find((f: { code: string }) => f.code === "rfd_date"),
    ).toMatchObject({ type: "date", required: true, section: "RFD" });
    expect(
      d.fields.find((f: { code: string }) => f.code === "dismantle_reason")
        .options.length,
    ).toBeGreaterThan(0);
    // Procurement and Permits data stay in their registers
    expect(d.fields.map((f: { code: string }) => f.code)).not.toEqual(
      expect.arrayContaining(["pr_no", "po_wo_no", "permit_type"]),
    );
    const procurementScopes = res.body.items
      .find((i: { register_key: string }) => i.register_key === "procurement")
      .fields.find((f: { code: string }) => f.code === "scope");
    expect(
      procurementScopes.options.map((o: { value: string }) => o.value),
    ).toEqual(expect.arrayContaining(["CW Dismantle", "TE Dismantle"]));

    const t = await team(app, db, KEY, "dismantle", R);
    const mine = await t.entry.api.call("get", "/registers");
    expect(
      mine.body.items.map((i: { register_key: string }) => i.register_key),
    ).toEqual([KEY]);
    expect((await t.entry.api.call("get", recPath(KEY))).status).toBe(200);

    // permission denied: a caller who holds another module only
    const other = await actor(app, db, {
      grants: G("gecol", "view"),
      regions: [R],
      modules: null,
    });
    const denied = await other.api.call("get", recPath(KEY));
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("module_forbidden");
    expect(
      (
        await other.api.call("post", recPath(KEY), {
          site_id: t.site.id,
          record_type: "cw",
          data: RFD,
        })
      ).status,
    ).toBe(404); // the site is outside what the module gives them
  });
});

describe("one record per site per part", () => {
  it("creates the CW and the TE part of a site, refuses a second record of the same part and an unknown part", async () => {
    const t = await team(app, db, KEY, "dismantle", R);
    const cw = await t.entry.api.call("post", recPath(KEY), {
      site_id: t.site.id,
      record_type: "cw",
      data: RFD,
    });
    expect(cw.status).toBe(201);
    expect(cw.body).toMatchObject({
      record_type: "cw",
      state: "entry",
      site_code: t.site.code,
      data: RFD,
    });
    const te = await t.entry.api.call("post", recPath(KEY), {
      site_id: t.site.id,
      record_type: "te",
      data: RFD,
    });
    expect(te.status).toBe(201);
    expect(te.body.record_type).toBe("te");

    const dup = await t.entry.api.call("post", recPath(KEY), {
      site_id: t.site.id,
      record_type: "cw",
      data: RFD,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("duplicate");
    expect(dup.body.existing_id).toBe(cw.body.id);
    const bad = await t.entry.api.call("post", recPath(KEY), {
      site_id: t.site.id,
      record_type: "xx",
      data: RFD,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({
      path: "/record_type",
      code: "not_in_list",
    });
    const none = await t.entry.api.call("post", recPath(KEY), {
      site_id: t.site.id,
      data: RFD,
    });
    expect(none.status).toBe(422);
    expect(none.body.errors[0]).toMatchObject({
      path: "/record_type",
      code: "required",
    });

    const list = await t.entry.api.call(
      "get",
      recPath(KEY) + `?site_id=${t.site.id}`,
    );
    expect(
      list.body.items.map((i: { record_type: string }) => i.record_type).sort(),
    ).toEqual(["cw", "te"]);
    const onlyTe = await t.entry.api.call(
      "get",
      recPath(KEY) + `?site_id=${t.site.id}&record_type=te`,
    );
    expect(onlyTe.body.items.map((i: { id: string }) => i.id)).toEqual([
      te.body.id,
    ]);
    // the database keeps the same promise without the API
    await expect(
      db.query(
        `INSERT INTO register_records (entity_id, register_key, record_type, site_id, region_id, data) SELECT gen_random_uuid(), 'dismantle', 'te', site_id, region_id, '{}'::jsonb FROM register_records WHERE id = $1`,
        [te.body.id],
      ),
    ).rejects.toThrow();
  });
});

describe("rules enforced in the database", () => {
  it("needs the RFD date before any later field; its document reference alone is allowed", async () => {
    const t = await team(app, db, KEY, "dismantle", R);
    const codes = (r: {
      status: number;
      body: { errors: { code: string; path: string }[] };
    }): string[] => {
      expect(r.status).toBe(422);
      return r.body.errors.map((e) => `${e.path}:${e.code}`);
    };
    expect(
      codes(
        await t.entry.api.call("post", recPath(KEY), {
          site_id: t.site.id,
          record_type: "cw",
          data: { dismantle_reason: "Swap" },
        }),
      ),
    ).toEqual(["/data/dismantle_reason:rfd_required"]);
    expect(
      codes(
        await t.entry.api.call("post", recPath(KEY), {
          site_id: t.site.id,
          record_type: "cw",
          data: { work_start_date: "2026-02-10", closed: false },
        }),
      ),
    ).toEqual([
      "/data/closed:rfd_required",
      "/data/work_start_date:rfd_required",
    ]);

    const rec = await t.entry.api.call("post", recPath(KEY), {
      site_id: t.site.id,
      record_type: "cw",
      data: { rfd_document_ref: "MAIL-77" },
    });
    expect(rec.status).toBe(201); // the document of step 1 may come before its date
    const noDate = await patch(
      t.entry.api,
      KEY,
      rec.body.id,
      rec.body.version,
      { data: { dismantle_reason: "Relocation" } },
    );
    expect(codes(noDate)).toEqual(["/data/dismantle_reason:rfd_required"]);
    const withDate = await patch(
      t.entry.api,
      KEY,
      rec.body.id,
      rec.body.version,
      { data: { ...RFD, dismantle_reason: "Relocation" } },
    );
    expect(withDate.status).toBe(200);
    expect(withDate.body.data).toMatchObject({
      rfd_date: "2026-02-01",
      rfd_document_ref: "MAIL-77",
      dismantle_reason: "Relocation",
    });
    // clearing the RFD while a later field is set is refused too
    const cleared = await patch(
      t.entry.api,
      KEY,
      rec.body.id,
      withDate.body.version,
      { data: { rfd_date: null } },
    );
    expect(codes(cleared)).toEqual(["/data/dismantle_reason:rfd_required"]);

    // submit: the RFD date is a required field (V4)
    const t2 = await team(app, db, KEY, "dismantle", R);
    const empty = await t2.entry.api.call("post", recPath(KEY), {
      site_id: t2.site.id,
      record_type: "te",
      data: {},
    });
    expect(empty.status).toBe(201);
    const submit = await post(
      t2.entry.api,
      KEY,
      empty.body.id,
      "submit",
      empty.body.version,
    );
    expect(codes(submit)).toEqual(["/data/rfd_date:required"]);
  });

  it("refuses a work end before the work start (the same day is fine) and any actual date in the future", async () => {
    const t = await team(app, db, KEY, "dismantle", R);
    const rec = await t.entry.api.call("post", recPath(KEY), {
      site_id: t.site.id,
      record_type: "cw",
      data: { ...RFD, work_start_date: "2026-03-10" },
    });
    expect(rec.status).toBe(201);
    const before = await patch(
      t.entry.api,
      KEY,
      rec.body.id,
      rec.body.version,
      { data: { work_end_date: "2026-03-09" } },
    );
    expect(before.status).toBe(422);
    expect(before.body.errors).toEqual([
      expect.objectContaining({
        path: "/data/work_end_date",
        code: "end_before_start",
      }),
    ]);
    const same = await patch(t.entry.api, KEY, rec.body.id, rec.body.version, {
      data: { work_end_date: "2026-03-10" },
    });
    expect(same.status).toBe(200);
    // moving the start after the end is refused the same way
    const later = await patch(
      t.entry.api,
      KEY,
      rec.body.id,
      same.body.version,
      { data: { work_start_date: "2026-03-11" } },
    );
    expect(later.status).toBe(422);
    expect(later.body.errors[0].code).toBe("end_before_start");

    const future = await patch(
      t.entry.api,
      KEY,
      rec.body.id,
      same.body.version,
      { data: { work_end_date: "2035-12-30" } },
    );
    expect(future.status).toBe(422);
    expect(future.body.errors[0]).toMatchObject({
      path: "/data/work_end_date",
      code: "future_date",
    });
    const futureStart = await t.entry.api.call("post", recPath(KEY), {
      site_id: t.site.id,
      record_type: "te",
      data: { ...RFD, work_start_date: "2035-12-30" },
    });
    expect(futureStart.status).toBe(422);
    expect(futureStart.body.errors[0]).toMatchObject({
      path: "/data/work_start_date",
      code: "future_date",
    });
    const futureRfd = await t.entry.api.call("post", recPath(KEY), {
      site_id: t.site.id,
      record_type: "te",
      data: { rfd_date: "2035-12-30" },
    });
    expect(futureRfd.status).toBe(422);
    expect(futureRfd.body.errors[0]).toMatchObject({
      path: "/data/rfd_date",
      code: "future_date",
    });
  });

  it("refuses a work start before the RFD date (the same day is fine), on create and on edit (0022 a)", async () => {
    const t = await team(app, db, KEY, "dismantle", R);
    const early = await t.entry.api.call("post", recPath(KEY), {
      site_id: t.site.id,
      record_type: "cw",
      data: { ...RFD, work_start_date: "2026-01-31" },
    });
    expect(early.status).toBe(422);
    expect(early.body.errors).toEqual([
      expect.objectContaining({
        path: "/data/work_start_date",
        code: "start_before_rfd",
      }),
    ]);
    const rec = await t.entry.api.call("post", recPath(KEY), {
      site_id: t.site.id,
      record_type: "cw",
      data: { ...RFD, work_start_date: "2026-02-01" },
    });
    expect(rec.status).toBe(201);
    const moveRfd = await patch(
      t.entry.api,
      KEY,
      rec.body.id,
      rec.body.version,
      { data: { rfd_date: "2026-02-02" } },
    );
    expect(moveRfd.status).toBe(422);
    expect(moveRfd.body.errors[0].code).toBe("start_before_rfd");
    const moveStart = await patch(
      t.entry.api,
      KEY,
      rec.body.id,
      rec.body.version,
      { data: { work_start_date: "2026-01-15" } },
    );
    expect(moveStart.body.errors[0].code).toBe("start_before_rfd");
  });

  it("closes a part only with its RN reference, then runs the 3-level approval; the supervising engineer must be a user; no custom fields", async () => {
    const t = await team(app, db, KEY, "dismantle", R);
    const rec = await t.entry.api.call("post", recPath(KEY), {
      site_id: t.site.id,
      record_type: "te",
      data: {
        ...RFD,
        work_start_date: "2026-02-10",
        work_end_date: "2026-02-12",
      },
    });
    expect(rec.status).toBe(201);
    const noRn = await patch(t.entry.api, KEY, rec.body.id, rec.body.version, {
      data: { closed: true },
    });
    expect(noRn.status).toBe(422);
    expect(noRn.body.errors).toEqual([
      expect.objectContaining({
        path: "/data/closing_rn_ref",
        code: "rn_required",
      }),
    ]);
    const blank = await patch(t.entry.api, KEY, rec.body.id, rec.body.version, {
      data: { closed: true, closing_rn_ref: "   " },
    });
    expect(blank.body.errors[0].code).toBe("rn_required");
    const stranger = await patch(
      t.entry.api,
      KEY,
      rec.body.id,
      rec.body.version,
      { data: { supervising_engineer: randomUUID() } },
    );
    expect(stranger.body.errors[0].code).toBe("unknown_user");
    const withCustom = await patch(
      t.entry.api,
      KEY,
      rec.body.id,
      rec.body.version,
      { custom: { x: 1 } },
    );
    expect(withCustom.status).toBe(422);

    const closed = await patch(
      t.entry.api,
      KEY,
      rec.body.id,
      rec.body.version,
      {
        data: {
          closed: true,
          closing_rn_ref: "TE-RN-0001",
          supervising_engineer: t.review.user.id,
        },
      },
    );
    expect(closed.status).toBe(200);
    expect(closed.body.data).toMatchObject({
      closed: true,
      closing_rn_ref: "TE-RN-0001",
      supervising_engineer: t.review.user.id,
    });
    const approved = await approveAll(t, rec.body.id, closed.body.version);
    expect(approved).toMatchObject({ state: "approved", is_current: true });
    // 0022 (b): a closed part is final, a new version is refused with a clear 422
    const v2 = await post(
      t.entry.api,
      KEY,
      rec.body.id,
      "versions",
      approved.version,
    );
    expect(v2.status).toBe(422);
    expect(v2.body.errors).toEqual([
      expect.objectContaining({ path: "/data/closed", code: "part_closed" }),
    ]);
    // permission denied: without the edit grant the refusal is the usual 403, not the rule
    const viewOnly = await actor(app, db, {
      grants: G("dismantle", "view"),
      regions: [R],
      modules: null,
    });
    expect(
      (
        await post(viewOnly.api, KEY, rec.body.id, "versions", approved.version)
      ).status,
    ).toBe(403);
    const au = await db.query(
      `SELECT after FROM audit_log WHERE entity_type = 'register_record' AND entity_id = $1 AND action = 'register_record_approve'`,
      [rec.body.id],
    );
    expect(au.rows[0].after.data.closing_rn_ref).toBe("TE-RN-0001");
  });
});

describe("a closed part is final (0022 b)", () => {
  it("allows a new version of an approved part that is not closed, and the version can close the part; then no more versions", async () => {
    const t = await team(app, db, KEY, "dismantle", R);
    const rec = await t.entry.api.call("post", recPath(KEY), {
      site_id: t.site.id,
      record_type: "cw",
      data: { ...RFD, work_start_date: "2026-02-10" },
    });
    expect(rec.status).toBe(201);
    const approved = await approveAll(t, rec.body.id, rec.body.version);
    expect(approved.state).toBe("approved");
    const v2 = await post(
      t.entry.api,
      KEY,
      rec.body.id,
      "versions",
      approved.version,
    );
    expect(v2.status).toBe(201);
    // the new version keeps the date rules
    const bad = await patch(t.entry.api, KEY, v2.body.id, v2.body.version, {
      data: { work_start_date: "2026-01-01" },
    });
    expect(bad.body.errors[0].code).toBe("start_before_rfd");
    const closed = await patch(t.entry.api, KEY, v2.body.id, v2.body.version, {
      data: { closed: true, closing_rn_ref: "CW-RN-0007" },
    });
    expect(closed.status).toBe(200);
    const approved2 = await approveAll(t, v2.body.id, closed.body.version);
    expect(approved2).toMatchObject({ state: "approved", is_current: true });
    const v3 = await post(
      t.entry.api,
      KEY,
      v2.body.id,
      "versions",
      approved2.version,
    );
    expect(v3.status).toBe(422);
    expect(v3.body.errors[0]).toMatchObject({ code: "part_closed" });
    // the database keeps the promise without the API
    await expect(
      db.query(
        `INSERT INTO register_records (entity_id, version_no, supersedes_id, register_key, record_type, site_id, region_id, data) SELECT entity_id, 3, id, register_key, record_type, site_id, region_id, data FROM register_records WHERE id = $1`,
        [v2.body.id],
      ),
    ).rejects.toThrow(/part_closed/);
  });
});

describe("permissions and region scope", () => {
  it("refuses a caller without create or without the entry cell, and hides the records of another region", async () => {
    const t = await team(app, db, KEY, "dismantle", R);
    const rec = await t.entry.api.call("post", recPath(KEY), {
      site_id: t.site.id,
      record_type: "cw",
      data: RFD,
    });
    expect(rec.status).toBe(201);

    const viewOnly = await actor(app, db, {
      grants: G("dismantle", "view"),
      regions: [R],
      modules: null,
    });
    const noCreate = await viewOnly.api.call("post", recPath(KEY), {
      site_id: t.site.id,
      record_type: "te",
      data: RFD,
    });
    expect(noCreate.status).toBe(403);
    // the reviewer holds a level, not the entry cell (Q56 ownership)
    const reviewer = await t.review.api.call("post", recPath(KEY), {
      site_id: t.site.id,
      record_type: "te",
      data: RFD,
    });
    expect(reviewer.status).toBe(403);
    expect(reviewer.body.code).toBe("action_forbidden");
    const notOwner = await actor(app, db, {
      grants: G("dismantle", "view", "create", "edit"),
      regions: [R],
      modules: null,
    });
    const notHolder = await notOwner.api.call("post", recPath(KEY), {
      site_id: t.site.id,
      record_type: "te",
      data: RFD,
    });
    expect(notHolder.status).toBe(403);
    expect(notHolder.body.code).toBe("not_eligible_holder");
    expect(
      (
        await patch(viewOnly.api, KEY, rec.body.id, rec.body.version, {
          data: { dismantle_reason: "Swap" },
        })
      ).status,
    ).toBe(403);

    // region scope (B3): a team of region 3 sees nothing of region 4 and cannot act on it
    const other = await team(app, db, KEY, "dismantle", 3);
    const otherList = await other.entry.api.call("get", recPath(KEY));
    expect(otherList.body.items.map((i: { id: string }) => i.id)).not.toContain(
      rec.body.id,
    );
    expect(
      (await other.entry.api.call("get", recPath(KEY, rec.body.id))).status,
    ).toBe(404);
    expect(
      (
        await patch(other.entry.api, KEY, rec.body.id, rec.body.version, {
          data: { dismantle_reason: "Swap" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await other.entry.api.call("post", recPath(KEY), {
          site_id: t.site.id,
          record_type: "te",
          data: RFD,
        })
      ).status,
    ).toBe(404); // a site of another region does not exist for them
    const admin = await plainAdmin(app, db);
    const all = await admin.api.call("get", recPath(KEY) + "?limit=200");
    expect(all.body.items.map((i: { id: string }) => i.id)).toContain(
      rec.body.id,
    );
  });
});
