// MSW handlers for global search and the Site ID list lookup (contract 0.15.17, plan F4). Synthetic records only.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';

const B = API_BASE;

interface MockRecord { type: 'sites' | 'registers' | 'documents' | 'meetings' | 'people' | 'contractors'; id: string; title: string; subtitle: string | null; region_id: number | null; href: string }

const RECORDS: MockRecord[] = [
  { type: 'sites', id: '60000000-0000-4000-8000-000000000001', title: 'TR-101 - Tripoli test site one - موقع طرابلس التجريبي الأول', subtitle: null, region_id: 1, href: '/sites/60000000-0000-4000-8000-000000000001' },
  { type: 'sites', id: '60000000-0000-4000-8000-000000000002', title: 'BN-205 - Benghazi test site', subtitle: null, region_id: 5, href: '/sites/60000000-0000-4000-8000-000000000002' },
  { type: 'registers', id: '60000000-0000-4000-8000-000000000003', title: 'PR-TEST-1 synthetic procurement line', subtitle: 'Procurement (PR/PO/WO)', region_id: 1, href: '/registers/procurement' },
  { type: 'documents', id: '60000000-0000-4000-8000-000000000004', title: 'A2_TSSR_TR-101.pdf', subtitle: 'TR-101', region_id: 1, href: '/sites/60000000-0000-4000-8000-000000000001' },
  { type: 'meetings', id: '60000000-0000-4000-8000-000000000005', title: 'Weekly coordination meeting', subtitle: '2026-11-10', region_id: null, href: '/registers/meetings' },
  { type: 'people', id: '60000000-0000-4000-8000-000000000006', title: 'Test Engineer One', subtitle: 'engineer.one@example.test', region_id: null, href: '/admin/users/60000000-0000-4000-8000-000000000006' },
  { type: 'contractors', id: '60000000-0000-4000-8000-000000000007', title: 'Demo Contractor Co', subtitle: 'cw_contractor', region_id: null, href: '/registers/contractors' },
];

/** Lower case, Latin accents and tashkeel removed, alef forms folded: a rough copy of the server rule, enough for the mock. */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ًͯ-ٰٟـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').toLowerCase();

export const searchHandlers = [
  http.get(`${B}/search`, ({ request }) => {
    const u = new URL(request.url);
    const q = (u.searchParams.get('q') ?? '').trim();
    if (q.length < 2) return HttpResponse.json({ type: 'about:blank', title: 'Invalid', status: 422, code: 'validation_failed' }, { status: 422 });
    const limit = Math.min(10, Math.max(1, Number(u.searchParams.get('limit') ?? '5')));
    const types = u.searchParams.getAll('types').flatMap((v) => v.split(',')).filter(Boolean);
    const needle = fold(q);
    const groups = (types.length ? types : ['sites', 'registers', 'documents', 'meetings', 'people', 'contractors']).map((type) => {
      const all = RECORDS.filter((r) => r.type === type && fold(r.title + ' ' + (r.subtitle ?? '')).includes(needle));
      const items = all.slice(0, limit).map((r) => {
        const at = fold(r.title).indexOf(needle);
        return { id: r.id, title: r.title, subtitle: r.subtitle, region_id: r.region_id, href: r.href, match_ranges: at >= 0 ? [[at, at + needle.length]] : [] };
      });
      return { type, total: all.length, truncated: all.length > items.length, items };
    }).filter((g) => g.items.length > 0 || g.total > 0);
    return HttpResponse.json({ q, groups });
  }),
  http.post(`${B}/search/site-ids`, async ({ request }) => {
    const body = (await request.json()) as { ids: string[] };
    const sites = RECORDS.filter((r) => r.type === 'sites');
    const found: { id: string; site_code: string; name: string; region_id: number; href: string }[] = [];
    const notFound: string[] = [];
    for (const id of body.ids) {
      const hit = sites.find((s) => s.title.split(' - ')[0]!.toUpperCase() === id.trim().toUpperCase());
      if (hit) found.push({ id: hit.id, site_code: hit.title.split(' - ')[0]!, name: hit.title.split(' - ')[1]!, region_id: hit.region_id!, href: hit.href });
      else notFound.push(id.trim());
    }
    return HttpResponse.json({ found, not_found: notFound });
  }),
];
