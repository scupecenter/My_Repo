import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes } from "node:crypto";
import type { Client as PgClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Api } from "./helpers";
import { startApp, superDb } from "./helpers";
import { G, Team, approveFlex, patch, post, recPath } from "./reg-helpers";
import { Actor, Site, actor, makeSite, plainAdmin } from "./wf-helpers";

/**
 * Follow-up B of the technical decisions of 2026-11-04 (migration 0067), Warehouse:
 *   Q270 three movements take quarantined stock out again: repaired back to stock (ADJ), written off (ADJ), returned to supplier (DN to the vendor, sup_dn);
 *        each a Warehouse document with a reason, approved by L2 like any other;
 *   Q281 a site whose overall status is Cancelled is left out of the dispatch list; its own page still shows it.
 * Region 1 (the Tripoli sequences). Dates are fixed strings: nothing depends on the weekday or the clock.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let t: Team;
let site: Site;
const R = 1;
const U = randomBytes(3).toString("hex").toUpperCase();

async function globalCell(kind: "entry" | "review" | "approve", userId: string): Promise<void> {
  const level = kind === "entry" ? 1 : kind === "review" ? 2 : 3;
  await db.query(`DELETE FROM matrix_cells WHERE register_key = 'warehouse' AND level = $1 AND region_id IS NULL`, [level]);
  const c = await db.query(
    `INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ('warehouse', $1, 'any_one'::"MatrixRule", NULL, true, now()) RETURNING id`,
    [level],
  );
  await db.query(`INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, 'user'::"AssigneeKind", $2)`, [c.rows[0].id, userId]);
}
async function prepare(): Promise<void> {
  await globalCell("entry", t.entry.user.id);
  await globalCell("review", t.review.user.id);
  await globalCell("approve", t.approve.user.id);
  await db.query(`DELETE FROM matrix_cells WHERE register_key = 'warehouse' AND region_id = ANY($1::int[])`, [[R]]);
}

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  const entry = await actor(app, db, { level: "entry", grants: G("warehouse", "view", "create", "edit", "delete"), regions: [R], modules: null });
  const review = await actor(app, db, { level: "review", grants: G("warehouse", "view"), regions: [R], modules: null });
  const approve = await actor(app, db, { level: "approve", grants: G("warehouse", "view", "approve"), regions: [R], modules: null });
  site = await makeSite(db, R, { prefix: "QX" });
  t = { entry, review, approve, site, region: R, key: "warehouse" };
  await prepare();
});
beforeEach(async () => {
  await db.query("SELECT pg_advisory_lock(770101)"); // one test at a time with the other warehouse and matrix suites
  await prepare();
});
afterEach(async () => {
  await db.query("SELECT pg_advisory_unlock(770101)");
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const move = (body: Record<string, unknown>, api: Api = t.entry.api) => api.call("post", "/warehouse/movements", body);
const exitDoc = (body: Record<string, unknown>, api: Api = t.entry.api) => api.call("post", "/warehouse/quarantine-exits", body);
const approveMovement = async (m: any): Promise<any> => {
  const rec = await t.entry.api.call("get", recPath("warehouse", m.register_record_id));
  await approveFlex(t, rec.body.id, rec.body.version);
  return (await t.entry.api.call("get", `/warehouse/movements/${m.id}`)).body;
};
const doc = (type: string, extra: Record<string, unknown> = {}) => ({
  record_type: type,
  doc_no: `${type.toUpperCase()}-FB-${U}-${randomBytes(2).toString("hex")}`,
  doc_date: "2026-01-10",
  txn_status: "Approved",
  ...extra,
});
const stock = async (id: string): Promise<any> => {
  const res = await t.entry.api.call("get", `/warehouse/stock?item_id=${id}`);
  expect(res.status).toBe(200);
  return res.body.items[0];
};
const newItem = async (code: string, extra: Record<string, unknown> = {}): Promise<any> => {
  const res = await admin.api.call("post", "/warehouse/items", { code, name_en: `Item ${code}`, uom: "pcs", reason: "Follow-up B test item", ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};
const receive = async (item: any, qty: number, serialPrefix?: string): Promise<string[]> => {
  const serials = serialPrefix ? Array.from({ length: qty }, (_, k) => `${serialPrefix}-${U}-${k}`) : undefined;
  const pl = await move({ ...doc("pl"), lines: [{ item_id: item.id, qty, ...(serials ? { serials } : {}) }] });
  expect(pl.status, JSON.stringify(pl.body)).toBe(201);
  expect((await approveMovement(pl.body)).status).toBe("posted");
  return serials ?? [];
};
/** Receives `qty`, delivers them to the site and returns `bad` of them to quarantine (Faulty); the rest stay on the site. */
const quarantine = async (item: any, qty: number, bad: number, serials?: string[]): Promise<void> => {
  const dn = await move({ ...doc("cw_dn"), site_id: site.id, lines: [{ item_id: item.id, qty, ...(serials ? { serials } : {}) }] });
  expect(dn.status, JSON.stringify(dn.body)).toBe(201);
  await approveMovement(dn.body);
  const rn = await move({
    ...doc("cw_rn", { reason: "Faulty or Damaged" }), site_id: site.id,
    lines: [{ item_id: item.id, qty: bad, condition: "Faulty", ...(serials ? { serials: serials.slice(0, bad) } : {}) }],
  });
  expect(rn.status, JSON.stringify(rn.body)).toBe(201);
  await approveMovement(rn.body);
};
const reg = (id: string) => t.entry.api.call("get", recPath("warehouse", id));

