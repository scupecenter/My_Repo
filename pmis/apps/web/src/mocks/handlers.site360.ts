import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';

/**
 * Synthetic SITE 360 menus (contract 0.15.21). A small subset of the 187 Master columns, with the same sections as the
 * API's defaults, so the grid can be tested. The real columns come from master_columns.
 */
type Col = { ord: number; letter: string; group_top: string | null; group_mid: string | null; header: string; sections: string[] };
const COLS: Col[] = [
  { ord: 1, letter: 'A', group_top: '#', group_mid: null, header: '#', sections: ['design_acq'] },
  { ord: 2, letter: 'B', group_top: 'RF & DESIGN', group_mid: 'Identification', header: 'Site ID', sections: ['design_acq'] },
  { ord: 4, letter: 'D', group_top: 'RF & DESIGN', group_mid: 'Identification', header: 'Site Name', sections: ['design_acq'] },
  { ord: 5, letter: 'E', group_top: 'RF & DESIGN', group_mid: 'Identification', header: 'Region', sections: ['design_acq'] },
  { ord: 23, letter: 'W', group_top: 'Phase Gate', group_mid: 'Pre-CW Readiness', header: 'Pre-CW Readiness', sections: ['cw'] },
  { ord: 24, letter: 'X', group_top: 'PRE-CW', group_mid: 'Project', header: 'Project Phase', sections: ['sow'] },
  { ord: 33, letter: 'AG', group_top: 'PRE-CW', group_mid: 'CW Procurement', header: 'CW Delivery Model', sections: ['cw'] },
  { ord: 78, letter: 'BZ', group_top: 'TE INSTALLATION', group_mid: 'TE Access', header: 'TE Access Date', sections: ['te'] },
  { ord: 144, letter: 'EN', group_top: 'CLUSTER OPTIMIZATION', group_mid: 'Cluster', header: 'Cluster ID', sections: ['hoto'] },
  { ord: 157, letter: 'FA', group_top: 'FINAL CLOSURE', group_mid: 'CW DLP / FAC', header: 'CW DLP Start Date', sections: ['om'] },
  { ord: 170, letter: 'FN', group_top: 'DISMANTLE', group_mid: 'CW Dismantle (RN)', header: 'Site CW RFD', sections: ['dismantle'] },
  { ord: 180, letter: 'FX', group_top: 'Progress', group_mid: null, header: 'Current Milestone', sections: ['status'] },
  { ord: 187, letter: 'GE', group_top: 'Issue & Remark', group_mid: null, header: 'Remark', sections: ['status'] },
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
  { id: 'a0000000-0000-4000-8000-000000000001', code: 'S360-001', name: 'Synthetic site one', region: 'Tripoli', milestone: 'Site Release', status: 'in_progress', phase: 'Phase 1', model: 'outsourced' },
  { id: 'a0000000-0000-4000-8000-000000000002', code: 'S360-002', name: 'Synthetic site two', region: 'Middle', milestone: 'CW Completion', status: 'on_hold', phase: 'Phase 2', model: 'internal' },
  { id: 'a0000000-0000-4000-8000-000000000003', code: 'S360-003', name: '', region: 'Zawia', milestone: null, status: 'completed', phase: 'Phase 2', model: 'outsourced' },
];

function rowsFor(key: string, offset: number, limit: number) {
  const cols = COLS.filter((c) => key === 'master' || c.sections.includes(key) || c.sections.includes('status') || IDENT.includes(c.ord));
  const page = SITES.slice(offset, offset + limit);
  const values = (site: (typeof SITES)[number]) => {
    const v: Record<string, string | null> = {};
    for (const c of cols) v[String(c.ord)] = null;
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
    filtered: SITES.length,
    offset,
    limit,
    rows: page.map((site, i) => ({ site_id: site.id, site_code: site.code, row_no: offset + i + 1, values: values(site) })),
    menu: { key, name_en: key, name_ar: key, columns: cols.map((c) => ({ ...c, is_phase_gate: c.group_top === 'Phase Gate' })), bands: menu(key, key, key).bands, frozen_ords: IDENT },
  };
}

export const site360Handlers = [
  http.get(`${API_BASE}/site360/sections`, () =>
    HttpResponse.json({ items: MENUS.map(([k, en, ar]) => menu(k, en, ar)), can_move: false })),
  http.get(`${API_BASE}/site360/:menu/rows`, ({ params, request }) => {
    const url = new URL(request.url);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    return HttpResponse.json(rowsFor(String(params.menu), offset, limit));
  }),
];
