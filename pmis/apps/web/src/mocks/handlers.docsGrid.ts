// MSW handlers for the documents grid (contract 0.15.14, migration 0097). Synthetic sites and columns; the statuses follow a fixed pattern so tests are stable.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';

const B = API_BASE;
const COLUMNS = [
  { doc_code: 'A2', name_en: 'A2 TSSR', name_ar: 'A2 تقرير المسح', kind: 'scanned_document', generated: false, group_key: 'stage:MS1', group_label: 'Stage MS1' },
  { doc_code: 'B1', name_en: 'B1 PR email', name_ar: 'B1 بريد طلب الشراء', kind: 'email', generated: false, group_key: 'stage:MS2', group_label: 'Stage MS2' },
  { doc_code: 'B7_DN', name_en: 'B7 CW DN', name_ar: 'B7 إشعار التسليم', kind: 'generated_form', generated: true, group_key: 'stage:MS2', group_label: 'Stage MS2' },
];
const STATUS_AT = ['approved', 'pending', 'missing', 'expired', 'not_required', 'blocked', 'generatable', 'not_applicable', 'rejected', 'missing'] as const;
const SITES = Array.from({ length: 40 }, (_, i) => ({ id: `50000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, site_code: `GRD-${String(i + 1).padStart(3, '0')}`, name: `Grid site ${i + 1}`, region_id: (i % 7) + 1 }));

export function gridCell(siteIdx: number, colIdx: number) {
  const status = STATUS_AT[(siteIdx * 3 + colIdx) % STATUS_AT.length]!;
  const reason = status === 'not_required' ? 'Not needed for this site' : status === 'blocked' ? 'Task B6 is locked' : null;
  return { status, reason, slots: status === 'not_applicable' ? 0 : 1, files: status === 'approved' || status === 'pending' ? 1 : 0 };
}

export const docsGridHandlers = [
  http.get(`${B}/documents/grid`, ({ request }) => {
    const u = new URL(request.url);
    const codes = (u.searchParams.get('site_code') ?? '').split(/[\s,;]+/).filter(Boolean);
    const status = u.searchParams.get('status');
    const docs = u.searchParams.getAll('doc_code');
    const columns = COLUMNS.filter((c) => docs.length === 0 || docs.includes(c.doc_code));
    const rows = SITES.map((s, i) => ({ site_id: s.id, site_code: s.site_code, site_name: s.name, region_id: s.region_id, download_allowed: s.region_id !== 7,
      cells: Object.fromEntries(columns.map((c, k) => [c.doc_code, gridCell(i, COLUMNS.indexOf(c) === -1 ? k : COLUMNS.indexOf(c))])) }))
      .filter((r) => codes.length === 0 || codes.includes(r.site_code))
      .filter((r) => !status || Object.values(r.cells).some((c) => c.status === status));
    return HttpResponse.json({ columns, rows: rows.slice(0, 50), page: { limit: 50, next_cursor: null } });
  }),
  http.get(`${B}/documents/grid/view`, () => HttpResponse.json({ columns: ['A2', 'B1'] })),
  http.put(`${B}/documents/grid/view`, () => new HttpResponse(null, { status: 204 })),
  http.post(`${B}/sites/:siteId/document-overrides`, () => HttpResponse.json({ id: '90000000-0000-4000-8000-000000000001', slots_changed: 1 }, { status: 201 })),
];
