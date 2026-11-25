import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes } from "node:crypto";
import type { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, superDb } from "./helpers";
import { actor, makeSite, makeTask, Site } from "./wf-helpers";
import type { Actor } from "./wf-helpers";

/**
 * The unified filter (contract 0.15.45): value lists of the enum fields, the screens `site-master-<menu>` and `dashboard`, the Master columns `m:<ord>`, the `filter`
 * of GET /site-master/{menu}/rows and of the dashboard endpoints. Everything runs in the shared test database: every site has a code with this file's tag, every
 * tree starts with a condition on that tag (so other files' sites never count), and the values written here carry the tag too.
 */
const TAG = randomBytes(3).toString("hex").toUpperCase();
/** The sites made inside single tests carry this tag instead, so the whole-file counts (the four sites above) are never disturbed. */
const EXTRA = randomBytes(3).toString("hex").toUpperCase();
let app: NestExpressApplication;
let db: PgClient;

type Tree = { op: "and" | "or"; items: unknown[] };
type Field = {
  key: string;
  type: string;
  operators: string[];
  group?: { key: string; label_en: string; label_ar: string };
  options?: { value: string; label_en: string }[];
  truncated?: boolean;
};
const q = (tree: Tree): string =>
  `filter=${encodeURIComponent(JSON.stringify(tree))}`;
const mine = (...items: unknown[]): Tree => ({
  op: "and",
  items: [{ field: "site_code", operator: "contains", value: TAG }, ...items],
});
const cond = (field: string, operator: string, value?: unknown) => ({
  field,
  operator,
  ...(value === undefined ? {} : { value }),
});
const SITES_VIEW: [string, string][] = [["sites", "view"]];
const DASH_VIEW: [string, string][] = [
  ["dashboard", "view"],
  ["sites", "view"],
];

