/**
 * Pure rules of GET /dashboard/ops (contract 0.15.98): the aging buckets of open PR/PO and the materials receive rate.
 * No database access here, so the buckets and the percentage are unit tested on their own.
 */

export type AgeBucketKey = "d0_7" | "d8_14" | "d15_30" | "over_30";

/** The aging buckets of an open PR or PO (calendar days since its date): 0-7, 8-14, 15-30, over 30. */
export const AGE_BUCKETS: readonly {
  key: AgeBucketKey;
  min: number;
  max: number | null;
}[] = [
  { key: "d0_7", min: 0, max: 7 },
  { key: "d8_14", min: 8, max: 14 },
  { key: "d15_30", min: 15, max: 30 },
  { key: "over_30", min: 31, max: null },
];

/** The bucket of an age in whole calendar days, or null for a negative or non-finite age (a future or broken date is not counted). */
export function ageBucket(days: number): AgeBucketKey | null {
  if (!Number.isFinite(days) || days < 0) return null;
  const b = AGE_BUCKETS.find(
    (x) => days >= x.min && (x.max === null || days <= x.max),
  );
  return b ? b.key : null;
}

export interface AgeBuckets {
  buckets: { key: AgeBucketKey; count: number }[];
  total: number;
  oldest_days: number | null;
}

/** The bucket counts of a list of ages (whole days), every bucket listed once, plus the total and the oldest age. */
export function bucketAges(ages: number[]): AgeBuckets {
  const counts = new Map<AgeBucketKey, number>();
  let oldest: number | null = null;
  for (const a of ages) {
    const k = ageBucket(a);
    if (k === null) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (oldest === null || a > oldest) oldest = a;
  }
  return {
    buckets: AGE_BUCKETS.map((b) => ({
      key: b.key,
      count: counts.get(b.key) ?? 0,
    })),
    total: [...counts.values()].reduce((x, y) => x + y, 0),
    oldest_days: oldest,
  };
}

/** The receive rate: dispatched against required, capped at 100%, one decimal; null when nothing is required. */
export function receivePct(
  required: number,
  dispatched: number,
): number | null {
  if (!(required > 0)) return null;
  const capped = Math.max(0, Math.min(dispatched, required));
  return Math.round((capped * 1000) / required) / 10;
}

// ---------------------------------------------------------------- item 3 (0.15.200): permits and HSE

/** The six PTW safety checks (the permits_hse fields jsa_tra to rescue_plan), in display order. */
export const PTW_CHECK_KEYS = [
  "jsa_tra",
  "toolbox_talk",
  "work_at_height",
  "lifting_plan",
  "loto",
  "rescue_plan",
] as const;
export type PtwCheckKey = (typeof PTW_CHECK_KEYS)[number];

/**
 * The PTW safety checks a permit still misses: a check counts as covered only when its value is "Done" or "N/A";
 * a missing, pending or free value is a gap (the permits form lists exactly these values).
 */
export function ptwCheckGaps(
  checks: Record<string, unknown> | null,
): PtwCheckKey[] {
  return PTW_CHECK_KEYS.filter((k) => {
    const v = checks?.[k];
    return v !== "Done" && v !== "N/A";
  });
}

/** The scorecard levels of the contractor performance report (migration 0180). */
export type ScorecardLevel = "ok" | "amber" | "red" | "insufficient";

/** The report item fields the dashboard scorecard reads (a subset of the contractor performance report item). */
export interface ScorecardItem {
  party_id: string;
  name: string;
  type: string;
  delay_days: number;
  issues_open: number;
  snags: { total: number; open: number; overdue: number; returned: number };
  quality: { total: number; failed: number };
  level: ScorecardLevel;
}

export interface ScorecardSummary {
  parties: number;
  by_level: Record<ScorecardLevel, number>;
  /** The mean delay days over the parties that have any delay, one decimal; null when nobody is delayed. */
  avg_delay_days: number | null;
  /** The share of snags not overdue (the on-time rectification rate), one decimal; null when there are no snags. */
  on_time_pct: number | null;
  /** The share of failed quality inspections (the rejection / NCR rate), one decimal; null when there are no inspections. */
  quality_fail_pct: number | null;
  snags: { total: number; open: number; overdue: number; returned: number };
  quality: { total: number; failed: number };
  /** The five worst parties (the report order is worst first): no amounts, the party and its worst figures only. */
  worst: {
    party_id: string;
    name: string;
    type: string;
    level: ScorecardLevel;
    delay_days: number;
    snags_overdue: number;
    quality_failed: number;
  }[];
}

/**
 * The scorecard section of the dashboard (0.15.202, item 5): the aggregate of the contractor performance report, so
 * the card and the performance screen never disagree. On-time completion, the average delay and the rejection rate,
 * with no amounts anywhere.
 */
