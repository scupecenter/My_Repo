import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';

/**
 * Synthetic SITE 360 menus (contract 0.15.21). A small subset of the 187 Master columns, with the same sections as the
 * API's defaults, so the grid can be tested. The real columns come from master_columns.
 */
type Col = { ord: number; letter: string; group_top: string | null; group_mid: string | null; header: string; sections: string[]; source_kind: string; source_note?: string | null };
const COLS: Col[] = [
  { ord: 1, letter: 'A', group_top: '#', group_mid: null, header: '#', sections: ['design_acq'], source_kind: 'derived' },
  { ord: 2, letter: 'B', group_top: 'RF & DESIGN', group_mid: 'Identification', header: 'Site ID', sections: ['design_acq'], source_kind: 'site' },
  { ord: 4, letter: 'D', group_top: 'RF & DESIGN', group_mid: 'Identification', header: 'Site Name', sections: ['design_acq'], source_kind: 'site' },
  { ord: 5, letter: 'E', group_top: 'RF & DESIGN', group_mid: 'Identification', header: 'Region', sections: ['design_acq'], source_kind: 'site' },
  { ord: 23, letter: 'W', group_top: 'Phase Gate', group_mid: 'Pre-CW Readiness', header: 'Pre-CW Readiness', sections: ['cw'], source_kind: 'milestone' },
  { ord: 24, letter: 'X', group_top: 'PRE-CW', group_mid: 'Project', header: 'Project Phase', sections: ['sow'], source_kind: 'site' },
  { ord: 33, letter: 'AG', group_top: 'PRE-CW', group_mid: 'CW Procurement', header: 'CW Delivery Model', sections: ['cw'], source_kind: 'site' },
  { ord: 78, letter: 'BZ', group_top: 'TE INSTALLATION', group_mid: 'TE Access', header: 'TE Access Date', sections: ['te'], source_kind: 'register' },
  { ord: 144, letter: 'EN', group_top: 'CLUSTER OPTIMIZATION', group_mid: 'Cluster', header: 'Cluster ID', sections: ['hoto'], source_kind: 'derived', source_note: 'Cluster ID of the site (= G).' },
  { ord: 157, letter: 'FA', group_top: 'FINAL CLOSURE', group_mid: 'CW DLP / FAC', header: 'CW DLP Start Date', sections: ['om'], source_kind: 'derived', source_note: 'CW PAC Actual Date (BV).' },
  { ord: 170, letter: 'FN', group_top: 'DISMANTLE', group_mid: 'CW Dismantle (RN)', header: 'Site CW RFD', sections: ['dismantle'], source_kind: 'register' },
  { ord: 172, letter: 'FP', group_top: 'DISMANTLE', group_mid: 'CW Dismantle (RN)', header: 'Planned Date', sections: ['dismantle'], source_kind: 'not_tracked', source_note: 'Not tracked: the Dismantle register has no planned date (owner question U4).' },
  { ord: 180, letter: 'FX', group_top: 'Progress', group_mid: null, header: 'Current Milestone', sections: ['status'], source_kind: 'site' },
  { ord: 187, letter: 'GE', group_top: 'Issue & Remark', group_mid: null, header: 'Remark', sections: ['status'], source_kind: 'register' },
];
const MENUS = [
  ['master', 'Master', 'الماستر'], ['design_acq', 'Design & Acquisition', 'التصميم والاستحواذ'], ['sow', 'SOW', 'نطاق العمل'],
  ['cw', 'CW', 'الأعمال المدنية'], ['te', 'TE', 'التركيبات'], ['hoto', 'HOTO', 'التسليم والإغلاق'],
  ['dismantle', 'Dismantle', 'الفك'], ['om', 'O&M', 'التشغيل والصيانة'],
] as const;
const IDENT = [1, 2, 3, 4];

function menu(key: string, name_en: string, name_ar: string) {
  const cols = COLS.filter((c) => key === 'master' || c.sections.includes(key) || c.sections.includes('status') || IDENT.includes(c.ord));
  const bands: { name: string | null; is_phase_gate: boolean; groups: { name: string | null; ords: number[] }[] }[] = [];
  for (const c of cols) {
    let b = bands[bands.length - 1];
    if (!b || b.name !== c.group_top) bands.push((b = { name: c.group_top, is_phase_gate: c.group_top === 'Phase Gate', groups: [] }));
    let g = b.groups[b.groups.length - 1];
    if (!g || g.name !== c.group_mid) b.groups.push((g = { name: c.group_mid, ords: [] }));
    g.ords.push(c.ord);
  }
  return {
    key, name_en, name_ar,
    columns: cols.map((c) => ({ ...c, is_phase_gate: c.group_top === 'Phase Gate' })),
    bands,
    frozen_ords: cols.map((c) => c.ord).filter((o) => IDENT.includes(o)),
  };
}

