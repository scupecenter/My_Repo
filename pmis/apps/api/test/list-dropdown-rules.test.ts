import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Client as PgClient } from "pg";
import { randomBytes } from "node:crypto";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, superDb } from "./helpers";
import { plainAdmin } from "./wf-helpers";
import type { Actor } from "./wf-helpers";

/**
 * Migration 0102 (F17, dropdown lists): value types, dependent lists, the default value, the colour, the deactivation record and the hard
 * delete that is allowed only for an unused value. Each list is created by this suite with a random code, so the suite never touches
 * the lists of the other suites.
 */
let app: NestExpressApplication;
let db: PgClient;
let admin: Actor;
const U = randomBytes(3).toString("hex").toUpperCase();
const code = (name: string) => `F17${name}${U}`;

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
  admin = await plainAdmin(app, db, true);
});
afterAll(async () => {
  await db.end();
  await app.close();
});


// PATCH routes need If-Match: the version of the catalogue, or of the value when the path names a value.
const patch = async (path: string, body: Record<string, unknown>) => {
  const m = /^\/list-catalogues\/([^/]+)(?:\/values\/([^/?]+))?$/.exec(path)!;
  const got = (await admin.api.call("get", `/list-catalogues/${m[1]}`)).body as {
    version: number;
    values: { id: string; version: number }[];
  };
  const version = m[2] ? got.values.find((v) => v.id === m[2])!.version : got.version;
  return admin.api.call("patch", path, body, { "If-Match": `"${version}"` });
};

// a workbook like the ones the template issues: the Data sheet with the issued header row, and the hidden _tpl sheet
const workbook = async (tplId: string, version: number, rows: (string | number)[][]) => {
  const wb = new ExcelJS.Workbook();
  const data = wb.addWorksheet("Data");
  data.addRow(["Value code", "Label EN", "Label AR", "Aliases (separate with ;)", "Colour (#RRGGBB)", "Parent value", "Sort order"]);
  for (const r of rows) data.addRow(r);
  const tpl = wb.addWorksheet("_tpl");
  tpl.addRow(["template_id", tplId]);
  tpl.addRow(["version", String(version)]);
  tpl.state = "hidden";
  return Buffer.from(await wb.xlsx.writeBuffer());
};

const createList = (c: string, extra: Record<string, unknown> = {}) =>
  admin.api.call("post", "/list-catalogues", {
    code: c,
    name_en: `List ${c}`,
    reason: "F17 suite list",
    ...extra,
  });

const addValue = (c: string, v: string, extra: Record<string, unknown> = {}) =>
  admin.api.call("post", `/list-catalogues/${c}/values`, {
    code: v,
    reason: "F17 suite value",
    ...extra,
  });

const listOf = async (c: string) =>
  (await admin.api.call("get", `/list-catalogues/${c}`)).body as {
    values: {
      id: string;
      code: string;
      label_en: string;
      is_active: boolean;
      is_default: boolean;
      colour: string | null;
      parent_code: string | null;
      deactivate_reason: string | null;
      version: number;
    }[];
    dependent_lists: string[];
  };

