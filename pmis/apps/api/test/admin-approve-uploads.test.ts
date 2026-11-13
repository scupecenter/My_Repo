import type { NestExpressApplication } from "@nestjs/platform-express";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { q } from "./calc-helpers";
import { Api, startApp, superDb } from "./helpers";
import { day, uploadFile } from "./tpl-helpers";
import { filled, moreSite, streamTeam, taskRow } from "./tpl-stream-helpers";
import { plainAdmin } from "./wf-helpers";

/**
 * Migration 0087 (owner decision 1 of 2026-11-12): the System Admin "approve all as is" of an upload batch of a task stream (action `admin_approve`).
 * Region 7 (the stream fixtures); tasks A2 and A5 of workflow v1. Dates are fixed past dates. The admin holds no cell of the Responsibility Matrix: the bypass of the
 * L2 holders is what is under test.
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

const upload = async (api: Api, buf: Buffer): Promise<Record<string, any>> => {
  const res = await uploadFile(api, buf, "filled.xlsx", {});
  if (res.status !== 202)
    throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as Record<string, any>;
};
const submit = (api: Api, id: string, version: number | string) =>
  api.call("post", `/import-batches/${id}/submit`, undefined, {
    "If-Match": `"${version}"`,
  });
const decide = (
  api: Api,
  id: string,
  version: number | string,
  body: Record<string, unknown>,
) =>
  api.call("post", `/import-batches/${id}/decisions`, body, {
    "If-Match": `"${version}"`,
  });
const REASON = "Handover pack accepted as it is by the PMO";
const flags = async (id: string) =>
  (
    await q<{
      state: string;
      admin_override: boolean;
      admin_approved_as_is: boolean;
      incomplete: boolean;
      incomplete_reasons: string[];
      admin_approve_reason: string | null;
    }>(
      db,
      `SELECT state::text AS state, admin_override, admin_approved_as_is, incomplete, incomplete_reasons, admin_approve_reason FROM task_instances WHERE id = $1`,
      [id],
    )
  )[0]!;

describe("admin approve as is", () => {
  it("refuses a holder of L2, an admin without step-up, a short reason and a partial scope; nothing changes", async () => {
    const t = await streamTeam(app, db, { A2: "open" });
    const batch = await upload(
      t.entry.api,
      await filled(t.entry.api, "TPL-SITE-DA", [
        { "Site ID": t.site.code, "A2 Actual Date": day("2026-01-10") },
      ]),
    );
    const sent = (await submit(t.entry.api, batch.id, batch.version)).body;

    // the holder of L2 and the uploader are not System Admins: 403 whatever the batch shows
    expect(
      (
        await decide(t.approve.api, batch.id, sent.version, {
          action: "admin_approve",
          scope: "all",
          note: REASON,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await decide(t.entry.api, batch.id, sent.version, {
          action: "admin_approve",
          scope: "all",
          note: REASON,
        })
      ).status,
    ).toBe(403);
    const noStep = await plainAdmin(app, db, false);
    const stepRes = await decide(noStep.api, batch.id, sent.version, {
      action: "admin_approve",
      scope: "all",
      note: REASON,
    });
    expect(stepRes.status).toBe(401);
    expect(stepRes.body.code).toBe("step_up_required");

    const admin = await plainAdmin(app, db);
    expect(
      (
        await decide(admin.api, batch.id, sent.version, {
          action: "admin_approve",
          scope: "all",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await decide(admin.api, batch.id, sent.version, {
          action: "admin_approve",
          scope: "all",
          note: "ok",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await decide(admin.api, batch.id, sent.version, {
          action: "admin_approve",
          scope: "rows",
          rows: [
            {
              row_id: "00000000-0000-4000-8000-000000000001",
              decision: "approved",
            },
          ],
          note: REASON,
        })
      ).status,
    ).toBe(422);
    expect((await taskRow(db, t.tasks.A2!)).state).toBe("in_approval");
    expect(await flags(t.tasks.A2!)).toMatchObject({
      admin_override: false,
      admin_approved_as_is: false,
      incomplete: false,
    });
    expect(
      await q(
        db,
        `SELECT 1 FROM audit_log WHERE entity_type = 'task' AND entity_id = $1 AND action = 'task_admin_approved_as_is'`,
        [t.tasks.A2],
      ),
    ).toHaveLength(0);
  });

  it("approves every row as it is, whoever holds L2: incomplete rows are flagged, the rows of a non-holder are approved, each row is audited, the successor opens", async () => {
    const t = await streamTeam(app, db, { A2: "open", A5: "locked" });
    const t2 = await moreSite(db, t, { A2: "open", A5: "locked" });
    const buf = await filled(t.entry.api, "TPL-SITE-DA", [
      {
        "Site ID": t.site.code,
        "A2 Planned Date": day("2026-01-05"),
        "A2 Actual Date": day("2026-01-10"),
      },
      { "Site ID": t2.site.code, "A2 Planned Date": day("2026-01-06"), "A2 Actual Date": day("2026-01-12") },
    ]);
    const batch = await upload(t.entry.api, buf);
    expect(batch.counts).toMatchObject({ update: 2, error: 0 });
    const sent = (await submit(t.entry.api, batch.id, batch.version)).body;

    const admin = await plainAdmin(app, db);
    const done = await decide(admin.api, batch.id, sent.version, {
      action: "admin_approve",
      scope: "all",
      note: REASON,
    });
    expect(done.status).toBe(200);
    expect(done.body.outcome).toMatchObject({
      decided: 2,
      approved: 2,
      rejected: 0,
      held: [],
      failed: [],
    });
    expect(done.body.status).toBe("approved");
    expect(done.body.counts).toMatchObject({
      approved: 2,
      pending: 0,
      admin_approved: 2,
    });
    // incomplete = what the files and the document slots lack (no document was uploaded here): the count of the answer is the count of the flags
    const nIncomplete = (await flags(t.tasks.A2!)).incomplete ? 1 : 0;
    const nIncomplete2 = (await flags(t2.tasks.A2!)).incomplete ? 1 : 0;
    expect(done.body.outcome.incomplete).toBe(nIncomplete + nIncomplete2);
    expect(done.body.counts.incomplete).toBe(nIncomplete + nIncomplete2);

    // the task of the complete row: approved with its values, flagged as an override, not incomplete
    expect(await taskRow(db, t.tasks.A2!)).toMatchObject({
      state: "approved",
      actual_date: "2026-01-10",
      planned_date: "2026-01-05",
    });
    expect(await flags(t.tasks.A2!)).toMatchObject({
      admin_override: true,
      admin_approved_as_is: true,
      admin_approve_reason: REASON,
    });
    // the reasons say what was missing: never an actual date here (both rows carry one)
    for (const id of [t.tasks.A2!, t2.tasks.A2!]) {
      const f = await flags(id);
      expect(f.incomplete_reasons).not.toContain("missing_actual_date");
      expect(f.incomplete).toBe(f.incomplete_reasons.length > 0);
    }
    expect((await taskRow(db, t2.tasks.A2!)).actual_date).toBe("2026-01-12");
    // the normal engine opens the successors
    expect((await taskRow(db, t.tasks.A5!)).state).toBe("open");
    expect((await taskRow(db, t2.tasks.A5!)).state).toBe("open");

    // the rows of the batch
    const rows = (
      await admin.api.call("get", `/import-batches/${batch.id}/rows`)
    ).body.items as Record<string, any>[];
    expect(rows.map((r) => r.decision)).toEqual(["approved", "approved"]);
    const dbRows = await q<{
      admin_approved: boolean;
      incomplete: boolean;
      decided_by: string;
    }>(
      db,
      `SELECT admin_approved, incomplete, decided_by::text AS decided_by FROM import_batch_rows WHERE batch_id = $1 ORDER BY ord`,
      [batch.id],
    );
    expect(dbRows.map((r) => r.admin_approved)).toEqual([true, true]);
    expect(dbRows.filter((r) => r.incomplete).length).toBe(nIncomplete + nIncomplete2);
    expect(dbRows.every((r) => r.decided_by === admin.user.id)).toBe(true);

    // the history and the audit: one workflow step and one audit row per task, with the reason, as an admin override; one audit row for the batch
    for (const id of [t.tasks.A2!, t2.tasks.A2!]) {
      const steps = await q<{
        action: string;
        admin_override: boolean;
        override_reason: string;
        acted_by: string;
      }>(
        db,
        `SELECT action::text AS action, admin_override, override_reason, acted_by::text AS acted_by FROM workflow_steps WHERE task_id = $1 AND action::text = 'admin_override'`,
        [id],
      );
      expect(steps).toEqual([
        {
          action: "admin_override",
          admin_override: true,
          override_reason: REASON,
          acted_by: admin.user.id,
        },
      ]);
      const aud = await q<{
        actor_id: string;
        reason: string;
        is_admin_override: boolean;
      }>(
        db,
        `SELECT actor_id::text AS actor_id, reason, is_admin_override FROM audit_log WHERE entity_type = 'task' AND entity_id = $1 AND action = 'task_admin_approved_as_is'`,
        [id],
      );
      expect(aud).toEqual([
        { actor_id: admin.user.id, reason: REASON, is_admin_override: true },
      ]);
    }
    const ba = await q<{
      action: string;
      is_admin_override: boolean;
      reason: string;
    }>(
      db,
      `SELECT action, is_admin_override, reason FROM audit_log WHERE entity_type = 'import_batch' AND entity_id = $1 AND action = 'import_batch_admin_approve'`,
      [batch.id],
    );
    expect(ba).toEqual([
      {
        action: "import_batch_admin_approve",
        is_admin_override: true,
        reason: REASON,
      },
    ]);
    // the uploader is told
    expect(
      await q(
        db,
        `SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'import_batch'`,
        [t.entry.user.id],
      ),
    ).toHaveLength(1);

    // a batch that is approved is closed: a second approve as is is refused
    const again = await decide(admin.api, batch.id, done.body.version, {
      action: "admin_approve",
      scope: "all",
      note: REASON,
    });
    expect(again.status).toBe(409);
  });

  it("approves a Save Draft / Planning batch: rows without an actual date are approved with what they have and flagged incomplete", async () => {
    const t = await streamTeam(app, db, { A2: "open", A5: "locked" });
    const buf = await filled(t.entry.api, "TPL-SITE-DA", [
      { "Site ID": t.site.code, "A2 Planned Date": day("2026-01-05") },
    ]);
    const res = await uploadFile(t.entry.api, buf, "filled.xlsx", { mode: "draft" });
    expect(res.status).toBe(202);
    const b = res.body as Record<string, any>;
    expect(b.counts).toMatchObject({ update: 1, error: 0 });
    const admin = await plainAdmin(app, db);
    const r = await decide(admin.api, b.id, b.version, { action: "admin_approve", scope: "all", note: REASON });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toMatchObject({ decided: 1, approved: 1, incomplete: 1, failed: [] });
    expect(await taskRow(db, t.tasks.A2!)).toMatchObject({ state: "approved", actual_date: null, planned_date: "2026-01-05" });
    const f = await flags(t.tasks.A2!);
    expect(f).toMatchObject({ admin_override: true, admin_approved_as_is: true, incomplete: true });
    expect(f.incomplete_reasons).toContain("missing_actual_date");
    expect((await taskRow(db, t.tasks.A5!)).state).toBe("open");
    const detail = await admin.api.call("get", `/sites/${t.site.id}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body.data_gap_items)).toContain("approved_incomplete");
  });
});
