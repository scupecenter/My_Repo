/** Item 7: timeline model, read only. Pure: rows and the chosen date keys in, day positions out.
    V3 (0.15.575): generalized from Site Master columns (numeric ords) to any string key, so a register's date fields use the same model. */
export interface TlPoint { key: string; day: number; iso: string }
export interface TlRow { id: string; code: string; points: TlPoint[]; from: number; to: number }
export interface TlModel { rows: TlRow[]; min: number; max: number; months: { day: number; label: string }[] }

const toDay = (v?: string | null): number | null => {
  if (!v) return null;
  const t = Date.parse(`${v.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? null : Math.floor(t / 86_400_000);
};
export const dayOf = (iso: string): number | null => toDay(iso);

/** Rows with no date under any chosen key are left out of the bars (the screen says how many). Today is part of the span so the marker is always inside. */
export function buildTimeline(rows: { id: string; code: string; values: Record<string, string | null> }[], keys: string[], today: string): TlModel | null {
  const out: TlRow[] = [];
  for (const r of rows) {
    const points = keys.flatMap((key) => { const iso = r.values[key]; const day = toDay(iso); return day === null || !iso ? [] : [{ key, day, iso: iso.slice(0, 10) }]; });
    if (points.length) out.push({ id: r.id, code: r.code, points, from: Math.min(...points.map((p) => p.day)), to: Math.max(...points.map((p) => p.day)) });
  }
  if (!out.length) return null;
  const t = toDay(today);
  const all = [...out.flatMap((r) => [r.from, r.to]), ...(t === null ? [] : [t])];
  const min = Math.min(...all), max = Math.max(...all);
  const months: TlModel['months'] = [];
  const d = new Date(min * 86_400_000);
  d.setUTCDate(1);
  for (let guard = 0; guard < 240; guard++) {
    const day = Math.floor(d.getTime() / 86_400_000);
    if (day > max) break;
    if (day >= min) months.push({ day, label: d.toISOString().slice(0, 7) });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return { rows: out, min, max, months };
}

export const posPct = (m: TlModel, day: number): number => ((day - m.min) / Math.max(m.max - m.min, 1)) * 100;