const catalogue = async (
  a: Actor,
  screen: string,
): Promise<Map<string, Field>> => {
  const res = await a.api.call(
    "get",
    `/saved-views/filter-fields?screen_key=${screen}`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return new Map((res.body.items as Field[]).map((f) => [f.key, f]));
};
const rowCodes = async (
  a: Actor,
  menu: string,
  tree: Tree,
): Promise<string[]> => {
  const res = await a.api.call(
    "get",
    `/site-master/${menu}/rows?limit=200&${q(tree)}`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.rows as { site_code: string }[])
    .map((r) => r.site_code)
    .sort();
};
const sorted = (...sites: Site[]): string[] => sites.map((s) => s.code).sort();

let tri1: Site, tri2: Site, zaw: Site, ben: Site;
/** The Master column whose value is the actual date of a task (a date field of the Master, not a field of `sites`). */
let dateCol: { task_code: string; ord: number };
/** A Master column filled by a task input that is a list with fixed options, the key of its value in the task and the options the catalogue offers. */
let enumCol: { task_code: string; key: string; ord: number; options: string[] };

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  tri1 = await makeSite(db, 1, { prefix: `UF${TAG}A`, scenario: "new_build" });
  tri2 = await makeSite(db, 1, { prefix: `UF${TAG}B`, scenario: "expansion" });
  zaw = await makeSite(db, 4, { prefix: `UF${TAG}C`, scenario: "expansion" });
  ben = await makeSite(db, 5, { prefix: `UF${TAG}D`, scenario: "hot_swap" });
  // two sites share a sub-region (the options are distinct), one is elsewhere, one has none
  await db.query(
    `UPDATE sites SET sub_region = $1 WHERE id = ANY($2::uuid[])`,
    [`SRA-${TAG}`, [tri1.id, tri2.id]],
  );
  await db.query(`UPDATE sites SET sub_region = $1 WHERE id = $2`, [
    `SRB-${TAG}`,
    ben.id,
  ]);
  await db.query(
    `UPDATE sites SET delivery_batch = $1 WHERE id = ANY($2::uuid[])`,
    [`Batch-${TAG}`, [tri1.id, zaw.id]],
  );

  const d =
    await db.query(`SELECT tf.task_code, mc.ord FROM template_task_fields tf JOIN master_columns mc ON mc.letter = tf.master_col AND mc.is_active
    WHERE tf.field_key = 'actual_date' AND tf.is_active AND tf.scenarios IS NULL AND tf.projection IS NULL AND mc.ord > 33 AND mc.ord < 180
      AND (SELECT count(*) FROM template_task_fields x WHERE x.is_active AND x.master_col = tf.master_col) = 1
      AND EXISTS (SELECT 1 FROM task_definitions td JOIN workflow_definitions w ON w.id = td.workflow_id AND w.version = 1 WHERE td.code = tf.task_code)
    ORDER BY mc.ord LIMIT 1`);
  dateCol = d.rows[0] as { task_code: string; ord: number };

  const e =
    await db.query(`SELECT tf.task_code, tf.field_key, mc.ord FROM template_task_fields tf JOIN master_columns mc ON mc.letter = tf.master_col AND mc.is_active
    WHERE tf.is_active AND tf.field_type = 'list' AND tf.field_key LIKE 'v:%' AND tf.scenarios IS NULL AND tf.projection IS NULL AND mc.ord > 33 AND mc.ord < 180
      AND (SELECT count(*) FROM template_task_fields x WHERE x.is_active AND x.master_col = tf.master_col) = 1
      AND EXISTS (SELECT 1 FROM task_definitions td JOIN workflow_definitions w ON w.id = td.workflow_id AND w.version = 1 WHERE td.code = tf.task_code)
    ORDER BY mc.ord`);
  const admin = await actor(app, db, { regions: null, grants: SITES_VIEW });
  const cat = await catalogue(admin, "site-master-master");
  for (const r of e.rows as {
    task_code: string;
    field_key: string;
    ord: number;
  }[]) {
    const f = cat.get(`m:${r.ord}`);
    if (f?.type === "enum" && (f.options?.length ?? 0) >= 2) {
      enumCol = {
        task_code: r.task_code,
        key: r.field_key.slice(2),
        ord: r.ord,
        options: f.options!.map((o) => o.value),
      };
      break;
    }
  }
});
afterAll(async () => {
  await db.end();
  await app.close();
});

