/**
 * Pure rules of GET /dashboard/extras (contract 0.15.16; F13 of the features build plan, owner decisions 2026-11-15).
 * No database access here, so the bands, the matrix, the decision tags and the gap totals are unit tested on their own.
 */

export type RiskBand = "low" | "medium" | "high" | "critical";

/** The bands of the 5x5 matrix (owner default of 2026-11-15, a setting for the administrator): score = probability x impact, each 1 to 5. */
export const RISK_BANDS: readonly {
  band: RiskBand;
  min: number;
  max: number;
}[] = [
  { band: "low", min: 1, max: 4 },
  { band: "medium", min: 5, max: 9 },
  { band: "high", min: 10, max: 16 },
  { band: "critical", min: 20, max: 25 },
];

/** The score of a risk, or null when probability or impact is not a whole number from 1 to 5. */
export function riskScore(probability: number, impact: number): number | null {
  const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= 5;
  return ok(probability) && ok(impact) ? probability * impact : null;
}

/** The band of a score (1 to 25), or null for a score that no 5x5 cell can give. */
export function riskBand(score: number): RiskBand | null {
  const hit = RISK_BANDS.find((b) => score >= b.min && score <= b.max);
  return hit ? hit.band : null;
}

/** A decision tag (F13 item 4): a high or critical open risk is acted on now, every other open risk is watched. Read only, it changes no status. */
export function decisionTag(band: RiskBand): "act_now" | "watch" {
  return band === "high" || band === "critical" ? "act_now" : "watch";
}

export interface RiskPoint {
  probability: number;
  impact: number;
}

/** The 25 cells in the order of probability (rows) then impact (columns), with the count of open risks in each, the bands and the risks left out. */
export function buildRiskMatrix(points: RiskPoint[]): {
  cells: {
    probability: number;
    impact: number;
    score: number;
    band: RiskBand;
    count: number;
  }[];
  bands: { band: RiskBand; min: number; max: number; count: number }[];
  invalid_total: number;
} {
  const counts = new Map<string, number>();
  let invalid = 0;
  for (const p of points) {
    const s = riskScore(p.probability, p.impact);
    if (s === null) {
      invalid += 1;
      continue;
    }
    const key = `${p.probability}:${p.impact}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const cells: {
    probability: number;
    impact: number;
    score: number;
    band: RiskBand;
    count: number;
  }[] = [];
  for (let probability = 1; probability <= 5; probability += 1) {
    for (let impact = 1; impact <= 5; impact += 1) {
      const score = probability * impact;
      cells.push({
        probability,
        impact,
        score,
        band: riskBand(score) as RiskBand,
        count: counts.get(`${probability}:${impact}`) ?? 0,
      });
    }
  }
  const bands = RISK_BANDS.map((b) => ({
    ...b,
    count: cells
      .filter((c) => c.band === b.band)
      .reduce((n, c) => n + c.count, 0),
  }));
  return { cells, bands, invalid_total: invalid };
}

/** Open risks sorted for the top list: highest score first, then by code. */
export function sortRisksForTop<T extends { score: number; risk_code: string }>(
  rows: T[],
): T[] {
  return [...rows].sort(
    (a, b) =>
      b.score - a.score ||
      (a.risk_code < b.risk_code ? -1 : a.risk_code > b.risk_code ? 1 : 0),
  );
}

export interface SiteGapReport {
  count: number;
  items: { kind: string; field?: string | null }[];
}

/** Totals of the data quality panel from the gap reports of the sites (`site_data_gaps`). Keys: kind, and the field for a missing field. */
export function aggregateGaps(reports: SiteGapReport[]): {
  sites_checked: number;
  sites_with_gaps: number;
  gaps_total: number;
  by_kind: { kind: string; field: string | null; count: number }[];
} {
  const byKind = new Map<
    string,
    { kind: string; field: string | null; count: number }
  >();
  let withGaps = 0;
  let total = 0;
  for (const r of reports) {
    if (r.count > 0) withGaps += 1;
    total += r.count;
    for (const item of r.items) {
      const field = item.kind === "missing_field" ? (item.field ?? null) : null;
      const key = `${item.kind}|${field ?? ""}`;
      const cur = byKind.get(key) ?? { kind: item.kind, field, count: 0 };
      cur.count += 1;
      byKind.set(key, cur);
    }
  }
  const by_kind = [...byKind.values()].sort(
    (a, b) =>
      b.count - a.count ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
      (a.field ?? "").localeCompare(b.field ?? ""),
  );
  return {
    sites_checked: reports.length,
    sites_with_gaps: withGaps,
    gaps_total: total,
    by_kind,
  };
}
