import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AccessService } from "../access/access.service";
import type { AuthContext } from "../auth/auth.types";
import { mapDbError } from "../common/db-errors";
import { problems } from "../common/problem";
import { isCalendarDate, oneParam } from "../common/query";
import { DbService } from "../db/db.service";
import { TaskDetailService } from "../workflow/task-detail.service";
import { TaskViewService, UserRefDto } from "../workflow/task-view.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ["entry", "review", "approve"] as const;
type Kind = (typeof KINDS)[number];

/**
 * The visits of a task to each level, rebuilt from the audit rows of the task (their `after.state`): consecutive rows in the same level form one visit,
 * which ends at the first row of the next state. The person who ended a visit is the one who acted on it. Time before the first audited change is not counted
 * (a task that started open has no row for that). `ids` is a SQL list of task ids as text.
 */
function visits(ids: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    r AS (
      SELECT al.entity_id AS task_id, al.id, al.at, al.actor_id,
        CASE al.after->>'state' WHEN 'open' THEN 'entry' WHEN 'entry' THEN 'entry' WHEN 'rejected' THEN 'entry'
          WHEN 'in_review' THEN 'review' WHEN 'in_approval' THEN 'approve' ELSE 'other' END AS kind
      FROM audit_log al WHERE al.entity_type = 'task' AND al.entity_id IN (${ids}) AND (al.after->>'state') IS NOT NULL
    ), f AS (
      SELECT r.*, CASE WHEN r.kind IS DISTINCT FROM lag(r.kind) OVER (PARTITION BY r.task_id ORDER BY r.id) THEN 1 ELSE 0 END AS chg FROM r
    ), g AS (
      SELECT f.*, sum(f.chg) OVER (PARTITION BY f.task_id ORDER BY f.id) AS isl FROM f
    ), i AS (
      SELECT task_id, isl, kind, min(at) AS start_at, (array_agg(actor_id ORDER BY id))[1] AS first_actor FROM g GROUP BY task_id, isl, kind
    ), seg AS (
      SELECT i.task_id, i.kind, i.start_at, lead(i.start_at) OVER (PARTITION BY i.task_id ORDER BY i.isl) AS end_at,
             lead(i.first_actor) OVER (PARTITION BY i.task_id ORDER BY i.isl) AS holder
      FROM i
    ), v AS (
      SELECT seg.task_id, seg.kind, seg.start_at, seg.end_at, seg.holder,
        extract(epoch FROM coalesce(seg.end_at, now()) - seg.start_at)::float8 AS seconds,
        cal_workdays_between((seg.start_at AT TIME ZONE 'Africa/Tripoli')::date, (coalesce(seg.end_at, now()) AT TIME ZONE 'Africa/Tripoli')::date) AS wd
      FROM seg WHERE seg.kind <> 'other'
    )`;
}

/** The team of a person: cw, te, both or none, from their active assignments. */
const TEAM_OF = (holder: Prisma.Sql): Prisma.Sql => Prisma.sql`(
  SELECT CASE WHEN bool_or(ua.team = 'both') OR (bool_or(ua.team = 'cw') AND bool_or(ua.team = 'te')) THEN 'both'
              WHEN bool_or(ua.team = 'cw') THEN 'cw' WHEN bool_or(ua.team = 'te') THEN 'te' ELSE 'none' END
  FROM user_role_assignments ua WHERE ua.user_id = ${holder} AND ua.valid_from <= now() AND (ua.valid_to IS NULL OR ua.valid_to > now()))`;

interface Agg {
  kind: Kind;
  visits: bigint;
  total_seconds: number;
  max_seconds: number;
  wd: bigint;
}

@Injectable()
export class InsightsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly detail: TaskDetailService,
    private readonly view: TaskViewService,
  ) {}

  /** Regions where the caller holds the view right on Sites and on Reports (the aggregates are report data); an empty array means none. */
  private async reportRegions(): Promise<number[] | null> {
    const a = await this.access.requireRegions("sites", "view");
    const b = await this.access.requireRegions("reports", "view");
    if (a === null) return b;
    if (b === null) return a;
    return a.filter((r) => b.includes(r));
  }

  private scope(
    regions: number[] | null,
    q: Record<string, unknown>,
  ): Prisma.Sql {
    const conds: Prisma.Sql[] = [Prisma.sql`true`];
    if (regions !== null)
      conds.push(Prisma.sql`t.region_id = ANY(${regions}::int[])`);
    const region = oneParam(q, "region_id");
    if (region) {
      if (!/^[1-7]$/.test(region))
        throw problems.validation([
          {
            path: "/region_id",
            code: "invalid",
            message: "region_id is 1 to 7.",
          },
        ]);
      conds.push(Prisma.sql`t.region_id = ${Number(region)}`);
    }
    const stage = oneParam(q, "stage_code");
    if (stage) conds.push(Prisma.sql`st.code = ${stage}`);
    return Prisma.join(conds, " AND ");
  }

  // ------------------------------------------------------------------ X4
  async taskTimeInState(auth: AuthContext, taskId: string) {
    const row = await this.detail.rowFor(auth, taskId);
    const rows = await this.db.tx.$queryRaw<
      {
        kind: Kind;
        start_at: Date;
        end_at: Date | null;
        holder: string | null;
        seconds: number;
        wd: number;
      }[]
    >(
      Prisma.sql`WITH ${visits(Prisma.sql`${row.id}::text`)} SELECT kind, start_at, end_at, holder::text AS holder, seconds, wd FROM v ORDER BY start_at, kind`,
    );
    const refs = await this.view.userRefs([
      ...new Set(rows.map((r) => r.holder).filter((x): x is string => !!x)),
    ]);
    const items = KINDS.map((kind) => {
      const mine = rows.filter((r) => r.kind === kind);
      return {
        state: kind,
        visits: mine.length,
        total_seconds: Math.round(mine.reduce((a, r) => a + r.seconds, 0)),
        longest_seconds: Math.round(Math.max(0, ...mine.map((r) => r.seconds))),
        working_days: mine.reduce((a, r) => a + Number(r.wd ?? 0), 0),
      };
    });
    const open = rows.find((r) => r.end_at === null);
    return {
      task_id: row.id,
      current_state: open ? open.kind : null,
      items,
      segments: rows.map((r) => ({
        state: r.kind,
        started_at: r.start_at,
        ended_at: r.end_at,
        seconds: Math.round(r.seconds),
        working_days: Number(r.wd ?? 0),
        ...(r.holder && refs.get(r.holder)
          ? { handled_by: refs.get(r.holder) as UserRefDto }
          : {}),
      })),
    };
  }

  /** Completed visits grouped by the person who handled them, or by their team. */
  async timeInStateReport(_auth: AuthContext, q: Record<string, unknown>) {
    const regions = await this.reportRegions();
    const groupBy = oneParam(q, "group_by") ?? "holder";
    if (!["holder", "team"].includes(groupBy))
      throw problems.validation([
        {
          path: "/group_by",
          code: "invalid",
          message: "group_by is holder or team.",
        },
      ]);
    const conds: Prisma.Sql[] = [
      Prisma.sql`v.end_at IS NOT NULL`,
      Prisma.sql`v.holder IS NOT NULL`,
    ];
    for (const [key, op] of [
      ["from", ">="],
      ["to", "<="],
    ] as const) {
      const d = oneParam(q, key);
      if (d === undefined) continue;
      if (!isCalendarDate(d))
        throw problems.validation([
          { path: `/${key}`, code: "invalid", message: `${key} is a date.` },
        ]);
      conds.push(
        Prisma.sql`(v.end_at AT TIME ZONE 'Africa/Tripoli')::date ${Prisma.raw(op)} ${d}::date`,
      );
    }
    const keyExpr =
      groupBy === "holder"
        ? Prisma.sql`v.holder::text`
        : TEAM_OF(Prisma.sql`v.holder`);
    const ids = Prisma.sql`SELECT t.id::text FROM task_instances t JOIN task_definitions td ON td.id = t.task_def_id JOIN stage_definitions st ON st.id = td.stage_id WHERE ${this.scope(regions, q)}`;
    const rows = await this.db.tx.$queryRaw<
      (Agg & { key: string | null })[]
    >(Prisma.sql`
      WITH ${visits(ids)}
      SELECT ${keyExpr} AS key, v.kind, count(*) AS visits, sum(v.seconds)::float8 AS total_seconds, max(v.seconds)::float8 AS max_seconds, sum(v.wd) AS wd
      FROM v WHERE ${Prisma.join(conds, " AND ")} GROUP BY 1, 2`);
    const refs =
      groupBy === "holder"
        ? await this.view.userRefs([
            ...new Set(rows.map((r) => r.key).filter((x): x is string => !!x)),
          ])
        : new Map<string, UserRefDto>();
    const groups = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const key = r.key ?? "none";
      const g = groups.get(key) ?? {
        ...(groupBy === "holder"
          ? {
              holder: refs.get(key) ?? {
                id: key,
                display_name: "Unknown",
                employee_id: null,
              },
            }
          : { team: key }),
        levels: {},
      };
      (g.levels as Record<string, unknown>)[r.kind] = {
        visits: Number(r.visits),
        total_seconds: Math.round(r.total_seconds),
        average_seconds: Math.round(r.total_seconds / Number(r.visits)),
        max_seconds: Math.round(r.max_seconds),
        working_days: Number(r.wd ?? 0),
      };
      groups.set(key, g);
    }
    return { group_by: groupBy, items: [...groups.values()] };
  }

  // ------------------------------------------------------------------ F1
  /** The state a register record sits in now, and the working days since its last recorded transition into that state (B3: the record must be visible). */
  async recordTimeInState(auth: AuthContext, key: string, id: string) {
    const def = await this.db.tx.$queryRaw<{ module_key: string }[]>(
      Prisma.sql`SELECT module_key FROM register_definitions WHERE register_key = ${key}`,
    );
    if (!def[0] || !UUID.test(id)) throw problems.notFound();
    const regs = await this.access.requireRegions(def[0].module_key, "view");
    const visible =
      regs === null
        ? Prisma.sql`true`
        : Prisma.sql`(r.is_global OR r.region_id = ANY(${regs}::int[]))`;
    const rec = (
      await this.db.tx.$queryRaw<{ id: string; state: string }[]>(Prisma.sql`
      SELECT r.id::text AS id, r.state FROM register_records r WHERE r.id = ${id}::uuid AND r.register_key = ${key} AND ${visible}`)
    )[0];
    if (!rec)
      throw problems.notFound(
        "The record does not exist or is not visible to you.",
      );
    const rows = await this.db.tx.$queryRaw<
      {
        from_state: string | null;
        to_state: string;
        at: Date;
        actor_id: string | null;
        level: string;
        admin_override: boolean;
      }[]
    >(Prisma.sql`
      SELECT st.from_state, st.to_state, st.at, st.actor_id::text AS actor_id, st.level, st.admin_override
      FROM status_transitions st WHERE st.entity_type = 'register_record' AND st.entity_id = ${rec.id}::uuid ORDER BY st.at, st.id`);
    const refs = await this.view.userRefs([
      ...new Set(rows.map((r) => r.actor_id).filter((x): x is string => !!x)),
    ]);
    const since =
      [...rows].reverse().find((r) => r.to_state === rec.state) ?? null;
    const wd = since
      ? ((
          await this.db.tx.$queryRaw<{ wd: number | null }[]>(Prisma.sql`
          SELECT cal_workdays_between((${since.at}::timestamptz AT TIME ZONE 'Africa/Tripoli')::date, cal_today()) AS wd`)
        )[0]?.wd ?? null)
      : null;
    return {
      record_id: rec.id,
      register_key: key,
      current_state: rec.state,
      since: since ? since.at : null,
      working_days_in_state: wd,
      transitions: rows.map((r) => ({
        from_state: r.from_state,
        to_state: r.to_state,
        at: r.at,
        actor: r.actor_id && refs.get(r.actor_id) ? refs.get(r.actor_id) : null,
        level: r.level,
        admin_override: r.admin_override,
      })),
    };
  }

  /**
   * Median and P85 working days of the completed stays of each state: a stay runs from one recorded transition to the next one of the same entity.
   * Admin-override transitions are left out. Tasks are grouped by stage, records by register; both per region. Visibility is the report rule (B3):
   * sites and reports for tasks, and the view of each register's module for records.
   */
  async stateDurationsReport(_auth: AuthContext, q: Record<string, unknown>) {
    const entity = oneParam(q, "entity_type");
    if (entity !== "task" && entity !== "register_record") {
      throw problems.validation([
        {
          path: "/entity_type",
          code: "invalid",
          message: "entity_type is task or register_record.",
        },
      ]);
    }
    const regionRaw = oneParam(q, "region_id");
    if (regionRaw !== undefined && !/^[1-7]$/.test(regionRaw))
      throw problems.validation([
        {
          path: "/region_id",
          code: "invalid",
          message: "region_id is 1 to 7.",
        },
      ]);
    // Region and group are the same for every transition of one entity, so the filter may run before the window of the stays.
    const regionCond =
      regionRaw === undefined
        ? Prisma.sql`true`
        : Prisma.sql`st.region_id = ${Number(regionRaw)}`;
    let visible: Prisma.Sql;
    if (entity === "task") {
      const regs = await this.reportRegions();
      visible =
        regs === null
          ? Prisma.sql`true`
          : Prisma.sql`st.region_id = ANY(${regs}::int[])`;
    } else {
      const reportRegs = await this.reportRegions();
      const defs = await this.db.tx.$queryRaw<
        { register_key: string; module_key: string }[]
      >(Prisma.sql`SELECT register_key, module_key FROM register_definitions`);
      const clauses: Prisma.Sql[] = [];
      for (const d of defs) {
        const regs = await this.access.regions(d.module_key, "view");
        const both =
          regs === null
            ? reportRegs
            : reportRegs === null
              ? regs
              : regs.filter((x) => reportRegs.includes(x));
        if (both !== null && both.length === 0) continue;
        const inRegions =
          both === null
            ? Prisma.sql`true`
            : Prisma.sql`st.region_id = ANY(${both}::int[])`;
        clauses.push(
          Prisma.sql`(st.group_key = ${d.register_key} AND ${inRegions})`,
        );
      }
      visible = clauses.length
        ? Prisma.join(clauses, " OR ")
        : Prisma.sql`false`;
    }
    const rows = await this.db.tx.$queryRaw<
      {
        region_id: number | null;
        group_key: string | null;
        state: string;
        count: bigint;
        median: number;
        p85: number;
      }[]
    >(Prisma.sql`
      WITH s AS (
        SELECT st.entity_id, st.region_id, st.group_key, st.to_state, st.at, st.id,
          lead(st.at) OVER (PARTITION BY st.entity_id ORDER BY st.at, st.id) AS next_at
        FROM status_transitions st
        WHERE st.entity_type = ${entity} AND NOT st.admin_override AND (${visible}) AND (${regionCond})
      ), w AS (
        SELECT s.region_id, s.group_key, s.to_state,
          cal_workdays_between((s.at AT TIME ZONE 'Africa/Tripoli')::date, (s.next_at AT TIME ZONE 'Africa/Tripoli')::date) AS wd
        FROM s WHERE s.next_at IS NOT NULL
      )
      SELECT w.region_id, w.group_key, w.to_state AS state, count(*) AS count,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY w.wd)::float8 AS median,
        percentile_cont(0.85) WITHIN GROUP (ORDER BY w.wd)::float8 AS p85
      FROM w WHERE w.wd IS NOT NULL GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
    return {
      entity_type: entity,
      items: rows.map((r) => ({
        region_id: r.region_id,
        group_key: r.group_key,
        state: r.state,
        count: Number(r.count),
        median_working_days: r.median,
        p85_working_days: r.p85,
      })),
    };
  }

  // ------------------------------------------------------------------ X5
  /**
   * Open tasks per holder. A claimed task counts for the person who claimed it; an unclaimed one counts for every person who could act on its level
   * (shared). Late = the SLA colour is red. A level nobody can hold is counted under `no_holder`.
   */
  async workload(_auth: AuthContext, q: Record<string, unknown>) {
    const regions = await this.reportRegions();
    const rows = await this.db.tx.$queryRaw<
      {
        holder: string | null;
        team: string | null;
        kind: Kind;
        open: bigint;
        late: bigint;
      }[]
    >(Prisma.sql`
      WITH act AS (
        SELECT t.id, t.ball_in_court_user_id AS pinned,
          wf_kind(CASE WHEN t.path_frozen_at IS NULL THEN wf_levels_live(t.id) ELSE t.levels_required END, greatest(t.current_level, 1)) AS kind,
          coalesce(sla_colour(CASE WHEN t.sla_start_date IS NULL OR r.id IS NULL THEN NULL ELSE cal_workdays_between(t.sla_start_date, cal_today(), r.calendar_id) END,
                              r.min_working_days, r.max_working_days) = 'red', false) AS late
        FROM task_instances t
        JOIN task_definitions td ON td.id = t.task_def_id JOIN stage_definitions st ON st.id = td.stage_id
        LEFT JOIN sla_rules r ON r.id = t.sla_rule_id
        WHERE t.state IN ('open', 'entry', 'in_review', 'in_approval') AND ${this.scope(regions, q)}
      ), h AS (
        SELECT act.kind, act.late, coalesce(act.pinned, e.user_id) AS holder
        FROM act LEFT JOIN LATERAL (SELECT x.user_id FROM wf_eligible(act.id, act.kind) x WHERE act.pinned IS NULL) e ON true
      )
      SELECT h.holder::text AS holder, ${TEAM_OF(Prisma.sql`h.holder`)} AS team, h.kind, count(*) AS open, count(*) FILTER (WHERE h.late) AS late
      FROM h GROUP BY h.holder, h.kind`);
    const refs = await this.view.userRefs([
      ...new Set(rows.map((r) => r.holder).filter((x): x is string => !!x)),
    ]);
    const byHolder = new Map<
      string,
      {
        holder: UserRefDto;
        team: string;
        open: number;
        late: number;
        by_level: Record<Kind, number>;
      }
    >();
    const none = { open: 0, late: 0 };
    for (const r of rows) {
      if (!r.holder) {
        none.open += Number(r.open);
        none.late += Number(r.late);
        continue;
      }
      const g = byHolder.get(r.holder) ?? {
        holder: refs.get(r.holder) ?? {
          id: r.holder,
          display_name: "Unknown",
          employee_id: null,
        },
        team: r.team ?? "none",
        open: 0,
        late: 0,
        by_level: { entry: 0, review: 0, approve: 0 },
      };
      g.open += Number(r.open);
      g.late += Number(r.late);
      g.by_level[r.kind] += Number(r.open);
      byHolder.set(r.holder, g);
    }
    const items = [...byHolder.values()].sort(
      (a, b) =>
        b.late - a.late ||
        b.open - a.open ||
        a.holder.display_name.localeCompare(b.holder.display_name),
    );
    return { items, no_holder: none };
  }

  // ------------------------------------------------------------------ X6
  /** What a task waits for: the predecessors not yet approved, the closed gate with its conditions (permits, suspensions) and open snags. */
  async blockedBy(auth: AuthContext, taskId: string) {
    const row = await this.detail.rowFor(auth, taskId);
    const [task] = await this.view.withLockReasons([row]);
    const preds = await this.db.tx.$queryRaw<
      { id: string; code: string; name_en: string; state: string }[]
    >(Prisma.sql`
      SELECT pi.id::text AS id, pd.code, pd.name_en, pi.state::text AS state
      FROM task_predecessors tp JOIN task_definitions pd ON pd.id = tp.predecessor_id
      JOIN task_instances pi ON pi.site_id = ${row.site_id}::uuid AND pi.task_def_id = tp.predecessor_id
      WHERE tp.task_def_id = ${row.task_def_id}::uuid AND pi.state NOT IN ('approved', 'na', 'skipped')`);
    const items = (task?.lock_reasons ?? []).map((r) => {
      const p =
        r.kind === "predecessor_not_approved"
          ? preds.find((x) => x.code === r.ref_code)
          : undefined;
      return {
        ...r,
        ...(p
          ? {
              task: {
                id: p.id,
                task_code: p.code,
                name_en: p.name_en,
                state: p.state,
              },
            }
          : {}),
      };
    });
    return {
      task_id: row.id,
      state: task?.state ?? row.state,
      blocked: items.length > 0,
      items,
    };
  }
  /** Frozen plans (0.15.480): the list, freeze now (System Admin), hide, and the variance report. The database judges every right and the regions. */
  async planFreezes(): Promise<unknown> {
    return this.freezeCall(Prisma.sql`SELECT plan_freezes_json() AS j`);
  }

  async createPlanFreeze(body: unknown): Promise<unknown> {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.label !== "string") throw problems.validation([{ path: "/label", code: "required", message: "Name the frozen plan." }]);
    const note = typeof b.note === "string" ? b.note : null;
    return this.freezeCall(Prisma.sql`SELECT plan_freeze_create(${b.label}::text, ${note}::text) AS j`);
  }

  async hidePlanFreeze(id: string): Promise<void> {
    if (!UUID.test(id)) throw problems.notFound();
    await this.freezeCall(Prisma.sql`SELECT plan_freeze_hide(${id}::uuid)::text AS j`);
  }

  async planFreezeReport(id: string, q: Record<string, unknown>): Promise<unknown> {
    if (!UUID.test(id)) throw problems.notFound();
    const r = oneParam(q, "region_id");
    if (r !== undefined && r !== "" && !/^[0-9]{1,6}$/.test(r)) throw problems.validation([{ path: "/region_id", code: "invalid", message: "A region id." }]);
    const region = r ? Number(r) : null;
    return this.freezeCall(Prisma.sql`SELECT plan_freeze_report(${id}::uuid, ${region}::integer) AS j`);
  }

  private async freezeCall(sql: Prisma.Sql): Promise<unknown> {
    try {
      const rows = await this.db.tx.$queryRaw<{ j: unknown }[]>(sql);
      return rows[0]?.j ?? null;
    } catch (e) {
      const p = mapDbError(e);
      if (p) throw p;
      throw e;
    }
  }
}