describe("enum value lists on GET /saved-views/filter-fields", () => {
  it("offers the distinct non-empty values of the data, once each, with a group, and no text operators", async () => {
    const a = await actor(app, db, { regions: null, grants: SITES_VIEW });
    const cat = await catalogue(a, "sites");
    const sub = cat.get("sub_region")!;
    expect(sub.type).toBe("enum");
    expect(sub.operators).toEqual([
      "is",
      "is_not",
      "in",
      "not_in",
      "empty",
      "not_empty",
    ]);
    expect(sub.group).toMatchObject({ key: "site" });
    expect(sub.group!.label_ar).toEqual(expect.any(String));
    expect(sub.truncated).toBe(false);
    const values = sub.options!.map((o) => o.value);
    expect(values.filter((v) => v.includes(TAG)).sort()).toEqual([
      `SRA-${TAG}`,
      `SRB-${TAG}`,
    ]); // two sites hold SRA, it is listed once
    expect(new Set(values).size).toBe(values.length);
    expect(values.every((v) => v.trim() !== "")).toBe(true);
    expect(values.length).toBeLessThanOrEqual(500);
    // the scope flags are fixed yes or na; every field of the dropdown carries its group
    expect(cat.get("scope_gecol_power")!.options!.map((o) => o.value)).toEqual([
      "yes",
      "na",
    ]);
    expect([...cat.values()].every((f) => f.group?.key)).toBe(true);
  });

  it("limits the values to the regions of the caller: a Tripoli reader never sees a Benghazi value", async () => {
    const tripoli = await actor(app, db, { regions: [1], grants: SITES_VIEW });
    for (const screen of ["sites", "site-master-master", "site-master-cw"]) {
      const cat = await catalogue(tripoli, screen);
      const values = cat
        .get("sub_region")!
        .options!.map((o) => o.value)
        .filter((v) => v.includes(TAG));
      expect(values, screen).toEqual([`SRA-${TAG}`]);
      const batches = cat
        .get("delivery_batch")!
        .options!.map((o) => o.value)
        .filter((v) => v.includes(TAG));
      expect(batches, screen).toEqual([`Batch-${TAG}`]); // tri1 holds it; zaw (Zawia) is not visible
    }
    const zawia = await actor(app, db, { regions: [4], grants: SITES_VIEW });
    const cat = await catalogue(zawia, "sites");
    expect(
      cat
        .get("sub_region")!
        .options!.map((o) => o.value)
        .filter((v) => v.includes(TAG)),
    ).toEqual([]);
  });

  it("does not check a value of an open enum field (it matches nothing); a fixed set still answers 422 invalid_value", async () => {
    const a = await actor(app, db, { regions: null, grants: SITES_VIEW });
    const open = await a.api.call(
      "get",
      `/sites?${q(mine(cond("sub_region", "is", `Nowhere-${TAG}`)))}`,
    );
    expect(open.status).toBe(200);
    expect(open.body.items).toEqual([]);
    const hit = await a.api.call(
      "get",
      `/sites?limit=50&${q(mine(cond("sub_region", "is", `SRA-${TAG}`)))}`,
    );
    expect(
      (hit.body.items as { site_code: string }[])
        .map((s) => s.site_code)
        .sort(),
    ).toEqual(sorted(tri1, tri2));
    const fixed = await a.api.call(
      "get",
      `/sites?${q(mine(cond("delivery_scenario", "is", "teleport")))}`,
    );
    expect(fixed.status).toBe(422);
    expect(fixed.body.errors[0]).toMatchObject({ code: "invalid_value" });
    // the text operators are gone for a code field
    const op = await a.api.call(
      "get",
      `/sites?${q(mine(cond("sub_region", "contains", "SR")))}`,
    );
    expect(op.status).toBe(422);
    expect(op.body.errors[0]).toMatchObject({ code: "invalid_operator" });
  });
});

describe("screens site360-<menu> and dashboard", () => {
  it("site-master-master offers the sites fields and the Master columns as m:<ord>, typed like the grid, with the phase band as group", async () => {
    const a = await actor(app, db, { regions: null, grants: SITES_VIEW });
    const cat = await catalogue(a, "site-master-master");
    const sitesCat = await catalogue(a, "sites");
    for (const k of sitesCat.keys()) expect(cat.has(k), k).toBe(true);
    const date = cat.get(`m:${dateCol.ord}`)!;
    expect(date).toBeDefined();
    expect(date.type).toBe("date");
    expect(date.operators).toContain("between");
    expect(date.group?.key).toEqual(expect.any(String));
    expect(
      enumCol,
      "no list column filled by a task input in the seed",
    ).toBeDefined();
    const en = cat.get(`m:${enumCol.ord}`)!;
    expect(en.type).toBe("enum");
    expect(en.options!.length).toBeGreaterThanOrEqual(2);
    // a Master column that is a field of `sites` is offered once, as the sites field (Site ID 2, region 5, sub-region 6, status 182)
    for (const ord of [2, 5, 6, 182])
      expect(cat.has(`m:${ord}`), `m:${ord}`).toBe(false);
    expect(
      [...cat.keys()].filter((k) => k.startsWith("m:")).length,
    ).toBeGreaterThan(20);
    expect([...cat.values()].every((f) => f.group?.key)).toBe(true);
  });

  it("a menu offers its own Master columns only: a column of another menu is not in site360-design_acq", async () => {
    const a = await actor(app, db, { regions: null, grants: SITES_VIEW });
    const master = await catalogue(a, "site-master-master");
    const design = await catalogue(a, "site-master-design_acq");
    const m = (c: Map<string, Field>): string[] =>
      [...c.keys()].filter((k) => k.startsWith("m:"));
    expect(m(design).length).toBeGreaterThan(0);
    expect(m(design).length).toBeLessThan(m(master).length);
    for (const k of m(design)) expect(master.has(k)).toBe(true);
    const outside = m(master).find((k) => !design.has(k))!;
    // the rows of that menu refuse it like an unknown field
    const res = await a.api.call(
      "get",
      `/site-master/design_acq/rows?${q(mine(cond(outside, "not_empty")))}`,
    );
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ code: "unknown_field" });
    expect(
      (
        await a.api.call(
          "get",
          `/site-master/master/rows?${q(mine(cond(outside, "not_empty")))}`,
        )
      ).status,
    ).toBe(200);
  });

  it("dashboard offers exactly the sites fields (no Master columns); an unknown menu or screen is 422", async () => {
    const a = await actor(app, db, { regions: null, grants: DASH_VIEW });
    const dash = await catalogue(a, "dashboard");
    const sites = await catalogue(a, "sites");
    for (const k of sites.keys()) expect(dash.has(k), k).toBe(true);
    expect([...dash.keys()].filter((k) => k.startsWith("m:"))).toEqual([]);
    expect(dash.get("sub_region")!.options!.map((o) => o.value)).toContain(
      `SRA-${TAG}`,
    );
    for (const bad of ["site-master-nope", "site-master-", "audit-log"]) {
      const res = await a.api.call(
        "get",
        `/saved-views/filter-fields?screen_key=${bad}`,
      );
      expect(res.status, bad).toBe(422);
    }
  });
});