/** Three synthetic sites in the shape of GET /site360/{menu}/rows: the values are keyed by the menu's column order. */
const SITES = [
  { id: 'a0000000-0000-4000-8000-000000000001', code: 'S360-001', name: 'Synthetic site one', region: 'Tripoli', milestone: 'Site Release', status: 'in_progress', phase: 'Phase 1', model: 'outsourced', batch: 'B1' },
  { id: 'a0000000-0000-4000-8000-000000000002', code: 'S360-002', name: 'Synthetic site two', region: 'Middle', milestone: 'CW Completion', status: 'on_hold', phase: 'Phase 2', model: 'internal', batch: 'B3' },
  { id: 'a0000000-0000-4000-8000-000000000003', code: 'S360-003', name: '', region: 'Zawia', milestone: null, status: 'completed', phase: 'Phase 2', model: 'outsourced', batch: 'B4' },
];

/** 0.15.45: `filter` (the unified filter tree). The mock narrows the rows on the Delivery batch field only; the real server compiles the whole tree. */
function batchesOf(filter: string | null): string[] | null {
  if (!filter) return null;
  try {
    const t = JSON.parse(filter) as { items: { field?: string; value?: unknown }[] };
    const c = t.items.find((x) => x.field === 'delivery_batch');
    return c ? (Array.isArray(c.value) ? c.value.map(String) : [String(c.value)]) : null;
  } catch { return null; }
}

function rowsFor(key: string, offset: number, limit: number, batches: string[] | null = null) {
  const cols = COLS.filter((c) => key === 'master' || c.sections.includes(key) || c.sections.includes('status') || IDENT.includes(c.ord));
  const list = batches ? SITES.filter((x) => batches.includes(x.batch)) : SITES;
  const page = list.slice(offset, offset + limit);
  const values = (site: (typeof SITES)[number]) => {
    const v: Record<string, string | null> = {};
    for (const c of cols) v[String(c.ord)] = null;
    v['4'] = site.name || null;
    v['5'] = site.region;
    v['24'] = site.phase;
    v['33'] = site.model;
    v['180'] = site.milestone;
    v['182'] = site.status;
    v['78'] = '2026-03-10';
    return v;
  };
  return {
    total: SITES.length,
    filtered: list.length,
    offset,
    limit,
    rows: page.map((site, i) => ({ site_id: site.id, site_code: site.code, row_no: offset + i + 1, values: values(site) })),
    menu: { key, name_en: key, name_ar: key, columns: cols.map((c) => ({ ...c, is_phase_gate: c.group_top === 'Phase Gate' })), bands: menu(key, key, key).bands, frozen_ords: IDENT },
  };
}

/** The cells of GET /site360/sites/{site_id}/sources for a synthetic site: value, kind, origin and the ids to open the source. */
function sourcesFor(site: (typeof SITES)[number], key: string) {
  const cols = COLS.filter((c) => key === 'master' || c.sections.includes(key) || c.sections.includes('status') || IDENT.includes(c.ord));
  const vals = rowsFor(key, SITES.indexOf(site), 1).rows[0]!.values;
  return cols.map((c) => {
    const base = { ord: c.ord, letter: c.letter, header: c.header, kind: c.source_kind, note: c.source_note ?? null, value: vals[String(c.ord)] ?? null, hidden: false, origin: null as string | null };
    if (c.ord === 1) return { ...base, origin: 'calculated' };
    if (c.ord === 2) return { ...base, value: site.code, field: 'site_code', origin: 'manual' };
    if (c.ord === 78) return { ...base, field: 'valid_from', register_key: 'permits_hse', record_id: 'b0000000-0000-4000-8000-000000000078', record_version: 2, origin: 'approved_record' };
    if (c.ord === 170) return { ...base, hidden: true, register_key: 'dismantle' };
    if (c.ord === 23) return { ...base, value: '2026-02-01', task_id: 'c0000000-0000-4000-8000-000000000023', task_code: 'MS1', task_name_en: 'Site Release', task_name_ar: 'تحرير الموقع', field: 'actual_date', origin: 'workflow' };
    if (base.value !== null && c.source_kind === 'site') return { ...base, origin: 'manual' };
    return base;
  });
}

export const site360Handlers = [
  // 0.15.35 (P1 Master): the source of every Master cell of one synthetic site
  http.get(`${API_BASE}/site360/sites/:siteId/sources`, ({ params, request }) => {
    const site = SITES.find((x) => x.id === params.siteId);
    if (!site) return HttpResponse.json({ type: 'about:blank', title: 'Not found', status: 404, code: 'not_found' }, { status: 404 });
    const key = new URL(request.url).searchParams.get('menu') ?? 'master';
    return HttpResponse.json({ site_id: site.id, site_code: site.code, menu: key, cells: sourcesFor(site, key) });
  }),
  http.get(`${API_BASE}/site360/sections`, () =>
    HttpResponse.json({ items: MENUS.map(([k, en, ar]) => menu(k, en, ar)), can_move: false })),
  http.get(`${API_BASE}/site360/:menu/rows`, ({ params, request }) => {
    const url = new URL(request.url);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    return HttpResponse.json(rowsFor(String(params.menu), offset, limit, batchesOf(url.searchParams.get('filter'))));
  }),
];
