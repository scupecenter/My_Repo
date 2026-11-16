import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes } from "node:crypto";
import type { Client as PgClient } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API, startApp, superDb } from "./helpers";
import { G } from "./reg-helpers";
import { actor, makeSite, makeTask } from "./wf-helpers";

/**
 * F1: approved status transitions. The step triggers write one row per state change of the approval steps; the append-only guard refuses
 * changes; the backfill is idempotent; the two reads (a record's time in state, the state durations report) respect the region and module rules.
 * Audit and step rows carry fixed timestamps in February 2026 (region 7), so the figures do not depend on the day the suite runs.
 */
const R7 = 7;
const PREFIX = `ST${randomBytes(3).toString("hex").toUpperCase()}`;
const T0 = Date.UTC(2026, 1, 1, 8, 0, 0); // Sunday 1 February 2026 08:00 UTC
const at = (days: number): string =>
  new Date(T0 + days * 86_400_000).toISOString();
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

const anon = (path: string) =>
  request(app.getHttpServer()).get(`${API}${path}`);
const risksView = () =>
  actor(app, db, {
    level: "view",
    grants: [...G("risks", "view")],
    regions: [R7],
    modules: null,
  });
const reporter = () =>
  actor(app, db, {
    level: "view",
    grants: [
      ...G("sites", "view"),
      ...G("reports", "view"),
      ...G("risks", "view"),
    ],
    regions: [R7],
    modules: null,
  });

/** A register record in region 7 with two recorded approval steps: entry to in_review (day 0, level 1), in_review to approved (day 2, level 2). */
async function recordWithSteps(): Promise<string> {
  const site = await makeSite(db, R7, { prefix: PREFIX });
  const rec = await db.query(
    `INSERT INTO register_records (entity_id, register_key, region_id, site_id, state, is_current) VALUES (gen_random_uuid(), 'risks', $1, $2, 'approved', true) RETURNING id`,
    [R7, site.id],
  );
  const id: string = rec.rows[0].id;
  await db.query(
    `INSERT INTO register_steps (record_id, level, action, before_state, after_state, created_at) VALUES ($1, 1, 'submit', 'entry', 'in_review', $2), ($1, 2, 'approve', 'in_review', 'approved', $3)`,
    [id, at(0), at(2)],
  );
  return id;
}