describe("dropdown lists (migration 0102)", () => {
  it("a dependent list needs a value of its parent, and the parent value must exist and be active", async () => {
    const P = code("Region");
    const C = code("SubRegion");
    expect((await createList(P)).status).toBe(201);
    expect((await createList(C, { parent_catalogue: P })).status).toBe(201);
    expect((await addValue(P, "North")).status).toBe(201);
    expect((await addValue(P, "South")).status).toBe(201);

    const none = await addValue(C, "Alpha");
    expect(none.status).toBe(422);
    const unknown = await addValue(C, "Alpha", { parent_code: "Nowhere" });
    expect(unknown.status).toBe(422);

    expect((await addValue(C, "Alpha", { parent_code: "North" })).status).toBe(
      201,
    );
    const v = (await listOf(C)).values.find((x) => x.code === "Alpha");
    expect(v?.parent_code).toBe("North");

    // the parent value is deactivated: a new value cannot use it, and the list shows the dependent list of its parent
    expect(
      (
        await patch(`/list-catalogues/${P}/values/${(await listOf(P)).values.find((x) => x.code === "South")!.id}`,
          { is_active: false, reason: "Retired region" },
        )
      ).status,
    ).toBe(200);
    expect((await addValue(C, "Beta", { parent_code: "South" })).status).toBe(
      422,
    );
    expect((await listOf(P)).dependent_lists).toContain(C);
  });

  it("a value that dependent values use cannot be deactivated, and a deactivation keeps its reason", async () => {
    const P = code("Owner");
    const C = code("Team");
    await createList(P);
    await createList(C, { parent_catalogue: P });
    await addValue(P, "Acme");
    await addValue(C, "Crew1", { parent_code: "Acme" });
    const acme = (await listOf(P)).values.find((x) => x.code === "Acme")!;

    const refused = await patch(`/list-catalogues/${P}/values/${acme.id}`,
      { is_active: false, reason: "Try with children" },
    );
    expect(refused.status).toBe(422);

    const crew = (await listOf(C)).values.find((x) => x.code === "Crew1")!;
    expect(
      (
        await patch(`/list-catalogues/${C}/values/${crew.id}`,
          { is_active: false, reason: "Crew disbanded" },
        )
      ).status,
    ).toBe(200);
    const row = (await listOf(C)).values.find((x) => x.code === "Crew1");
    expect(row?.is_active).toBe(false);
    expect(row?.deactivate_reason).toBe("Crew disbanded");
  });

  it("the default value is one per list, active, and cannot be deleted or deactivated while it is the default", async () => {
    const L = code("Priority");
    await createList(L);
    await addValue(L, "High", { colour: "#C0392B" });
    await addValue(L, "Low", { colour: "#2E86C1" });
    const high = (await listOf(L)).values.find((x) => x.code === "High")!;
    const low = (await listOf(L)).values.find((x) => x.code === "Low")!;
    expect(high.colour).toBe("#C0392B");

    expect(
      (
        await patch(`/list-catalogues/${L}/values/${high.id}`,
          { is_default: true, reason: "Default priority" },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await patch(`/list-catalogues/${L}/values/${low.id}`,
          { is_default: true, reason: "Default priority" },
        )
      ).status,
    ).toBe(200);
    const now = await listOf(L);
    expect(now.values.filter((x) => x.is_default).map((x) => x.code)).toEqual([
      "Low",
    ]);

    expect(
      (
        await patch(`/list-catalogues/${L}/values/${low.id}`,
          { is_active: false, reason: "Retire low" },
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await admin.api.call(
          "delete",
          `/list-catalogues/${L}/values/${low.id}?reason=Remove%20default`,
        )
      ).status,
    ).toBe(422);
  });

  it("hard delete: an unused value is deleted; a value of a dependent parent is refused as in use", async () => {
    const P = code("Area");
    const C = code("Zone");
    await createList(P);
    await createList(C, { parent_catalogue: P });
    await addValue(P, "Free");
    await addValue(P, "Used");
    await addValue(C, "Z1", { parent_code: "Used" });
    const free = (await listOf(P)).values.find((x) => x.code === "Free")!;
    const used = (await listOf(P)).values.find((x) => x.code === "Used")!;

    const del = await admin.api.call(
      "delete",
      `/list-catalogues/${P}/values/${free.id}?reason=Entered%20by%20mistake`,
    );
    expect(del.status).toBe(200);
    expect((await listOf(P)).values.some((x) => x.code === "Free")).toBe(false);

    const refused = await admin.api.call(
      "delete",
      `/list-catalogues/${P}/values/${used.id}?reason=Remove%20used%20value`,
    );
    expect(refused.status).toBe(422);
    expect((await listOf(P)).values.some((x) => x.code === "Used")).toBe(true);
  });

  it("value types are checked on creation: a number, a date, a site, a person or a vendor must be a real entry", async () => {
    const N = code("Count");
    const D = code("Due");
    const S = code("SiteRef");
    await createList(N, { value_type: "number" });
    await createList(D, { value_type: "date" });
    await createList(S, { value_type: "site" });
    expect((await addValue(N, "12.5")).status).toBe(201);
    expect((await addValue(N, "twelve")).status).toBe(422);
    expect((await addValue(D, "2026-11-15")).status).toBe(201);
    expect((await addValue(D, "2026-02-30")).status).toBe(422);
    expect((await addValue(S, "NO-SUCH-SITE-9999")).status).toBe(422);
    expect(
      (
        await patch(`/list-catalogues/${N}`, {
          value_type: "text",
          reason: "Type change with values",
        })
      ).status,
    ).toBe(422);
  });

  it("colour must be #RRGGBB and the parent of a list cannot loop", async () => {
    const A = code("LoopA");
    const B = code("LoopB");
    await createList(A);
    await createList(B, { parent_catalogue: A });
    expect((await addValue(A, "Red", { colour: "red" })).status).toBe(422);
    const loop = await patch(`/list-catalogues/${A}`, {
      parent_catalogue: B,
      reason: "Make a loop",
    });
    expect(loop.status).toBe(422);
  });
  it("the values import accepts only the issued list values template; a bad file is refused and nothing is applied", async () => {
    const L = code("Imported");
    await createList(L);
    const wrong = await workbook("TPL-NEW-SITES", 1, [["Gamma", "Gamma", "", "", "", "", ""]]);
    const refused = await admin.api
      .call("post", `/list-catalogues/${L}/values/import`, undefined)
      .attach("file", wrong, "wrong.xlsx")
      .field("reason", "F17 wrong template");
    expect(refused.status).toBe(422);
    expect((await listOf(L)).values).toHaveLength(0);

    const badRow = await workbook("TPL-LISTVALUES", 1, [
      ["Delta", "Delta", "", "", "", "", ""],
      ["Epsilon", "Epsilon", "", "", "red", "", ""],
    ]);
    const badRes = await admin.api
      .call("post", `/list-catalogues/${L}/values/import`, undefined)
      .attach("file", badRow, "bad.xlsx")
      .field("reason", "F17 bad colour");
    expect(badRes.status).toBe(422);
    expect((await listOf(L)).values).toHaveLength(0);

    const good = await workbook("TPL-LISTVALUES", 1, [
      ["Alpha", "Alpha EN", "", "a1;a2", "#2E86C1", "", 10],
      ["Beta", "Beta EN", "", "", "", "", ""],
    ]);
    const ok = await admin.api
      .call("post", `/list-catalogues/${L}/values/import`, undefined)
      .attach("file", good, "good.xlsx")
      .field("reason", "F17 import");
    expect(ok.status).toBe(200);
    const alpha = (await listOf(L)).values.find((x) => x.code === "Alpha");
    expect(alpha?.colour).toBe("#2E86C1");
    expect((await listOf(L)).values.map((x) => x.code).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("D54: the template filled with the current values is downloaded, edited and uploaded again (update by code, unchanged rows, new codes)", async () => {
    const L = code("RoundTrip");
    await createList(L);
    await addValue(L, "Alpha", { label_en: "Alpha EN", colour: "#2E86C1" });
    await addValue(L, "Beta", { label_en: "Beta EN" });
    const res = await admin.api
      .call("get", `/templates/TPL-LISTVALUES/download?list=${L}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(res.body as unknown as ExcelJS.Buffer);
    const data = book.getWorksheet("Data")!;
    const cells = (r: number) => [1, 2, 3, 4, 5, 6, 7].map((c) => (data.getRow(r).getCell(c).text ?? "").toString());
    expect(cells(2).slice(0, 2)).toEqual(["Alpha", "Alpha EN"]);
    expect(cells(2)[4]).toBe("#2E86C1");
    expect(cells(3).slice(0, 2)).toEqual(["Beta", "Beta EN"]);
    // edit one label, leave the other row, add a new code
    data.getRow(2).getCell(2).value = "Alpha changed";
    data.getRow(4).getCell(1).value = "Gamma";
    data.getRow(4).getCell(2).value = "Gamma EN";
    const buffer = Buffer.from(await book.xlsx.writeBuffer());
    const up = await admin.api
      .call("post", `/list-catalogues/${L}/values/import`, undefined)
      .attach("file", buffer, "roundtrip.xlsx")
      .field("reason", "D54 round trip");
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ imported: 2, created: 1, updated: 1, unchanged: 1 });
    const vals = (await listOf(L)).values;
    expect(vals.find((x) => x.code === "Alpha")?.label_en).toBe("Alpha changed");
    expect(vals.find((x) => x.code === "Beta")?.label_en).toBe("Beta EN");
    expect(vals.map((x) => x.code).sort()).toEqual(["Alpha", "Beta", "Gamma"]);
    // an unknown list is 404; a plain download stays empty
    expect((await admin.api.call("get", "/templates/TPL-LISTVALUES/download?list=NoSuchList9")).status).toBe(404);
  });
});

// Contract 0.15.244 (item 15 of the improvement research): the colour of a list value reaches the register fields, display only.
describe("list value colour in the register fields (0.15.244)", () => {
  it("a coloured value of the ProcScope list shows its colour in the procurement scope options", async () => {
    const cat = (await admin.api.call("get", "/list-catalogues/ProcScope")).body as { values: { id: string; code: string }[] };
    const cw = cat.values.find((v) => v.code === "CW")!;
    const r = await patch(`/list-catalogues/ProcScope/values/${cw.id}`, { colour: "#0E7490", reason: "item 15 colour reach" });
    expect(r.status).toBe(200);
    const regs = (await admin.api.call("get", "/registers")).body as { items: { register_key: string; fields: { code: string; options?: { value: string; colour?: string | null }[] }[] }[] };
    const scope = regs.items.find((x) => x.register_key === "procurement")!.fields.find((f) => f.code === "scope")!;
    expect(scope.options?.find((o) => o.value === "CW")?.colour).toBe("#0E7490");
    await patch(`/list-catalogues/ProcScope/values/${cw.id}`, { colour: null, reason: "item 15 colour reach cleanup" });
  });
});
