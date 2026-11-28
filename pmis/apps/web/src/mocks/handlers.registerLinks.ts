import { http, HttpResponse } from 'msw';
import { API_BASE as B } from '@/api/client';
import type { RegisterLinkEntry } from '@/api/registerLinks';
import { viewer } from './db';
import { guard, problem } from './handlers';

/** Contract 0.15.584: the link catalogue, as register_link_catalogue and admin_register_link_catalogue_save of migration 0713 decide it. Synthetic: a few declared links; nothing is removed. */
const SEED: RegisterLinkEntry[] = [
  { from_register: 'warehouse', field: 'procurement_order_id', to_register: 'procurement', target_state: 'approved', target_record_type: null, enforce: false, same_site: true, enabled: true },
  { from_register: 'issues', field: 'risk_entity_id', to_register: 'risks', target_state: 'approved', target_record_type: null, enforce: false, same_site: false, enabled: true },
  { from_register: 'dismantle', field: 'closing_rn_id', to_register: 'warehouse', target_state: 'approved', target_record_type: null, enforce: false, same_site: false, enabled: false },
];
let links: RegisterLinkEntry[] = SEED.map((l) => ({ ...l }));
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
    const b = (await request.json()) as { links?: RegisterLinkEntry[]; reason?: string };
    if ((b.reason ?? '').trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required' }] });
    const next = b.links ?? [];
    if (links.some((o) => !next.some((n) => n.from_register === o.from_register && n.field === o.field))) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/links', code: 'no_delete' }] });
    links = next.map((n) => {
      const o = links.find((x) => x.from_register === n.from_register && x.field === n.field);
      return { target_state: 'approved', target_record_type: null, ...o, ...n, to_register: o?.to_register ?? n.to_register };
    });
    version += 1;
    return HttpResponse.json({ links, version, can_edit: true }, { headers: { ETag: `"${version}"` } });
  }),
];