describe("F1 the step triggers", () => {
  it("write one transition per state change of a task step, with the level and the actor, and nothing for a step without a change", async () => {
    const site = await makeSite(db, R7, { prefix: PREFIX });
    const task = await makeTask(db, site, "B9", "in_review");
    await db.query(
      `INSERT INTO workflow_steps (task_id, level, action, before_state, after_state, created_at) VALUES ($1, 2, 'approve', 'in_review', 'in_approval', $2)`,
      [task, at(3)],
    );
    await db.query(
      `INSERT INTO workflow_steps (task_id, level, action, before_state, after_state) VALUES ($1, 2, 'claim', 'in_approval', 'in_approval')`,
      [task],
    );
    const rows = (
      await db.query(
        `SELECT entity_type, from_state, to_state, level, level_no, group_key, region_id, source FROM status_transitions WHERE entity_id = $1`,
        [task],
      )
    ).rows;
    expect(rows).toEqual([
      expect.objectContaining({
        entity_type: "task",
        from_state: "in_review",
        to_state: "in_approval",
        level: "L2",
        level_no: 2,
        region_id: R7,
        source: "step",
      }),
    ]);
  });

  it("write the register transitions of a record step, and the table refuses every change to a row", async () => {
    const id = await recordWithSteps();
    const rows = (
      await db.query(
        `SELECT to_state, level, source FROM status_transitions WHERE entity_id = $1 ORDER BY at`,
        [id],
      )
    ).rows;
    expect(rows).toEqual([
      { to_state: "in_review", level: "L1", source: "step" },
      { to_state: "approved", level: "L2", source: "step" },
    ]);
    await expect(
      db.query(
        `UPDATE status_transitions SET to_state = 'x' WHERE entity_id = $1`,
        [id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM status_transitions WHERE entity_id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
  });
});

describe("F1 the backfill", () => {
  it("adds the approval actions of the audit log once, and a second run adds nothing for them", async () => {
    const site = await makeSite(db, R7, { prefix: PREFIX });
    const task = await makeTask(db, site, "B9", "in_review");
    const audit = await db.query(
      `INSERT INTO audit_log (at, action, entity_type, entity_id, site_id, region_id, before, after)
       VALUES ($1, 'task_submit', 'task', $2, $3, $4, $5::jsonb, $6::jsonb) RETURNING id`,
      [
        at(-400),
        task,
        site.id,
        R7,
        JSON.stringify({ state: "entry", current_level: 1 }),
        JSON.stringify({ state: "in_review" }),
      ],
    );
    const first = (await db.query(`SELECT st_backfill_audit(now()) AS n`))
      .rows[0].n as number;
    const second = (await db.query(`SELECT st_backfill_audit(now()) AS n`))
      .rows[0].n as number;
    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBeLessThan(first + 1);
    const mine = (
      await db.query(
        `SELECT source, level, from_state, to_state, level_no FROM status_transitions WHERE origin_id = $1`,
        [String(audit.rows[0].id)],
      )
    ).rows;
    expect(mine).toEqual([
      {
        source: "backfill_audit",
        level: "L1",
        from_state: "entry",
        to_state: "in_review",
        level_no: 1,
      },
    ]);
  });
});

describe("F1 time in state of a register record", () => {
  it("is 401 without a session, 404 for an unknown register or record, and 200 with the transitions for a visible record", async () => {
    const id = await recordWithSteps();
    expect(
      (await anon(`/registers/risks/records/${id}/time-in-state`)).status,
    ).toBe(401);
    const v = await risksView();
    expect(
      (await v.api.call("get", `/registers/nope/records/${id}/time-in-state`))
        .status,
    ).toBe(404);
    expect(
      (
        await v.api.call(
          "get",
          `/registers/risks/records/not-a-uuid/time-in-state`,
        )
      ).status,
    ).toBe(404);
    const res = await v.api.call(
      "get",
      `/registers/risks/records/${id}/time-in-state`,
    );
    expect(res.status).toBe(200);
    expect(res.body.current_state).toBe("approved");
    expect(
      res.body.transitions.map((t: { to_state: string }) => t.to_state),
    ).toEqual(["in_review", "approved"]);
    expect(res.body.transitions[1].level).toBe("L2");
    expect(
      typeof res.body.working_days_in_state === "number" ||
        res.body.working_days_in_state === null,
    ).toBe(true);
  });
});

describe("F1 state durations report", () => {
  it("needs entity_type (422), the reports grant (403), and returns median and P85 per state and region", async () => {
    await recordWithSteps();
    const r = await reporter();
    expect((await r.api.call("get", "/reports/state-durations")).status).toBe(
      422,
    );
    expect(
      (
        await r.api.call(
          "get",
          "/reports/state-durations?entity_type=task&region_id=9",
        )
      ).status,
    ).toBe(422);
    const noReports = await risksView();
    expect(
      (
        await noReports.api.call(
          "get",
          "/reports/state-durations?entity_type=register_record",
        )
      ).status,
    ).toBe(403);
    const res = await r.api.call(
      "get",
      "/reports/state-durations?entity_type=register_record&region_id=7",
    );
    expect(res.status).toBe(200);
    const item = res.body.items.find(
      (i: { group_key: string; state: string }) =>
        i.group_key === "risks" && i.state === "in_review",
    );
    expect(item).toBeDefined();
    expect(item.region_id).toBe(R7);
    expect(item.count).toBeGreaterThanOrEqual(1);
    expect(item.p85_working_days).toBeGreaterThanOrEqual(
      item.median_working_days,
    );
    const tasks = await r.api.call(
      "get",
      "/reports/state-durations?entity_type=task",
    );
    expect(tasks.status).toBe(200);
    expect(Array.isArray(tasks.body.items)).toBe(true);
  });
});
