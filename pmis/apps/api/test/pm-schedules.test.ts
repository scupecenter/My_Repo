import type { NestExpressApplication } from "@nestjs/platform-express";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, superDb } from "./helpers";
import { GECOL, team, type Team } from "./reg-helpers";
import { plainAdmin } from "./wf-helpers";

/**
 * Preventive-maintenance schedules that create drafts only (contract 0.15.161, migration 0261). The write needs admin.settings edit, a reason and If-Match.
 * A draft is created by a person through the register's own create path (their rights apply), never by a timer, and only when the schedule is due.
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

describe("pm schedules (contract 0.15.161)", () => {
  it("saves admin-only, validates, creates one draft as the caller when due, and moves the next due date on", async () => {
    const admin = await plainAdmin(app, db);
    const g: Team = await team(app, db, "gecol", "gecol", 7);

    const cur = await admin.api.call("get", "/settings/pm-schedules");
    expect(cur.status).toBe(200);
    expect(cur.body.schedules).toEqual([]);
    expect((cur.body.catalogue.registers as { key: string }[]).map((r) => r.key)).toContain("gecol");
    const etag = cur.headers.etag as string;

    const sched = (over: Record<string, unknown> = {}) => ({
      id: "gecol-monthly",
      name_en: "GECOL monthly check",
      name_ar: "فحص شهري",
      register_key: "gecol",
      site_id: g.site.id,
      data: GECOL,
      every: 1,
      unit: "month",
      next_due: "2026-01-01",
      active: true,
      ...over,
    });
    const body = (schedules: unknown[]) => ({ reason: "pm test", schedules });

    expect((await g.entry.api.call("put", "/settings/pm-schedules", body([sched()]), { "If-Match": etag })).status).toBe(403);
    expect((await admin.api.call("put", "/settings/pm-schedules", body([sched()]))).status).toBe(428);
    expect((await admin.api.call("put", "/settings/pm-schedules", body([sched()]), { "If-Match": '"999"' })).status).toBe(412);

    // database rules: unknown register, the same id twice
    const bad = await admin.api.call("put", "/settings/pm-schedules", body([sched({ register_key: "nope" }), sched({ name_en: "Same id" })]), { "If-Match": etag });
    expect(bad.status).toBe(422);
    const codes = (bad.body.errors as { code: string; path: string }[]).map((e) => `${e.path}:${e.code}`);
    expect(codes).toEqual(expect.arrayContaining(["/schedules/1/register_key:unknown_register", "/schedules/2/id:duplicate"]));
    // shape rules (zod strict): a unit that does not exist, an unknown key
    expect((await admin.api.call("put", "/settings/pm-schedules", body([sched({ unit: "day" })]), { "If-Match": etag })).status).toBe(422);
    expect((await admin.api.call("put", "/settings/pm-schedules", body([{ ...sched(), extra: 1 }]), { "If-Match": etag })).status).toBe(422);

    const ok = await admin.api.call("put", "/settings/pm-schedules", body([sched(), sched({ id: "future-one", name_en: "Future", next_due: "2099-01-01" })]), { "If-Match": etag });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(1);
    const audit = await db.query("SELECT reason FROM audit_log WHERE action = 'pm_schedules_update' ORDER BY id DESC LIMIT 1");
    expect(audit.rows[0]?.reason).toBe("pm test");

    // the register team sees its schedules; nothing is created by reading
    const mine = await g.entry.api.call("get", "/settings/pm-schedules");
    expect(mine.status).toBe(200);
    expect(mine.body.schedules).toHaveLength(2);

    // not due: refused; due: one draft in entry, saved by the caller; the next due date moves past today
    expect((await g.entry.api.call("post", "/pm-schedules/future-one/generate")).status).toBe(409);
    const gen = await g.entry.api.call("post", "/pm-schedules/gecol-monthly/generate");
    expect(gen.status).toBe(201);
    expect(gen.body.register_key).toBe("gecol");
    const rec = await db.query("SELECT state::text AS state, created_by FROM register_records WHERE id = $1", [gen.body.record_id]);
    expect(rec.rows[0]?.state).toBe("entry");
    expect(rec.rows[0]?.created_by).toBe(g.entry.user.id);
    const today = (await db.query("SELECT cal_today()::text AS d")).rows[0].d as string;
    expect((gen.body.next_due as string) > today).toBe(true);
    // pressed again: not due any more, so no second draft
    expect((await g.entry.api.call("post", "/pm-schedules/gecol-monthly/generate")).status).toBe(409);
    const after = await admin.api.call("get", "/settings/pm-schedules");
    const s = (after.body.schedules as { id: string; last_record_id?: string }[]).find((x) => x.id === "gecol-monthly");
    expect(s?.last_record_id).toBe(gen.body.record_id);

    // a person without the register's view cannot see or generate it
    const other = await team(app, db, "procurement", "procurement", 1);
    expect((await other.entry.api.call("post", "/pm-schedules/gecol-monthly/generate")).status).toBe(404);
  });
});
