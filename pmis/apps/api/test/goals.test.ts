import type { NestExpressApplication } from "@nestjs/platform-express";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, superDb } from "./helpers";
import { team, type Team } from "./reg-helpers";
import { plainAdmin } from "./wf-helpers";

/**
 * Goals with automatic progress (contract 0.15.150, migration 0251). Reads need dashboard.view; the write needs admin.settings edit for all regions,
 * a reason and If-Match, and is audited. The database checks the rules again (known milestone task, known region, period, whole target, unique id).
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

const codesOf = (body: { errors?: { code: string; path?: string }[] }): string[] =>
  (body.errors ?? []).map((e) => `${e.path}:${e.code}`).sort();

describe("goals (contract 0.15.150)", () => {
  it("lists the catalogue, writes admin-only, validates, versions, audits and counts progress", async () => {
    const admin = await plainAdmin(app, db);
    const g: Team = await team(app, db, "gecol", "gecol", 7);

    const cur = await admin.api.call("get", "/settings/goals");
    expect(cur.status).toBe(200);
    expect(cur.body.goals).toEqual([]);
    const metrics = (cur.body.catalogue.metrics as { code: string }[]).map((m) => m.code);
    expect(metrics).toContain("MS6");
    expect(cur.body.catalogue.regions).toHaveLength(7);
    const etag = cur.headers.etag as string;

    // the dashboard card is in the card catalogue of Settings, Screens, Dashboard
    const dash = await admin.api.call("get", "/settings/dashboard");
    expect((dash.body.catalogue.cards as { code: string }[]).map((c) => c.code)).toContain("goals");

    const goal = (over: Record<string, unknown> = {}) => ({
      id: "on-air-month",
      name_en: "On-Air this month",
      name_ar: "الربط هذا الشهر",
      metric: "MS6",
      region_id: null,
      period: "month",
      target: 10,
      active: true,
      ...over,
    });
    const body = (goals: unknown[], over: Record<string, unknown> = {}) => ({ reason: "goals test", goals, ...over });

    // only admin.settings edit may write; If-Match is required; a stale version is refused
    expect((await g.entry.api.call("put", "/settings/goals", body([goal()]), { "If-Match": etag })).status).toBe(403);
    expect((await admin.api.call("put", "/settings/goals", body([goal()]))).status).toBe(428);
    expect((await admin.api.call("put", "/settings/goals", body([goal()]), { "If-Match": '"999"' })).status).toBe(412);

    // field errors of the database: unknown milestone task, the same id twice (the shape rules are checked first by zod)
    const bad = await admin.api.call("put", "/settings/goals", body([goal({ metric: "NOPE" }), goal({ name_en: "Same id" })]), { "If-Match": etag });
    expect(bad.status).toBe(422);
    expect(codesOf(bad.body)).toEqual(expect.arrayContaining(["/goals/1/metric:unknown_metric", "/goals/2/id:duplicate"]));
    // the shape rules: a period that does not exist, a region out of range, a target that is not whole
    const shape = await admin.api.call("put", "/settings/goals", body([goal({ period: "week" }), goal({ id: "other-one", region_id: 99, target: 1.5 })]), { "If-Match": etag });
    expect(shape.status).toBe(422);
    // a key the contract does not know is refused before the database (zod strict)
    expect((await admin.api.call("put", "/settings/goals", body([{ ...goal(), extra: 1 }]), { "If-Match": etag })).status).toBe(422);

    // a valid save: version up, audit row with the reason
    const ok = await admin.api.call("put", "/settings/goals", body([goal(), goal({ id: "tripoli-quarter", name_en: "Tripoli quarter", region_id: 1, period: "quarter", target: 4, active: false })]), { "If-Match": etag });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(1);
    expect(ok.body.goals).toHaveLength(2);
    expect(ok.headers.etag).toBeTruthy();
    const audit = await db.query("SELECT reason FROM audit_log WHERE action = 'goals_update' ORDER BY id DESC LIMIT 1");
    expect(audit.rows[0]?.reason).toBe("goals test");

    // progress: only active goals, counted by the system, with the period and a status
    const pr = await admin.api.call("get", "/goals/progress");
    expect(pr.status).toBe(200);
    expect(pr.body.goals).toHaveLength(1);
    const p = pr.body.goals[0];
    expect(p).toMatchObject({ id: "on-air-month", metric: "MS6", period: "month", target: 10 });
    // the count is the same as a direct count of sites with an approved MS6 task this month (other suites may have seeded some)
    const direct = await db.query("SELECT count(DISTINCT s.id)::int AS n FROM task_instances ti JOIN task_definitions td ON td.id = ti.task_def_id JOIN sites s ON s.id = ti.site_id WHERE td.code = 'MS6' AND ti.state::text = 'approved' AND ti.actual_date >= date_trunc('month', cal_today())::date AND ti.actual_date <= cal_today() AND s.is_active AND s.overall_status <> 'cancelled'");
    expect(p.actual).toBe(direct.rows[0].n);
    expect(p.percent).toBe(Math.round((1000 * direct.rows[0].n) / 10) / 10);
    expect(p.period_start <= p.period_end).toBe(true);
    expect(["behind", "at_risk", "on_track"]).toContain(p.status);
  });
});
