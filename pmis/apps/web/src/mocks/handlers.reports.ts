// MSW handlers of the Report Center (contract 0.15.598): the library and a run. The mock registers have no report data of their own, so a run answers the
// shape the real API gives over a small fixed sample (the grouping, totals and chart are computed the same way the server does).
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { ReportLibrary, ReportRun } from '@/api/reports';
import { guard, problem } from './handlers';

const B = API_BASE;
const ITEMS: ReportLibrary['items'] = [
  { key: 'procurement_status', group: 'procurement', title_en: 'Procurement status', title_ar: 'حالة المشتريات', group_by: 'state', default_view: 'grouped' },
  { key: 'issues_overview', group: 'quality', title_en: 'Issues overview', title_ar: 'نظرة عامة على المشاكل', group_by: 'state', default_view: 'chart' },
  { key: 'equipment_status', group: 'equipment', title_en: 'Tools and equipment', title_ar: 'الأدوات والمعدات', group_by: 'state', default_view: 'grouped' },
];
const GROUPS: ReportLibrary['groups'] = [
  { key: 'procurement', label_en: 'Procurement', label_ar: 'المشتريات' },
  { key: 'quality', label_en: 'Quality and issues', label_ar: 'الجودة والمشاكل' },
  { key: 'equipment', label_en: 'Tools and equipment', label_ar: 'الأدوات والمعدات' },
];
const SAMPLE = [['entry', 'T-101', 1], ['approved', 'T-102', 1], ['approved', 'T-103', 2], ['in_review', 'T-104', 2]] as const;

export const reportsHandlers = [
  http.get(`${B}/reports/library`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ groups: GROUPS, items: ITEMS } satisfies ReportLibrary); }),
  http.post(`${B}/reports/:key/run`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const def = ITEMS.find((i) => i.key === params.key);
    if (!def) return problem(404, 'not_found', 'Not found');
    const b = (await request.json().catch(() => ({}))) as { region_id?: number; group_by?: ReportRun['params']['group_by'] };
    const by = (b.group_by ?? def.group_by) as ReportRun['params']['group_by'];
    const rows = SAMPLE.filter((s) => b.region_id === undefined || s[2] === b.region_id).map((s) => ({ site_code: s[1], region: s[2], state: s[0], created_at: '2026-11-20T08:00:00.000Z', record_type: null, id: s[1] }));
    const groups = new Map<string, number>();
    for (const r of rows) groups.set(String(r[by as 'state' | 'region' | 'site_code'] ?? ''), (groups.get(String(r[by as 'state' | 'region' | 'site_code'] ?? '')) ?? 0) + 1);
    const list = [...groups].map(([key, count]) => ({ key, label: key || '-', count, sums: {} }));
    const out: ReportRun = {
      key: def.key, title_en: def.title_en, title_ar: def.title_ar, as_of: new Date().toISOString(), freshness: 'live',
      params: { region_id: b.region_id ?? null, from: null, to: null, company_id: null, group_by: by },
      columns: [
        { code: 'site_code', label_en: 'Site ID', label_ar: 'رقم الموقع', kind: 'text' }, { code: 'region', label_en: 'Region', label_ar: 'المنطقة', kind: 'text' },
        { code: 'state', label_en: 'State', label_ar: 'الحالة', kind: 'text' }, { code: 'created_at', label_en: 'Created', label_ar: 'تاريخ الإنشاء', kind: 'date' },
      ],
      rows, truncated: false, groups: list, totals: { count: rows.length, sums: {} }, chart: { type: 'bar', series: list.map((x) => ({ label: x.label, value: x.count })) },
    };
    return HttpResponse.json(out);
  }),
];
