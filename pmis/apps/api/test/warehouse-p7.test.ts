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
import { G, Team, approveFlex, post, recPath } from "./reg-helpers";
import { Actor, Site, actor, makeSite, plainAdmin } from "./wf-helpers";

/**
 * Migration 0053 (work package P7; owner answers Q105, Q106, Q107 and decision D6):
 *   Q105 a Faulty or Damaged return goes to quarantine, never back to the available stock;
 *   Q106 automatic numbering (doc_sequences), a typed number still accepted, the Doc No. locked after posting;
 *   Q107 need rules confirmed / pending configuration, code source; a pending need never counts toward complete;
 *   D6   the TE Dispatch Complete date (the latest posted TE DN, Q65) beside the need-based status complete / short.
 * Region 1 (TR, the seeded sequences) and region 6 (no sequence seeded). Dates are fixed strings: nothing depends on the weekday or the clock.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let t: Team;
let site: Site;
const R = 1;
const R6 = 6;
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
async function prepare(): Promise<void> {
  await globalCell("entry", t.entry.user.id);
  await globalCell("review", t.review.user.id);
  await globalCell("approve", t.approve.user.id);
  await db.query(
    `DELETE FROM matrix_cells WHERE register_key = 'warehouse' AND region_id = ANY($1::int[])`,
    [[R, R6]],
  );
}

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  const entry = await actor(app, db, {
    level: "entry",
    grants: G("warehouse", "view", "create", "edit", "delete"),
    regions: [R, R6],
    modules: null,
  });
  const review = await actor(app, db, {
    level: "review",
    grants: G("warehouse", "view"),
    regions: [R, R6],
    modules: null,
  });
  const approve = await actor(app, db, {
    level: "approve",
    grants: G("warehouse", "view", "approve"),
    regions: [R, R6],
    modules: null,
  });
  site = await makeSite(db, R, { prefix: "WP" });
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
  doc_no: `${type.toUpperCase()}-P7-${U}-${randomBytes(2).toString("hex")}`,
  doc_date: "2026-01-10",
  txn_status: "Approved",
  ...extra,
});
const stock = async (id: string): Promise<any> => {
  const res = await t.entry.api.call("get", `/warehouse/stock?item_id=${id}`);
  expect(res.status).toBe(200);
  return res.body.items[0];
};
const itemByCode = async (code: string): Promise<any> => {
  const res = await admin.api.call(
    "get",
    `/warehouse/items?limit=200&include_inactive=true&q=${encodeURIComponent(code)}`,
  );
  return res.body.items.find((i: any) => i.code === code);
};
const newItem = async (
  code: string,
  extra: Record<string, unknown> = {},
): Promise<any> => {
  const res = await admin.api.call("post", "/warehouse/items", {
    code,
    name_en: `Item ${code}`,
    uom: "pcs",
    reason: "P7 test item",
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};
/** Other suites add test items with unrestricted need rules (for example a "Router" rule of quantity 2): keep them out of the dispatch cases (region 7 only). */
const isolateNeedRules = async (): Promise<void> => {
  await db.query(
    `UPDATE warehouse_item_need_rules n SET applies_when = '{"region_ids": [7]}'::jsonb FROM warehouse_items i
     WHERE i.id = n.item_id AND n.applies_when IS NULL AND i.item_code NOT IN ('C280500A101A', 'C000000L114A', 'WG5-DUAL-BS', 'HANT262890',
       'KZ00-65F', 'KH14-056', 'S9500', 'S9501', 'S9700', 'MTS9514A', '800-00211')`,
  );
};
/** Receives qty into the central store (posted PL); serial-tracked items get generated serials. */
const receive = async (
  item: any,
  qty: number,
  serialPrefix?: string,
): Promise<string[]> => {
  const serials = serialPrefix
    ? Array.from({ length: qty }, (_, k) => `${serialPrefix}-${U}-${k}`)
    : undefined;
  const pl = await move({
    ...doc("pl"),
    lines: [{ item_id: item.id, qty, ...(serials ? { serials } : {}) }],
  });
  expect(pl.status, JSON.stringify(pl.body)).toBe(201);
  expect((await approveMovement(pl.body)).status).toBe("posted");
  return serials ?? [];
};

