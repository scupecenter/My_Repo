import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes } from "node:crypto";
import type { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeUser, startApp, superDb } from "./helpers";
import { actor, plainAdmin } from "./wf-helpers";
import type { Actor } from "./wf-helpers";

/**
 * The + Filter pilot: Users, Assignments, Warehouse movements. Each screen checks the same right as its own list (the filter never shows more than the
 * list does), and a tree only narrows the rows.
 */
const TAG = randomBytes(3).toString("hex");
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
const tree = (field: string, operator: string, value: unknown) =>
  `filter=${encodeURIComponent(JSON.stringify({ op: "and", items: [{ field, operator, value }] }))}`;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe("filter pilot", () => {
  it("offers the fields of Users, Assignments and Warehouse movements only to who can open the list", async () => {
    const nobody = await actor(app, db, { regions: null, grants: [] });
    for (const screen of ["users", "assignments", "warehouse-movements"]) {
      const no = await nobody.api.call(
        "get",
        `/saved-views/filter-fields?screen_key=${screen}`,
      );
      expect(no.status, screen).toBe(403);
      const ok = await admin.api.call(
        "get",
        `/saved-views/filter-fields?screen_key=${screen}`,
      );
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((ok.body.items as unknown[]).length).toBeGreaterThan(3);
    }
  });

  it("narrows the user list by a tree", async () => {
    const u = await makeUser(db, { status: "active" });
    await makeUser(db, { status: "active" });
    // No unfiltered list call here: it adds nothing to this test and its cost grows with every user the other suites leave in the shared
    // database (about 60 s with 8000 users, because the list joins per-row sign-in and 2FA lookups before it pages), which hit the 30 s limit.
    const res = await admin.api.call(
      "get",
      `/users?${tree("email", "contains", u.email)}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const mails = (res.body.items as { email: string }[]).map((r) => r.email);
    expect(mails).toEqual([u.email]);
  });

  it("narrows the warehouse movements by a tree and keeps the list status", async () => {
    const res = await admin.api.call(
      "get",
      `/warehouse/movements?${tree("doc_no", "contains", `NOPE-${TAG}`)}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});
