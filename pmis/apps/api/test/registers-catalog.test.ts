import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes } from "node:crypto";
import type { Client as PgClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { startApp, superDb } from "./helpers";
import {
  G,
  Team,
  approveFlex,
  otherSite,
  post,
  recPath,
  team,
} from "./reg-helpers";
import { actor } from "./wf-helpers";

/**
 * Migration 0025: nine registers on the generic framework (contractors, quality, issues, risks, change_control, readiness_handover, meetings, rf_design,
 * acquisition). For each: it is enabled with the spec's fields, one record is created, submitted, reviewed and approved, a required or blocking rule answers 422
 * with the field path, a caller from another region does not see a site record, and a caller without the module is refused. Region 2 is used by this suite.
 */
let app: NestExpressApplication;
let db: PgClient;
const R = 2;
const R2 = 3;
const U = randomBytes(3).toString("hex");

beforeAll(async () => {
  app = await startApp();
  db = await superDb();
});
beforeEach(async () => {
  await db.query("SELECT pg_advisory_lock(770101)"); // one test at a time with the matrix suite (it rewrites the cells and levels of the same rows)
});
afterEach(async () => {
  await db.query("SELECT pg_advisory_unlock(770101)");
});
afterAll(async () => {
  await db.end();
  await app.close();
});

/** The global row of a register has no region: its holders sit in the global cell of the Matrix row. */
async function globalCell(
  key: string,
  kind: "entry" | "review" | "approve",
  userId: string,
): Promise<void> {
  const level = kind === "entry" ? 1 : kind === "review" ? 2 : 3;
  await db.query(
    "DELETE FROM matrix_cells WHERE register_key = $1 AND level = $2 AND region_id IS NULL",
    [key, level],
  );
  const c = await db.query(
    `INSERT INTO matrix_cells (register_key, level, rule, region_id, is_global, updated_at) VALUES ($1, $2, 'any_one'::"MatrixRule", NULL, true, now()) RETURNING id`,
    [key, level],
  );
  await db.query(
    `INSERT INTO matrix_cell_assignees (cell_id, kind, ref_id) VALUES ($1, 'user'::"AssigneeKind", $2)`,
    [c.rows[0].id, userId],
  );
}

async function teamL(
  key: string,
  module: string,
  region: number,
): Promise<Team> {
  return team(app, db, key, module, region);
}

async function globalTeam(key: string, module: string): Promise<Team> {
  const entry = await actor(app, db, {
    level: "entry",
    grants: G(module, "view", "create", "edit"),
    regions: [R],
    modules: null,
  });
  const review = await actor(app, db, {
    level: "review",
    grants: G(module, "view"),
    regions: [R],
    modules: null,
  });
  const approve = await actor(app, db, {
    level: "approve",
    grants: G(module, "view", "approve"),
    regions: [R],
    modules: null,
  });
  await globalCell(key, "entry", entry.user.id);
  await globalCell(key, "review", review.user.id);
  await globalCell(key, "approve", approve.user.id);
  return { entry, review, approve, site: undefined as never, region: R, key };
}

interface Spec {
  key: string;
  module: string;
  global?: boolean;
  type?: string;
  data: (t: Team) => Record<string, unknown>;
  bad: {
    type?: string;
    data: Record<string, unknown>;
    path: string;
    code: string;
  };
  /** a one-per-site register: the invalid record goes to another site */
  onePerSite?: boolean;
  fieldsInclude: string[];
}

const SPECS: Spec[] = [
  {
    key: "contractors",
    module: "contractors",
    global: true,
    type: "company",
    fieldsInclude: ["contractor_name", "team_name", "contract_end"],
    data: () => ({
      contractor_name: `Co ${U}`,
      company_type: "CW Contractor",
      contract_ref: "C-1",
      contract_start: "2026-01-01",
      contract_end: "2027-01-01",
      company_status: "Active",
    }),
    bad: {
      data: { company_type: "CW Contractor" },
      path: "/data/contractor_name",
      code: "required",
    },
  },
  {
    key: "quality",
    module: "quality",
    type: "snag",
    fieldsInclude: ["record_code", "stage", "severity", "approved_by"],
    data: () => ({
      record_code: `QI-${U}`,
      stage: "CW QC",
      severity: "Major",
      description: "Cracked base",
      raised_date: "2026-01-05",
      result: "Open",
    }),
    bad: {
      data: { description: "no id" },
      path: "/data/record_code",
      code: "required",
    },
  },
  {
    key: "issues",
    module: "issues",
    fieldsInclude: [
      "pending_issue",
      "owner_user",
      "raised_date",
      "issue_status",
    ],
    data: (t) => ({
      pending_issue: "Access key missing",
      raised_date: "2026-01-05",
      issue_status: "Open",
      owner_user: t.entry.user.id,
    }),
    bad: {
      data: { pending_issue: "x", raised_date: "2026-01-05" },
      path: "/data/issue_status",
      code: "required",
    },
  },
  {
    key: "risks",
    module: "risks",
    global: true,
    fieldsInclude: ["risk_id", "risk_statement", "probability", "impact"],
    data: () => ({
      risk_id: `RSK-${U}`,
      risk_statement: "Late fiber",
      category: "Schedule",
      probability: 3,
      impact: 4,
    }),
    bad: {
      data: { risk_id: `RSK-bad-${U}` },
      path: "/data/risk_statement",
      code: "required",
    },
  },
  {
    key: "change_control",
    module: "change_control",
    fieldsInclude: ["change_id", "change_type", "old_value", "approval_date"],
    data: () => ({
      change_id: `CHG-${U}`,
      change_type: "Suspension",
      request_date: "2026-01-06",
      reason: "Access denied by the owner",
    }),
    bad: {
      data: { change_id: `CHG-bad-${U}` },
      path: "/data/change_type",
      code: "required",
    },
  },
  {
    key: "readiness_handover",
    module: "readiness",
    onePerSite: true,
    fieldsInclude: [
      "om_checklist",
      "hoto_package_actual_date",
      "closure_approval_date",
    ],
    data: () => ({
      om_checklist: "Done",
      om_accepted_by: "O&M lead",
      om_acceptance_date: "2026-01-08",
    }),
    bad: {
      data: { om_checklist: "N/A" },
      path: "/data/na_reason",
      code: "required",
    },
  },
  {
    key: "meetings",
    module: "meetings",
    global: true,
    fieldsInclude: ["meeting_date", "title", "attendees"],
    data: () => ({
      meeting_date: "2026-01-08",
      title: `Weekly ${U}`,
      meeting_type: "Progress",
    }),
    bad: {
      data: { meeting_date: "2026-01-08" },
      path: "/data/title",
      code: "required",
    },
  },
  {
    key: "rf_design",
    module: "rf_design",
    onePerSite: true,
    fieldsInclude: [
      "latitude",
      "site_scenario",
      "tssr_approved",
      "lld_approved_date",
    ],
    data: () => ({
      latitude: 32.8,
      longitude: 13.2,
      site_scenario: "New Build",
      tssr_submitted: "2026-01-05",
      tssr_approved: "2026-01-07",
    }),
    bad: {
      data: { latitude: 95 },
      path: "/data/latitude",
      code: "out_of_range",
    },
  },
  {
    key: "acquisition",
    module: "acquisition",
    fieldsInclude: [
      "candidate",
      "selected",
      "contract_signoff_date",
      "lease_expiry_date",
    ],
    data: () => ({
      candidate: "A",
      latitude: 32.8,
      longitude: 13.2,
      address: "Plot 12",
      selected: "Yes",
      selection_date: "2026-01-07",
    }),
    bad: {
      data: { latitude: 32.8 },
      path: "/data/candidate",
      code: "required",
    },
  },
];

const body = (
  s: Spec,
  t: Team,
  data: Record<string, unknown>,
  type = s.type,
): Record<string, unknown> => ({
  ...(s.global ? {} : { site_id: t.site.id }),
  ...(type ? { record_type: type } : {}),
  data,
});

describe.each(SPECS)("$key register", (s) => {
  it("is enabled with the spec fields and the right scope, and a caller without the module is refused", async () => {
    const t = s.global
      ? await globalTeam(s.key, s.module)
      : await teamL(s.key, s.module, R);
    const list = await t.entry.api.call("get", "/registers");
    expect(list.status).toBe(200);
    const def = list.body.items.find(
      (i: { register_key: string }) => i.register_key === s.key,
    );
    expect(def).toMatchObject({
      register_key: s.key,
      module_key: s.module,
      site_scoped: !s.global,
      approval_levels: expect.any(Number),
    });
    expect(def.fields.map((f: { code: string }) => f.code)).toEqual(
      expect.arrayContaining(s.fieldsInclude),
    );
    if (s.key === "contractors")
      expect(def.record_types).toEqual(["company", "team"]);
    if (s.key === "acquisition") expect(def.multiple_per_site).toBe(true);
    if (s.onePerSite) expect(def.multiple_per_site).toBe(false);

    const denied = await actor(app, db, {
      grants: G("gecol", "view"),
      regions: [R],
      modules: null,
    });
    const res = await denied.api.call("get", recPath(s.key));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("module_forbidden");
  });

  it("creates, submits, reviews and approves one record, and a rule or required field answers 422 with its path", async () => {
    const t = s.global
      ? await globalTeam(s.key, s.module)
      : await teamL(s.key, s.module, R);
    const c = await t.entry.api.call(
      "post",
      recPath(s.key),
      body(s, t, s.data(t)),
    );
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body).toMatchObject({
      register_key: s.key,
      state: "entry",
      record_type: s.type ?? null,
    });
    const done = await approveFlex(t, c.body.id, c.body.version);
    expect(done).toMatchObject({ state: "approved", is_current: true });
    expect(
      (await t.review.api.call("get", recPath(s.key, c.body.id))).status,
    ).toBe(200);

    // the invalid record is a draft until it is submitted; the submit answers 422 with the field path
    const t2 = s.onePerSite ? { ...t, site: (await otherSite(db, t)).site } : t;
    const b = await t2.entry.api.call(
      "post",
      recPath(s.key),
      body(s, t2, s.bad.data, s.bad.type ?? s.type),
    );
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const sub = await post(
      t2.entry.api,
      s.key,
      b.body.id,
      "submit",
      b.body.version,
    );
    expect(sub.status).toBe(422);
    expect(sub.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: s.bad.path, code: s.bad.code }),
      ]),
    );
  });

  it("scopes by region: a caller of another region sees no site record, a global row stays visible to the module holders (Q69)", async () => {
    const t = s.global
      ? await globalTeam(s.key, s.module)
      : await teamL(s.key, s.module, R);
    const c = await t.entry.api.call(
      "post",
      recPath(s.key),
      body(s, t, s.data(t)),
    );
    expect(c.status).toBe(201);
    const away = await actor(app, db, {
      level: "entry",
      grants: G(s.module, "view", "create", "edit"),
      regions: [R2],
      modules: null,
    });
    const got = await away.api.call("get", recPath(s.key, c.body.id));
    const listed = await away.api.call("get", recPath(s.key));
    expect(listed.status).toBe(200);
    if (s.global) {
      expect(got.status).toBe(200);
      expect(listed.body.items.map((i: { id: string }) => i.id)).toContain(
        c.body.id,
      );
    } else {
      expect(got.status).toBe(404);
      expect(listed.body.items.map((i: { id: string }) => i.id)).not.toContain(
        c.body.id,
      );
      const make = await away.api.call(
        "post",
        recPath(s.key),
        body(s, t, s.data(t)),
      );
      expect(make.status).toBe(404); // the site is outside their regions
    }
    if (s.global) {
      const withSite = await t.entry.api.call("post", recPath(s.key), {
        site_id: (await teamL("procurement", "procurement", R)).site.id,
        ...(s.type ? { record_type: s.type } : {}),
        data: s.data(t),
      });
      expect(withSite.status).toBe(422);
      expect(withSite.body.errors[0]).toMatchObject({
        path: "/site_id",
        code: "not_site_scoped",
      });
    } else {
      const noSite = await t.entry.api.call("post", recPath(s.key), {
        ...(s.type ? { record_type: s.type } : {}),
        data: s.data(t),
      });
      expect(noSite.status).toBe(422);
      expect(noSite.body.errors[0]).toMatchObject({
        path: "/site_id",
        code: "required",
      });
    }
  });
});

