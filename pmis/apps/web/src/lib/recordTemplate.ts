import type { RegisterDefinition, RegisterRecord } from '@/api/types';

/** Item 8: the kinds of value a template or a copy keeps. Dates, people, parties, files, rows and sites are left out: they go stale or belong to the old record. */
const COPY_TYPES = new Set(['text', 'number', 'list', 'multi_list', 'yes_no']);

export type TemplateData = Record<string, string | number | boolean | string[] | null>;

/** The values of `data` that may be copied: plain values of fields the caller may edit (not read-only, not locked). */
export function copyableData(def: Pick<RegisterDefinition, 'fields'>, data: Record<string, unknown>): TemplateData {
  const out: TemplateData = {};
  for (const f of def.fields) {
    if (!COPY_TYPES.has(f.type) || f.read_only || f.locked) continue;
    const v = data[f.code];
    if (v === undefined) continue;
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[f.code] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[f.code] = v as string[];
  }
  return out;
}

/** A short name for a record in the "start from" list: its site and its first text value. */
export function recordName(def: Pick<RegisterDefinition, 'fields'>, r: Pick<RegisterRecord, 'data' | 'site_code' | 'id'>): string {
  const first = def.fields.find((f) => f.type === 'text' && typeof r.data[f.code] === 'string' && (r.data[f.code] as string).trim());
  const text = first ? String(r.data[first.code]).trim().slice(0, 40) : '';
  return [r.site_code, text].filter(Boolean).join(' · ') || r.id.slice(0, 8);
}
