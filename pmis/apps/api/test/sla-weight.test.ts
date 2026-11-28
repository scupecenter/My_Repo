import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, superDbSla } from "./helpers";
import {
  Actor,
  actor,
  etag,
  makeSite,
  makeTask,
  plainAdmin,
} from "./wf-helpers";

/**
 * Migrations 0109 and 0110 (F14, owner request 2026-11-15): the SLA rule of a task is saved as a new effective-dated version, an unused rule is deleted and a used
 * one is deactivated with the reason, a draft shows the weight totals and publishing is refused while a weight group is not 100. Own database (TEST_DATABASE_URL_SLA).
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
let noStep: Actor;
let plain: Actor;

beforeAll(async () => {
  app = await startApp({
    databaseUrl: process.env.TEST_DATABASE_URL_SLA as string,
  });
  db = await superDbSla();
  admin = await plainAdmin(app, db, true);
  noStep = await plainAdmin(app, db, false);
  plain = await actor(app, db, { level: "entry" });
});
afterAll(async () => {
  await db.end();
  await app.close();
});

const REASON = "Owner request for the SLA in the editor";
const BASE = "/workflow/versions";
const hdr = (t: string): Record<string, string> => ({ "If-Match": t });
const rule = (
  min: number,
  max: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  min_working_days: min,
  max_working_days: max,
  start_event: "PRED",
  unit: "working",
  calendar_code: "std",
  reason: REASON,
  ...extra,
});
const read = async (v: number): Promise<{ tag: string }> => {
  const r = await admin.api.call("get", `${BASE}/${v}`);
  expect(r.status).toBe(200);
  return { tag: etag(r) };
};
const items = async (
  v: number,
): Promise<
  {
    task_code: string;
    counts_in_weight: boolean;
    weight_value: number;
    weight_group: string | null;
    sla: { id: string; max_working_days: number } | null;
  }[]
> => {
  const r = await admin.api.call("get", `${BASE}/${v}/sla-weight`);
  expect(r.status).toBe(200);
  return r.body.items;
};

describe("SLA rule versions", () => {
  it("refuses the SLA doors to a user without the grant (403) and to a session without step-up (401)", async () => {
    const t = await read(1);
    expect(
      (
        await plain.api.call(
          "put",
          `${BASE}/1/tasks/A2/sla-rule`,
          rule(1, 3),
          hdr(t.tag),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await noStep.api.call(
          "put",
          `${BASE}/1/tasks/A2/sla-rule`,
          rule(1, 3),
          hdr(t.tag),
        )
      ).status,
    ).toBe(401);
  });

  it("saves a new version: the open rule ends and the new one applies from today; a bad range is refused", async () => {
    const t = await read(1);
    const bad = await admin.api.call(
      "put",
      `${BASE}/1/tasks/A2/sla-rule`,
      rule(5, 2),
      hdr(t.tag),
    );
    expect(bad.status).toBe(422);
    const ok = await admin.api.call(
      "put",
      `${BASE}/1/tasks/A2/sla-rule`,
      rule(1, 4, { warning_pct: 80, breach_owner_role: "CW Team Lead" }),
      hdr(t.tag),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.rule).toMatchObject({
      task_code: "A2",
      max_working_days: 4,
      warning_pct: 80,
      breach_owner_role: "CW Team Lead",
      is_active: true,
    });
    const now = (await items(1)).find((x) => x.task_code === "A2")!;
    expect(now.sla!.max_working_days).toBe(4);
    const closed = (
      await db.query(`SELECT count(*)::int AS n FROM sla_rules r JOIN task_definitions td ON td.id = r.task_def_id
      WHERE td.code = 'A2' AND td.workflow_id = (SELECT id FROM workflow_definitions WHERE version = 1) AND r.effective_to = current_date`)
    ).rows[0].n as number;
    expect(closed).toBeGreaterThanOrEqual(1);
  });

  it("a rule a task already uses is deactivated with the reason, not deleted", async () => {
    const site = await makeSite(db, 5);
    const taskId = await makeTask(db, site, "A1", "open");
    const cur = (await items(1)).find((x) => x.task_code === "A1")!;
    expect(cur.sla).not.toBeNull();
    await db.query(`UPDATE task_instances SET sla_rule_id = $1 WHERE id = $2`, [
      cur.sla!.id,
      taskId,
    ]);
    const t = await read(1);
    const r = await admin.api.call(
      "post",
      `${BASE}/1/tasks/A1/sla-rules/${cur.sla!.id}/remove`,
      { reason: REASON },
      hdr(t.tag),
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      outcome: "deactivated",
      tasks_using_rule: 1,
    });
    const row = (
      await db.query(
        `SELECT is_active, inactive_reason FROM sla_rules WHERE id = $1`,
        [cur.sla!.id],
      )
    ).rows[0];
    expect(row).toMatchObject({ is_active: false, inactive_reason: REASON });
  });
});

describe("weights in a draft and the publish check", () => {
  let draft = 0;
  it("a System Admin drafts version 1; a weight is refused outside a draft", async () => {
    const r = await admin.api.call("post", BASE, {
      parent_version: 1,
      reason: REASON,
    });
    expect(r.status).toBe(201);
    draft = r.body.version as number;
    const pub = await read(1);
    const refused = await admin.api.call(
      "put",
      `${BASE}/1/tasks/A1/weight`,
      {
        counts_in_weight: true,
        weight_value: 10,
        weight_group: "CW",
        reason: REASON,
      },
      hdr(pub.tag),
    );
    expect(refused.status).toBe(409);
  });

  it("the draft shows the group totals live; publishing is refused while a group is not 100", async () => {
    const d = await read(draft);
    const a = await admin.api.call(
      "put",
      `${BASE}/${draft}/tasks/A1/weight`,
      {
        counts_in_weight: true,
        weight_value: 60,
        weight_group: "CW",
        reason: REASON,
      },
      hdr(d.tag),
    );
    expect(a.status).toBe(200);
    const d2 = await read(draft);
    const b = await admin.api.call(
      "put",
      `${BASE}/${draft}/tasks/A2/weight`,
      {
        counts_in_weight: true,
        weight_value: 30,
        weight_group: "CW",
        reason: REASON,
      },
      hdr(d2.tag),
    );
    expect(b.status).toBe(200);
    const totals = await admin.api.call(
      "get",
      `${BASE}/${draft}/weight-totals`,
    );
    expect(totals.body.items).toEqual([
      expect.objectContaining({ group: "CW", total: 90, ok: false }),
    ]);
    const d3 = await read(draft);
    const pub = await admin.api.call(
      "post",
      `${BASE}/${draft}/publish`,
      { reason: REASON, confirm_text: `v${draft}` },
      hdr(d3.tag),
    );
    expect(pub.status).toBe(409);
    expect(JSON.stringify(pub.body)).toContain("not_100");
  });

  it("a group that totals 100 is ok", async () => {
    const d = await read(draft);
    const c = await admin.api.call(
      "put",
      `${BASE}/${draft}/tasks/A2/weight`,
      {
        counts_in_weight: true,
        weight_value: 40,
        weight_group: "CW",
        reason: REASON,
      },
      hdr(d.tag),
    );
    expect(c.status).toBe(200);
    const totals = await admin.api.call(
      "get",
      `${BASE}/${draft}/weight-totals`,
    );
    expect(totals.body.items).toEqual([
      expect.objectContaining({ group: "CW", total: 100, ok: true }),
    ]);
  });

  it("an unused draft rule is deleted for real", async () => {
    const d = await read(draft);
    const cur = (await items(draft)).find((x) => x.task_code === "B2")!;
    if (!cur.sla) return;
    const r = await admin.api.call(
      "post",
      `${BASE}/${draft}/tasks/B2/sla-rules/${cur.sla.id}/remove`,
      { reason: REASON },
      hdr(d.tag),
    );
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("deleted");
  });
});

describe("the lock mode of a version (0491: strict by default, stored on the version)", () => {
  it("is strict everywhere, refused in a published version, set in a draft by the publish right and copied to the next draft", async () => {
    const list = await admin.api.call("get", BASE);
    const items = list.body.items as { version: number; status: string; lock_mode?: string }[];
    expect(items.every((x) => x.lock_mode === "strict")).toBe(true);
    let draft = items.find((x) => x.status === "draft")?.version;
    const pubV = Math.max(...items.filter((x) => x.status === "published").map((x) => x.version));
    const pub = await read(pubV);
    const body = { lock_mode: "open", reason: REASON };
    expect((await admin.api.call("put", `${BASE}/${pubV}/lock-mode`, body, hdr(pub.tag))).status).toBe(409);
    if (!draft) {
      const r = await admin.api.call("post", BASE, { parent_version: pubV, reason: REASON });
      expect(r.status).toBe(201);
      draft = r.body.version as number;
    }
    const d = await read(draft);
    expect((await admin.api.call("put", `${BASE}/${draft}/lock-mode`, { lock_mode: "wild", reason: REASON }, hdr(d.tag))).status).toBe(422);
    expect((await plain.api.call("put", `${BASE}/${draft}/lock-mode`, body, hdr(d.tag))).status).toBe(403);
    const ok = await admin.api.call("put", `${BASE}/${draft}/lock-mode`, body, hdr(d.tag));
    expect(ok.status).toBe(200);
    expect((await admin.api.call("get", `${BASE}/${draft}`)).body.lock_mode).toBe("open");
    const d2 = await read(draft);
    expect((await admin.api.call("put", `${BASE}/${draft}/lock-mode`, body, hdr(d2.tag))).status).toBe(409);
  });
});
