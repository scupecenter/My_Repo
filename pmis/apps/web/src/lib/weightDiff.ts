import type { WeightSet } from "@/api/types";

/** Settings review gap 7 (contract 0.15.434): the item level difference between the draft and the set in force, worked out from the two sets. Read only. */
export type DiffKind = "added" | "removed" | "changed";
export interface DiffRow {
  kind: DiffKind;
  level: "activity" | "item";
  activity: string;
  code: string;
  name: string;
  /** For a changed row: the fields that differ, with their before and after text. */
  fields: { field: "name" | "weight" | "unit" | "measure_rule"; before: string; after: string }[];
}

type Act = WeightSet["activities"][number];
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));

function fieldsOf(a: { name_en: string; weight: number; unit?: string | null; measure_rule?: string | null }, b: typeof a, withItemFields: boolean) {
  const out: DiffRow["fields"] = [];
  if (a.name_en !== b.name_en) out.push({ field: "name", before: a.name_en, after: b.name_en });
  if (Number(a.weight) !== Number(b.weight)) out.push({ field: "weight", before: s(a.weight), after: s(b.weight) });
  if (withItemFields) {
    if (s(a.unit) !== s(b.unit)) out.push({ field: "unit", before: s(a.unit), after: s(b.unit) });
    if (s(a.measure_rule) !== s(b.measure_rule)) out.push({ field: "measure_rule", before: s(a.measure_rule), after: s(b.measure_rule) });
  }
  return out;
}

export function diffWeightSets(active: Act[], draft: Act[]): DiffRow[] {
  const rows: DiffRow[] = [];
  const cur = new Map(active.map((a) => [a.code, a]));
  const nxt = new Map(draft.map((a) => [a.code, a]));
  for (const a of draft) {
    const o = cur.get(a.code);
    if (!o) {
      rows.push({ kind: "added", level: "activity", activity: a.code, code: a.code, name: a.name_en, fields: [] });
      for (const i of a.items) rows.push({ kind: "added", level: "item", activity: a.code, code: i.code, name: i.name_en, fields: [] });
      continue;
    }
    const f = fieldsOf(o, a, false);
    if (f.length) rows.push({ kind: "changed", level: "activity", activity: a.code, code: a.code, name: a.name_en, fields: f });
    const oi = new Map(o.items.map((i) => [i.code, i]));
    const ni = new Map(a.items.map((i) => [i.code, i]));
    for (const i of a.items) {
      const p = oi.get(i.code);
      if (!p) rows.push({ kind: "added", level: "item", activity: a.code, code: i.code, name: i.name_en, fields: [] });
      else {
        const g = fieldsOf(p, i, true);
        if (g.length) rows.push({ kind: "changed", level: "item", activity: a.code, code: i.code, name: i.name_en, fields: g });
      }
    }
    for (const i of o.items) if (!ni.has(i.code)) rows.push({ kind: "removed", level: "item", activity: a.code, code: i.code, name: i.name_en, fields: [] });
  }
  for (const a of active) {
    if (nxt.has(a.code)) continue;
    rows.push({ kind: "removed", level: "activity", activity: a.code, code: a.code, name: a.name_en, fields: [] });
    for (const i of a.items) rows.push({ kind: "removed", level: "item", activity: a.code, code: i.code, name: i.name_en, fields: [] });
  }
  return rows;
}
