import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import { guard, problem } from './handlers';
import { buildDashboard } from './dashboardData';
import { viewer } from './db';

const B = API_BASE;

/** The mock accounts see every region; the module comes from their navigation list (the real API checks `dashboard.view`). */
const canUse = (): boolean => !!viewer()?.nav.includes('dashboard');

const bad = (q: URLSearchParams) => {
  const ref = q.get('ref_date');
  if (ref && !/^\d{4}-\d{2}-\d{2}$/.test(ref)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/ref_date', code: 'invalid' }] });
  if (q.get('region_id') && !/^[1-7]$/.test(q.get('region_id')!)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/region_id', code: 'invalid' }] });
  return null;
};

// Mock of GET /dashboard (contract 0.7.2). An account without `dashboard` in its navigation gets the module_forbidden answer.
export const dashboardHandlers = [
  http.get(`${B}/dashboard`, ({ request }) => {
    const g = guard(); if (g) return g;
    if (!canUse()) return problem(403, 'module_forbidden', 'You cannot use dashboard');
    const q = new URL(request.url).searchParams;
    return bad(q) ?? HttpResponse.json(buildDashboard(q));
  }),
  http.get(`${B}/dashboard/export`, ({ request }) => {
    const g = guard(); if (g) return g;
    if (!canUse()) return problem(403, 'module_forbidden', 'You cannot use dashboard');
    const q = new URL(request.url).searchParams;
    const d = buildDashboard(q);
    const csv = `${String.fromCharCode(0xfeff)}section,item,metric,value\r\nheadline,sites,active,${d.headline.sites_total}\r\n`;
    return new HttpResponse(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="GSDN_Dashboard_${d.basis.ref_date}.csv"` } });
  }),
];