describe("Q105: Faulty and Damaged returns are quarantined", () => {
  it("a Good return goes back to the available stock; a Faulty or Damaged one is held in quarantine and cannot be issued", async () => {
    const it1 = await newItem(`QA-${U}`);
    await receive(it1, 10);
    const dn = await move({
      ...doc("cw_dn"),
      site_id: site.id,
      lines: [{ item_id: it1.id, qty: 10 }],
    });
    expect(dn.status, JSON.stringify(dn.body)).toBe(201);
    await approveMovement(dn.body);
    expect(await stock(it1.id)).toMatchObject({
      on_hand: 0,
      available: 0,
      quarantine: 0,
    });

    // three return notes: Faulty (line), Damaged (document condition), Good
    const faulty = await move({
      ...doc("cw_rn", { reason: "Faulty or Damaged" }),
      site_id: site.id,
      lines: [{ item_id: it1.id, qty: 3, condition: "Faulty" }],
    });
    const damaged = await move({
      ...doc("cw_rn", { reason: "Other", condition: "Damaged" }),
      site_id: site.id,
      lines: [{ item_id: it1.id, qty: 2 }],
    });
    const good = await move({
      ...doc("cw_rn", { reason: "Relocation" }),
      site_id: site.id,
      lines: [{ item_id: it1.id, qty: 1, condition: "Good" }],
    });
    for (const m of [faulty, damaged, good])
      expect(m.status, JSON.stringify(m.body)).toBe(201);
    await approveMovement(faulty.body);
    await approveMovement(damaged.body);
    await approveMovement(good.body);

    const s = await stock(it1.id);
    expect(s).toMatchObject({ on_hand: 1, available: 1, quarantine: 5 });
    // the damaged document's condition is written on its line when it posts
    const posted = await t.entry.api.call(
      "get",
      `/warehouse/movements/${damaged.body.id}`,
    );
    expect(posted.body.lines[0].condition).toBe("Damaged");
    // only the good unit can be issued again
    const over = await move({
      ...doc("cw_dn"),
      site_id: site.id,
      lines: [{ item_id: it1.id, qty: 2 }],
    });
    expect(over.status).toBe(422);
    expect(over.body.code).toBe("insufficient_stock");
    // the site holds what was not returned, whatever the condition
    const onSite = await t.entry.api.call(
      "get",
      `/warehouse/stock?item_id=${it1.id}&site_id=${site.id}`,
    );
    expect(onSite.body.items[0]).toMatchObject({ on_hand: 4, quarantine: 0 });
  });

  it("a return for Faulty or Damaged must name the condition before the submit; a quarantined serial is not In Stock", async () => {
    const trk = await newItem(`QS-${U}`, { serial_tracked: true });
    const [s0] = await receive(trk, 1, "QS");
    const dn = await move({
      ...doc("te_dn"),
      site_id: site.id,
      lines: [{ item_id: trk.id, qty: 1, serials: [s0] }],
    });
    await approveMovement(dn.body);
    const rn = await move({
      ...doc("te_rn", { reason: "Faulty or Damaged" }),
      site_id: site.id,
      lines: [{ item_id: trk.id, qty: 1, serials: [s0] }],
    });
    expect(rn.status, JSON.stringify(rn.body)).toBe(201);
    const rec = await t.entry.api.call(
      "get",
      recPath("warehouse", rn.body.register_record_id),
    );
    const sub = await post(
      t.entry.api,
      "warehouse",
      rec.body.id,
      "submit",
      rec.body.version,
    );
    expect(sub.status).toBe(422);
    expect(sub.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/lines/0/condition",
          code: "condition_required",
        }),
      ]),
    );
    const fixed = await t.entry.api.call(
      "patch",
      recPath("warehouse", rec.body.id),
      { data: { condition: "Faulty" } },
      { "If-Match": `"${rec.body.version}"` },
    );
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    await approveMovement(rn.body);
    expect(await stock(trk.id)).toMatchObject({
      on_hand: 0,
      available: 0,
      quarantine: 1,
    });
    const ser = await db.query(
      `SELECT status, return_condition FROM warehouse_serials WHERE serial_no = $1`,
      [s0],
    );
    expect(ser.rows[0]).toMatchObject({
      status: "Returned",
      return_condition: "Faulty",
    });
    const again = await move({
      ...doc("te_dn"),
      site_id: site.id,
      lines: [{ item_id: trk.id, qty: 1, serials: [s0] }],
    });
    expect(again.status).toBe(422);
  });
});

