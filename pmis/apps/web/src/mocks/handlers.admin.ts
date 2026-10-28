// MSW handlers for phase 3a: users and roles, groups, delegation, absence and cover, exports. Synthetic data only.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { Assignment, UserDetail } from '@/api/types';
import { absentOn, accountKeyOf, accountStatus, cred, db, save, slotsOf, STAFF, stepUpValid, toSummary, viewer, type MockTask } from './db';
import { PROFILES, type MockUser } from './adminData';
import { O } from './orgState';
import { find, guard, page, problem, stepUp, transition } from './handlers';
import { byId, uid } from './ids';

const B = API_BASE;
const TODAY = '2026-10-25';
const A = () => db().admin;
const ref = (e: string) => ({ id: uid(e), display_name: byId(e).name_en, employee_id: e });
const eOf = (id: string) => STAFF.find((s) => uid(s.employee_id) === id)?.employee_id;
const isLead = () => viewer()?.key === 'pm';
const needAdmin = () => guard() ?? (isLead() ? null : problem(403, 'action_forbidden', 'Administrators only'));
const bad = (path: string, code: string, title = 'Validation failed') => problem(422, 'validation_failed', title, { errors: [{ path, code }] });
const noReason = (b: { reason?: string }) => ((b.reason ?? '').trim().length < 3 ? bad('/reason', 'required', 'A reason is required') : null);
const tag = (n: number) => ({ headers: { ETag: `"${n}"` } });
const now = () => new Date().toISOString();

/** Name, email and phone of an admin-list user: the registry row, or the data typed when a local user was created. */
const prof = (u: MockUser) => (u.local ? { name_en: u.local.display_name, name_ar: u.local.display_name, email: u.local.email, phone: u.local.phone } : byId(u.employee_id));
export const uref = (u: MockUser) => (u.local ? { id: u.local.id, display_name: u.local.display_name, ...(u.employee_id ? { employee_id: u.employee_id } : {}) } : ref(u.employee_id));
/** Direct manager and department of a user (0.4.0). */
export const orgOf = (u: MockUser) => {
  const id = uref(u).id, o = O(), mgr = o.managers[id] ? A().users.find((x) => uref(x).id === o.managers[id]) : undefined, d = o.departments.find((x) => x.id === o.deptOf[id]);
  return { manager: mgr ? uref(mgr) : null, department: d ? { id: d.id, code: d.code, name_en: d.name_en, name_ar: d.name_ar } : null };
};
export const userOf = (u: MockUser) => {
  const s = prof(u), c = cred(accountKeyOf(u));
  return {
    ...uref(u), ...orgOf(u), email: s.email, phone: s.phone ?? null, local_sign_in: !!c?.enabled, must_change_password: !!c?.must_change, status: u.status, locale: 'en' as const, mfa_exempt: u.mfa.exempt, mfa_exempt_until: u.mfa.until, last_login_at: '2026-10-24T07:00:00Z', created_at: '2026-09-01T08:00:00Z', version: u.version,
  };
};
const rowsOf = (e: string, ended = false) => A().assignments.filter((a) => a.user.employee_id === e && (ended || a.is_active_now));
export const detail = (u: MockUser): UserDetail => ({
  ...userOf(u), assignments: rowsOf(u.employee_id, true),
  groups: A().groups.filter((g) => g.members.includes(u.employee_id)).map((g) => ({ id: g.id, name: g.name, is_system_admins: g.is_system_admins })), teams: [...new Set(rowsOf(u.employee_id).map((a) => a.team ?? 'none'))],
}) as UserDetail;
const roleOf = (id: string) => A().roles.find((r) => r.id === id);
export const userBy = (id: string) => A().users.find((u) => (u.local ? u.local.id : uid(u.employee_id)) === id);
const tasksAll = () => [...db().tasks, ...db().extra, ...Object.values(db().ov)];
const heldBy = (t: MockTask, e: string) => toSummary(t).ball_in_court?.holders.some((h) => h.employee_id === e);
const emptyBulk = () => ({ bulk_action_id: crypto.randomUUID(), done: [] as { id: string; created_id?: string }[], skipped: [] as { ref: string; code: string; message?: string }[], failed: [] as { ref: string; code: string; message?: string }[] });