describe("a hidden field stays hidden", () => {
  it("a site field a field rule hides is not offered, not filterable and its value is not a list option, on every screen and endpoint", async () => {
    const lead = await actor(app, db, { regions: null, grants: DASH_VIEW });
    const reader = await actor(app, db, { regions: null, grants: DASH_VIEW });
    const code = `uf_secret_${TAG.toLowerCase()}`;
    const f = await db.query(
      `INSERT INTO field_definitions (entity_type, code, label_en, data_type, in_list_filters) VALUES ('site', $1, 'Secret', 'text', true) RETURNING id`,
      [code],
    );
    await db.query(
      `INSERT INTO field_permissions (field_id, role_id, access) VALUES ($1, $2, 'hidden')`,
      [f.rows[0].id, reader.roleId],
    );
    await db.query(
      `UPDATE sites SET custom = custom || jsonb_build_object($1::text, $2::text) WHERE id = $3`,
      [code, `gold${TAG}`, tri1.id],
    );
    const tree = mine(cond(`c:${code}`, "is", `gold${TAG}`));
    for (const screen of ["sites", "site-master-master", "dashboard"]) {
      expect(
        (await catalogue(lead, screen)).has(`c:${code}`),
        `lead ${screen}`,
      ).toBe(true);
      const seen = await reader.api.call(
        "get",
        `/saved-views/filter-fields?screen_key=${screen}`,
      );
      expect(seen.status).toBe(200);
      expect(JSON.stringify(seen.body), `reader ${screen}`).not.toContain(code);
    }
    expect(await rowCodes(lead, "master", tree)).toEqual([tri1.code]);
    const refused = await reader.api.call(
      "get",
      `/site-master/master/rows?${q(tree)}`,
    );
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toMatchObject({ code: "unknown_field" });
    for (const path of [
      "/dashboard",
      "/dashboard/extras",
      "/dashboard/site-map",
      "/project-status",
    ]) {
      const lead200 = await lead.api.call("get", `${path}?${q(tree)}`);
      expect(lead200.status, `lead ${path}`).toBe(200);
      const res = await reader.api.call("get", `${path}?${q(tree)}`);
      expect(res.status, `reader ${path}`).toBe(422);
      expect(res.body.errors[0]).toMatchObject({ code: "unknown_field" });
    }
  });

  it("a Master column owned by a register the caller may not view is not offered and is refused; with the register right it works", async () => {
    const s = await makeSite(db, 1, { prefix: `UX${EXTRA}E` });
    const name = `UF-CON-${TAG}`;
    const party = (
      await db.query(
        `INSERT INTO external_parties (name, type, is_active) VALUES ($1, 'cw_contractor', true) RETURNING id`,
        [name],
      )
    ).rows[0].id as string;
    await db.query(
      `INSERT INTO procurement_records (site_id, region_id, scope, order_status, party_id) VALUES ($1, 1, 'CW', 'issued', $2)`,
      [s.id, party],
    );
    const mod = (
      await db.query(
        `SELECT module_key FROM register_definitions WHERE register_key = 'procurement'`,
      )
    ).rows[0].module_key as string;
    const without = await actor(app, db, { regions: null, grants: SITES_VIEW });
    const withReg = await actor(app, db, {
      regions: null,
      grants: [...SITES_VIEW, [mod, "view"]],
    });
    expect((await catalogue(without, "site-master-master")).has("m:36")).toBe(
      false,
    );
    expect((await catalogue(withReg, "site-master-master")).has("m:36")).toBe(true);
    const tree: Tree = {
      op: "and",
      items: [cond("site_code", "is", s.code), cond("m:36", "is", name)],
    };
    const refused = await without.api.call(
      "get",
      `/site-master/master/rows?${q(tree)}`,
    );
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toMatchObject({ code: "unknown_field" });
    expect(await rowCodes(withReg, "master", tree)).toEqual([s.code]);
  });
});

