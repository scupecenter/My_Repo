// MSW handlers of P10 (contract 0.12.12, owner answers Q115 and Q117): saved views on the server and the caller's drafts. They behave like the
// real API where the screens care: a private view is only the owner's (another account gets 404), sharing needs views.share (the PM and the
// Team Lead accounts here), only the owner or views.manage (the PM) changes a shared view, every change bumps the version (If-Match), and a
// view is deactivated, never deleted. The state is per mock database, so resetDb() starts it again.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { Draft, SavedView, SavedViewAudience } from '@/api/views';
import { db, viewer, type Db } from './db';
import { guard, problem } from './handlers';
import { uid } from './ids';

const B = API_BASE;
type Row = SavedView & { owner_key: string; audience_in: SavedViewAudience };
type State = { views: Row[]; drafts: Map<string, Draft & { owner: string; payload: Record<string, unknown> }> };
const states = new WeakMap<Db, State>();
const omit = <T extends object>(o: T, ...keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const S = (): State => {
  const d = db();
  let s = states.get(d);
  if (!s) { s = { views: [], drafts: new Map() }; states.set(d, s); }
  return s;
};
const me = () => viewer()!;
const shareScope = (): 'none' | 'limited' | 'all' => (['pm', 'reviewer'].includes(me().key) ? 'all' : 'none');
const isManager = () => me().key === 'pm';
const nonEmpty = (a?: SavedViewAudience) => !!a && (!!a.everyone || !!a.role_ids?.length || !!a.group_ids?.length || !!a.user_ids?.length);
const myId = () => uid(me().employee_id ?? '9999');
const now = () => new Date().toISOString();
const invalid = (path: string, code = 'invalid') => problem(422, 'validation_failed', 'Validation failed', { errors: [{ path, code, message: code }] });

/** Shared views reach everyone in the mock when `everyone` is set, or the accounts named by id. */
const addressed = (v: Row) => v.audience_in.everyone || (v.audience_in.user_ids ?? []).includes(myId());
const canRead = (v: Row) => v.owner_key === me().key || (v.is_active && v.shared && addressed(v));
const out = (v: Row): SavedView => {
  const mine = v.owner_key === me().key, mgr = v.shared && isManager();
  const a = v.audience_in, rest = omit(v, 'owner_key', 'audience_in') as unknown as SavedView;
  return {
    ...rest, is_owner: mine, can_edit: mine || mgr, can_share: (mine && shareScope() !== 'none') || mgr,
    audience: mine || mgr ? { everyone: !!a.everyone, roles: [], groups: [], users: (a.user_ids ?? []).map((id) => ({ id, display_name: id })) } : null,
  };
};
function versionOk(req: Request, v: Row) {
  const h = req.headers.get('If-Match');
  if (!h) return problem(428, 'precondition_required', 'If-Match is required');
  return h.trim() === '*' || Number(h.replace(/"/g, '')) === v.version ? null : problem(412, 'precondition_failed', 'The view changed; reload and retry');
}
const find = (id: string) => S().views.find((v) => v.id === id && canRead(v));
const dupe = (owner: string, screen: string, name: string, not?: string) => S().views.some((x) => x.owner_key === owner && x.screen_key === screen && x.is_active && x.id !== not && x.name.toLowerCase() === name.toLowerCase());

function make(screen: string, b: { name: string; filters?: Record<string, unknown>; columns?: SavedView['columns']; sort?: SavedView['sort']; audience?: SavedViewAudience }, imported = false): Row {
  const v = me();
  return {
    id: crypto.randomUUID(), screen_key: screen, name: b.name.trim(), filters: b.filters ?? {}, columns: b.columns ?? {}, sort: b.sort ?? [], stripped_columns: 0,
    owner: { id: myId(), display_name: v.name, employee_id: v.employee_id ?? null }, owner_left: false, is_owner: true, shared: nonEmpty(b.audience),
    audience: null, can_edit: true, can_share: shareScope() !== 'none', is_active: true, version: 1, imported, created_at: now(), updated_at: now(),
    owner_key: v.key, audience_in: b.audience ?? {},
  };
}

export const viewsHandlers = [
  http.get(`${B}/saved-views`, ({ request }) => {
    const g = guard(); if (g) return g;
    const q = new URL(request.url).searchParams, screen = q.get('screen_key'), inactive = q.get('include_inactive') === 'true';
    const items = S().views.filter((v) => (!screen || v.screen_key === screen) && canRead(v) && (v.is_active || (inactive && v.owner_key === me().key)))
      .sort((a, b) => Number(b.owner_key === me().key) - Number(a.owner_key === me().key) || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
    return HttpResponse.json({ items: items.map(out), can_share: shareScope(), can_manage: isManager() });
  }),
  http.post(`${B}/saved-views/import`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const b = await request.json() as { screen_key: string; items: { local_id: string; name: string; filters?: Record<string, unknown> }[] };
    const done: SavedView[] = [];
    let skipped = 0;
    for (const it of b.items ?? []) {
      const ref = `${b.screen_key}:${it.local_id}`;
      if (S().views.some((x) => x.owner_key === me().key && (x as Row & { ref?: string }).ref === ref)) { skipped++; continue; }
      let name = it.name, n = 1;
      while (dupe(me().key, b.screen_key, name)) { n++; name = `${it.name} (${n})`; }
      const r = Object.assign(make(b.screen_key, { name, filters: it.filters }, true), { ref });
      S().views.push(r);
      done.push(out(r));
    }
    return HttpResponse.json({ imported: done.length, skipped, items: done });
  }),
  http.post(`${B}/saved-views`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const b = await request.json() as { screen_key: string; name: string; audience?: SavedViewAudience };
    if (!b.name?.trim()) return invalid('/name');
    if (nonEmpty(b.audience) && shareScope() === 'none') return problem(403, 'action_forbidden', 'Sharing a view needs views.share');
    if (dupe(me().key, b.screen_key, b.name)) return problem(409, 'duplicate', 'You already have a view with this name');
    const r = make(b.screen_key, b);
    S().views.push(r);
    return HttpResponse.json(out(r), { status: 201, headers: { ETag: `"${r.version}"` } });
  }),
  http.get(`${B}/saved-views/:id`, ({ params }) => {
    const g = guard(); if (g) return g;
    const v = find(String(params.id));
    return v ? HttpResponse.json(out(v), { headers: { ETag: `"${v.version}"` } }) : problem(404, 'not_found', 'Not found');
  }),
  http.patch(`${B}/saved-views/:id`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const v = find(String(params.id));
    if (!v) return problem(404, 'not_found', 'Not found');
    if (!out(v).can_edit) return problem(403, 'action_forbidden', 'Only the owner changes this view');
    const bad = versionOk(request, v); if (bad) return bad;
    if (!v.is_active) return problem(409, 'invalid_transition', 'Restore the view first');
    const b = await request.json() as Partial<Row> & { audience?: SavedViewAudience; reason?: string };
    if (v.owner_key !== me().key && (b.reason ?? '').trim().length < 3) return invalid('/reason', 'required');
    if (b.audience && nonEmpty(b.audience) && shareScope() === 'none' && !isManager()) return problem(403, 'action_forbidden', 'Sharing a view needs views.share');
    if (b.name && dupe(v.owner_key, v.screen_key, b.name, v.id)) return problem(409, 'duplicate', 'Name in use');
    Object.assign(v, { ...(b.name ? { name: b.name.trim() } : {}), ...(b.filters ? { filters: b.filters } : {}), ...(b.columns ? { columns: b.columns } : {}), ...(b.sort ? { sort: b.sort } : {}) });
    if (b.audience) { v.audience_in = b.audience; v.shared = nonEmpty(b.audience); }
    v.version += 1; v.updated_at = now();
    return HttpResponse.json(out(v), { headers: { ETag: `"${v.version}"` } });
  }),
  ...(['deactivate', 'restore'] as const).map((op) => http.post(`${B}/saved-views/:id/${op}`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const v = S().views.find((x) => x.id === String(params.id) && (x.owner_key === me().key || (x.shared && isManager())));
    if (!v) return problem(404, 'not_found', 'Not found');
    const bad = versionOk(request, v); if (bad) return bad;
    if (v.is_active === (op === 'restore')) return problem(409, 'invalid_transition', 'Nothing to change');
    v.is_active = op === 'restore'; v.version += 1; v.updated_at = now();
    return HttpResponse.json(out(v), { headers: { ETag: `"${v.version}"` } });
  })),
  http.post(`${B}/saved-views/:id/transfer`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const v = find(String(params.id));
    if (!v) return problem(404, 'not_found', 'Not found');
    if (!out(v).can_edit) return problem(403, 'action_forbidden', 'Not allowed');
    const bad = versionOk(request, v); if (bad) return bad;
    if (!v.shared) return problem(409, 'invalid_transition', 'A private view is not handed over');
    const b = await request.json() as { owner_id: string; reason: string };
    if ((b.reason ?? '').trim().length < 3) return invalid('/reason', 'required');
    v.owner = { id: b.owner_id, display_name: b.owner_id }; v.owner_key = `id:${b.owner_id}`; v.owner_left = false; v.version += 1;
    return HttpResponse.json(out(v), { headers: { ETag: `"${v.version}"` } });
  }),
  http.get(`${B}/saved-views/:id/versions`, ({ params }) => {
    const g = guard(); if (g) return g;
    const v = S().views.find((x) => x.id === String(params.id) && x.owner_key === me().key);
    return v ? HttpResponse.json({ items: [{ version: v.version, change: v.version === 1 ? 'create' : 'edit', snapshot: { name: v.name }, reason: null, changed_by: v.owner, changed_at: v.updated_at }] }) : problem(404, 'not_found', 'Not found');
  }),

  // ---- drafts (Q115): the caller's own; never a submission
  http.get(`${B}/me/drafts`, () => {
    const g = guard(); if (g) return g;
    const items = [...S().drafts.values()].filter((d) => d.owner === me().key).map((d) => omit(d, 'owner', 'payload'));
    return HttpResponse.json({ items, retention_days: 30 });
  }),
  http.get(`${B}/me/drafts/:key`, ({ params }) => {
    const g = guard(); if (g) return g;
    const d = S().drafts.get(`${me().key}|${String(params.key)}`);
    if (!d) return problem(404, 'not_found', 'There is no draft');
    return HttpResponse.json(omit(d, 'owner'));
  }),
  http.put(`${B}/me/drafts/:key`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    const key = String(params.key);
    if (!/^(task|record|form)\.[A-Za-z0-9_.-]{1,200}$/.test(key)) return invalid('/draft_key');
    const b = await request.json() as { payload: Record<string, unknown>; base_version?: number | null };
    const k = `${me().key}|${key}`, cur = S().drafts.get(k);
    if (cur && b.base_version != null && b.base_version !== cur.version) return problem(412, 'precondition_failed', 'This draft was saved from another window');
    const t = now();
    const d = { key, version: (cur?.version ?? 0) + 1, saved_at: t, created_at: cur?.created_at ?? t, expires_at: new Date(Date.now() + 30 * 864e5).toISOString(), owner: me().key, payload: b.payload };
    S().drafts.set(k, d);
    return HttpResponse.json(omit(d, 'owner', 'payload'));
  }),
  http.delete(`${B}/me/drafts/:key`, ({ params }) => {
    const g = guard(); if (g) return g;
    S().drafts.delete(`${me().key}|${String(params.key)}`);
    return new HttpResponse(null, { status: 204 });
  }),
];