export const adminHandlers = [
  // ------------------------------------------------------------------ users
  http.get(`${B}/users`, ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const u = new URL(request.url).searchParams, q = (u.get('q') ?? '').toLowerCase(), st = u.get('status'), role = u.get('role_id'), grp = u.get('group_id');
    const items = A().users.filter((x) => {
      const s = prof(x);
      return (!q || `${s.name_en} ${s.name_ar} ${s.email} ${x.employee_id}`.toLowerCase().includes(q)) && (!st || x.status === st)
        && (!role || rowsOf(x.employee_id).some((a) => a.role.id === role)) && (!grp || A().groups.find((y) => y.id === grp)?.members.includes(x.employee_id));
    });
    return page(items.map(userOf));
  }),
  http.get(`${B}/users/deleted`, ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const q = (new URL(request.url).searchParams.get('q') ?? '').toLowerCase();
    return page(A().deleted.filter((d) => `${d.name_en} ${d.email} ${d.employee_id}`.toLowerCase().includes(q)).map(deletedBody));
  }),
  http.get(`${B}/users/:id`, ({ params }) => {
    const g = needAdmin(); if (g) return g;
    const u = userBy(params.id as string);
    return u ? HttpResponse.json(detail(u), tag(u.version)) : problem(404, 'not_found', 'User not found');
  }),
  http.patch(`${B}/users/:id`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const u = userBy(params.id as string);
    if (!u) return problem(404, 'not_found', 'User not found');
    const b = (await request.json()) as { status?: MockUser['status']; reason?: string };
    const r = noReason(b); if (r) return r;
    if ((b.status === 'suspended' || b.status === 'disabled') && u.employee_id === viewer()!.employee_id) return problem(403, 'self_beneficiary', 'Not for your own account');
    if ((b.status === 'suspended' || b.status === 'disabled') && lastAdmin(u)) return problem(409, 'last_admin', 'At least one active admin must remain');
    if (b.status) { u.status = b.status; if (b.status !== 'active') endSessions(u.employee_id); }
    u.version += 1; save();
    return HttpResponse.json(detail(u), tag(u.version));
  }),
  http.post(`${B}/users/:id/delete`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const u = userBy(params.id as string);
    if (!u) return problem(404, 'not_found', 'User not found');
    if (u.employee_id === viewer()!.employee_id) return problem(403, 'self_beneficiary', 'Not for your own account');
    if (!stepUpValid()) return stepUp();
    const b = (await request.json()) as { reason?: string };
    const r = noReason(b); if (r) return r;
    if (lastAdmin(u)) return problem(409, 'last_admin', 'At least one active admin must remain');
    const row = { employee_id: u.employee_id, name_en: byId(u.employee_id).name_en, email: byId(u.employee_id).email, status: u.status, deleted_at: now(), deleted_by: viewer()!.employee_id!, reason: b.reason!.trim(), version: u.version + 1 };
    A().deleted.unshift(row); A().users = A().users.filter((x) => x !== u); endSessions(u.employee_id); save();
    return HttpResponse.json(deletedBody(row));
  }),
  http.post(`${B}/users/:id/restore`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const d = A().deleted.find((x) => uid(x.employee_id) === params.id);
    if (!d) return problem(404, 'not_found', 'Deleted user not found');
    if (!stepUpValid()) return stepUp();
    const r = noReason((await request.json()) as { reason?: string }); if (r) return r;
    const why = blocked(d);
    if (why) return problem(409, 'duplicate', 'Cannot restore', { errors: [{ path: why.path, code: 'duplicate' }] });
    const u = { employee_id: d.employee_id, status: 'active' as const, version: d.version + 1, mfa: { exempt: false, until: null, reason: null, by: null } };
    A().users.push(u); A().deleted = A().deleted.filter((x) => x !== d); save();
    return HttpResponse.json(detail(u), tag(u.version));
  }),
  http.get(`${B}/users/:id/assignments`, ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const e = eOf(params.id as string) ?? (userBy(params.id as string)?.local ? '' : undefined);
    return e !== undefined ? HttpResponse.json({ items: rowsOf(e, new URL(request.url).searchParams.get('include_ended') === 'true') }) : problem(404, 'not_found', 'User not found');
  }),

  // ------------------------------------------------------------------ assignments
  http.get(`${B}/assignments`, ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const u = new URL(request.url).searchParams, role = u.get('role_id'), user = u.get('user_id');
    return page(A().assignments.filter((a) => a.is_active_now && (!role || a.role.id === role) && (!user || a.user.id === user)));
  }),
  http.post(`${B}/assignments/bulk-assign`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const b = (await request.json()) as { user_ids: string[]; role_ids: string[]; defaults: Partial<Assignment>; reason?: string; dry_run?: boolean };
    const r = noReason(b); if (r) return r;
    if (!b.user_ids?.length || !b.role_ids?.length || !b.defaults?.permission_level) return bad('/user_ids', 'required');
    const out = { ...emptyBulk(), dry_run: !!b.dry_run };
    for (const uidv of b.user_ids) for (const rid of b.role_ids) {
      const u = userBy(uidv), role = roleOf(rid), key = `${uidv}:${rid}`;
      if (!u || !role) { out.failed.push({ ref: key, code: 'not_found' }); continue; }
      if (rowsOf(u.employee_id).some((a) => a.role.id === rid)) { out.skipped.push({ ref: key, code: 'already_assigned', message: 'Already holds this role' }); continue; }
      const row = {
        id: crypto.randomUUID(), user: uref(u), role: { id: role.id, code: role.code, name_en: role.name_en, name_ar: role.name_ar }, permission_level: b.defaults.permission_level, team: b.defaults.team ?? 'none',
        region_ids: b.defaults.region_ids ?? role.default_region_ids ?? 'all', module_keys: b.defaults.module_keys ?? role.default_module_keys ?? 'all', profile_ids: b.defaults.profile_ids ?? [], is_primary: false,
        valid_from: b.defaults.valid_from ?? now(), valid_to: b.defaults.valid_to ?? null, is_active_now: true, assigned_at: now(), version: 1,
      } as Assignment;
      out.done.push({ id: row.id, created_id: row.id });
      if (!b.dry_run) { A().assignments.push(row); if (u.status === 'pending_assignment') { u.status = 'active'; u.version += 1; } }
    }
    save();
    return HttpResponse.json(out);
  }),
  http.post(`${B}/assignments/bulk-update`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const b = (await request.json()) as { items: { id: string; version: number }[]; patch: Partial<Assignment>; reason?: string; dry_run?: boolean };
    const r = noReason(b); if (r) return r;
    const out = { ...emptyBulk(), dry_run: !!b.dry_run };
    for (const it of b.items) {
      const a = A().assignments.find((x) => x.id === it.id);
      if (!a) out.failed.push({ ref: it.id, code: 'not_found' });
      else if (a.version !== it.version) out.failed.push({ ref: it.id, code: 'precondition_failed', message: 'Changed by someone else' });
      else { out.done.push({ id: a.id }); if (!b.dry_run) { Object.assign(a, b.patch, { version: a.version + 1 }); } }
    }
    save();
    return HttpResponse.json(out);
  }),
  http.post(`${B}/assignments/bulk-end`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const b = (await request.json()) as { items: { id: string; version: number }[]; valid_to?: string; reason?: string; dry_run?: boolean };
    const r = noReason(b); if (r) return r;
    const out = { ...emptyBulk(), dry_run: !!b.dry_run };
    for (const it of b.items) {
      const a = A().assignments.find((x) => x.id === it.id);
      if (!a) { out.failed.push({ ref: it.id, code: 'not_found' }); continue; }
      if (a.version !== it.version) { out.failed.push({ ref: it.id, code: 'precondition_failed' }); continue; }
      // The last System Admin cannot lose the only admin seat.
      if (a.permission_level === 'admin' && A().assignments.filter((x) => x.is_active_now && x.permission_level === 'admin').length < 2) { out.failed.push({ ref: it.id, code: 'last_admin', message: 'At least one active admin must remain' }); continue; }
      out.done.push({ id: a.id });
      if (!b.dry_run) Object.assign(a, { valid_to: b.valid_to ?? now(), is_active_now: false, version: a.version + 1 });
    }
    save();
    return HttpResponse.json(out);
  }),
  http.post(`${B}/assignments/copy`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const b = (await request.json()) as { from_user_id: string; to_user_ids: string[]; mode: 'add' | 'replace'; reason?: string; dry_run?: boolean };
    const r = noReason(b); if (r) return r;
    const from = userBy(b.from_user_id);
    if (!from || !b.to_user_ids?.length) return bad('/to_user_ids', 'required');
    const out = { ...emptyBulk(), dry_run: !!b.dry_run };
    for (const tid of b.to_user_ids) {
      const to = userBy(tid);
      if (!to || to === from) { out.failed.push({ ref: tid, code: 'not_found' }); continue; }
      for (const src of rowsOf(from.employee_id)) {
        if (rowsOf(to.employee_id).some((a) => a.role.id === src.role.id)) { out.skipped.push({ ref: `${tid}:${src.role.id}`, code: 'already_assigned' }); continue; }
        const row = { ...src, id: crypto.randomUUID(), user: ref(to.employee_id), version: 1, assigned_at: now() } as Assignment;
        out.done.push({ id: row.id, created_id: row.id });
        if (!b.dry_run) { A().assignments.push(row); if (to.status === 'pending_assignment') { to.status = 'active'; to.version += 1; } }
      }
    }
    save();
    return HttpResponse.json(out);
  }),
  http.get(`${B}/permission-profiles`, () => (viewer() ? HttpResponse.json({ items: PROFILES }) : problem(401, 'unauthenticated', 'Sign in required'))),

  // ------------------------------------------------------------------ MFA exemption
  http.get(`${B}/users/:id/mfa-exemption`, ({ params }) => {
    const g = needAdmin(); if (g) return g;
    const u = userBy(params.id as string);
    if (!u) return problem(404, 'not_found', 'User not found');
    return HttpResponse.json({ user: uref(u), exempt: u.mfa.exempt, until: u.mfa.until, reason: u.mfa.reason, granted_by: u.mfa.by ? ref(u.mfa.by) : undefined });
  }),
  http.put(`${B}/users/:id/mfa-exemption`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const u = userBy(params.id as string);
    if (!u) return problem(404, 'not_found', 'User not found');
    if (u.employee_id === viewer()!.employee_id) return problem(403, 'self_beneficiary', 'Nobody can exempt themselves');
    if (!stepUpValid()) return stepUp();
    const b = (await request.json()) as { reason?: string; until?: string | null };
    const r = noReason(b); if (r) return r;
    if (b.until && Date.parse(b.until) <= Date.now()) return bad('/until', 'must_be_future');
    u.mfa = { exempt: true, until: b.until ?? null, reason: b.reason!.trim(), by: viewer()!.employee_id }; save();
    return HttpResponse.json({ user: uref(u), exempt: true, until: u.mfa.until, reason: u.mfa.reason, granted_by: ref(u.mfa.by!), granted_at: now() });
  }),
  http.post(`${B}/users/:id/mfa-exemption/revoke`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const u = userBy(params.id as string);
    if (!u) return problem(404, 'not_found', 'User not found');
    if (!stepUpValid()) return stepUp();
    const r = noReason((await request.json()) as { reason?: string }); if (r) return r;
    u.mfa = { exempt: false, until: null, reason: null, by: null }; save();
    return HttpResponse.json({ user: uref(u), exempt: false, until: null, reason: null });
  }),

  // ------------------------------------------------------------------ roles
  http.get(`${B}/roles`, ({ request }) => {
    if (!viewer()) return problem(401, 'unauthenticated', 'Sign in required');
    const inactive = new URL(request.url).searchParams.get('include_inactive') === 'true';
    return HttpResponse.json({ items: A().roles.filter((r) => inactive || r.is_active).map((r) => ({ ...r, active_assignment_count: A().assignments.filter((a) => a.is_active_now && a.role.id === r.id).length })) });
  }),
  http.post(`${B}/roles`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const b = (await request.json()) as { code: string; name_en: string; name_ar?: string; can_hold_matrix_levels: boolean; description_en?: string; reason?: string };
    const r = noReason(b); if (r) return r;
    if (!/^[A-Z][A-Z0-9_]{1,40}$/.test(b.code ?? '')) return bad('/code', 'pattern');
    if ((b.name_en ?? '').trim().length < 2) return bad('/name_en', 'min_length');
    if (A().roles.some((x) => x.code.toUpperCase() === b.code)) return problem(409, 'duplicate', 'A role with this code exists');
    const role = { id: crypto.randomUUID(), code: b.code, name_en: b.name_en, name_ar: b.name_ar ?? null, description_en: b.description_en ?? null, can_hold_matrix_levels: !!b.can_hold_matrix_levels, is_active: true, active_assignment_count: 0, version: 1 } as never;
    A().roles.push(role); save();
    return HttpResponse.json(role, { status: 201, ...tag(1) });
  }),
  http.patch(`${B}/roles/:id`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const role = roleOf(params.id as string);
    if (!role) return problem(404, 'not_found', 'Role not found');
    if (request.headers.get('If-Match') !== `"${role.version ?? 1}"`) return problem(412, 'precondition_failed', 'The role changed; reload and retry');
    const { reason, ...patch } = (await request.json()) as { reason?: string; is_active?: boolean };
    const r = noReason({ reason }); if (r) return r;
    if (patch.is_active === false && A().assignments.some((a) => a.is_active_now && a.role.id === role.id)) return problem(409, 'role_in_use', 'The role is assigned to people');
    Object.assign(role, patch, { version: (role.version ?? 1) + 1 }); save();
    return HttpResponse.json(role, tag(role.version ?? 1));
  }),

  // ------------------------------------------------------------------ groups
  http.get(`${B}/groups`, ({ request }) => {
    if (!viewer()) return problem(401, 'unauthenticated', 'Sign in required');
    const q = (new URL(request.url).searchParams.get('q') ?? '').toLowerCase();
    return page(A().groups.filter((x) => x.name.toLowerCase().includes(q)).map((x) => ({ ...x, member_count: x.members.length })));
  }),
  http.post(`${B}/groups`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const b = (await request.json()) as { name: string; member_ids?: string[]; reason?: string };
    const r = noReason(b); if (r) return r;
    if ((b.name ?? '').trim().length < 2) return bad('/name', 'min_length');
    const grp = { id: crypto.randomUUID(), name: b.name.trim(), member_count: 0, is_system_admins: false, is_active: true, matrix_cell_count: 0, members: (b.member_ids ?? []).map(eOf).filter(Boolean) as string[] };
    A().groups.push(grp as never); save();
    return HttpResponse.json(groupBody(grp.id), { status: 201, ...tag(1) });
  }),
  http.get(`${B}/groups/:id`, ({ params }) => {
    const g = guard(); if (g) return g;
    const body = groupBody(params.id as string);
    return body ? HttpResponse.json(body, tag(1)) : problem(404, 'not_found', 'Group not found');
  }),
  http.patch(`${B}/groups/:id`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const grp = A().groups.find((x) => x.id === params.id);
    if (!grp) return problem(404, 'not_found', 'Group not found');
    const b = (await request.json()) as { name?: string; is_active?: boolean; reason?: string };
    const r = noReason(b); if (r) return r;
    if (b.name) grp.name = b.name; if (b.is_active !== undefined) grp.is_active = b.is_active; save();
    return HttpResponse.json(groupBody(grp.id), tag(1));
  }),
  http.post(`${B}/groups/:id/members`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const grp = A().groups.find((x) => x.id === params.id);
    if (!grp) return problem(404, 'not_found', 'Group not found');
    const b = (await request.json()) as { user_ids: string[]; reason?: string };
    const r = noReason(b); if (r) return r;
    // Adding yourself to the target group of an active delegation is refused unless you are a System Admin acting without delegation.
    const targeted = A().delegations.some((d) => d.target_kind === 'group' && d.target_id === grp.id && !d.revoked_at);
    if (targeted && (b.user_ids ?? []).includes(uid(viewer()!.employee_id!)) && (!isLead() || db().cfg.actingDelegate)) return problem(403, 'self_beneficiary', 'You cannot add yourself to a group that holds your delegation');
    const out = emptyBulk();
    for (const id of b.user_ids ?? []) {
      const e = eOf(id);
      if (!e) out.failed.push({ ref: id, code: 'not_found' });
      else if (grp.members.includes(e)) out.skipped.push({ ref: id, code: 'duplicate' });
      else { grp.members.push(e); out.done.push({ id }); }
    }
    save();
    return HttpResponse.json(out);
  }),
  http.delete(`${B}/groups/:id/members/:uid`, ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const grp = A().groups.find((x) => x.id === params.id), e = eOf(params.uid as string);
    if (!grp || !e) return problem(404, 'not_found', 'Not found');
    if (((new URL(request.url).searchParams.get('reason')) ?? '').trim().length < 3) return bad('/reason', 'required');
    if (grp.is_system_admins && grp.members.length < 2) return problem(409, 'last_admin', 'At least one active admin must remain');
    grp.members = grp.members.filter((m) => m !== e); save();
    return new HttpResponse(null, { status: 204 });
  }),

  // ------------------------------------------------------------------ delegations (contract: user target only)
  http.get(`${B}/delegations`, ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const st = new URL(request.url).searchParams.get('state') ?? 'active';
    const items = A().delegations.map(delegationBody).filter((d) => st === 'all' || d.state === st);
    return page(items);
  }),
  http.post(`${B}/delegations`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = (await request.json()) as { to_user_id?: string; target_kind?: 'user' | 'role' | 'group'; target_id?: string; scope: 'full' | 'partial'; rights?: string[]; region_codes?: number[]; module_codes?: string[]; allow_redelegate?: boolean; valid_from: string; valid_to?: string | null; reason?: string };
    const kind = b.target_kind ?? 'user', tid = b.target_id ?? b.to_user_id;
    if (!!b.to_user_id === !!b.target_kind) return bad('/target_kind', b.to_user_id ? 'both_targets' : 'target_required');
    if (b.target_kind && !b.target_id) return bad('/target_id', 'required');
    const to = kind === 'user' ? userBy(tid!) : undefined;
    if (to?.employee_id === viewer()!.employee_id) return problem(403, 'self_beneficiary', 'You cannot delegate to yourself');
    if (!stepUpValid()) return stepUp();
    const r = noReason(b); if (r) return r;
    const label = kind === 'user' ? to && byId(to.employee_id).name_en : kind === 'role' ? roleOf(tid!)?.name_en : A().groups.find((x) => x.id === tid)?.name;
    if (!label) return bad(b.target_kind ? '/target_id' : '/to_user_id', 'not_found');
    if (b.scope === 'partial' && !b.rights?.length) return bad('/rights', 'required');
    if (b.valid_to && b.valid_to < b.valid_from) return bad('/valid_to', 'before_valid_from');
    const d = { id: crypto.randomUUID(), from: viewer()!.employee_id!, to: to?.employee_id ?? null, target_kind: kind, target_id: tid!, label, scope: b.scope, rights: b.scope === 'partial' ? b.rights! : [], region_codes: b.region_codes ?? [], module_codes: b.module_codes ?? [], allow_redelegate: !!b.allow_redelegate, valid_from: b.valid_from, valid_to: b.valid_to ?? null, revoked_at: null, reason: b.reason!.trim() };
    A().delegations.push(d); save();
    return HttpResponse.json(delegationBody(d), { status: 201 });
  }),
  http.post(`${B}/delegations/:id/revoke`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const d = A().delegations.find((x) => x.id === params.id);
    if (!d) return problem(404, 'not_found', 'Delegation not found');
    const r = noReason((await request.json()) as { reason?: string }); if (r) return r;
    d.revoked_at = now(); save();
    return HttpResponse.json(delegationBody(d));
  }),

  // ------------------------------------------------------------------ absences and cover
  http.get(`${B}/absences`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams, user = u.get('user_id'), on = u.get('active_on'), kind = u.get('kind');
    const me = viewer()!.employee_id;
    const items = A().absences.filter((a) => (isLead() || a.employee_id === me) && (!user || uid(a.employee_id) === user) && (!kind || a.kind === kind) && (!on || (a.from_date <= on && on <= a.to_date)));
    return page(items.map(absenceBody));
  }),
  http.post(`${B}/absences`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const b = (await request.json()) as { user_id?: string; kind: 'annual' | 'sick' | 'emergency' | 'other'; from_date: string; to_date: string; note?: string };
    const me = viewer()!.employee_id!, e = b.user_id ? eOf(b.user_id) : me;
    if (!e) return bad('/user_id', 'not_found');
    // An employee records only their own annual leave; sick or emergency leave of others needs the lead.
    if (!isLead() && (e !== me || b.kind !== 'annual')) return problem(403, 'action_forbidden', 'Only a lead records this absence');
    if (!b.from_date || !b.to_date || b.to_date < b.from_date) return bad('/to_date', 'before_from_date');
    const row = { id: crypto.randomUUID(), employee_id: e, kind: b.kind, from_date: b.from_date, to_date: b.to_date, note: b.note ?? null, recorded_by: me, version: 1 };
    A().absences.push(row); save();
    return HttpResponse.json(absenceBody(row), { status: 201 });
  }),
  http.delete(`${B}/absences/:id`, ({ params }) => {
    const g = guard(); if (g) return g;
    const i = A().absences.findIndex((a) => a.id === params.id);
    if (i < 0) return problem(404, 'not_found', 'Absence not found');
    if (!isLead() && A().absences[i].employee_id !== viewer()!.employee_id) return problem(403, 'action_forbidden', 'Not yours');
    A().absences.splice(i, 1); save();
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${B}/reassignments/eligible-users`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url).searchParams, q = (u.get('q') ?? '').toLowerCase(), from = u.get('from_user_id'), away = absentOn(TODAY);
    return page(A().users.filter((x) => x.status === 'active' && !away.has(x.employee_id) && (x.local ? x.local.id : uid(x.employee_id)) !== from && prof(x).name_en.toLowerCase().includes(q)).map(uref));
  }),
  http.get(`${B}/reassignments/alerts`, ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isLead()) return problem(403, 'action_forbidden', 'Leads only');
    const u = new URL(request.url).searchParams, cause = u.get('cause'), user = u.get('user_id');
    return page(alerts().filter((a) => (!cause || a.cause === cause) && (!user || a.holder?.id === user)));
  }),
  http.post(`${B}/tasks/reassign`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isLead()) return problem(403, 'action_forbidden', 'Leads only');
    const b = (await request.json()) as { scope: 'task' | 'site' | 'person'; task_id?: string; site_id?: string; from_user_id?: string; decision: 'reassign' | 'act_on_behalf' | 'keep'; to_user_id?: string; reason?: string; dry_run?: boolean };
    const r = noReason(b); if (r) return r;
    const from = b.from_user_id ? eOf(b.from_user_id) : undefined;
    let tasks: MockTask[] = [];
    if (b.scope === 'task') { const t = b.task_id ? find(b.task_id) : undefined; if (!t) return problem(404, 'not_found', 'Task not found'); tasks = [t]; }
    else if (!from) return bad('/from_user_id', 'required');
    else tasks = tasksAll().filter((t) => heldBy(t, from) && t.state !== 'approved' && (b.scope === 'person' || t.site_id === b.site_id));
    let to: string | undefined;
    if (b.decision === 'reassign') {
      to = b.to_user_id ? eOf(b.to_user_id) : undefined;
      if (!to) return bad('/to_user_id', 'required');
      const u = userBy(b.to_user_id!);
      if (!u || u.status !== 'active' || absentOn(TODAY).has(to) || to === from) return problem(422, 'not_eligible_holder', 'This person cannot hold the task');
    }
    const out = { ...emptyBulk(), dry_run: !!b.dry_run };
    for (const t of tasks) {
      out.done.push({ id: t.id });
      if (b.dry_run) continue;
      if (b.decision === 'reassign') { A().reassigned[t.id] = to!; delete A().kept[t.id]; }
      else if (b.decision === 'keep') A().kept[t.id] = now();
      else A().onBehalf[t.id] = viewer()!.employee_id!;
      t.version += 1; // task-level holder change; SLA and stage progress stay untouched (B12b)
    }
    save();
    return HttpResponse.json(out);
  }),

  http.post(`${B}/tasks/:id/act-on-behalf`, async ({ params, request }) => {
    const g = guard(); if (g) return g;
    if (!isLead()) return problem(403, 'action_forbidden', 'Leads only');
    const t = find(params.id as string);
    if (!t) return problem(404, 'not_found', 'Task not found');
    if (!request.headers.get('If-Match')) return problem(428, 'precondition_required', 'If-Match is required');
    if (request.headers.get('If-Match') !== `"${t.version}"`) return problem(412, 'precondition_failed', 'The task changed; reload and retry');
    const b = (await request.json()) as { action?: 'submit' | 'review' | 'approve' | 'reject'; level?: number; reason?: string; note?: string };
    const errs = [...((b.reason ?? '').trim().length < 3 ? [{ path: '/reason', code: 'required' }] : []), ...(!['submit', 'review', 'approve', 'reject'].includes(b.action ?? '') ? [{ path: '/action', code: 'required' }] : [])];
    if (errs.length) return problem(422, 'validation_failed', 'Validation failed', { errors: errs });
    if (b.action === 'reject' && !(b.note ?? '').trim()) return problem(422, 'note_required', 'A rejection needs a note', { errors: [{ path: '/note', code: 'required' }] });
    if (b.level !== (t.current_level ?? 1)) return problem(409, 'invalid_transition', 'The task is at another level');
    const ok = (b.action === 'submit' && (t.state === 'entry' || t.state === 'open')) || (b.action === 'review' && t.state === 'in_review') || (b.action === 'approve' && t.state === 'in_approval') || (b.action === 'reject' && (t.state === 'in_review' || t.state === 'in_approval'));
    if (!ok) return problem(409, 'invalid_transition', 'This action does not fit the task state');
    if (b.action === 'approve' && !stepUpValid()) return stepUp();
    if (b.action === 'submit') { t.state = 'in_review'; t.level_kind = 'review'; t.current_level = 2; t.version += 1; }
    else transition(t, b.action === 'review' ? 'pass' : b.action as 'approve' | 'reject', b.note);
    A().onBehalf[t.id] = viewer()!.employee_id!; save();
    return HttpResponse.json({ task: { ...toSummary(t), approval_path: [], slots: [], allowed_actions: [] }, step_ids: [] }, { headers: { ETag: `"${t.version}"` } });
  }),

  // ------------------------------------------------------------------ exports
  http.get(`${B}/exports/parts`, ({ request }) => {
    const g = guard(); if (g) return g;
    const cols = new URL(request.url).searchParams.get('include_columns') === 'true';
    return HttpResponse.json({ items: PARTS.filter((p) => !denied().includes(p.key)).map((p) => (cols && COLUMNS[p.key] ? { ...p, columns: COLUMNS[p.key].map((code) => ({ code, label_en: code, label_ar: code })) } : p)) });
  }),
  http.post(`${B}/exports/master`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const b = ((await request.json().catch(() => ({}))) ?? {}) as { parts?: string[]; view?: { source: string; filters: object; columns: string[] }; regions?: number[]; as_of?: string };
    if (b.parts?.length && b.view) return bad('/view', 'parts_and_view_exclusive');
    if (b.view && (!b.view.source || !b.view.columns?.length)) return bad('/view/columns', 'required');
    if (b.as_of && b.as_of > TODAY) return bad('/as_of', 'future_date');
    if (b.regions && (!b.regions.length || b.regions.some((r) => r < 1 || r > 7))) return bad('/regions', 'out_of_scope');
    const no = [...(b.parts ?? []), ...(b.view ? [b.view.source] : [])].filter((p) => denied().includes(p));
    if (no.length) return problem(403, 'action_forbidden', 'You may not export these parts', { errors: no.map((p) => ({ path: `/parts/${p}`, code: 'export_denied' })) });
    const id = crypto.randomUUID();
    A().exports.unshift({
      id, kind: b.view ? 'view' : b.parts?.length ? 'partial' : 'full', parts: b.parts ?? [], view: b.view, job_id: `job-${id.slice(0, 8)}`, created_at: now(), status: 'queued', regions: b.regions ?? [1, 2, 3, 4, 5, 6, 7],
      as_of: b.as_of ?? TODAY, row_count: null, expires_at: null, polls: 0, size: 2048,
    } as never);
    save();
    return HttpResponse.json({ id: `job-${id.slice(0, 8)}`, kind: 'master_export', status: 'queued' }, { status: 202 });
  }),
  http.get(`${B}/exports/master`, () => {
    const g = guard(); if (g) return g;
    // Each poll moves a running job one step: queued -> running -> done.
    for (const e of A().exports) {
      if (e.status === 'queued' || e.status === 'running') {
        e.polls += 1; e.status = e.polls >= 2 ? 'done' : 'running';
        if (e.status === 'done') { e.row_count = 150; e.expires_at = new Date(Date.now() + 7 * 864e5).toISOString(); }
      }
    }
    save();
    return page(A().exports.map(({ polls: _p, size: _s, ...x }) => (void [_p, _s], x)));
  }),
  http.get(`${B}/exports/master/:id/download`, ({ params }) => {
    const g = guard(); if (g) return g;
    const e = A().exports.find((x) => x.id === params.id);
    if (!e) return problem(404, 'not_found', 'Export not found');
    if (e.status === 'expired') return problem(410, 'export_expired', 'The file expired; start a new export');
    if (e.status !== 'done') return problem(409, 'invalid_transition', 'The export is not ready');
    const name = `تصدير_ماستر_${TODAY}.xlsx`;
    return new HttpResponse(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]), {
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="Master_export_${TODAY}.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store' },
    });
  }),

  // ------------------------------------------------------------------ slots of a task
  http.get(`${B}/tasks/:id/slots`, ({ params }) => {
    const g = guard(); if (g) return g;
    const t = find(params.id as string);
    return t ? HttpResponse.json({ items: slotsOf(t) }) : problem(404, 'not_found', 'Task not found');
  }),
];

const PARTS = ([
  ['procurement', 'Procurement (PR/PO/WO)', 'المشتريات', 'Procurement'], ['contractors', 'Contractors', 'المقاولون', 'Contractors'], ['gecol', 'GECOL power', 'كهرباء GECOL', 'GECOL'], ['hlc', 'HLC fiber', 'ألياف HLC', 'HLC'],
  ['permits_hse', 'Permits & HSE', 'التصاريح والسلامة', 'Permits'], ['warehouse', 'Warehouse', 'المخزن', 'Warehouse'], ['quality', 'Quality', 'الجودة', 'Quality'], ['issues', 'Issue Log', 'سجل المشاكل', 'Issues'],
  ['risks', 'Risk Register', 'سجل المخاطر', 'Risks'], ['change_control', 'Change Control', 'ضبط التغيير', 'Change Control'], ['readiness_handover', 'Readiness & Handover', 'الجاهزية والتسليم', 'Readiness'],
  ['as_built', 'As-Built', 'كما بُني', 'As-Built'], ['meetings', 'Meetings', 'الاجتماعات', 'Meetings'], ['dismantle', 'Dismantle', 'الإزالة', 'Dismantle'],
  ['sites', 'Sites and milestones', 'المواقع والمعالم', 'Sites'], ['milestones', 'Milestones', 'المعالم', 'Milestones'], ['tasks', 'Tasks by stage', 'المهام حسب المرحلة', 'Tasks'], ['project_status', 'Project Status', 'حالة المشروع', 'Project Status'],
] as const).map(([key, label_en, label_ar, master_sheet]) => ({ key, label_en, label_ar, master_sheet }));
const COLUMNS: Record<string, string[]> = {
  sites: ['site_code', 'site_name', 'region', 'scenario', 'overall_status', 'current_stage', 'progress_pct', 'health_index'],
  tasks: ['site_code', 'task_code', 'task_name', 'stage', 'task_state', 'holder', 'due_date', 'sla_status', 'approved_at'],
};
// A reviewer lacks the export grant for the commercial registers.
const denied = (): string[] => (viewer()?.key === 'pm' ? [] : ['procurement', 'contractors', 'warehouse']);

function groupBody(id: string) {
  const grp = A().groups.find((x) => x.id === id);
  return grp && { ...grp, member_count: grp.members.length, members: grp.members.map((e) => ({ user: ref(e), status: A().users.find((u) => u.employee_id === e)?.status ?? 'active', added_at: '2026-10-01T08:00:00Z' })) };
}
const endSessions = (e: string) => { db().cfg.sessions = db().cfg.sessions.filter((x) => x.emp !== e); };
/** The System Admins group would have no active member left without this person. */
function lastAdmin(u: MockUser) {
  const grp = A().groups.find((x) => x.is_system_admins);
  return !!grp?.members.includes(u.employee_id) && !grp.members.some((m) => m !== u.employee_id && A().users.find((x) => x.employee_id === m)?.status === 'active');
}
const blocked = (d: ReturnType<typeof db>['admin']['deleted'][number]) =>
  A().users.some((u) => u.employee_id === d.employee_id) ? { path: '/employee_id', text: 'employee ID' } : A().users.some((u) => prof(u).email === d.email) ? { path: '/email', text: 'email' } : null;
function deletedBody(d: ReturnType<typeof db>['admin']['deleted'][number]) {
  const b = blocked(d), s = STAFF.find((x) => x.employee_id === d.employee_id);
  return { id: uid(d.employee_id), display_name: d.name_en, employee_id: d.employee_id, email: d.email, status: d.status, locale: 'en' as const, mfa_exempt: false, created_at: '2026-09-01T08:00:00Z', version: d.version,
    deleted_at: d.deleted_at, deleted_by: ref(d.deleted_by), delete_reason: d.reason, can_restore: !b, restore_blocked_reason: b ? `The ${b.text} now belongs to another account.` : null, ...(s ? {} : {}) };
}
function delegationBody(d: ReturnType<typeof db>['admin']['delegations'][number]) {
  const t = Date.now(), from = Date.parse(d.valid_from), to = d.valid_to ? Date.parse(d.valid_to) : Infinity;
  const state = d.revoked_at ? 'revoked' : t < from ? 'scheduled' : t > to ? 'expired' : 'active';
  return { id: d.id, from_user: ref(d.from), to_user: d.to ? ref(d.to) : null, target_kind: d.target_kind, target: { kind: d.target_kind, id: d.target_id, label: d.label }, region_codes: d.region_codes, module_codes: d.module_codes, allow_redelegate: d.allow_redelegate, scope: d.scope, rights: d.rights, valid_from: d.valid_from, valid_to: d.valid_to, state, reason: d.reason, revoked_at: d.revoked_at };
}
function absenceBody(a: ReturnType<typeof db>['admin']['absences'][number]) {
  return { id: a.id, user: ref(a.employee_id), kind: a.kind, from_date: a.from_date, to_date: a.to_date, note: a.note, recorded_by: ref(a.recorded_by), self_recorded: a.recorded_by === a.employee_id, open_task_count: tasksAll().filter((t) => t.state !== 'approved' && heldBy(t, a.employee_id)).length, version: a.version };
}
function alerts() {
  const away = absentOn(TODAY), out: object[] & { cause?: string }[] = [];
  for (const t of tasksAll()) {
    if (t.state === 'approved' || db().admin.kept[t.id] || db().admin.onBehalf[t.id]) continue;
    const s = toSummary(t), holder = s.ball_in_court?.holders.find((h) => h.employee_id && away.has(h.employee_id)) ?? s.ball_in_court?.holders[0];
    const hr = holder?.employee_id ? ref(holder.employee_id) : undefined;
    const dead = s.ball_in_court?.holders.find((h) => h.employee_id && accountStatus(h.employee_id) !== 'active');
    if (dead?.employee_id) out.push({ task: s, cause: 'holder_deactivated', holder: ref(dead.employee_id), holder_account_status: accountStatus(dead.employee_id), absence: null, idle_working_days: null });
    else if (holder?.employee_id && away.has(holder.employee_id)) {
      const ab = A().absences.find((x) => x.employee_id === holder.employee_id && x.from_date <= TODAY && TODAY <= x.to_date);
      out.push({ task: s, cause: 'absent', holder: hr, absence: ab ? absenceBody(ab) : null, idle_working_days: s.idle_working_days ?? null });
    } else if ((s.idle_working_days ?? 0) >= A().idleDays) out.push({ task: s, cause: 'idle', holder: hr, absence: null, idle_working_days: s.idle_working_days });
  }
  return out as { task: ReturnType<typeof toSummary>; cause: 'absent' | 'idle' | 'holder_deactivated'; holder?: { id: string; display_name: string; employee_id: string } }[];
}