describe("GET /site-master/{menu}/rows with a filter on Master columns", () => {
  it("filters by a date column: is, before, after, between and empty, and reads the value the grid shows", async () => {
    const a = await actor(app, db, { regions: null, grants: SITES_VIEW });
    const early = await makeSite(db, 1, { prefix: `UX${EXTRA}F` });
    const late = await makeSite(db, 1, { prefix: `UX${EXTRA}G` });
    const none = await makeSite(db, 1, { prefix: `UX${EXTRA}H` });
    await makeTask(db, early, dateCol.task_code, "open", {
      actualDate: "2026-03-10",
    });
    await makeTask(db, late, dateCol.task_code, "open", {
      actualDate: "2026-05-20",
    });
    const key = `m:${dateCol.ord}`;
    const only = (...items: unknown[]): Tree => ({
      op: "and",
      items: [
        {
          field: "site_code",
          operator: "in",
          value: [early.code, late.code, none.code],
        },
        ...items,
      ],
    });
    expect(
      await rowCodes(a, "master", only(cond(key, "is", "2026-03-10"))),
    ).toEqual([early.code]);
    expect(
      await rowCodes(a, "master", only(cond(key, "after", "2026-04-01"))),
    ).toEqual([late.code]);
    expect(
      await rowCodes(a, "master", only(cond(key, "before", "2026-04-01"))),
    ).toEqual([early.code]);
    expect(
      await rowCodes(
        a,
        "master",
        only(cond(key, "between", ["2026-03-01", "2026-03-31"])),
      ),
    ).toEqual([early.code]);
    expect(await rowCodes(a, "master", only(cond(key, "not_empty")))).toEqual(
      [early.code, late.code].sort(),
    );
    expect(await rowCodes(a, "master", only(cond(key, "empty")))).toEqual([
      none.code,
    ]);
    // a date is a date: a number operator is refused, a bad date is 422
    const op = await a.api.call(
      "get",
      `/site-master/master/rows?${q(only(cond(key, "gt", 5)))}`,
    );
    expect(op.status).toBe(422);
    expect(op.body.errors[0]).toMatchObject({ code: "invalid_operator" });
    expect(
      (
        await a.api.call(
          "get",
          `/site-master/master/rows?${q(only(cond(key, "is", "soon")))}`,
        )
      ).status,
    ).toBe(422);
    // the filtered counts follow, the grid value is the one filtered on
    const res = await a.api.call(
      "get",
      `/site-master/master/rows?limit=50&${q(only(cond(key, "after", "2026-04-01")))}`,
    );
    expect(res.body.filtered).toBe(1);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
    expect(res.body.rows[0].values[String(dateCol.ord)]).toBe("2026-05-20");
  });

  it("filters by an enum column (is, is_not, in, not_in, not_empty), combined with a sites field in an OR group", async () => {
    expect(
      enumCol,
      "no list column filled by a task input in the seed",
    ).toBeDefined();
    const a = await actor(app, db, { regions: null, grants: SITES_VIEW });
    const [v1, v2] = enumCol.options as [string, string];
    const s1 = await makeSite(db, 1, { prefix: `UX${EXTRA}I` });
    const s2 = await makeSite(db, 1, { prefix: `UX${EXTRA}J` });
    const s3 = await makeSite(db, 4, {
      prefix: `UX${EXTRA}K`,
      scenario: "expansion",
    });
    for (const [s, v] of [
      [s1, v1],
      [s2, v2],
    ] as const) {
      const id = await makeTask(db, s, enumCol.task_code, "open");
      await db.query(
        `UPDATE task_instances SET "values" = jsonb_build_object($1::text, $2::text) WHERE id = $3`,
        [enumCol.key, v, id],
      );
    }
    const key = `m:${enumCol.ord}`;
    const only = (...items: unknown[]): Tree => ({
      op: "and",
      items: [
        {
          field: "site_code",
          operator: "in",
          value: [s1.code, s2.code, s3.code],
        },
        ...items,
      ],
    });
    expect(await rowCodes(a, "master", only(cond(key, "is", v1)))).toEqual([
      s1.code,
    ]);
    expect(
      await rowCodes(a, "master", only(cond(key, "in", [v2, "Nothing"]))),
    ).toEqual([s2.code]);
    expect(await rowCodes(a, "master", only(cond(key, "not_empty")))).toEqual(
      [s1.code, s2.code].sort(),
    );
    expect(await rowCodes(a, "master", only(cond(key, "is_not", v1)))).toEqual(
      [s2.code, s3.code].sort(),
    );
    expect(
      await rowCodes(a, "master", only(cond(key, "not_in", [v1, v2]))),
    ).toEqual([s3.code]);
    // an open list: a value nobody holds matches nothing and is not an error
    expect(
      await rowCodes(a, "master", only(cond(key, "is", `Nothing-${TAG}`))),
    ).toEqual([]);
    // (the enum column is v1) OR (the site is in Zawia)
    const group: Tree = {
      op: "or",
      items: [cond(key, "is", v1), cond("region_id", "is", "4")],
    };
    expect(await rowCodes(a, "master", only(group))).toEqual(
      [s1.code, s3.code].sort(),
    );
  });

  it("keeps every earlier tree working on the menu rows (the sites fields), and the region scope of the caller", async () => {
    const all = await actor(app, db, { regions: null, grants: SITES_VIEW });
    const tripoli = await actor(app, db, { regions: [1], grants: SITES_VIEW });
    const tree = mine({
      op: "or",
      items: [
        cond("delivery_scenario", "is", "expansion"),
        cond("region_id", "is", "5"),
      ],
    });
    expect(await rowCodes(all, "master", tree)).toEqual(sorted(tri2, zaw, ben));
    expect(await rowCodes(tripoli, "master", tree)).toEqual(sorted(tri2));
    expect(
      await rowCodes(all, "cw", mine(cond("sub_region", "is", `SRB-${TAG}`))),
    ).toEqual(sorted(ben));
  });

  it("answers 422 for an unknown field and for a Master column on a list that has none", async () => {
    const a = await actor(app, db, { regions: null, grants: SITES_VIEW });
    for (const field of ["nope", "m:9999", `m:${dateCol.ord}`]) {
      const path =
        field === `m:${dateCol.ord}` ? "/sites" : "/site-master/master/rows";
      const res = await a.api.call(
        "get",
        `${path}?${q(mine(cond(field, "not_empty")))}`,
      );
      expect(res.status, `${path} ${field}`).toBe(422);
      expect(res.body.errors[0], `${path} ${field}`).toMatchObject({
        code: "unknown_field",
      });
    }
  });
});

