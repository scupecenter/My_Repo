import { http, HttpResponse } from 'msw';
import { API_BASE as B } from '@/api/client';
import type { RegisterLink } from '@/api/registerLinks';
import { viewer } from './db';
import { guard, problem } from './handlers';

/** Contract 0.15.332: the link catalogue, as register_links_json and admin_register_links_save of migration 0431 decide it. Synthetic: a few built-in links; nothing is removed. */
const SEED: RegisterLink[] = [
  { from_register: 'warehouse', field: 'procurement_order_id', to_register: 'procurement', picker: 'order', validate: true, same_site: false, approved_only: true, enabled: true, builtin: true },
  { from_register: 'issues', field: 'risk_entity_id', to_register: 'risks', picker: 'record', validate: true, same_site: false, approved_only: false, enabled: true, builtin: true },
  { from_register: 'incidents', field: 'issue_entity_id', to_register: 'issues', picker: 'record', validate: true, same_site: false, approved_only: false, enabled: false, builtin: false },
];
let links: RegisterLink[] = SEED.map((l) => ({ ...l }));
let version = 1;
export const resetRegisterLinks = () => { links = SEED.map((l) => ({ ...l })); version = 1; };
const isAdmin = () => viewer()?.key === 'pm';

export const registerLinksHandlers = [
  http.get(`${B}/settings/register-links`, () => {
    const g = guard();
    if (g) return g;
    return HttpResponse.json({ links, version, can_edit: isAdmin() }, { headers: { ETag: `"${version}"` } });
  }),
  http.put(`${B}/settings/register-links`, async ({ request }) => {
    const g = guard();
    if (g) return g;
    if (!isAdmin()) return problem(403, 'action_forbidden', 'You are not allowed to do this.');
    const b = (await request.json()) as { links?: RegisterLink[]; reason?: string };
    if ((b.reason ?? '').trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required' }] });
    const next = b.links ?? [];
    if (links.some((o) => !next.some((n) => n.from_register === o.from_register && n.field === o.field))) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/links', code: 'no_delete' }] });
    links = next.map((n) => ({ ...n, builtin: links.find((o) => o.from_register === n.from_register && o.field === n.field)?.builtin ?? false }));
    version += 1;
    return HttpResponse.json({ links, version, can_edit: true }, { headers: { ETag: `"${version}"` } });
  }),
  http.get(`${B}/registers/:key/link-options`, ({ params, request }) => {
    const g = guard();
    if (g) return g;
    const field = new URL(request.url).searchParams.get('field');
    const l = links.find((x) => x.from_register === params.key && x.field === field && x.enabled !== false);
    if (!l) return HttpResponse.json({ items: [] });
    return HttpResponse.json({ items: [{ entity_id: '22222222-2222-4222-8222-222222222222', title: `${l.to_register} sample`, state: 'approved' }] });
  }),
];
