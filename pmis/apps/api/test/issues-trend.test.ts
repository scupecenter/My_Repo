import type { NestExpressApplication } from "@nestjs/platform-express";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, superDb } from "./helpers";
import { G } from "./reg-helpers";
import { actor, plainAdmin } from "./wf-helpers";

/** Weekly issues trend (contract 0.15.592, migration 0715): opened and closed per ISO week from the issue register, dashboard.view only, caller's issues regions. */
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

describe("issues weekly trend (contract 0.15.592)", () => {
  it("returns one row per ISO week, oldest first, validates the range and needs dashboard.view", async () => {
    const admin = await plainAdmin(app, db);
    const r = await admin.api.call("get", "/dashboard/issues-trend");
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(true);
    expect(r.body.weeks).toBe(12);
    const items = r.body.items as { week_start: string; week_end: string; opened: number; closed: number; open_end: number }[];
    expect(items).toHaveLength(12);
    for (const [i, w] of items.entries()) {
      expect(new Date(`${w.week_start}T00:00:00Z`).getUTCDay()).toBe(1); // Monday
      expect(w.week_end >= w.week_start).toBe(true);
      expect(w.opened).toBeGreaterThanOrEqual(0);
      expect(w.closed).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(w.week_start > items[i - 1]!.week_start).toBe(true);
    }
    expect((await admin.api.call("get", "/dashboard/issues-trend?weeks=4")).body.items).toHaveLength(4);
    expect((await admin.api.call("get", "/dashboard/issues-trend?weeks=3")).status).toBe(422);
    expect((await admin.api.call("get", "/dashboard/issues-trend?weeks=53")).status).toBe(422);
    const none = await actor(app, db, { level: "entry", grants: G("sites", "view"), regions: [7], modules: null });
    expect((await none.api.call("get", "/dashboard/issues-trend")).status).toBe(403);
  });
});