describe("GET /dashboard and the dashboard endpoints narrowed by filter", () => {
  const get = async (a: Actor, path: string, tree?: Tree, extra = "") => {
    const res = await a.api.call(
      "get",
      `${path}?${tree ? q(tree) : ""}${extra}`,
    );
    expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
    return res.body as Record<string, any>;
  };

  it("keeps only the matching sites in the headline, says it is not project wide, and only narrows the caller's regions", async () => {
    const all = await actor(app, db, { regions: null, grants: DASH_VIEW });
    const tripoli = await actor(app, db, { regions: [1], grants: DASH_VIEW });
    const plain = await get(all, "/dashboard");
    expect(plain.meta.project_wide).toBe(true);
    const everything = await get(all, "/dashboard", mine());
    expect(everything.headline.sites_total).toBe(4);
    expect(everything.meta.project_wide).toBe(false);
    const expansion = await get(
      all,
      "/dashboard",
      mine(cond("delivery_scenario", "is", "expansion")),
    );
    expect(expansion.headline.sites_total).toBe(2);
    const group = await get(
      all,
      "/dashboard",
      mine({
        op: "or",
        items: [
          cond("region_id", "is", "5"),
          cond("sub_region", "is", `SRA-${TAG}`),
        ],
      }),
    );
    expect(group.headline.sites_total).toBe(3); // tri1, tri2 (SRA) and ben (Benghazi)
    const narrow = await get(
      all,
      "/dashboard",
      mine(
        cond("region_id", "in", ["1"]),
        cond("delivery_scenario", "is", "expansion"),
      ),
    );
    expect(narrow.headline.sites_total).toBe(1);
    // beside the other filters of the page, and an empty match gives an empty view
    const both = await get(all, "/dashboard", mine(), "&region_id=4");
    expect(both.headline.sites_total).toBe(1);
    const nobody = await get(
      all,
      "/dashboard",
      mine(cond("site_code", "is", `NO-SUCH-${TAG}`)),
    );
    expect(nobody.headline.sites_total).toBe(0);
    // a Tripoli caller never gets more than Tripoli, whatever the tree asks for
    expect(
      (await get(tripoli, "/dashboard", mine())).headline.sites_total,
    ).toBe(2);
    expect(
      (await get(tripoli, "/dashboard", mine(cond("region_id", "is", "5"))))
        .headline.sites_total,
    ).toBe(0);
  });

  it("the extras, the map, the Project Status and the export follow the same tree", async () => {
    const all = await actor(app, db, {
      regions: null,
      grants: [...DASH_VIEW, ["dashboard", "export"]],
    });
    const tree = mine(
      cond("region_id", "in", ["1", "4"]),
      cond("delivery_scenario", "is", "expansion"),
    );
    const map = await get(all, "/dashboard/site-map", tree);
    const codes = (map.items as { site_code: string }[])
      .map((s) => s.site_code)
      .sort();
    expect(codes).toEqual(sorted(tri2, zaw));
    const unfilteredMap = await get(all, "/dashboard/site-map", mine());
    expect((unfilteredMap.items as unknown[]).length).toBe(4);
    await get(all, "/dashboard/extras", tree);
    const ps = await get(all, "/project-status", tree);
    expect(ps).toBeDefined();
    const exp = await all.api.call(
      "get",
      `/dashboard/export?format=xlsx&${q(tree)}`,
    );
    expect(exp.status).toBe(200);
  });

  it("answers 422 for an unknown field, a wrong operator or a malformed tree, on every dashboard endpoint", async () => {
    const a = await actor(app, db, {
      regions: null,
      grants: [...DASH_VIEW, ["dashboard", "export"]],
    });
    for (const path of [
      "/dashboard",
      "/dashboard/extras",
      "/dashboard/site-map",
      "/project-status",
      "/dashboard/export?format=xlsx",
    ]) {
      const sep = path.includes("?") ? "&" : "?";
      const unknown = await a.api.call(
        "get",
        `${path}${sep}${q(mine(cond("nope", "is", "x")))}`,
      );
      expect(unknown.status, path).toBe(422);
      expect(unknown.body.errors[0], path).toMatchObject({
        code: "unknown_field",
      });
      const op = await a.api.call(
        "get",
        `${path}${sep}${q(mine(cond("sub_region", "contains", "x")))}`,
      );
      expect(op.status, path).toBe(422);
      const bad = await a.api.call("get", `${path}${sep}filter=%7Bnot-json`);
      expect(bad.status, path).toBe(422);
    }
    // the dashboard has no Master columns
    const ord = await a.api.call(
      "get",
      `/dashboard?${q(mine(cond(`m:${dateCol.ord}`, "not_empty")))}`,
    );
    expect(ord.status).toBe(422);
    expect(ord.body.errors[0]).toMatchObject({ code: "unknown_field" });
  });
});

