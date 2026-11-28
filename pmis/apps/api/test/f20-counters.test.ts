import type { NestExpressApplication } from "@nestjs/platform-express";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roundDays } from "../src/dashboard/dashboard-extras.rules";
import { q, today, wdBetween } from "./dash-fixture";
import { startApp, superDbF20K } from "./helpers";
import { actor, plainAdmin, type Actor } from "./wf-helpers";

/**
 * F20 counters (contract 0.15.29, migration 0113): the sources of the seven counters that had none before, the sites per Site Master view, and the
 * stale-task idle limit of the dashboard settings. The data is synthetic and written as the superuser into its own database (TEST_DATABASE_URL_F20K),
 * with the triggers off, so the expected figures are the ones computed by hand below:
 *   Tripoli (region 1): site A (active, On-Air this month, TE PAC done, As-Built submitted), site C (cancelled, never counted)
 *   Benghazi (region 5): site B (active, On-Air this month, TE PAC done, no As-Built)
 *   On-Air target of the month: 4 sites (set in the settings row), so the admin figure is 2 of 4 = 50.0 and Tripoli is 1 of 4 = 25.0.
 */

type J = Record<string, any>;

let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let tripoli: Actor;
let denied: Actor;
let p85Expected: number;

const kpi = (body: J, code: string): J =>
  (body.counters.kpis as J[]).find((k) => k.code === code)!;

