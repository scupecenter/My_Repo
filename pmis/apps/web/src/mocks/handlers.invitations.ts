// MSW handlers for user invitations (decision 5, migration 0091): the admin list, invite, resend, revoke and the two public routes. Synthetic data only.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { UserInvitation, UserInvitationCreate } from '@/api/invitations';
import { guard, page, problem } from './handlers';
import { db } from './db';

const B = API_BASE;
interface Mock { inv: UserInvitation; token: string | null; password: string | null }
let seq = 1;
let store: Mock[] = [];
const newToken = () => `mock-token-${String(seq++).padStart(4, '0')}-`.padEnd(43, 'x');
const invalid = () => problem(404, 'invitation_invalid', 'This invitation link does not work', { detail: 'This invitation link does not work.' });
const open = (t: string) => store.find((m) => m.token === t && m.inv.status === 'pending' && new Date(m.inv.expires_at).getTime() > Date.now());
const hours = 72;

/** Test and demo helper: the token of the newest invitation to an email (the mail is not simulated). */
export const mockInvitationToken = (email: string) => [...store].reverse().find((m) => m.inv.email === email)?.token ?? null;
export const resetMockInvitations = () => { store = []; seq = 1; };

const admin = () => guard() ?? (db().admin ? null : problem(403, 'action_forbidden', 'Administrators only'));

export const invitationHandlers = [
  http.get(`${B}/users/invitations`, ({ request }) => {
    const g = admin(); if (g) return g;
    const u = new URL(request.url), q = (u.searchParams.get('q') ?? '').toLowerCase(), st = u.searchParams.get('status');
    return page(store.map((m) => m.inv).filter((i) => (!q || i.email.includes(q) || i.display_name.toLowerCase().includes(q)) && (!st || i.status === st)).reverse());
  }),
  http.post(`${B}/users/invitations`, async ({ request }) => {
    const g = admin(); if (g) return g;
    const b = (await request.json()) as UserInvitationCreate;
    if ((b.reason ?? '').trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required' }] });
    const email = b.email.trim().toLowerCase();
    if (store.some((m) => m.inv.email === email && m.inv.status === 'pending') || db().admin.users.some((x) => x.local?.email.toLowerCase() === email)) {
      return problem(409, 'duplicate', 'Duplicate', { errors: [{ path: '/email', code: 'duplicate' }] });
    }
    const now = new Date();
    const inv: UserInvitation = {
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, email, display_name: b.display_name, employee_id: b.employee_id ?? null, phone: b.phone ?? null, status: 'pending',
      expires_at: new Date(now.getTime() + hours * 3600_000).toISOString(), created_at: now.toISOString(), last_sent_at: now.toISOString(), send_count: 1,
      invited_by: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Mock Admin' }, reason: b.reason, require_two_factor: b.require_two_factor ?? false,
      elevated: (b.assignments ?? []).some((a) => a.permission_level === 'admin'), department: null, manager: null, groups: [],
      assignments: (b.assignments ?? []).map((a) => ({ ...a, role: { id: a.role_id, code: 'MOCK', name_en: 'Role', name_ar: null } })),
      accepted_at: null, accepted_user_id: null, revoked_at: null, revoke_reason: null,
    };
    store.push({ inv, token: newToken(), password: null });
    return HttpResponse.json(inv, { status: 201 });
  }),
  http.post(`${B}/users/invitations/:id/:action`, async ({ params }) => {
    const g = admin(); if (g) return g;
    const m = store.find((x) => x.inv.id === params.id);
    if (!m) return problem(404, 'not_found', 'Not found');
    if (params.action === 'revoke') {
      if (m.inv.status !== 'pending') return problem(409, 'invalid_transition', 'Not pending');
      m.inv = { ...m.inv, status: 'revoked', revoked_at: new Date().toISOString() }; m.token = null;
    } else {
      if (m.inv.status === 'accepted' || m.inv.status === 'revoked') return problem(409, 'invalid_transition', 'Not pending');
      m.inv = { ...m.inv, status: 'pending', send_count: m.inv.send_count + 1, expires_at: new Date(Date.now() + hours * 3600_000).toISOString() }; m.token = newToken();
    }
    return HttpResponse.json(m.inv);
  }),
  http.get(`${B}/invitations/:token`, ({ params }) => {
    const m = open(String(params.token));
    if (!m) return invalid();
    return HttpResponse.json({ display_name: m.inv.display_name, email: m.inv.email, employee_id: m.inv.employee_id, phone: m.inv.phone, expires_at: m.inv.expires_at, password_policy: { min_length: 12, max_length: 128 } });
  }),
  http.post(`${B}/invitations/:token/accept`, async ({ params, request }) => {
    const m = open(String(params.token));
    if (!m) return invalid();
    const { password } = (await request.json()) as { password: string };
    if (password.length < 12) return problem(422, 'weak_password', 'Password does not meet the policy', { errors: [{ path: '/password', code: 'too_short' }] });
    m.inv = { ...m.inv, status: 'accepted', accepted_at: new Date().toISOString() }; m.token = null; m.password = password;
    return HttpResponse.json({ created: true, two_factor_enrolment_pending: m.inv.require_two_factor }, { status: 201 });
  }),
];