describe("permission denied", () => {
  it("the catalogue of site360-<menu> needs the Site Register right and the dashboard one needs the dashboard right too", async () => {
    const noSites = await actor(app, db, {
      regions: null,
      grants: [
        ["issues", "view"],
        ["dashboard", "view"],
      ],
    });
    const noDash = await actor(app, db, { regions: null, grants: SITES_VIEW });
    for (const screen of ["site-master-master", "site-master-cw", "dashboard"]) {
      const res = await noSites.api.call(
        "get",
        `/saved-views/filter-fields?screen_key=${screen}`,
      );
      expect(res.status, screen).toBe(403);
      expect(res.body.code, screen).toBe("module_forbidden");
    }
    const dash = await noDash.api.call(
      "get",
      "/saved-views/filter-fields?screen_key=dashboard",
    );
    expect(dash.status).toBe(403);
    expect(dash.body.code).toBe("module_forbidden");
    expect(
      (
        await noDash.api.call(
          "get",
          "/saved-views/filter-fields?screen_key=site360-master",
        )
      ).status,
    ).toBe(200);
    // anonymous
    const anon = await noDash.api
      .raw("get", "/saved-views/filter-fields?screen_key=dashboard")
      .set("Cookie", "pmis_session=bad");
    expect(anon.status).toBe(401);
  });

  it("the rows of a menu refuse a caller without the Site Register right, with and without a filter", async () => {
    const noSites = await actor(app, db, {
      regions: null,
      grants: [["issues", "view"]],
    });
    const plain = await noSites.api.call("get", "/site-master/master/rows");
    expect(plain.status).toBe(403);
    const filtered = await noSites.api.call(
      "get",
      `/site-master/master/rows?${q(mine(cond("sub_region", "is", `SRA-${TAG}`)))}`,
    );
    expect(filtered.status).toBe(403);
    expect(filtered.body.code).toBe("module_forbidden");
  });

  it("the dashboard endpoints refuse a caller without the dashboard right, and a filter from a caller without the Site Register right", async () => {
    const noDash = await actor(app, db, { regions: null, grants: SITES_VIEW });
    const noSites = await actor(app, db, {
      regions: null,
      grants: [["dashboard", "view"]],
    });
    const tree = mine(cond("delivery_scenario", "is", "expansion"));
    for (const path of [
      "/dashboard",
      "/dashboard/extras",
      "/dashboard/site-map",
      "/project-status",
    ]) {
      const denied = await noDash.api.call("get", `${path}?${q(tree)}`);
      expect(denied.status, path).toBe(403);
      expect(denied.body.code, path).toBe("module_forbidden");
    }
    // without a filter the dashboard still opens; with one it would read site data the caller may not see
    expect((await noSites.api.call("get", "/dashboard")).status).toBe(200);
    const withFilter = await noSites.api.call("get", `/dashboard?${q(tree)}`);
    expect(withFilter.status).toBe(403);
    expect(withFilter.body.code).toBe("module_forbidden");
  });
});
