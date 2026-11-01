import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes } from "node:crypto";
import type { Client as PgClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { Api } from "./helpers";
import { startApp, superDb } from "./helpers";
import { G, Team, approveFlex, post, recPath, team } from "./reg-helpers";
import { Actor, Site, actor, makeSite, plainAdmin } from "./wf-helpers";

/**
 * Migration 0026: the Warehouse register in full. Item master as data, derived stock, DN / RN / PL / OPEN / ADJ documents with lines and serials, reservations,
 * stock posting on the final approval, cancel. Region 1 holds the site of this suite; the global cells of the 'warehouse' row name its three holders.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let t: Team;
let site: Site;
const R = 1;
const R2 = 3;
const U = randomBytes(3).toString("hex").toUpperCase();

async function globalCell(
  kind: "entry" | "review" | "approve",
  userId: string,
): Promise<void> {
  const level = kind === "entry" ? 1 : kind === "review" ? 2 : 3;
  await db.query(
    `DELETE FROM matrix_cells WHERE register_key = 'warehouse' AND level = $1 AND region_id IS NULL`,
    [level],
  );
  const c = await db.query(
    `INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ('warehouse', $1, 'any_one'::"MatrixRule", NULL, true, now()) RETURNING id`,
    [level],
  );
  await db.query(
    `INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, 'user'::"AssigneeKind", $2)`,
    [c.rows[0].id, userId],
  );
}

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  const entry = await actor(app, db, {
    level: "entry",
    grants: G("warehouse", "view", "create", "edit", "delete"),
    regions: [R],
    modules: null,
  });
  const review = await actor(app, db, {
    level: "review",
    grants: G("warehouse", "view"),
    regions: [R],
    modules: null,
  });
  const approve = await actor(app, db, {
    level: "approve",
    grants: G("warehouse", "view", "approve"),
    regions: [R],
    modules: null,
  });
  site = await makeSite(db, R, { prefix: "WH" });
  t = { entry, review, approve, site, region: R, key: "warehouse" };
  await prepare();
});
/** The matrix suite rewrites the cells and the level count of the warehouse row in parallel: every test starts from this state. */
async function prepare(): Promise<void> {
  await globalCell("entry", t.entry.user.id);
  await globalCell("review", t.review.user.id);
  await globalCell("approve", t.approve.user.id);
  await db.query(
    `UPDATE register_definitions SET approval_levels = 3 WHERE register_key = 'warehouse'`,
  );
  // a region cell of another suite would win over the global cells above
  await db.query(
    `DELETE FROM matrix_cells WHERE register_key = 'warehouse' AND region_id = $1`,
    [R],
  );
}
beforeEach(async () => {
  await db.query("SELECT pg_advisory_lock(770101)"); // one test at a time with the matrix suite
  await prepare();
});
afterEach(async () => {
  await db.query("SELECT pg_advisory_unlock(770101)");
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const items = async (api: Api, qs = ""): Promise<any[]> =>
  (
    await api.call(
      "get",
      `/warehouse/items?limit=200&include_inactive=true${qs}`,
    )
  ).body.items;
const itemOf = async (code: string): Promise<any> =>
  (await items(admin.api, `&q=${encodeURIComponent(code)}`)).find(
    (i) => i.code === code,
  );
const stock = async (id: string, siteId?: string): Promise<any> => {
  const res = await t.entry.api.call(
    "get",
    `/warehouse/stock?item_id=${id}${siteId ? `&site_id=${siteId}` : ""}`,
  );
  expect(res.status).toBe(200);
  return res.body.items[0];
};
const move = (body: Record<string, unknown>, api: Api = t.entry.api) =>
  api.call("post", "/warehouse/movements", body);
const approveMovement = async (m: any): Promise<any> => {
  const rec = await t.entry.api.call(
    "get",
    recPath("warehouse", m.register_record_id),
  );
  await approveFlex(t, rec.body.id, rec.body.version);
  return (await t.entry.api.call("get", `/warehouse/movements/${m.id}`)).body;
};
const doc = (type: string, extra: Record<string, unknown> = {}) => ({
  record_type: type,
  doc_no: `${type.toUpperCase()}-${U}-${randomBytes(2).toString("hex")}`,
  doc_date: "2026-01-10",
  txn_status: "Approved",
  ...extra,
});

let tower: any;
let trk: any;

describe("item master: data, edited by the System Admin", () => {
  it("lists the seeded CW and TE items with their need rules, and refuses a caller without the module", async () => {
    const cw = await items(admin.api, "&category=CW");
    expect(cw).toHaveLength(28);
    expect(cw[0]).toMatchObject({
      code: "CW-01",
      name_en: "Tower",
      uom: "m",
      serial_tracked: false,
      is_active: true,
    });
    expect(cw.map((i) => i.name_en)).toEqual(
      expect.arrayContaining([
        "Indoor Rack",
        "Fiber Cable – Patch Cord",
        'PVC Pipe 1"',
      ]),
    );
    const all = await items(admin.api);
    expect(all.length).toBeGreaterThanOrEqual(49);
    const router = all.find((i) => i.code === "S9500");
    expect(router).toMatchObject({
      serial_tracked: true,
      category: "IP",
      progress_item_code: "ROUTER",
    });
    expect(router.need_rules[0]).toMatchObject({
      need_unit: "Router",
      quantity: 1,
    });
    expect(all.find((i) => i.code === "CW-07").as_built_item_code).toBe(
      "PATCH_CORD_FIBER",
    ); // Q74: the As-Built item is linked by Warehouse code
    tower = await itemOf("CW-01");

    const denied = await actor(app, db, {
      grants: G("gecol", "view"),
      regions: [R],
      modules: null,
    });
    const res = await denied.api.call("get", "/warehouse/items");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("module_forbidden");
  });

  it("adds, renames and deactivates an item with a reason, If-Match, audit with before and after; a non-admin is refused", async () => {
    const code = `TST-${U}`;
    const denied = await t.entry.api.call("post", "/warehouse/items", {
      code,
      name_en: "Tester",
      uom: "pcs",
      reason: "Not allowed",
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("action_forbidden");

    const noReason = await admin.api.call("post", "/warehouse/items", {
      code,
      name_en: "Tester",
      uom: "pcs",
    });
    expect(noReason.status).toBe(422);
    const c = await admin.api.call("post", "/warehouse/items", {
      code,
      name_en: "Tracked Tester",
      name_ar: "جهاز",
      uom: "pcs",
      category: "Accessories",
      serial_tracked: true,
      contract_qty: 10,
      need_rules: [{ need_unit: "Router", quantity: 2 }],
      reason: "New item for the pilot",
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.headers.etag).toBeTruthy();
    expect(c.body).toMatchObject({
      code,
      name_en: "Tracked Tester",
      serial_tracked: true,
      contract_qty: 10,
      is_active: true,
      version: 1,
    });
    expect(c.body.need_rules[0]).toMatchObject({
      need_unit: "Router",
      quantity: 2,
    });
    trk = c.body;
    expect(
      (
        await admin.api.call("post", "/warehouse/items", {
          code,
          name_en: "Again",
          uom: "pcs",
          reason: "Duplicate code",
        })
      ).status,
    ).toBe(409);

    expect(
      (
        await admin.api.call("patch", `/warehouse/items/${trk.id}`, {
          name_en: "x",
          reason: "No If-Match",
        })
      ).status,
    ).toBe(428);
    expect(
      (
        await admin.api.call(
          "patch",
          `/warehouse/items/${trk.id}`,
          { name_en: "Renamed Tester", reason: "Stale" },
          { "If-Match": '"9"' },
        )
      ).status,
    ).toBe(412);
    const r = await admin.api.call(
      "patch",
      `/warehouse/items/${trk.id}`,
      { name_en: "Renamed Tester", reason: "Better name" },
      { "If-Match": `"${trk.version}"` },
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      name_en: "Renamed Tester",
      version: 2,
      code,
    });
    expect(
      (
        await t.entry.api.call(
          "patch",
          `/warehouse/items/${trk.id}`,
          { name_en: "y", reason: "Not allowed" },
          { "If-Match": '"2"' },
        )
      ).status,
    ).toBe(403);

    const audit = await db.query(
      `SELECT action, before, after, reason FROM audit_log WHERE entity_type = 'warehouse_item' AND entity_id = $1 ORDER BY id`,
      [trk.id],
    );
    expect(audit.rows.map((a) => a.action)).toEqual([
      "warehouse_item_create",
      "warehouse_item_update",
    ]);
    expect(audit.rows[1].before.name_en).toBe("Tracked Tester");
    expect(audit.rows[1].after.name_en).toBe("Renamed Tester");
    expect(audit.rows[1].reason).toBe("Better name");
    trk = r.body;

    // a second item is deactivated: it leaves the active list but stays readable
    const spare = await admin.api.call("post", "/warehouse/items", {
      code: `SPR-${U}`,
      name_en: "Spare",
      uom: "m",
      reason: "Spare item",
    });
    const off = await admin.api.call(
      "patch",
      `/warehouse/items/${spare.body.id}`,
      { is_active: false, reason: "Not used" },
      { "If-Match": `"${spare.body.version}"` },
    );
    expect(off.status).toBe(200);
    expect(off.body.is_active).toBe(false);
    const active = await admin.api.call("get", `/warehouse/items?q=SPR-${U}`);
    expect(active.body.items).toHaveLength(0);
    expect(
      (await admin.api.call("get", `/warehouse/items/${spare.body.id}`)).body
        .name_en,
    ).toBe("Spare");
    const a2 = await db.query(
      `SELECT action FROM audit_log WHERE entity_type = 'warehouse_item' AND entity_id = $1 ORDER BY id`,
      [spare.body.id],
    );
    expect(a2.rows.map((a) => a.action)).toEqual([
      "warehouse_item_create",
      "warehouse_item_deactivate",
    ]);
  });
});

describe("receipts, reservations, posting and returns", () => {
  it("a PL receipt changes the stock only when it is approved; its serials enter the store", async () => {
    const before = await stock(tower.id);
    const m = await move({
      ...doc("pl"),
      lines: [
        { item_id: tower.id, qty: 100 },
        { item_id: trk.id, qty: 3, serials: [`S1-${U}`, `S2-${U}`, `S3-${U}`] },
      ],
    });
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    expect(m.body).toMatchObject({
      kind: "receipt",
      record_type: "pl",
      status: "pending",
      site_id: null,
      reserved: false,
      version: 1,
    });
    expect(m.body.lines).toHaveLength(2);
    expect(m.headers.etag).toBeTruthy();
    expect((await stock(tower.id)).on_hand).toBe(before.on_hand); // nothing is posted before the approval
    const done = await approveMovement(m.body);
    expect(done).toMatchObject({ status: "posted", version: 2 });
    expect(done.posted_at).toBeTruthy();
    expect((await stock(tower.id)).on_hand).toBe(before.on_hand + 100);
    const ser = await db.query(
      `SELECT status, pl_invoice_no FROM warehouse_serials WHERE serial_no = $1`,
      [`S1-${U}`],
    );
    expect(ser.rows[0]).toMatchObject({
      status: "In Stock",
      pl_invoice_no: m.body.doc_no,
    });
    expect((await stock(trk.id)).on_hand).toBe(3);
  });

  it("a pending DN reserves its stock; the same stock cannot be issued twice; the line rules answer 422", async () => {
    const start = await stock(tower.id);
    const a = await move({
      ...doc("cw_dn"),
      site_id: site.id,
      lines: [{ item_id: tower.id, qty: 30, qty_approved: 40 }],
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({
      kind: "issue",
      status: "pending",
      reserved: true,
      site_code: site.code,
    });
    expect(a.body.lines[0]).toMatchObject({
      qty: 30,
      qty_approved: 40,
      item_code: "CW-01",
      uom: "m",
    });
    const s = await stock(tower.id);
    expect(s).toMatchObject({
      reserved: start.reserved + 30,
      pending_issue: start.pending_issue + 30,
      available: start.available - 30,
    });
    expect(s.on_hand).toBe(start.on_hand);

    const over = await move({
      ...doc("cw_dn"),
      site_id: site.id,
      lines: [{ item_id: tower.id, qty: start.available }],
    });
    expect(over.status).toBe(422);
    expect(over.body.code).toBe("insufficient_stock");
    expect(over.body.errors[0]).toMatchObject({
      path: "/lines/0/qty",
      code: "insufficient_stock",
    });

    const bad = await move({
      ...doc("cw_dn"),
      site_id: site.id,
      lines: [{ item_id: tower.id, qty: 5, qty_approved: 3 }],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({
      path: "/lines/0/qty_approved",
      code: "below_dispatched",
    });
    const fraction = await move({
      ...doc("cw_dn"),
      site_id: site.id,
      lines: [{ item_id: (await itemOf("CW-25")).id, qty: 1.5 }],
    });
    expect(fraction.body.errors[0]).toMatchObject({
      path: "/lines/0/qty",
      code: "whole_units",
    });
    const count = await move({
      ...doc("cw_dn"),
      site_id: site.id,
      lines: [{ item_id: trk.id, qty: 2, serials: [`S1-${U}`] }],
    });
    expect(count.body.errors[0]).toMatchObject({
      path: "/lines/0/serials",
      code: "serial_count",
    });
    const unknown = await move({
      ...doc("cw_dn"),
      site_id: site.id,
      lines: [{ item_id: trk.id, qty: 1, serials: [`NOPE-${U}`] }],
    });
    expect(unknown.body.errors[0]).toMatchObject({
      path: "/lines/0/serials",
      code: "unknown_serial",
    });
    const notTracked = await move({
      ...doc("cw_dn"),
      site_id: site.id,
      lines: [{ item_id: tower.id, qty: 1, serials: ["X"] }],
    });
    expect(notTracked.body.errors[0]).toMatchObject({
      code: "not_serial_tracked",
    });
    const noSite = await move({
      ...doc("cw_dn"),
      lines: [{ item_id: tower.id, qty: 1 }],
    });
    expect(noSite.status).toBe(422);
    expect(noSite.body.errors[0]).toMatchObject({
      path: "/site_id",
      code: "required",
    });
    const dup = await move({
      ...doc("cw_dn"),
      doc_no: a.body.doc_no,
      site_id: site.id,
      lines: [{ item_id: tower.id, qty: 1 }],
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("duplicate");
    const empty = await move({ ...doc("cw_dn"), site_id: site.id, lines: [] });
    expect(empty.status).toBe(422);

    // the approval posts the issue to the site; the stock is lowered once, the reservation is gone
    const done = await approveMovement(a.body);
    expect(done.status).toBe("posted");
    const after = await stock(tower.id);
    expect(after).toMatchObject({
      on_hand: start.on_hand - 30,
      reserved: start.reserved,
      pending_issue: start.pending_issue,
    });
    expect(await stock(tower.id, site.id)).toMatchObject({
      on_hand: 30,
      site_id: site.id,
    });
    const q = await db.query(
      `SELECT dispatched::float8 AS d FROM warehouse_site_qty WHERE site_id = $1 AND item_id = $2`,
      [site.id, tower.id],
    );
    expect(q.rows[0].d).toBe(30);
  });

  it("a return note needs a reason, cannot exceed what the site holds, and posts the return when approved", async () => {
    const start = await stock(tower.id);
    const tooMuch = await move({
      ...doc("cw_rn", { reason: "Other" }),
      site_id: site.id,
      lines: [{ item_id: tower.id, qty: 31 }],
    });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.code).toBe("insufficient_stock");
    expect(tooMuch.body.errors[0].code).toBe("insufficient_on_site");
    const rn = await move({
      ...doc("cw_rn"),
      site_id: site.id,
      lines: [{ item_id: tower.id, qty: 10, condition: "Good" }],
    });
    expect(rn.status, JSON.stringify(rn.body)).toBe(201);
    expect(rn.body).toMatchObject({
      kind: "return",
      status: "pending",
      reserved: false,
    });
    expect((await stock(tower.id)).pending_return).toBe(
      start.pending_return + 10,
    );
    // without a reason the submit is refused (BP 10)
    const sub = await post(
      t.entry.api,
      "warehouse",
      rn.body.register_record_id,
      "submit",
      (
        await t.entry.api.call(
          "get",
          recPath("warehouse", rn.body.register_record_id),
        )
      ).body.version,
    );
    expect(sub.status).toBe(422);
    expect(sub.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/data/reason", code: "required" }),
      ]),
    );
    const rec = await t.entry.api.call(
      "get",
      recPath("warehouse", rn.body.register_record_id),
    );
    const fixed = await t.entry.api.call(
      "patch",
      recPath("warehouse", rec.body.id),
      { data: { reason: "Faulty or Damaged" } },
      { "If-Match": `"${rec.body.version}"` },
    );
    expect(fixed.status).toBe(200);
    const done = await approveMovement(rn.body);
    expect(done.status).toBe("posted");
    expect(await stock(tower.id)).toMatchObject({
      on_hand: start.on_hand + 10,
      pending_return: start.pending_return,
    });
    expect((await stock(tower.id, site.id)).on_hand).toBe(20);
  });

  it("serials travel with the documents: dispatched by a DN, returned by an RN that names the same site", async () => {
    const s1 = `S1-${U}`;
    const dn = await move({
      ...doc("te_dn"),
      site_id: site.id,
      lines: [{ item_id: trk.id, qty: 1, serials: [s1] }],
    });
    expect(dn.status, JSON.stringify(dn.body)).toBe(201);
    const twice = await move({
      ...doc("te_dn"),
      site_id: site.id,
      lines: [{ item_id: trk.id, qty: 1, serials: [s1] }],
    });
    expect(twice.body.errors[0]).toMatchObject({ code: "serial_reserved" });
    await approveMovement(dn.body);
    const ser = await db.query(
      `SELECT status, dn_no, site_id FROM warehouse_serials WHERE serial_no = $1`,
      [s1],
    );
    expect(ser.rows[0]).toMatchObject({
      status: "Dispatched",
      dn_no: dn.body.doc_no,
      site_id: site.id,
    });
    expect((await stock(trk.id)).on_hand).toBe(2);

    // an RN of a serial that was never delivered to this site is refused; the delivered one returns
    const other = await move({
      ...doc("te_rn", { reason: "Other" }),
      site_id: site.id,
      lines: [{ item_id: trk.id, qty: 1, serials: [`S2-${U}`] }],
    });
    expect(other.body.errors[0]).toMatchObject({ code: "rn_without_dn" });
    const rn = await move({
      ...doc("te_rn", { reason: "Relocation" }),
      site_id: site.id,
      lines: [{ item_id: trk.id, qty: 1, serials: [s1], condition: "Faulty" }],
    });
    expect(rn.status).toBe(201);
    await approveMovement(rn.body);
    const back = await db.query(
      `SELECT status, rn_no, return_condition, site_id FROM warehouse_serials WHERE serial_no = $1`,
      [s1],
    );
    expect(back.rows[0]).toMatchObject({
      status: "Returned",
      rn_no: rn.body.doc_no,
      return_condition: "Faulty",
      site_id: null,
    });
  });

  it("an in-use item keeps its unit and serial tracking, and cannot be deactivated while a movement of it is pending", async () => {
    const r = await admin.api.call(
      "patch",
      `/warehouse/items/${(await itemOf(trk.code)).id}`,
      { uom: "m", reason: "Change the unit" },
      { "If-Match": `"${(await itemOf(trk.code)).version}"` },
    );
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("item_in_use");
    const pend = await move({
      ...doc("pl"),
      lines: [{ item_id: trk.id, qty: 1, serials: [`S9-${U}`] }],
    });
    expect(pend.status).toBe(201);
    const cur = await itemOf(trk.code);
    const off = await admin.api.call(
      "patch",
      `/warehouse/items/${trk.id}`,
      { is_active: false, reason: "Retire" },
      { "If-Match": `"${cur.version}"` },
    );
    expect(off.status).toBe(422);
    expect(off.body.code).toBe("item_in_use");
    const cancel = await t.entry.api.call(
      "post",
      `/warehouse/movements/${pend.body.id}/cancel`,
      { reason: "Entered by mistake" },
      { "If-Match": `"${pend.body.version}"` },
    );
    expect(cancel.status).toBe(200);
    // a name change is still allowed
    const rename = await admin.api.call(
      "patch",
      `/warehouse/items/${trk.id}`,
      { name_ar: "جهاز مُتتبَّع", reason: "Arabic name" },
      { "If-Match": `"${cur.version}"` },
    );
    expect(rename.status).toBe(200);
  });

  it("cancels a pending movement (reason, If-Match, step-up) and releases the reservation; an approved one cannot be cancelled", async () => {
    const start = await stock(tower.id);
    const m = await move({
      ...doc("cw_dn"),
      site_id: site.id,
      lines: [{ item_id: tower.id, qty: 15 }],
    });
    expect((await stock(tower.id)).reserved).toBe(start.reserved + 15);
    expect(
      (
        await t.review.api.call(
          "post",
          `/warehouse/movements/${m.body.id}/cancel`,
          { reason: "No right" },
          { "If-Match": '"1"' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await t.entry.api.call(
          "post",
          `/warehouse/movements/${m.body.id}/cancel`,
          {},
          { "If-Match": '"1"' },
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await t.entry.api.call(
          "post",
          `/warehouse/movements/${m.body.id}/cancel`,
          { reason: "Wrong site" },
          { "If-Match": '"7"' },
        )
      ).status,
    ).toBe(412);
    const c = await t.entry.api.call(
      "post",
      `/warehouse/movements/${m.body.id}/cancel`,
      { reason: "Wrong site" },
      { "If-Match": `"${m.body.version}"` },
    );
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({
      status: "cancelled",
      cancel_reason: "Wrong site",
      reserved: false,
    });
    expect(await stock(tower.id)).toMatchObject({
      reserved: start.reserved,
      available: start.available,
    });
    const again = await t.entry.api.call(
      "post",
      `/warehouse/movements/${m.body.id}/cancel`,
      { reason: "Twice" },
      { "If-Match": `"${c.body.version}"` },
    );
    expect(again.status).toBe(409);
    const posted = (
      await t.entry.api.call(
        "get",
        "/warehouse/movements?status=posted&kind=issue",
      )
    ).body.items[0];
    expect(
      (
        await t.entry.api.call(
          "post",
          `/warehouse/movements/${posted.id}/cancel`,
          { reason: "Too late" },
          { "If-Match": `"${posted.version}"` },
        )
      ).status,
    ).toBe(409);
  });

  it("an adjustment cannot take more than is available; a serial-tracked item cannot be adjusted down", async () => {
    const s = await stock(tower.id);
    const down = await move({
      ...doc("adj"),
      lines: [{ item_id: tower.id, qty: -(s.available + 1) }],
    });
    expect(down.status).toBe(422);
    expect(down.body.code).toBe("insufficient_stock");
    const ok = await move({
      ...doc("adj"),
      lines: [{ item_id: tower.id, qty: -1 }],
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ kind: "adjustment", reserved: true });
    const zero = await move({
      ...doc("adj"),
      lines: [{ item_id: tower.id, qty: 0 }],
    });
    expect(zero.status).toBe(422);
    const tracked = await move({
      ...doc("adj"),
      lines: [{ item_id: trk.id, qty: -1 }],
    });
    expect(tracked.body.errors[0]).toMatchObject({ code: "serial_adjustment" });
    const open = await move({
      ...doc("open"),
      lines: [{ item_id: tower.id, qty: 5 }],
    });
    expect(open.status).toBe(201);
    expect(open.body).toMatchObject({ kind: "receipt", record_type: "open" });
  });
});

describe("scope and permissions", () => {
  it("lists movements and stock by site; another region does not see the site documents, and a caller without the module or the create right is refused", async () => {
    const bySite = await t.entry.api.call(
      "get",
      `/warehouse/movements?site_id=${site.id}`,
    );
    expect(bySite.status).toBe(200);
    expect(bySite.body.items.length).toBeGreaterThan(0);
    expect(
      bySite.body.items.every(
        (m: { site_id: string }) => m.site_id === site.id,
      ),
    ).toBe(true);
    expect(
      (await t.entry.api.call("get", "/warehouse/movements?status=nope"))
        .status,
    ).toBe(422);
    const pending = await move({
      ...doc("cw_dn"),
      site_id: site.id,
      lines: [{ item_id: tower.id, qty: 1 }],
    });

    const away = await actor(app, db, {
      level: "entry",
      grants: G("warehouse", "view", "create"),
      regions: [R2],
      modules: null,
    });
    expect(
      (await away.api.call("get", `/warehouse/movements/${pending.body.id}`))
        .status,
    ).toBe(404);
    const list = await away.api.call("get", "/warehouse/movements?limit=200");
    expect(list.body.items.map((m: { id: string }) => m.id)).not.toContain(
      pending.body.id,
    );
    expect(
      list.body.items.some(
        (m: { site_id: string | null }) => m.site_id === null,
      ),
    ).toBe(true); // global documents (PL, OPEN, ADJ) are visible to the module holders
    expect(
      (await away.api.call("get", `/warehouse/stock?site_id=${site.id}`))
        .status,
    ).toBe(404);
    expect(
      (
        await away.api.call("post", "/warehouse/movements", {
          ...doc("cw_dn"),
          site_id: site.id,
          lines: [{ item_id: tower.id, qty: 1 }],
        })
      ).status,
    ).toBe(404);

    const viewer = await actor(app, db, {
      level: "view",
      grants: G("warehouse", "view"),
      regions: [R],
      modules: null,
    });
    const noCreate = await viewer.api.call("post", "/warehouse/movements", {
      ...doc("pl"),
      lines: [{ item_id: tower.id, qty: 1 }],
    });
    expect(noCreate.status).toBe(403);
    const none = await actor(app, db, {
      grants: G("gecol", "view"),
      regions: [R],
      modules: null,
    });
    for (const p of [
      "/warehouse/movements",
      "/warehouse/stock",
      `/warehouse/movements/${pending.body.id}`,
    ]) {
      const res = await none.api.call("get", p);
      expect(res.status, p).toBe(403);
      expect(res.body.code).toBe("module_forbidden");
    }
    expect(
      (
        await none.api.call("post", "/warehouse/movements", {
          ...doc("pl"),
          lines: [{ item_id: tower.id, qty: 1 }],
        })
      ).status,
    ).toBe(403);
  });

  it("the warehouse register refuses a document without lines (created through the generic path) with a pointer to the movement endpoint", async () => {
    const c = await t.entry.api.call("post", recPath("warehouse"), {
      site_id: site.id,
      record_type: "cw_dn",
      data: {
        doc_no: `BARE-${U}`,
        doc_date: "2026-01-10",
        txn_status: "Approved",
      },
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const sub = await post(
      t.entry.api,
      "warehouse",
      c.body.id,
      "submit",
      c.body.version,
    );
    expect(sub.status).toBe(422);
    expect(sub.body.errors[0]).toMatchObject({
      path: "/lines",
      code: "lines_required",
    });
    const withSite = await t.entry.api.call("post", recPath("warehouse"), {
      site_id: site.id,
      record_type: "pl",
      data: { doc_no: `PLS-${U}` },
    });
    expect(withSite.status).toBe(422);
    expect(withSite.body.errors[0]).toMatchObject({
      path: "/site_id",
      code: "not_site_scoped",
    });
  });
});

describe("the As-Built item list", () => {
  it("lists the seeded items linked to Warehouse codes; adds, renames, relinks and deactivates them (admin only, audited); the register follows", async () => {
    const list = await admin.api.call(
      "get",
      "/as-built/items?include_inactive=true",
    );
    expect(list.status).toBe(200);
    const cw = list.body.items.filter(
      (i: { section: string }) => i.section === "cw",
    );
    expect(cw).toHaveLength(31);
    expect(
      cw.find((i: { code: string }) => i.code === "PATCH_CORD_FIBER"),
    ).toMatchObject({
      master_column: "L",
      warehouse_item_code: "CW-07",
      unit: "m",
      field_code: "q_patch_cord_fiber",
    });
    expect(
      cw.find((i: { code: string }) => i.code === "CONCRETE_PLAIN")
        .warehouse_item_code,
    ).toBeNull(); // concrete stays As-Built only (Q74)

    const code = `X_${U}`;
    const body = {
      code,
      section: "cw",
      name_en: "Cable Clamp (pcs)",
      unit: "pcs",
      master_column: "AI",
      warehouse_item_code: "CW-26",
      reason: "New CW item",
    };
    const denied = await t.entry.api.call("post", "/as-built/items", body);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("action_forbidden");
    const taken = await admin.api.call("post", "/as-built/items", body);
    expect(taken.status).toBe(422); // CW-26 (DC Box) is linked to DC_BOX already
    expect(taken.body.errors[0]).toMatchObject({
      path: "/warehouse_item_code",
      code: "already_linked",
    });
    const c = await admin.api.call("post", "/as-built/items", {
      ...body,
      warehouse_item_code: null,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body).toMatchObject({
      code,
      section: "cw",
      field_code: `q_${code.toLowerCase()}`,
      is_active: true,
      version: 1,
    });
    expect(
      (
        await admin.api.call("post", "/as-built/items", {
          ...body,
          warehouse_item_code: null,
        })
      ).status,
    ).toBe(409);

    // the new item is a field of the register at once, and the quantity rules apply to it
    const reg = (await admin.api.call("get", "/registers")).body.items.find(
      (r: { register_key: string }) => r.register_key === "as_built",
    );
    expect(
      reg.fields.find(
        (f: { code: string }) => f.code === `q_${code.toLowerCase()}`,
      ),
    ).toMatchObject({
      label_en: "Cable Clamp (pcs)",
      type: "number",
      section: "CW quantities",
    });
    expect(reg.fields.map((f: { code: string }) => f.code)).toEqual(
      expect.arrayContaining([
        "q_tower",
        "q_sector_qty",
        "configuration",
        "rsl",
      ]),
    );

    const ab = await team2();
    const field = `q_${code.toLowerCase()}`;
    const rec = await ab.entry.api.call("post", recPath("as_built"), {
      site_id: ab.site.id,
      data: { q_tower: 12.5, [field]: 3, configuration: "WL" },
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const frac = await ab.entry.api.call(
      "patch",
      recPath("as_built", rec.body.id),
      { data: { [field]: 2.5, q_tower_x: 1 } },
      { "If-Match": `"${rec.body.version}"` },
    );
    expect(frac.status).toBe(422); // the unknown field
    const bad = await ab.entry.api.call(
      "patch",
      recPath("as_built", rec.body.id),
      { data: { [field]: 2.5, q_busbar: -1 } },
      { "If-Match": `"${rec.body.version}"` },
    );
    expect(bad.status).toBe(200);
    const sub = await post(
      ab.entry.api,
      "as_built",
      rec.body.id,
      "submit",
      bad.body.version,
    );
    expect(sub.status).toBe(422);
    expect(sub.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: `/data/${field}`,
          code: "whole_units",
        }),
        expect.objectContaining({ path: "/data/q_busbar", code: "negative" }),
      ]),
    );
    const fixed = await ab.entry.api.call(
      "patch",
      recPath("as_built", rec.body.id),
      { data: { [field]: 4, q_busbar: 2 } },
      { "If-Match": `"${bad.body.version}"` },
    );
    const done = await approveFlex(ab, rec.body.id, fixed.body.version);
    expect(done.state).toBe("approved");
    expect(done.data).toMatchObject({ q_tower: 12.5, [field]: 4 });
    const second = await ab.entry.api.call("post", recPath("as_built"), {
      site_id: ab.site.id,
      data: {},
    });
    expect(second.status).toBe(409); // one record per site
    const away = await actor(app, db, {
      level: "entry",
      grants: G("as_built", "view"),
      regions: [R2],
      modules: null,
    });
    expect(
      (await away.api.call("get", recPath("as_built", rec.body.id))).status,
    ).toBe(404);
    const noModule = await actor(app, db, {
      grants: G("gecol", "view"),
      regions: [R],
      modules: null,
    });
    expect((await noModule.api.call("get", "/as-built/items")).status).toBe(
      403,
    );

    // rename, relink, in-use guard, deactivate
    const rn = await admin.api.call(
      "patch",
      `/as-built/items/${c.body.id}`,
      {
        name_en: "Cable Clamp 2 (pcs)",
        warehouse_item_code: "CW-26",
        reason: "Rename",
      },
      { "If-Match": '"1"' },
    );
    expect(rn.status).toBe(422);
    const ok = await admin.api.call(
      "patch",
      `/as-built/items/${c.body.id}`,
      {
        name_en: "Cable Clamp 2 (pcs)",
        name_ar: "مشبك",
        master_column: "AJ",
        reason: "Rename",
      },
      { "If-Match": '"1"' },
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      name_en: "Cable Clamp 2 (pcs)",
      master_column: "AJ",
      version: 2,
    });
    const reg2 = (await admin.api.call("get", "/registers")).body.items.find(
      (r: { register_key: string }) => r.register_key === "as_built",
    );
    expect(
      reg2.fields.find((f: { code: string }) => f.code === field).label_en,
    ).toBe("Cable Clamp 2 (pcs)");
    const unit = await admin.api.call(
      "patch",
      `/as-built/items/${c.body.id}`,
      { unit: "m", reason: "Change unit" },
      { "If-Match": '"2"' },
    );
    expect(unit.status).toBe(422);
    expect(unit.body.code).toBe("item_in_use");
    expect(
      (
        await t.entry.api.call(
          "patch",
          `/as-built/items/${c.body.id}`,
          { name_en: "zz", reason: "No right" },
          { "If-Match": '"2"' },
        )
      ).status,
    ).toBe(403);
    const off = await admin.api.call(
      "patch",
      `/as-built/items/${c.body.id}`,
      { is_active: false, reason: "Retired" },
      { "If-Match": '"2"' },
    );
    expect(off.status).toBe(200);
    const reg3 = (await admin.api.call("get", "/registers")).body.items.find(
      (r: { register_key: string }) => r.register_key === "as_built",
    );
    expect(reg3.fields.map((f: { code: string }) => f.code)).not.toContain(
      field,
    );
    const audit = await db.query(
      `SELECT action, before, after FROM audit_log WHERE entity_type = 'as_built_item' AND entity_id = $1 ORDER BY id`,
      [c.body.id],
    );
    expect(audit.rows.map((a) => a.action)).toEqual([
      "as_built_item_create",
      "as_built_item_update",
      "as_built_item_deactivate",
    ]);
    expect(audit.rows[1].before.name_en).toBe("Cable Clamp (pcs)");
    expect(audit.rows[1].after.name_en).toBe("Cable Clamp 2 (pcs)");
    // the value already entered is kept
    expect(
      (await ab.entry.api.call("get", recPath("as_built", rec.body.id))).body
        .data[field],
    ).toBe(4);
  });
});

/** An As-Built team of region 1 (region cells, so the global cells of the other suites do not matter). */
async function team2(): Promise<Team> {
  return team(app, db, "as_built", "as_built", R);
}
