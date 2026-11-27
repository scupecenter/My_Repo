import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, superDb } from "./helpers";
import { plainAdmin } from "./wf-helpers";
import type { Actor } from "./wf-helpers";

/**
 * GET /users pages the user rows first and joins the sign-in, 2FA and MFA lookups for that page only, so the time does not grow with the
 * total number of users. With a few thousand users the page must come back quickly, sorted by name, with the next cursor and the full total.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
const TAG = `scale${Date.now().toString(36)}`;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db);
  await db.query(
    `INSERT INTO users (email, display_name, status, updated_at)
     SELECT $1 || g || '@example.test', 'Zz ' || $1 || ' ' || lpad(g::text, 5, '0'), 'active'::"UserStatus", now() FROM generate_series(1, 4000) g`,
    [TAG],
  );
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe("users list at scale", () => {
  it("returns a page of 200 fast, in name order, with cursor and total", async () => {
    await admin.api.call("get", `/users?limit=5`); // warm the app (connections, plans) so a cold shared runner does not count
    const t0 = Date.now();
    const res = await admin.api.call("get", `/users?limit=200&q=${TAG}`);
    const ms = Date.now() - t0;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const items = res.body.items as { display_name: string; local_sign_in: boolean; two_factor: string }[];
    expect(items).toHaveLength(200);
    expect(items.map((i) => i.display_name)).toEqual([...items.map((i) => i.display_name)].sort());
    expect(items[0]!.display_name).toBe(`Zz ${TAG} 00001`);
    expect(items[0]!.two_factor).toBe("off");
    expect((res.body.page as { total: number; next_cursor: string | null }).total).toBe(4000);
    expect((res.body.page as { next_cursor: string | null }).next_cursor).not.toBeNull();
    expect(ms, `took ${ms} ms`).toBeLessThan(5000);
    console.log(`users list, 4000 extra users, page of 200: ${ms} ms`);
  });

  it("the unfiltered page is as fast", async () => {
    const t0 = Date.now();
    const res = await admin.api.call("get", `/users?limit=200`);
    const ms = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(ms, `took ${ms} ms`).toBeLessThan(5000);
  });
});