describe("Q270: quarantined stock leaves quarantine through three movements", () => {
  it("repaired back to stock: pending it holds the quantity in quarantine; approved by L2 it moves quarantine to available", async () => {
    const it1 = await newItem(`QR-${U}`);
    await receive(it1, 10);
    await quarantine(it1, 10, 4);
    expect(await stock(it1.id)).toMatchObject({ on_hand: 0, available: 0, quarantine: 4, quarantine_pending: 0 });

    const ex = await exitDoc({ exit_kind: "repaired", reason: "Repaired by the vendor", doc_date: "2026-02-03", lines: [{ item_id: it1.id, qty: 3 }] });
    expect(ex.status, JSON.stringify(ex.body)).toBe(201);
    expect(ex.body).toMatchObject({ kind: "quarantine_exit", exit_kind: "repaired", record_type: "adj", status: "pending", site_id: null, exit_reason: "Repaired by the vendor" });
    expect(ex.body.doc_no).toMatch(/^ADJ-WH-\d{4}-\d{4}$/);
    expect(ex.body.lines[0]).toMatchObject({ item_id: it1.id, qty: 3 });
    // pending: nothing moved yet, the quantity is held
    expect(await stock(it1.id)).toMatchObject({ on_hand: 0, available: 0, quarantine: 4, quarantine_pending: 3 });
    // it is a register record that waits for L2 like any warehouse document
    const rec = await reg(ex.body.register_record_id);
    expect(rec.body).toMatchObject({ state: "entry", record_type: "adj" });
    expect(rec.body.data).toMatchObject({ exit_kind: "Repaired back to stock", exit_reason: "Repaired by the vendor" });

    const posted = await approveMovement(ex.body);
    expect(posted).toMatchObject({ status: "posted", doc_no_locked: true, doc_date: "2026-02-03" });
    expect(await stock(it1.id)).toMatchObject({ on_hand: 3, available: 3, quarantine: 1, quarantine_pending: 0 });
    // the repaired units can be issued again, the quarantined one cannot
    const dn = await move({ ...doc("cw_dn"), site_id: site.id, lines: [{ item_id: it1.id, qty: 3 }] });
    expect(dn.status, JSON.stringify(dn.body)).toBe(201);
    const over = await move({ ...doc("cw_dn"), site_id: site.id, lines: [{ item_id: it1.id, qty: 1 }] });
    expect(over.status).toBe(422);
    expect(over.body.code).toBe("insufficient_stock");
    // audited: the creation with the reason, and the posting
    const a = await db.query(`SELECT action, reason, after FROM audit_log WHERE entity_type = 'wh_movement' AND entity_id = $1 ORDER BY id`, [ex.body.id]);
    expect(a.rows.map((r) => r.action)).toEqual(["warehouse_quarantine_exit_create", "warehouse_quarantine_exit_posted"]);
    expect(a.rows[0].reason).toBe("Repaired by the vendor");
    expect(a.rows[1].after).toMatchObject({ exit_kind: "repaired", doc_no: ex.body.doc_no });
  });

  it("written off: quarantine to gone, on hand and available unchanged", async () => {
    const it1 = await newItem(`QW-${U}`);
    await receive(it1, 5);
    await quarantine(it1, 5, 5);
    expect(await stock(it1.id)).toMatchObject({ on_hand: 0, available: 0, quarantine: 5 });
    const ex = await exitDoc({ exit_kind: "written_off", reason: "Beyond repair, scrapped", lines: [{ item_id: it1.id, qty: 2 }] });
    expect(ex.status, JSON.stringify(ex.body)).toBe(201);
    expect(ex.body).toMatchObject({ exit_kind: "written_off", record_type: "adj" });
    await approveMovement(ex.body);
    expect(await stock(it1.id)).toMatchObject({ on_hand: 0, available: 0, quarantine: 3, quarantine_pending: 0 });
  });

  it("returned to supplier: a DN to the vendor (sup_dn, its own numbering), quarantine to out, nothing added to the stock", async () => {
    const it1 = await newItem(`QS-${U}`);
    await receive(it1, 6);
    await quarantine(it1, 6, 6);
    const ex = await exitDoc({ exit_kind: "returned_to_supplier", reason: "Sent back under warranty", remark: "RMA 77", lines: [{ item_id: it1.id, qty: 6 }] });
    expect(ex.status, JSON.stringify(ex.body)).toBe(201);
    expect(ex.body).toMatchObject({ exit_kind: "returned_to_supplier", record_type: "sup_dn", sequence_key: "DN-SUP-WH" });
    expect(ex.body.doc_no).toMatch(/^DN-SUP-WH-\d{4}-\d{4}$/);
    await approveMovement(ex.body);
    expect(await stock(it1.id)).toMatchObject({ on_hand: 0, available: 0, quarantine: 0, quarantine_pending: 0 });
    const list = await t.entry.api.call("get", "/warehouse/movements?kind=quarantine_exit&limit=100");
    expect(list.status).toBe(200);
    expect(list.body.items.map((m: any) => m.id)).toContain(ex.body.id);
    expect(list.body.items.every((m: any) => m.kind === "quarantine_exit")).toBe(true);
  });

  it("the quantity is limited to the quarantine that is not already in a pending exit; a cancelled exit releases it", async () => {
    const it1 = await newItem(`QL-${U}`);
    await receive(it1, 8);
    await quarantine(it1, 8, 5);
    const a = await exitDoc({ exit_kind: "written_off", reason: "First", lines: [{ item_id: it1.id, qty: 4 }] });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await exitDoc({ exit_kind: "repaired", reason: "Second", lines: [{ item_id: it1.id, qty: 2 }] });
    expect(b.status).toBe(422);
    expect(b.body.code).toBe("insufficient_stock");
    expect(JSON.stringify(b.body)).toContain("1 can leave quarantine");
    // nothing to take out of an item with no quarantine
    const clean = await newItem(`QN-${U}`);
    await receive(clean, 3);
    const none = await exitDoc({ exit_kind: "repaired", reason: "Nothing there", lines: [{ item_id: clean.id, qty: 1 }] });
    expect(none.status).toBe(422);
    // cancel the first (a void with a reason and step-up): the quantity is free again
    await t.entry.api.stepUp(t.entry.user.password);
    const cancel = await t.entry.api.call("post", `/warehouse/movements/${a.body.id}/cancel`, { reason: "Entered twice" }, { "If-Match": `"${a.body.version}"` });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.status).toBe("cancelled");
    expect(await stock(it1.id)).toMatchObject({ quarantine: 5, quarantine_pending: 0 });
    const c = await exitDoc({ exit_kind: "repaired", reason: "Third", lines: [{ item_id: it1.id, qty: 5 }] });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
  });

  it("a reason is required; the kind and the quantity are checked; no fraction in pieces", async () => {
    const it1 = await newItem(`QV-${U}`);
    await receive(it1, 2);
    await quarantine(it1, 2, 2);
    const line = { item_id: it1.id, qty: 1 };
    expect((await exitDoc({ exit_kind: "repaired", lines: [line] })).status).toBe(422);
    const short = await exitDoc({ exit_kind: "repaired", reason: "ab", lines: [line] });
    expect(short.status).toBe(422);
    expect((await exitDoc({ exit_kind: "melted", reason: "Because", lines: [line] })).status).toBe(422);
    expect((await exitDoc({ exit_kind: "repaired", reason: "Because", lines: [] })).status).toBe(422);
    expect((await exitDoc({ exit_kind: "repaired", reason: "Because", lines: [{ item_id: it1.id, qty: 0 }] })).status).toBe(422);
    expect((await exitDoc({ exit_kind: "repaired", reason: "Because", lines: [{ item_id: it1.id, qty: -1 }] })).status).toBe(422);
    const frac = await exitDoc({ exit_kind: "repaired", reason: "Because", lines: [{ item_id: it1.id, qty: 1.5 }] });
    expect(frac.status).toBe(422);
    expect((await exitDoc({ exit_kind: "repaired", reason: "Because", extra: 1, lines: [line] })).status).toBe(422);     // unknown keys are refused
    expect((await exitDoc({ exit_kind: "repaired", reason: "Because", lines: [{ item_id: "00000000-0000-4000-8000-000000000000", qty: 1 }] })).status).toBe(422);
    expect(await stock(it1.id)).toMatchObject({ quarantine: 2, quarantine_pending: 0 });
  });

  it("serial-tracked items: one serial per unit, each quarantined and not in another pending exit; the serials leave the status Returned when it posts", async () => {
    const trk = await newItem(`QT-${U}`, { serial_tracked: true });
    const serials = await receive(trk, 3, "QT");
    await quarantine(trk, 3, 2, serials);                                  // serials 0 and 1 are returned Faulty, 2 stays on the site
    const status = async (s: string): Promise<string> => (await db.query(`SELECT status FROM warehouse_serials WHERE serial_no = $1`, [s])).rows[0].status;
    expect(await status(serials[0]!)).toBe("Returned");
    // the serial list is required and must be quarantined
    const noSerials = await exitDoc({ exit_kind: "repaired", reason: "Fixed", lines: [{ item_id: trk.id, qty: 1 }] });
    expect(noSerials.status).toBe(422);
    expect(noSerials.body.errors[0]).toMatchObject({ path: "/lines/0/serials", code: "serial_count" });
    const onSite = await exitDoc({ exit_kind: "repaired", reason: "Fixed", lines: [{ item_id: trk.id, qty: 1, serials: [serials[2]!] }] });
    expect(onSite.status).toBe(422);
    expect(onSite.body.errors[0]).toMatchObject({ code: "serial_not_quarantined" });
    const plain = await newItem(`QP-${U}`);
    const wrong = await exitDoc({ exit_kind: "repaired", reason: "Fixed", lines: [{ item_id: plain.id, qty: 1, serials: ["X1"] }] });
    expect(wrong.status).toBe(422);
    // repaired: serial 0 goes back In Stock; written off: serial 1 is Written Off
    const fix = await exitDoc({ exit_kind: "repaired", reason: "Fixed", lines: [{ item_id: trk.id, qty: 1, serials: [serials[0]!] }] });
    expect(fix.status, JSON.stringify(fix.body)).toBe(201);
    const twice = await exitDoc({ exit_kind: "written_off", reason: "Scrap", lines: [{ item_id: trk.id, qty: 1, serials: [serials[0]!] }] });
    expect(twice.status).toBe(422);
    expect(twice.body.errors[0]).toMatchObject({ code: "serial_reserved" });
    const scrap = await exitDoc({ exit_kind: "written_off", reason: "Scrap", lines: [{ item_id: trk.id, qty: 1, serials: [serials[1]!] }] });
    expect(scrap.status, JSON.stringify(scrap.body)).toBe(201);
    await approveMovement(fix.body);
    await approveMovement(scrap.body);
    expect(await status(serials[0]!)).toBe("In Stock");
    expect(await status(serials[1]!)).toBe("Written Off");
    expect(await stock(trk.id)).toMatchObject({ on_hand: 1, quarantine: 0 });
    // the repaired serial can be delivered again; the written-off one cannot
    const dn = await move({ ...doc("te_dn"), site_id: site.id, lines: [{ item_id: trk.id, qty: 1, serials: [serials[0]!] }] });
    expect(dn.status, JSON.stringify(dn.body)).toBe(201);
  });

  it("returned to supplier moves the serials to Returned to Supplier", async () => {
    const trk = await newItem(`QU-${U}`, { serial_tracked: true });
    const serials = await receive(trk, 1, "QU");
    await quarantine(trk, 1, 1, serials);
    const ex = await exitDoc({ exit_kind: "returned_to_supplier", reason: "Warranty", lines: [{ item_id: trk.id, qty: 1, serials }] });
    expect(ex.status, JSON.stringify(ex.body)).toBe(201);
    await approveMovement(ex.body);
    expect((await db.query(`SELECT status FROM warehouse_serials WHERE serial_no = $1`, [serials[0]])).rows[0].status).toBe("Returned to Supplier");
  });

  it("the L2 approval is the normal one: L1 submits, a non-approver cannot approve it, and the kind in the record cannot be edited into another", async () => {
    const it1 = await newItem(`QA-${U}`);
    await receive(it1, 3);
    await quarantine(it1, 3, 3);
    const ex = await exitDoc({ exit_kind: "written_off", reason: "Scrap", lines: [{ item_id: it1.id, qty: 1 }] });
    const rec = (await reg(ex.body.register_record_id)).body;
    // someone changes the record's kind: the submit refuses it
    const edit = await patch(t.entry.api, "warehouse", rec.id, rec.version, { data: { exit_kind: "Repaired back to stock" } });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const bad = await post(t.entry.api, "warehouse", rec.id, "submit", edit.body.version);
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/data/exit_kind", code: "exit_kind_fixed" })]));
    const back = await patch(t.entry.api, "warehouse", rec.id, edit.body.version, { data: { exit_kind: "Written off", exit_reason: "" } });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const noReason = await post(t.entry.api, "warehouse", rec.id, "submit", back.body.version);
    expect(noReason.status).toBe(422);
    expect(noReason.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/data/exit_reason", code: "required" })]));
    const fixed = await patch(t.entry.api, "warehouse", rec.id, back.body.version, { data: { exit_reason: "Scrap, confirmed" } });
    const sub = await post(t.entry.api, "warehouse", rec.id, "submit", fixed.body.version);
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    // the entry holder cannot approve it (the review holder neither)
    await t.entry.api.stepUp(t.entry.user.password);
    expect((await post(t.entry.api, "warehouse", rec.id, "approve", sub.body.version)).status).toBe(403);
    expect((await t.entry.api.call("get", `/warehouse/movements/${ex.body.id}`)).body.status).toBe("pending");
  });

  it("permission denied: a reader of the Warehouse cannot create an exit, and a caller without the module is refused", async () => {
    const it1 = await newItem(`QD-${U}`);
    await receive(it1, 2);
    await quarantine(it1, 2, 2);
    const body = { exit_kind: "written_off", reason: "Scrap", lines: [{ item_id: it1.id, qty: 1 }] };
    const reader = await actor(app, db, { grants: G("warehouse", "view"), regions: [R], modules: null });
    const r1 = await exitDoc(body, reader.api);
    expect(r1.status).toBe(403);
    const other = await actor(app, db, { grants: G("gecol", "view"), regions: [R], modules: null });
    expect((await exitDoc(body, other.api)).status).toBe(403);
    // nothing was held
    expect(await stock(it1.id)).toMatchObject({ quarantine: 2, quarantine_pending: 0 });
  });
});