export function scorecardSummary(items: ScorecardItem[]): ScorecardSummary {
  const by_level: Record<ScorecardLevel, number> = { ok: 0, amber: 0, red: 0, insufficient: 0 };
  const snags = { total: 0, open: 0, overdue: 0, returned: 0 };
  const quality = { total: 0, failed: 0 };
  let delaySum = 0;
  let delayed = 0;
  for (const it of items) {
    by_level[it.level] += 1;
    snags.total += it.snags.total;
    snags.open += it.snags.open;
    snags.overdue += it.snags.overdue;
    snags.returned += it.snags.returned;
    quality.total += it.quality.total;
    quality.failed += it.quality.failed;
    if (it.delay_days > 0) {
      delaySum += it.delay_days;
      delayed += 1;
    }
  }
  const pct = (part: number, total: number): number | null =>
    total > 0 ? Math.round((part * 1000) / total) / 10 : null;
  return {
    parties: items.length,
    by_level,
    avg_delay_days: delayed > 0 ? Math.round((delaySum * 10) / delayed) / 10 : null,
    on_time_pct: pct(snags.total - snags.overdue, snags.total),
    quality_fail_pct: pct(quality.failed, quality.total),
    snags,
    quality,
    worst: items.slice(0, 5).map((it) => ({
      party_id: it.party_id,
      name: it.name,
      type: it.type,
      level: it.level,
      delay_days: it.delay_days,
      snags_overdue: it.snags.overdue,
      quality_failed: it.quality.failed,
    })),
  };
}

// ---------------------------------------------------------------- item 6 (0.15.203): quality, snags and NCR

/** The mean of a list of day counts, one decimal; null when the list is empty. */
export function meanDays(days: number[]): number | null {
  if (days.length === 0) return null;
  const sum = days.reduce((x, y) => x + y, 0);
  return Math.round((sum / days.length) * 10) / 10;
}

/** The first-time acceptance rate: pass against pass + fail, one decimal; null when nothing is decided. */
export function firstPassPct(pass: number, fail: number): number | null {
  const decided = pass + fail;
  if (!(decided > 0)) return null;
  return Math.round((pass * 1000) / decided) / 10;
}

// ---------------------------------------------------------------- item 7 (0.15.204): pending approvals bottleneck

export interface ApprovalWaitRow {
  role_id: string | null;
  name_en: string | null;
  name_ar: string | null;
  days: number | null;
  state: string;
}

export interface ApprovalsByRole {
  total: number;
  review: number;
  approve: number;
  waiting: AgeBuckets;
  by_role: {
    role_id: string;
    name_en: string;
    name_ar: string | null;
    count: number;
    oldest_days: number | null;
    buckets: AgeBuckets["buckets"];
  }[];
  unassigned: number;
}

/**
 * The waiting tasks (states in_review and in_approval) grouped by the ball-in-court role: the counts per level kind,
 * the overall age buckets, and per role the count, the oldest age and the buckets. Rows with no role count as
 * unassigned (a group holds the level, or nobody yet). Most waiting tasks first, then the English name.
 */
export function approvalsByRole(rows: ApprovalWaitRow[]): ApprovalsByRole {
  const byRole = new Map<string, { name_en: string; name_ar: string | null; days: number[] }>();
  let review = 0;
  let approve = 0;
  let unassigned = 0;
  const allDays: number[] = [];
  for (const r of rows) {
    if (r.state === "in_review") review += 1;
    else if (r.state === "in_approval") approve += 1;
    if (r.days !== null) allDays.push(r.days);
    if (r.role_id === null) {
      unassigned += 1;
      continue;
    }
    const entry = byRole.get(r.role_id) ?? { name_en: r.name_en ?? "", name_ar: r.name_ar, days: [] };
    if (r.days !== null) entry.days.push(r.days);
    else entry.days.push(0);
    byRole.set(r.role_id, entry);
  }
  const by_role = [...byRole.entries()]
    .map(([role_id, e]) => {
      const b = bucketAges(e.days);
      return {
        role_id,
        name_en: e.name_en,
        name_ar: e.name_ar,
        count: e.days.length,
        oldest_days: b.oldest_days,
        buckets: b.buckets,
      };
    })
    .sort((a, b) => b.count - a.count || a.name_en.localeCompare(b.name_en));
  return {
    total: rows.length,
    review,
    approve,
    waiting: bucketAges(allDays),
    by_role,
    unassigned,
  };
}

// ---------------------------------------------------------------- item 8 (0.15.205): change requests and overdue meeting actions

export interface ChangeWaitRow {
  kind: string;
  status: string;
  days: number | null;
}

export interface ChangesSummary {
  pending: number;
  approved_not_applied: number;
  by_kind: { kind: string; count: number }[];
  pending_aging: AgeBuckets;
}