describe("rules of the spec", () => {
  it("Contractors: an approved company becomes an external party, a team needs an existing company and becomes an external team", async () => {
    const t = await globalTeam("contractors", "contractors");
    const name = `Rules Co ${U}`;
    const co = await t.entry.api.call("post", recPath("contractors"), {
      record_type: "company",
      data: {
        contractor_name: name,
        company_type: "CW Contractor",
        contract_start: "2026-01-01",
        contract_end: "2027-01-01",
      },
    });
    // the team of a company that does not exist yet is refused
    const orphan = await t.entry.api.call("post", recPath("contractors"), {
      record_type: "team",
      data: { team_name: "T-1", contractor: name },
    });
    expect(
      (
        await post(
          t.entry.api,
          "contractors",
          orphan.body.id,
          "submit",
          orphan.body.version,
        )
      ).body.errors[0],
    ).toMatchObject({ path: "/data/contractor", code: "unknown_contractor" });
    const approved = await approveFlex(t, co.body.id, co.body.version);
    const party = await db.query(
      "SELECT name, type::text AS type, is_active, contract_end::text AS contract_end FROM external_parties WHERE id = $1",
      [approved.entity_id],
    );
    expect(party.rows[0]).toMatchObject({
      name,
      type: "cw_contractor",
      is_active: true,
      contract_end: "2027-01-01",
    });
    const team1 = await t.entry.api.call("post", recPath("contractors"), {
      record_type: "team",
      data: { team_name: "T-2", contractor: name, specialization: "Tower RT" },  // 0057 (Q104): the agreed TeamSpecialization values; CW is a group, kept as an inactive value
    });
    const tdone = await approveFlex(t, team1.body.id, team1.body.version);
    const et = await db.query(
      "SELECT name, party_id FROM external_teams WHERE id = $1",
      [tdone.entity_id],
    );
    expect(et.rows[0]).toMatchObject({
      name: "T-2",
      party_id: approved.entity_id,
    });
    // a company-only field on a team, a contract end before its start, a duplicate company
    const bad = await t.entry.api.call("post", recPath("contractors"), {
      record_type: "team",
      data: { team_name: "T-3", contractor: name, contract_ref: "x" },
    });
    expect(
      (
        await post(
          t.entry.api,
          "contractors",
          bad.body.id,
          "submit",
          bad.body.version,
        )
      ).body.errors,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "not_applicable" }),
      ]),
    );
    const dates = await t.entry.api.call("post", recPath("contractors"), {
      record_type: "company",
      data: {
        contractor_name: `Dates ${U}`,
        contract_start: "2026-05-01",
        contract_end: "2026-01-01",
      },
    });
    expect(
      (
        await post(
          t.entry.api,
          "contractors",
          dates.body.id,
          "submit",
          dates.body.version,
        )
      ).body.errors[0],
    ).toMatchObject({ code: "date_error" });
    const dup = await t.entry.api.call("post", recPath("contractors"), {
      record_type: "company",
      data: { contractor_name: name.toUpperCase() },
    });
    expect(
      (
        await post(
          t.entry.api,
          "contractors",
          dup.body.id,
          "submit",
          dup.body.version,
        )
      ).body.errors[0],
    ).toMatchObject({ path: "/data/contractor_name", code: "duplicate" });
  });

  it("Change Control and Quality: the approver fields come from the final approval (Q45); a scope change needs its values; a resumption needs a suspension", async () => {
    const t = await teamL("change_control", "change_control", R);
    const c = await t.entry.api.call("post", recPath("change_control"), {
      site_id: t.site.id,
      data: {
        change_id: `CHG-S-${U}`,
        change_type: "Suspension",
        request_date: "2026-01-06",
      },
    });
    const typed = await t.entry.api.call("post", recPath("change_control"), {
      site_id: t.site.id,
      data: {
        change_id: `CHG-T-${U}`,
        change_type: "Suspension",
        approved_by: t.entry.user.id,
      },
    });
    expect(typed.status).toBe(422); // the approver is never typed
    expect(typed.body.errors[0]).toMatchObject({
      path: "/data/approved_by",
      code: "field_read_only",
    });
    const resume = await t.entry.api.call("post", recPath("change_control"), {
      site_id: t.site.id,
      data: { change_id: `CHG-R-${U}`, change_type: "Resumption" },
    });
    expect(
      (
        await post(
          t.entry.api,
          "change_control",
          resume.body.id,
          "submit",
          resume.body.version,
        )
      ).body.errors[0],
    ).toMatchObject({ code: "no_suspension" });
    const scope = await t.entry.api.call("post", recPath("change_control"), {
      site_id: t.site.id,
      data: { change_id: `CHG-X-${U}`, change_type: "Scope Change" },
    });
    const errs = (
      await post(
        t.entry.api,
        "change_control",
        scope.body.id,
        "submit",
        scope.body.version,
      )
    ).body.errors;
    expect(errs.map((e: { path: string }) => e.path)).toEqual(
      expect.arrayContaining([
        "/data/field_item",
        "/data/old_value",
        "/data/new_value",
      ]),
    );
    const done = await approveFlex(t, c.body.id, c.body.version);
    expect(done.data).toMatchObject({
      approval: "Approved",
      approved_by: t.approve.user.id,
      approval_date: new Date().toISOString().slice(0, 10),
    });
    // now the resumption has an approved suspension
    const again = await post(
      t.entry.api,
      "change_control",
      resume.body.id,
      "submit",
      resume.body.version,
    );
    expect(again.status).toBe(200);

    const q = await teamL("quality", "quality", R);
    const na = await q.entry.api.call("post", recPath("quality"), {
      site_id: q.site.id,
      record_type: "itp",
      data: { record_code: `QI-N-${U}`, result: "N/A" },
    });
    expect(
      (
        await post(
          q.entry.api,
          "quality",
          na.body.id,
          "submit",
          na.body.version,
        )
      ).body.errors[0],
    ).toMatchObject({ path: "/data/na_reason", code: "required" });
    const ok = await q.entry.api.call("post", recPath("quality"), {
      site_id: q.site.id,
      record_type: "itp",
      data: {
        record_code: `QI-O-${U}`,
        result: "N/A",
        na_reason: "No ITP for this scope",
      },
    });
    const qdone = await approveFlex(q, ok.body.id, ok.body.version);
    expect(qdone.data).toMatchObject({
      approved_by: q.approve.user.id,
      na_approved_by: q.approve.user.id,
    });
    const snag = await q.entry.api.call("post", recPath("quality"), {
      site_id: q.site.id,
      record_type: "snag",
      data: { record_code: `QI-G-${U}` },
    });
    expect(
      (
        await post(
          q.entry.api,
          "quality",
          snag.body.id,
          "submit",
          snag.body.version,
        )
      ).body.errors[0],
    ).toMatchObject({ path: "/data/severity", code: "required" });
  });

  it("Acquisition: one candidate Selected = Yes per site, a candidate once per site, and a sign-off needs the selection", async () => {
    const t = await teamL("acquisition", "acquisition", R);
    const a = await t.entry.api.call("post", recPath("acquisition"), {
      site_id: t.site.id,
      data: { candidate: "A", selected: "Yes", selection_date: "2026-01-07" },
    });
    await approveFlex(t, a.body.id, a.body.version);
    const b = await t.entry.api.call("post", recPath("acquisition"), {
      site_id: t.site.id,
      data: { candidate: "B", selected: "Yes", selection_date: "2026-01-08" },
    });
    expect(
      (
        await post(
          t.entry.api,
          "acquisition",
          b.body.id,
          "submit",
          b.body.version,
        )
      ).body.errors[0],
    ).toMatchObject({ path: "/data/selected", code: "second_selected" });
    const dup = await t.entry.api.call("post", recPath("acquisition"), {
      site_id: t.site.id,
      data: { candidate: "A" },
    });
    expect(
      (
        await post(
          t.entry.api,
          "acquisition",
          dup.body.id,
          "submit",
          dup.body.version,
        )
      ).body.errors[0],
    ).toMatchObject({ path: "/data/candidate", code: "duplicate" });
    const nodate = await t.entry.api.call("post", recPath("acquisition"), {
      site_id: t.site.id,
      data: {
        candidate: "C",
        selected: "No",
        contract_signoff_date: "2026-01-05",
      },
    });
    expect(
      (
        await post(
          t.entry.api,
          "acquisition",
          nodate.body.id,
          "submit",
          nodate.body.version,
        )
      ).body.errors[0],
    ).toMatchObject({ code: "not_selected" });
  });

  it("Readiness and RF & Design: one record per site (409 with the existing id); Issue owner may be a user or an external party; Risk ranges", async () => {
    const t = await teamL("readiness_handover", "readiness", R);
    const a = await t.entry.api.call("post", recPath("readiness_handover"), {
      site_id: t.site.id,
      data: { om_checklist: "Done" },
    });
    expect(a.status).toBe(201);
    const dup = await t.entry.api.call("post", recPath("readiness_handover"), {
      site_id: t.site.id,
      data: {},
    });
    expect(dup.status).toBe(409);
    expect(dup.body.existing_id).toBe(a.body.id);

    const i = await teamL("issues", "issues", R);
    const mk = (
      extra: Record<string, unknown>,
      owner?: Record<string, unknown>,
    ) =>
      i.entry.api.call("post", recPath("issues"), {
        site_id: i.site.id,
        ...owner,
        data: {
          pending_issue: "x",
          raised_date: "2026-01-05",
          issue_status: "Open",
          ...extra,
        },
      });
    const none = await mk({});
    expect(
      (
        await post(
          i.entry.api,
          "issues",
          none.body.id,
          "submit",
          none.body.version,
        )
      ).body.errors[0],
    ).toMatchObject({ path: "/data/owner_user", code: "required" });
    const mine = await mk({ owner_user: i.entry.user.id });
    expect(
      (
        await post(
          i.entry.api,
          "issues",
          mine.body.id,
          "submit",
          mine.body.version,
        )
      ).status,
    ).toBe(200);
    const party = await db.query(
      `INSERT INTO external_parties (name, type) VALUES ($1, 'other'::"ExternalPartyType") RETURNING id`,
      [`Owner ${U}`],
    );
    const theirs = await mk({}, { external_party_id: party.rows[0].id });
    expect(
      (
        await post(
          i.entry.api,
          "issues",
          theirs.body.id,
          "submit",
          theirs.body.version,
        )
      ).status,
    ).toBe(200);

    const r = await globalTeam("risks", "risks");
    const rk = await r.entry.api.call("post", recPath("risks"), {
      data: {
        risk_id: `RSK-X-${U}`,
        risk_statement: "s",
        probability: 7,
        impact: 2,
        last_review_date: "2026-01-05",
        next_review_date: "2026-01-01",
      },
    });
    const errs = (
      await post(r.entry.api, "risks", rk.body.id, "submit", rk.body.version)
    ).body.errors;
    expect(errs.map((e: { code: string }) => e.code)).toEqual(
      expect.arrayContaining(["out_of_range", "before_last_review"]),
    );
  });
});