describe("Q106: numbering service and the Doc No. lock", () => {
  it("numbers a document without a Doc No. from the sequence of its type and region; a typed number is still accepted", async () => {
    const it1 = await newItem(`NM-${U}`);
    await receive(it1, 5);
    const { doc_no: _x, ...noNumber } = doc("cw_dn");
    void _x;
    const a = await move({
      ...noNumber,
      site_id: site.id,
      lines: [{ item_id: it1.id, qty: 1 }],
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.doc_no).toMatch(/^DN-CW-TR-2026-\d{4}$/);
    expect(a.body.sequence_key).toBe("DN-CW-TR");
    const b = await move({
      ...noNumber,
      site_id: site.id,
      lines: [{ item_id: it1.id, qty: 1 }],
    });
    const n = (x: string) => Number(x.slice(-4));
    expect(n(b.body.doc_no)).toBeGreaterThan(n(a.body.doc_no));
    // the issue is audited
    const audit = await db.query(
      `SELECT after FROM audit_log WHERE action = 'doc_number_issue' AND entity_id = $1`,
      [a.body.register_record_id],
    );
    expect(audit.rows[0].after).toMatchObject({
      doc_no: a.body.doc_no,
      sequence_key: "DN-CW-TR",
    });
    // a typed number: accepted when unique, refused when a sequence issued it (even if its document is voided)
    const typed = await move({
      ...doc("cw_dn"),
      site_id: site.id,
      lines: [{ item_id: it1.id, qty: 1 }],
    });
    expect(typed.status).toBe(201);
    expect(typed.body.sequence_key).toBeNull();
    await t.entry.api.stepUp(t.entry.user.password);
    const cancel = await t.entry.api.call(
      "post",
      `/warehouse/movements/${a.body.id}/cancel`,
      { reason: "Wrong site" },
      { "If-Match": `"${a.body.version}"` },
    );
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    const reuse = await move({
      ...doc("cw_dn", { doc_no: a.body.doc_no }),
      site_id: site.id,
      lines: [{ item_id: it1.id, qty: 1 }],
    });
    expect(reuse.status).toBe(409);
  });

  it("locks the Doc No. once the movement posts: an edit or a new version cannot change it", async () => {
    const it1 = await newItem(`LK-${U}`);
    await receive(it1, 2);
    const m = await move({
      ...doc("cw_dn"),
      site_id: site.id,
      lines: [{ item_id: it1.id, qty: 1 }],
    });
    const done = await approveMovement(m.body);
    expect(done).toMatchObject({ status: "posted", doc_no_locked: true });
    const rec = await t.entry.api.call(
      "get",
      recPath("warehouse", m.body.register_record_id),
    );
    const nv = await t.entry.api.call(
      "post",
      recPath("warehouse", rec.body.id, "/versions"),
      {},
      { "If-Match": `"${rec.body.version}"` },
    );
    expect(nv.status, JSON.stringify(nv.body)).toBe(201);
    const edit = await t.entry.api.call(
      "patch",
      recPath("warehouse", nv.body.id),
      { data: { doc_no: `CHANGED-${U}` } },
      { "If-Match": `"${nv.body.version}"` },
    );
    expect(edit.status).toBe(422);
    expect(edit.body.errors[0]).toMatchObject({
      path: "/data/doc_no",
      code: "doc_no_locked",
    });
    // the remark of the new version may still change
    const remark = await t.entry.api.call(
      "patch",
      recPath("warehouse", nv.body.id),
      { data: { remark: "Corrected remark" } },
      { "If-Match": `"${nv.body.version}"` },
    );
    expect(remark.status, JSON.stringify(remark.body)).toBe(200);
  });

  it("a region without a sequence keeps a typed number; the admin adds one (validated, audited, next number only up)", async () => {
    const site6 = await makeSite(db, R6, { prefix: "WQ" });
    const it1 = await newItem(`RG-${U}`);
    await receive(it1, 5);
    const { doc_no: _x, ...noNumber } = doc("te_dn");
    void _x;
    const none = await move({
      ...noNumber,
      site_id: site6.id,
      lines: [{ item_id: it1.id, qty: 1 }],
    });
    expect(none.status).toBe(201);
    expect(none.body.doc_no).toBeNull();

    const list = await admin.api.call("get", "/number-sequences");
    expect(list.status).toBe(200);
    expect(list.body.items.map((s: any) => s.key)).toEqual(
      expect.arrayContaining(["DN-CW-TR", "RN-CW-TR", "PAC-CW-TR", "PL-WH"]),
    );
    const key = `DN-TE-G${U.slice(0, 3)}`;
    const body = {
      key,
      record_type: "te_dn",
      region_id: R6,
      region_code: "GM",
      pattern: "DN-TE-{REGION}-{YYYY}-{SEQ:4}",
      reason: "Region code given",
    };
    expect(
      (await t.entry.api.call("post", "/number-sequences", body)).status,
    ).toBe(403);
    const bad = await admin.api.call("post", "/number-sequences", {
      ...body,
      pattern: "DN-TE-{REGION}-{SEQ:4}",
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ code: "year_required" });
    const unknown = await admin.api.call("post", "/number-sequences", {
      ...body,
      colour: "red",
    });
    expect(unknown.status).toBe(422);
    const ok = await admin.api.call("post", "/number-sequences", {
      ...body,
      next_value: 41,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({
      key,
      next_value: 41,
      region_id: R6,
      version: 1,
    });
    const down = await admin.api.call(
      "patch",
      `/number-sequences/${key}`,
      { next_value: 3, reason: "Lower it" },
      { "If-Match": '"1"' },
    );
    expect(down.status).toBe(422);
    expect(down.body.errors[0]).toMatchObject({ code: "only_up" });

    const numbered = await move({
      ...noNumber,
      doc_date: "2026-03-01",
      site_id: site6.id,
      lines: [{ item_id: it1.id, qty: 1 }],
    });
    expect(numbered.body.doc_no).toBe("DN-TE-GM-2026-0041");
    const audit = await db.query(
      `SELECT action, reason FROM audit_log WHERE entity_type = 'doc_sequence' AND entity_id = $1`,
      [key],
    );
    expect(audit.rows).toEqual([
      { action: "doc_sequence_create", reason: "Region code given" },
    ]);
  });
});

describe("Q107 and D6: need rules, the TE dispatch date and the need status", () => {
  it("shows the code source and the rule status; a pending need is the default; confirmed needs a quantity", async () => {
    const lpu = await itemByCode("C000000L114A");
    expect(lpu).toMatchObject({ code_source: "master" });
    expect(lpu.need_rules[0]).toMatchObject({
      need_unit: "LPU Kit",
      quantity: 2,
      status: "confirmed",
    });
    const bts = await itemByCode("C280500A101A");
    expect(bts.need_rules[0]).toMatchObject({
      status: "pending_configuration",
      quantity_rule: { per: "rf_sector", wl_vendor: "Cambium" },
    });
    expect((await itemByCode("CW-01")).code_source).toBe(
      "internal_provisional",
    );
    expect((await itemByCode("SFP-SM-10G-10KM")).code_source).toBe(
      "internal_provisional",
    );

    const it1 = await newItem(`NR-${U}`, {
      // limited to region 7, so the dispatch cases of region 1 below do not meet it
      need_rules: [
        { need_unit: "Router", quantity: 1, applies_when: { region_ids: [7] } },
      ],
    });
    expect(it1.need_rules[0].status).toBe("pending_configuration");
    const noQty = await admin.api.call(
      "patch",
      `/warehouse/items/${it1.id}`,
      {
        need_rules: [{ need_unit: "Router", status: "confirmed" }],
        reason: "Confirm",
      },
      { "If-Match": `"${it1.version}"` },
    );
    expect(noQty.status).toBe(422);
    const badRule = await admin.api.call(
      "patch",
      `/warehouse/items/${it1.id}`,
      {
        need_rules: [{ need_unit: "Router", quantity_rule: { per: "tower" } }],
        reason: "Odd",
      },
      { "If-Match": `"${it1.version}"` },
    );
    expect(badRule.status).toBe(422);
    const gaps = await t.entry.api.call("get", "/warehouse/config-gaps");
    expect(gaps.status).toBe(200);
    expect(
      gaps.body.pending_need_rules.map((g: any) => g.item_code),
    ).toEqual(expect.arrayContaining(["C280500A101A", "KZ00-65F", it1.code]));
    expect(gaps.body.provisional_codes.map((g: any) => g.item_code)).toContain(
      "CW-28",
    );
    expect(gaps.body.regions_without_wl_vendor).toContain(1);
  });

  it("an IP Router Only site needs the router only (Q6): complete once a router model is delivered; the date is the latest posted TE DN (Q65)", async () => {
    await isolateNeedRules();
    const ro = await makeSite(db, R, { prefix: "WR" });
    await db.query(
      `UPDATE sites SET scope_te_full = 'na', scope_te_ip_router_only = 'yes' WHERE id = $1`,
      [ro.id],
    );
    const start = await t.entry.api.call(
      "get",
      `/warehouse/dispatch-status/${ro.id}`,
    );
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    expect(start.body).toMatchObject({
      te_applies: true,
      router_only: true,
      need_status: "short",
      te_dispatch_complete_date: null,
    });
    expect(start.body.lines.map((l: any) => l.need_unit)).toEqual(["Router"]);

    const router = await itemByCode("S9501");
    const sfp = await newItem(`SF-${U}`);
    const [r0] = await receive(router, 1, "RT");
    await receive(sfp, 2);
    const dn1 = await move({
      ...doc("te_dn", { doc_date: "2026-02-01" }),
      site_id: ro.id,
      lines: [{ item_id: router.id, qty: 1, serials: [r0] }],
    });
    const dn2 = await move({
      ...doc("te_dn", { doc_date: "2026-01-15" }),
      site_id: ro.id,
      lines: [{ item_id: sfp.id, qty: 1 }],
    });
    const dn3 = await move({
      ...doc("te_dn", { doc_date: "2026-03-20" }),
      site_id: ro.id,
      lines: [{ item_id: sfp.id, qty: 1 }],
    }); // stays pending: it does not count
    for (const m of [dn1, dn2, dn3])
      expect(m.status, JSON.stringify(m.body)).toBe(201);
    await approveMovement(dn1.body);
    await approveMovement(dn2.body); // posted after dn1, with an earlier date

    const d = await t.entry.api.call(
      "get",
      `/warehouse/dispatch-status/${ro.id}`,
    );
    expect(d.body).toMatchObject({
      need_status: "complete",
      te_dispatch_complete_date: "2026-02-01",
      latest_te_dn_no: dn1.body.doc_no,
      short_lines: 0,
      pending_lines: 0,
    });
    expect(d.body.lines[0]).toMatchObject({
      need_group: "ROUTER",
      rule_status: "confirmed",
      need: 1,
      delivered: 1,
      short: 0,
      line_status: "complete",
    });
  });

  it("a TE Full site is short until the confirmed needs are met, then pending configuration (never complete) while sector and MW needs are pending", async () => {
    await isolateNeedRules();
    const te = await makeSite(db, R, { prefix: "WT" });
    await db.query(
      `UPDATE sites SET scope_te_full = 'yes', scope_te_ip_router_only = 'na' WHERE id = $1`,
      [te.id],
    );
    const first = (
      await t.entry.api.call("get", `/warehouse/dispatch-status/${te.id}`)
    ).body;
    expect(first.need_status).toBe("short");
    const byUnit = (b: any, u: string) =>
      b.lines.filter((l: any) => l.need_unit === u);
    expect(byUnit(first, "LPU Kit")[0]).toMatchObject({
      need: 2,
      delivered: 0,
      short: 2,
      line_status: "short",
    });
    expect(byUnit(first, "Cambium Sector")[0]).toMatchObject({
      rule_status: "pending_configuration",
      need: null,
      line_status: "pending_configuration",
    });
    expect(byUnit(first, "Intracom Sector")).toHaveLength(2); // the dual BS and its antenna are each needed

    const lpu = await itemByCode("C000000L114A");
    const cab = await itemByCode("MTS9514A");
    const bat = await itemByCode("800-00211");
    const rtr = await itemByCode("S9700");
    await receive(lpu, 2);
    const [c0] = await receive(cab, 1, "CB");
    const bats = await receive(bat, 2, "BT");
    const [r0] = await receive(rtr, 1, "RX");
    const dn = await move({
      ...doc("te_dn", { doc_date: "2026-04-02" }),
      site_id: te.id,
      lines: [
        { item_id: lpu.id, qty: 2 },
        { item_id: cab.id, qty: 1, serials: [c0] },
        { item_id: bat.id, qty: 2, serials: bats },
        { item_id: rtr.id, qty: 1, serials: [r0] },
      ],
    });
    expect(dn.status, JSON.stringify(dn.body)).toBe(201);
    await approveMovement(dn.body);
    const after = (
      await t.entry.api.call("get", `/warehouse/dispatch-status/${te.id}`)
    ).body;
    expect(after).toMatchObject({
      need_status: "pending_configuration",
      te_dispatch_complete_date: "2026-04-02",
      short_lines: 0,
    });
    expect(after.pending_lines).toBeGreaterThan(0);
    expect(
      after.lines
        .filter((l: any) => l.rule_status === "confirmed")
        .every((l: any) => l.line_status === "complete"),
    ).toBe(true);

    // a return makes it short again; the date stays the latest posted TE DN
    const rn = await move({
      ...doc("te_rn", { reason: "Relocation", doc_date: "2026-04-05" }),
      site_id: te.id,
      lines: [{ item_id: lpu.id, qty: 1, condition: "Good" }],
    });
    await approveMovement(rn.body);
    const back = (
      await t.entry.api.call("get", `/warehouse/dispatch-status/${te.id}`)
    ).body;
    expect(back).toMatchObject({
      need_status: "short",
      te_dispatch_complete_date: "2026-04-02",
    });

    // the list: filter by status and region, without the lines
    const list = await t.entry.api.call(
      "get",
      `/warehouse/dispatch-status?need_status=short&region_id=${R}&q=${te.code}`,
    );
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      site_id: te.id,
      need_status: "short",
    });
    expect(list.body.items[0].lines).toBeUndefined();
    expect(
      (
        await t.entry.api.call(
          "get",
          "/warehouse/dispatch-status?need_status=done",
        )
      ).status,
    ).toBe(422);
  });

  it("the region WL vendor: admin only, audited; another region does not see a site's dispatch; a caller without the module is refused", async () => {
    const regs = await t.entry.api.call("get", "/warehouse/region-vendors");
    expect(regs.status).toBe(200);
    expect(regs.body.items).toHaveLength(7);
    expect(
      (
        await t.entry.api.call("put", "/warehouse/region-vendors/7", {
          wl_vendor: "Cambium",
          reason: "Try",
        })
      ).status,
    ).toBe(403);
    const set = await admin.api.call("put", "/warehouse/region-vendors/7", {
      wl_vendor: "Intracom",
      reason: "Vendor of the region",
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ region_id: 7, wl_vendor: "Intracom" });
    const clear = await admin.api.call(
      "put",
      "/warehouse/region-vendors/7",
      { wl_vendor: null, reason: "Not confirmed yet" },
      { "If-Match": `"${set.body.version}"` },
    );
    expect(clear.status).toBe(200);
    const audit = await db.query(
      `SELECT before, after FROM audit_log WHERE entity_type = 'warehouse_region_vendor' AND entity_id = '7' ORDER BY id`,
    );
    expect(audit.rows.map((r) => r.after.wl_vendor)).toEqual([
      "Intracom",
      null,
    ]);

    const far = await actor(app, db, {
      grants: G("warehouse", "view"),
      regions: [5],
      modules: null,
    });
    expect(
      (await far.api.call("get", `/warehouse/dispatch-status/${site.id}`))
        .status,
    ).toBe(404);
    const none = await actor(app, db, {
      grants: G("gecol", "view"),
      regions: [R],
      modules: null,
    });
    expect(
      (await none.api.call("get", "/warehouse/dispatch-status")).status,
    ).toBe(403);
    expect((await none.api.call("get", "/warehouse/config-gaps")).status).toBe(
      403,
    );
  });
});