/**
 * The change requests: the pending ones (status requested) aged in calendar days since the request date, per kind
 * (most first, then the kind name), and the approved ones not yet applied. Rejected and applied ones are not counted.
 */
export function changesSummary(rows: ChangeWaitRow[]): ChangesSummary {
  const kinds = new Map<string, number>();
  const ages: number[] = [];
  let pending = 0;
  let approved = 0;
  for (const r of rows) {
    if (r.status === "approved") approved += 1;
    if (r.status !== "requested") continue;
    pending += 1;
    kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
    ages.push(r.days !== null && r.days > 0 ? r.days : 0);
  }
  return {
    pending,
    approved_not_applied: approved,
    by_kind: [...kinds.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    pending_aging: bucketAges(ages),
  };
}

export interface ActionDueRow {
  status: string;
  days_overdue: number | null;
}

export interface ActionsSummary {
  open: number;
  overdue: number;
  no_due_date: number;
  overdue_aging: AgeBuckets;
}

/**
 * The meeting actions that are not closed (status open or in_progress): how many are open, how many are overdue (due date
 * before today), how many have no due date, and the days overdue of the late ones in the usual buckets.
 */
export function actionsSummary(rows: ActionDueRow[]): ActionsSummary {
  const late: number[] = [];
  let open = 0;
  let none = 0;
  for (const r of rows) {
    if (r.status !== "open" && r.status !== "in_progress") continue;
    open += 1;
    if (r.days_overdue === null) none += 1;
    else if (r.days_overdue > 0) late.push(r.days_overdue);
  }
  return { open, overdue: late.length, no_due_date: none, overdue_aging: bucketAges(late) };
}

/** Phase scope (0.15.367): one registered phase with its site counts. Counts only; every figure is derived from the sites. */
export interface PhaseScopeRow {
  phase: string | null;
  sites: number;
  completed: number;
  in_progress: number;
  not_started: number;
  on_hold: number;
  on_air: number;
}

export interface PhaseScopeOut extends PhaseScopeRow {
  /** On-air sites over the sites of the phase, in percent (one decimal); null when the phase has no site. */
  progress_pct: number | null;
  /** The target of the phase: all its registered sites. Derived, never typed. */
  target_sites: number;
}

const PHASE_NONE = null;

/**
 * Phase scope: the registered, not cancelled sites per project phase (the sites table field project_phase), with the share on air.
 * Sites with no phase are one row with phase null. Rows are ordered by phase name (natural order, "C" collation like the registers), no phase last.
 */
export function phaseScope(rows: PhaseScopeRow[]): { phases: PhaseScopeOut[]; total: PhaseScopeOut } {
  const phases: PhaseScopeOut[] = rows
    .map((r) => ({
      ...r,
      progress_pct: r.sites > 0 ? Math.round((r.on_air / r.sites) * 1000) / 10 : null,
      target_sites: r.sites,
    }))
    .sort((a, b) =>
      a.phase === PHASE_NONE ? 1 : b.phase === PHASE_NONE ? -1 : a.phase!.localeCompare(b.phase!, "en", { numeric: true }),
    );
  const sum = (k: keyof PhaseScopeRow) => phases.reduce((n, r) => n + (r[k] as number), 0);
  const sites = sum("sites");
  const on_air = sum("on_air");
  return {
    phases,
    total: {
      phase: PHASE_NONE,
      sites,
      completed: sum("completed"),
      in_progress: sum("in_progress"),
      not_started: sum("not_started"),
      on_hold: sum("on_hold"),
      on_air,
      progress_pct: sites > 0 ? Math.round((on_air / sites) * 1000) / 10 : null,
      target_sites: sites,
    },
  };
}

/**
 * The monthly On-Air target derived from the scope: the sites not yet on air spread over the months left to the latest planned date of the
 * On-Air task in scope (30-day months, at least one). Null when no site of the scope has a planned date or nothing is left to do.
 * A planned end already past asks for everything this month.
 */
export function autoMonthlyOnAir(remaining: number, plannedEnd: string | null, today: string): { value: number | null; months_left: number | null } {
  if (!plannedEnd || remaining <= 0) return { value: null, months_left: null };
  const days = Math.round((Date.parse(`${plannedEnd}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const months = Math.max(1, Math.ceil(days / 30));
  return { value: Math.ceil(remaining / months), months_left: months };
}

/** The target in force: a typed number counts only while the manual override is on and the number is a positive whole. */
export function targetInForce(override: boolean, manual: number | null, derived: number | null): { value: number | null; source: "derived" | "manual" } {
  if (override && manual !== null && manual > 0) return { value: manual, source: "manual" };
  return { value: derived, source: "derived" };
}