async function seed(d: PgClient): Promise<void> {
  await d.query("SET session_replication_role = replica");
  const wf = (
    await q<{ id: string }>(
      d,
      "SELECT id FROM workflow_definitions WHERE version = 1",
    )
  )[0]!.id;
  const td: Record<string, string> = {};
  for (const r of await q<{ id: string; code: string }>(
    d,
    "SELECT id, code FROM task_definitions WHERE workflow_id = $1 AND code IN ('D5', 'MS6', 'MS7')",
    [wf],
  ))
    td[r.code] = r.id;
  const day = await today(d);
  const dayAgo = async (n: number): Promise<string> =>
    (
      await q<{ x: string }>(d, "SELECT (cal_today() - $1::int)::text AS x", [
        n,
      ])
    )[0]!.x;

  const site: Record<string, { id: string; region: number }> = {};
  const mk = async (
    code: string,
    region: number,
    status: string,
  ): Promise<void> => {
    const r = await q<{ id: string }>(
      d,
      `INSERT INTO sites (site_code, name, region_id, workflow_version_id, delivery_scenario, overall_status, updated_at)
       VALUES ($1, $2, $3, $4, 'new_build'::"DeliveryScenario", $5::"OverallStatus", now()) RETURNING id`,
      [`F20K-${code}`, `F20K ${code}`, region, wf, status],
    );
    site[code] = { id: r[0]!.id, region };
  };
  await mk("A", 1, "in_progress");
  await mk("B", 5, "in_progress");
  await mk("C", 1, "cancelled");

  const task = async (
    s: string,
    code: string,
    state: string,
    o: { actual?: boolean; updatedAgo?: number } = {},
  ): Promise<void> => {
    await d.query(
      `INSERT INTO task_instances (site_id, region_id, task_def_id, state, current_level, levels_required, actual_date, approved_date, updated_at)
       VALUES ($1, $2, $3, $4::"TaskState", 0, 3, $5::date, $5::date, $6)`,
      [
        site[s]!.id,
        site[s]!.region,
        td[code],
        state,
        o.actual ? day : null,
        new Date(Date.now() - (o.updatedAgo ?? 0) * 86400e3),
      ],
    );
  };
  // On-Air this month (MS6) and TE PAC (MS7) approved at A and B; A is the only one with an As-Built TE part submitted
  await task("A", "MS6", "approved", { actual: true });
  await task("B", "MS6", "approved", { actual: true });
  await task("A", "MS7", "approved", { actual: true });
  await task("B", "MS7", "approved", { actual: true });
  // open tasks: A is idle for 30 days (stale with the default limit of 2), B was touched just now
  await task("A", "D5", "open", { updatedAgo: 30 });
  await task("B", "D5", "open", { updatedAgo: 0 });

  await d.query(
    `INSERT INTO as_built_records (site_id, region_id, quantities, te_submitted_date)
     VALUES ($1, 1, '{}'::jsonb, cal_today())`,
    [site.A!.id],
  );

  // Dismantle: A CW closed, A TE open, B CW open, and the cancelled site C TE open (never counted)
  const dis = async (
    s: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<void> => {
    await d.query(
      `INSERT INTO register_records (entity_id, version_no, register_key, record_type, site_id, region_id, state, is_current, data, approved_at, current_level)
       VALUES (gen_random_uuid(), 1, 'dismantle', $1, $2, $3, 'approved', true, $4::jsonb, now(), 3)`,
      [
        type,
        site[s]!.id,
        site[s]!.region,
        JSON.stringify({ rfd_date: await dayAgo(40), ...data }),
      ],
    );
  };
  await dis("A", "cw", { closed: true, closing_rn_ref: "RN-1" });
  await dis("A", "te", { closed: false });
  await dis("B", "cw", { closed: false });
  await dis("C", "te", { closed: false });

  // Assignments (Procurement, approved): P1 at A (vehicle ready, advance disbursed after the work closed), P2 at B (vehicle not reserved)
  const proc = async (
    entity: string,
    s: string,
    data: Record<string, unknown>,
  ): Promise<void> => {
    await d.query(
      `INSERT INTO register_records (entity_id, version_no, register_key, site_id, region_id, state, is_current, data, approved_at, current_level)
       VALUES ($1, 1, 'procurement', $2, $3, 'approved', true, $4::jsonb, now(), 3)`,
      [entity, site[s]!.id, site[s]!.region, JSON.stringify(data)],
    );
  };
  const P1 = "00000000-0000-4000-8000-000000000001";
  const P2 = "00000000-0000-4000-8000-000000000002";
  await proc(P1, "A", {
    scope: "Survey",
    vehicle_required: true,
    advance_required: true,
    actual_end: await dayAgo(3),
  });
  await proc(P2, "B", {
    scope: "Survey",
    vehicle_required: true,
    advance_required: true,
  });
  await d.query(
    `INSERT INTO assignment_readiness (procurement_entity_id, readiness, open_advances_after_close) VALUES
       ($1, 'awaiting_advance', true), ($2, 'awaiting_vehicle', false)`,
    [P1, P2],
  );
  const adv = async (
    s: string,
    region: number,
    data: Record<string, unknown>,
  ): Promise<void> => {
    await d.query(
      `INSERT INTO register_records (entity_id, version_no, register_key, record_type, site_id, region_id, state, is_current, data, approved_at, current_level)
       VALUES (gen_random_uuid(), 1, 'financial_advances', 'advance', $1, $2, 'approved', true, $3::jsonb, now(), 3)`,
      [site[s]!.id, region, JSON.stringify(data)],
    );
  };
  // disbursed after the work closed: counted; settled: not open; P2 has no actual end: not counted
  await adv("A", 1, { procurement_record_id: P1, advance_state: "disbursed" });
  await adv("A", 1, { procurement_record_id: P1, advance_state: "settled" });
  await adv("B", 5, { procurement_record_id: P2, advance_state: "disbursed" });

  // The On-Air target of the month: 4 sites
  await d.query(
    `UPDATE settings SET value = jsonb_set(value, '{targets,monthly_on_air}', '4'::jsonb) WHERE key = 'dashboard.settings'`,
  );
  // 0.15.367: a typed target counts only while the manual override of the target policy is on (off by default: the target is derived from the scope)
  await d.query(`UPDATE settings SET value = '{"manual_override": true}'::jsonb WHERE key = 'dashboard.target_policy'`);

  // Task transitions of the open task of A: entry, then in review, then approved (the approved state is not a working state)
  const dA = (
    await q<{ id: string }>(
      d,
      "SELECT id FROM task_instances WHERE site_id = $1 AND task_def_id = $2",
      [site.A!.id, td.D5],
    )
  )[0]!.id;
  const tr = async (
    to: string,
    agoDays: number,
    origin: string,
  ): Promise<void> => {
    await d.query(
      `INSERT INTO status_transitions (entity_type, entity_id, region_id, site_id, group_key, from_state, to_state, at, actor_id, level_no, level, action, source, origin_id)
       VALUES ('task', $1, 1, $2, 'TE', NULL, $3, now() - make_interval(days => $4::int), NULL, 1, 'L1', 'seed', 'step', $5)`,
      [dA, site.A!.id, to, agoDays, origin],
    );
  };
  await tr("entry", 12, "f20k-t1");
  await tr("in_review", 7, "f20k-t2");
  await tr("approved", 2, "f20k-t3");
  // Two closed working intervals (12 to 7 days ago, 7 to 2 days ago): the 85th percentile of two values is a + 0.85 * (b - a)
  const i1 = await wdBetween(d, 12, 7);
  const i2 = await wdBetween(d, 7, 2);
  const [lo, hi] = [Math.min(i1, i2), Math.max(i1, i2)];
  p85Expected = roundDays(lo + 0.85 * (hi - lo))!;
}

beforeAll(async () => {
  app = await startApp({
    databaseUrl: process.env.TEST_DATABASE_URL_F20K as string,
  });
  db = await superDbF20K();
  await seed(db);
  admin = await plainAdmin(app, db, true);
  tripoli = await actor(app, db, {
    regions: [1],
    grants: [
      ["dashboard", "view"],
      ["sites", "view"],
      // the register counters read register_records under row security, so the reader needs view on those registers
      ["procurement", "view"],
      ["financial_advances", "view"],
      ["car_dispatcher", "view"],
      ["dismantle", "view"],
      ["as_built", "view"],
    ],
  });
  denied = await actor(app, db, { regions: null, grants: [] });
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe("F20 counters: the seven former gaps and the Site Master counts (contract 0.15.29)", () => {
  it("the administrator sees a value for every counter that had no source, and none is pending", async () => {
    const res = await admin.api.call("get", "/dashboard/extras");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as J;
    expect(body.counters.available).toBe(true);

    expect(kpi(body, "vehicle_ready").value).toBe(50); // P1 of the two assignments
    expect(kpi(body, "advances_open_after_close").value).toBe(1); // one disbursed advance of P1
    expect(kpi(body, "dismantle_pending").value).toBe(2); // A TE and B CW; A CW closed, C is cancelled
    expect(kpi(body, "as_built_submitted").value).toBe(50); // 1 of the 2 sites with TE PAC
    expect(kpi(body, "time_in_state_p85").value).toBe(p85Expected);
    expect(kpi(body, "time_in_state_p85").unit).toBe("days");
    expect(kpi(body, "stale_tasks").value).toBe(50); // A idle 30 days, of the 2 open tasks
    expect(kpi(body, "on_air_vs_target").value).toBe(50); // 2 sites on air against the target of 4

    for (const code of [
      "vehicle_ready",
      "advances_open_after_close",
      "dismantle_pending",
      "as_built_submitted",
      "time_in_state_p85",
      "stale_tasks",
      "on_air_vs_target",
    ])
      expect(body.counters.pending_kpis).not.toContain(code);
  });

  it("lists the sites per Site Master view, with integer counts", async () => {
    const body = (await admin.api.call("get", "/dashboard/extras")).body as J;
    const menus = body.counters.site_master_menus as J[];
    expect(body.counters.site360_menus).toEqual(menus); // the deprecated name, one release
    expect(menus.map((m) => m.code)).toEqual(
      expect.arrayContaining(["CW", "TE", "OM"]),
    );
    for (const m of menus) expect(Number.isInteger(m.sites)).toBe(true);
  });

  it("applies the B3 region scope: a Tripoli reader sees only the Tripoli figures", async () => {
    const res = await tripoli.api.call("get", "/dashboard/extras");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as J;
    expect(kpi(body, "vehicle_ready").value).toBe(100); // P1 only
    expect(kpi(body, "advances_open_after_close").value).toBe(1);
    expect(kpi(body, "dismantle_pending").value).toBe(1); // A TE; Benghazi and the cancelled site are left out
    expect(kpi(body, "as_built_submitted").value).toBe(100); // A only
    expect(kpi(body, "stale_tasks").value).toBe(100); // A only
    expect(kpi(body, "on_air_vs_target").value).toBe(25); // 1 of 4
  });

  it("refuses a caller who may not see the dashboard", async () => {
    const res = await denied.api.call("get", "/dashboard/extras");
    expect(res.status).toBe(403);
  });

  it("the idle limit is a dashboard setting: validated, optional on a save, and kept when absent", async () => {
    const cur = await admin.api.call("get", "/settings/dashboard");
    expect(cur.status).toBe(200);
    expect(cur.body.stale_idle_days).toBe(2);
    expect(cur.body.targets.monthly_on_air).toBe(4);
    const etag = cur.headers.etag as string;
    const base = {
      reason: "F20 idle limit test",
      targets: cur.body.targets,
      thresholds: Object.fromEntries(
        Object.entries(cur.body.thresholds as Record<string, J>).map(
          ([k, v]) => [k, { green: v.green, amber: v.amber }],
        ),
      ),
      tabs: {
        pmo: { order: [], hidden: [] },
        cw: { order: [], hidden: [] },
        te: { order: [], hidden: [] },
      },
    };
    const bad = await admin.api.call(
      "put",
      "/settings/dashboard",
      { ...base, stale_idle_days: 31 },
      { "If-Match": etag },
    );
    expect(bad.status).toBe(422);

    const set = await admin.api.call(
      "put",
      "/settings/dashboard",
      { ...base, stale_idle_days: 7 },
      { "If-Match": etag },
    );
    expect(set.status).toBe(200);
    expect(set.body.stale_idle_days).toBe(7);

    // a save without the key keeps the stored value
    const keep = await admin.api.call("get", "/settings/dashboard");
    const again = await admin.api.call("put", "/settings/dashboard", base, {
      "If-Match": keep.headers.etag as string,
    });
    expect(again.status).toBe(200);
    expect(again.body.stale_idle_days).toBe(7);
  });
});