describe("Q281: a Cancelled site is left out of the TE dispatch list but stays on its own page", () => {
  const teSite = async (prefix: string, status?: string): Promise<Site> => {
    const s = await makeSite(db, R, { prefix });
    await db.query(`UPDATE sites SET scope_te_full = 'yes' WHERE id = $1`, [s.id]);
    if (status) await db.query(`UPDATE sites SET overall_status = $2::"OverallStatus" WHERE id = $1`, [s.id, status]);
    return s;
  };
  const codes = async (query: string): Promise<string[]> => {
    const res = await t.entry.api.call("get", `/warehouse/dispatch-status?${query}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.items.map((d: any) => d.site_code);
  };

  it("the list and its need_status filter leave the cancelled site out; the site's own dispatch page still answers", async () => {
    const live = await teSite("QZL", "in_progress");
    const gone = await teSite("QZC", "cancelled");
    const ok = await codes(`region_id=${R}&q=QZ&limit=200`);
    expect(ok).toContain(live.code);
    expect(ok).not.toContain(gone.code);
    const ns = (await t.entry.api.call("get", `/warehouse/dispatch-status/${live.id}`)).body.need_status;
    expect(await codes(`region_id=${R}&q=QZ&need_status=${ns}&limit=200`)).toEqual([live.code]);
    expect(await codes(`region_id=${R}&q=${gone.code}&limit=200`)).toEqual([]);
    expect(await codes(`q=${gone.code}&need_status=${ns}`)).toEqual([]);
    // its own page is unchanged
    const own = await t.entry.api.call("get", `/warehouse/dispatch-status/${gone.id}`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body).toMatchObject({ site_code: gone.code, te_applies: true });
    // reopened (no longer cancelled): back in the list
    await db.query(`UPDATE sites SET overall_status = 'on_hold' WHERE id = $1`, [gone.id]);
    expect(await codes(`region_id=${R}&q=${gone.code}`)).toEqual([gone.code]);
  });
});
