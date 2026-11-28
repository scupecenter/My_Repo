import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth.types';
import { problems } from '../common/problem';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';
import { RegistersService } from '../registers/registers.service';
import { REPORT_GROUPS, REPORTS, reportByKey, type ReportBy, type ReportDef } from './report-catalogue';

/** One report run reads at most this many rows (Settings > Reports sets a lower limit in step 5). */
export const MAX_ROWS = 5000;
const PAGE = 200;

const runBody = z.object({
  region_id: z.number().int().min(1).max(99).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  company_id: z.string().uuid().optional(),
  group_by: z.enum(['state', 'region', 'record_type', 'site_code']).optional(),
}).strict();

type Col = { code: string; label_en: string; label_ar: string; kind: 'text' | 'number' | 'date' };
type Item = Record<string, unknown>;
export interface ReportRun {
  key: string; title_en: string; title_ar: string; as_of: string; freshness: 'live';
  params: { region_id: number | null; from: string | null; to: string | null; company_id: string | null; group_by: ReportBy };
  columns: Col[]; rows: Record<string, unknown>[]; truncated: boolean;
  groups: { key: string; label: string; count: number; sums: Record<string, number> }[];
  totals: { count: number; sums: Record<string, number> };
  chart: { type: 'bar'; series: { label: string; value: number }[] };
}

const BUILT_IN: Col[] = [
  { code: 'site_code', label_en: 'Site ID', label_ar: 'رقم الموقع', kind: 'text' },
  { code: 'region', label_en: 'Region', label_ar: 'المنطقة', kind: 'text' },
  { code: 'state', label_en: 'State', label_ar: 'الحالة', kind: 'text' },
  { code: 'created_at', label_en: 'Created', label_ar: 'تاريخ الإنشاء', kind: 'date' },
];

/**
 * Ready reports (Report Center, step 1). A run reads the register through RegistersService.listRecords, so the caller's view grant, regions and row rules are the
 * register screen's own: a report never shows more than the screen. Grouping, totals and the chart series are computed here from the rows read; the result is stamped
 * with the time it was read (as of) so a figure can be traced.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly db: DbService, private readonly access: AccessService, private readonly registers: RegistersService) {}

  /** The ready reports the caller may run: the register must be one the caller can view in at least one region. */
  async library(): Promise<{ groups: { key: string; label_en: string; label_ar: string }[]; items: Omit<ReportDef, 'register'>[] }> {
    const items: Omit<ReportDef, 'register'>[] = [];
    const modules = await this.moduleOf(REPORTS.map((r) => r.register));
    for (const r of REPORTS) {
      const mod = modules.get(r.register);
      if (!mod) continue;
      const regs = await this.access.regions(mod, 'view');
      if (regs !== null && regs.length === 0) continue;
      const { register: _register, ...pub } = r;
      void _register;
      items.push(pub);
    }
    const groups = Object.entries(REPORT_GROUPS).map(([key, [label_en, label_ar]]) => ({ key, label_en, label_ar }));
    return { groups, items };
  }

  async run(auth: AuthContext, key: string, raw: unknown): Promise<ReportRun> {
    const def = reportByKey(key);
    if (!def) throw problems.notFound();
    const p = parse(runBody, raw ?? {});
    const by: ReportBy = p.group_by ?? def.group_by;
    const columns = await this.columnsOf(def.register);
    const rows: Item[] = [];
    let truncated = false;
    let cursor: string | null = null;
    const q: Record<string, unknown> = { limit: PAGE };
    if (p.region_id !== undefined) q.region_id = String(p.region_id);
    for (;;) {
      const page: { items: unknown[]; page: { next_cursor: string | null } } = await this.registers.listRecords(auth, def.register, { ...q, ...(cursor ? { cursor } : {}) });
      for (const it of page.items as Item[]) {
        const created = it.created_at instanceof Date ? it.created_at.toISOString() : String(it.created_at ?? '');
        const day = created.slice(0, 10);
        if (p.from && day && day < p.from) continue;
        if (p.to && day && day > p.to) continue;
        if (it.state === 'voided') continue;
        if (rows.length >= MAX_ROWS) { truncated = true; break; }
        rows.push(this.flat(it, created, columns));
      }
      cursor = page.page.next_cursor;
      if (!cursor || truncated) break;
    }
    const numeric = columns.filter((c) => c.kind === 'number').map((c) => c.code);
    const groups = new Map<string, { key: string; label: string; count: number; sums: Record<string, number> }>();
    const totals = { count: rows.length, sums: Object.fromEntries(numeric.map((c) => [c, 0])) as Record<string, number> };
    for (const r of rows) {
      const gk = String(r[by] ?? '');
      const g = groups.get(gk) ?? { key: gk, label: gk || '-', count: 0, sums: Object.fromEntries(numeric.map((c) => [c, 0])) as Record<string, number> };
      g.count++;
      for (const c of numeric) {
        const v = Number(r[c]);
        if (Number.isFinite(v) && r[c] !== null && r[c] !== '') { g.sums[c] = (g.sums[c] ?? 0) + v; totals.sums[c] = (totals.sums[c] ?? 0) + v; }
      }
      groups.set(gk, g);
    }
    const list = [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return {
      key: def.key, title_en: def.title_en, title_ar: def.title_ar, as_of: new Date().toISOString(), freshness: 'live',
      params: { region_id: p.region_id ?? null, from: p.from ?? null, to: p.to ?? null, company_id: p.company_id ?? null, group_by: by },
      columns, rows, truncated, groups: list, totals,
      chart: { type: 'bar', series: list.map((g) => ({ label: g.label, value: g.count })) },
    };
  }

  /** Built-in columns, then the register's list columns (active, shown in the list), numbers marked so they total. */
  private async columnsOf(register: string): Promise<Col[]> {
    const rf = await this.db.tx.$queryRaw<{ code: string; label_en: string; label_ar: string | null; field_type: string }[]>(Prisma.sql`
      SELECT code, label_en, label_ar, field_type FROM register_fields
      WHERE register_key = ${register} AND is_active AND in_list AND NOT derived ORDER BY sort_order, code LIMIT 12`);
    const extra = rf.map((f): Col => ({
      code: f.code, label_en: f.label_en, label_ar: f.label_ar ?? f.label_en,
      kind: f.field_type === 'number' ? 'number' : f.field_type === 'date' ? 'date' : 'text',
    }));
    const seen = new Set(BUILT_IN.map((c) => c.code));
    return [...BUILT_IN, ...extra.filter((c) => !seen.has(c.code))];
  }

  private flat(it: Item, created: string, columns: Col[]): Record<string, unknown> {
    const data = (it.data ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const c of columns) {
      if (c.code === 'site_code') out[c.code] = it.site_code ?? null;
      else if (c.code === 'region') out[c.code] = it.region_id ?? null;
      else if (c.code === 'state') out[c.code] = it.state ?? null;
      else if (c.code === 'created_at') out[c.code] = created;
      else out[c.code] = data[c.code] ?? null;
    }
    out.record_type = it.record_type ?? null;
    out.id = it.id ?? it.entity_id ?? null;
    return out;
  }

  private async moduleOf(keys: string[]): Promise<Map<string, string>> {
    const rows = await this.db.tx.$queryRaw<{ register_key: string; module_key: string }[]>(Prisma.sql`
      SELECT register_key, module_key FROM register_definitions WHERE register_key = ANY(${keys}::text[])`);
    return new Map(rows.map((r) => [r.register_key, r.module_key]));
  }
}
