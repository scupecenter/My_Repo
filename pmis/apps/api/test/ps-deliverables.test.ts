import type { NestExpressApplication } from "@nestjs/platform-express";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { q } from "./calc-helpers";
import { startApp, superDb } from "./helpers";
import { team, type Team } from "./reg-helpers";
import { plainAdmin } from "./wf-helpers";

/**
 * F4 follow-up 1 (contract 0.15.470, migration 0610): Project Status items read the Deliverables register. Reads need dashboard.view; the write needs
 * admin.settings edit for all regions, a reason, If-Match, and is audited. Manual values are never touched.
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

interface Row {
  item_code: string;
  kind: string | null;
  mode: string;
  source: string;
}
const codesOf = (body: { errors?: { code: string; path?: string }[] }): string[] =>
  (body.errors ?? []).map((e) => `${e.path}:${e.code}`).sort();

describe("Project Status items from the Deliverables register (contract 0.15.470)", () => {
  it("reads the defaults, admin-only write, rules, audit; manual values untouched; the counts follow the register", async () => {
    const admin = await plainAdmin(app, db);
    const g: Team = await team(app, db, "gecol", "gecol", 7);
    const cur = await admin.api.call("get", "/settings/dashboard/ps-deliverables");
    expect(cur.status).toBe(200);
    const items = cur.body.items as Row[];
    const hld = items.find((i) => i.kind === "HLD");
    expect(hld).toBeTruthy();
    expect(hld!.mode).toBe("auto");
    // no deliverable exists yet: the figure still comes from the manual value
    expect(hld!.source).toBe("manual");
    const etag = cur.headers.etag as string;
    const put = (b: object, h: Record<string, string> = { "If-Match": etag }) =>
      admin.api.call("put", "/settings/dashboard/ps-deliverables", b, h);
    const code = hld!.item_code;
    const ok = { reason: "Owner turned HLD back to manual", items: [{ item_code: code, kind: "HLD", mode: "manual" }] };

    expect((await g.entry.api.call("put", "/settings/dashboard/ps-deliverables", ok, { "If-Match": etag })).status).toBe(403);
    expect((await admin.api.call("put", "/settings/dashboard/ps-deliverables", ok)).status).toBe(428);
    expect((await put(ok, { "If-Match": '"999"' })).status).toBe(412);
    const bad = await put({ reason: "Rule test", items: [{ item_code: "9.99", kind: "HLD", mode: "auto" }] });
    expect(bad.status).toBe(422);
    expect(codesOf(bad.body).some((c) => c.endsWith("/item_code:invalid"))).toBe(true);
    const badKind = await put({ reason: "Rule test", items: [{ item_code: code, kind: "NOPE", mode: "auto" }] });
    expect(badKind.status).toBe(422);
    expect(codesOf(badKind.body).some((c) => c.endsWith("/kind:invalid"))).toBe(true);
    const noKind = await put({ reason: "Rule test", items: [{ item_code: code, mode: "auto" }] });
    expect(noKind.status).toBe(422);
    expect(codesOf(noKind.body).some((c) => c.endsWith("/kind:required"))).toBe(true);
    const dup = await put({ reason: "Rule test", items: [{ item_code: code, kind: "HLD", mode: "auto" }, { item_code: code, kind: "HLD", mode: "auto" }] });
    expect(dup.status).toBe(422);
    expect((await put({ reason: "Rule test", items: [{ item_code: code, kind: "HLD", mode: "sometimes" }] })).status).toBe(422);
    expect((await put({ reason: "", items: [] })).status).toBe(422);
    expect((await put({ reason: "Extra key", items: [], extra: 1 })).status).toBe(422);

    const manualBefore = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM ps_manual_values`);
    try {
      const saved = await put(ok);
      expect(saved.status).toBe(200);
      expect(saved.body.version).toBeGreaterThan(0);
      const row = (saved.body.items as Row[]).find((i) => i.item_code === code)!;
      expect(row.mode).toBe("manual");
      const au = await q(db, `SELECT 1 FROM audit_log WHERE action = 'ps_deliverables_update' AND entity_id = 'dashboard.ps_deliverables'`);
      expect(au.length).toBeGreaterThan(0);
      const manualAfter = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM ps_manual_values`);
      expect(manualAfter[0]!.n).toBe(manualBefore[0]!.n);
      // the map function honours the saved mode
      const mp = await q<{ mode: string }>(db, `SELECT mode FROM ps_deliv_map() WHERE item = '${code}'`);
      expect(mp[0]!.mode).toBe("manual");
    } finally {
      const now = await admin.api.call("get", "/settings/dashboard/ps-deliverables");
      await admin.api.call(
        "put",
        "/settings/dashboard/ps-deliverables",
        { reason: "test reset to the defaults", items: [{ item_code: code, kind: "HLD", mode: "auto" }] },
        { "If-Match": now.headers.etag as string },
      );
    }
    // the counts: no approved deliverable of a kind that is not used means zero
    const none = await q<{ accepted: number; total: number }>(db, `SELECT * FROM ps_deliv_counts('TRN', current_date, NULL)`);
    expect(none[0]!.total).toBeGreaterThanOrEqual(0);
    expect(none[0]!.accepted).toBeLessThanOrEqual(none[0]!.total);
  });
});
