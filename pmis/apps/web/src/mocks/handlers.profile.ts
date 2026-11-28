// MSW handlers for the self-service "My profile" page (contract 0.9.2, 0.12.6): details, email change request (with the code mailed to the new
// address) and its admin decision, phone change request and its decision, password, two-factor self enrolment and self disable, and the admin
// "enforced" mark. Synthetic only. The mock sends no mail: the code of an email change is always MOCK_EMAIL_CODE.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { MyProfile } from '@/api/profile';
import { accountKeyOf, ACCOUNTS, cred, db, effectiveBrand, effectivePrefs, identity, save, sessionBody, STAFF, stepUpValid, tfLabel, viewer } from './db';
import { APPEARANCE_OPTIONS } from '../lib/appearance';
/** 0197: the sidebar object of the mock door: known keys only, the badge style of the list, lists of menu keys (the real check is ui_nav_check). */
const NAV_KEY = /^[a-z0-9_.]{1,60}$/;
const navOk = (v: unknown): boolean => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  for (const [k, x] of Object.entries(r)) {
    if (k === 'badge_style') { if (x !== 'full' && x !== 'dot' && x !== 'none') return false; continue; }
    if (k === 'hidden' || k === 'order' || k === 'pins') {
      if (!Array.isArray(x) || x.length > (k === 'pins' ? 20 : 200) || x.some((e) => typeof e !== 'string' || !NAV_KEY.test(e))) return false;
      continue;
    }
    return false;
  }
  return true;
};
import { isBrand } from '@/lib/brands';
import { checkCode, codeProblem, GENERIC, needAdmin, recordFailure, userByParam, whoOf } from './handlers.auth';
import { guard, problem, stepUp } from './handlers';
import { passwordRules } from './handlers.auth';
import { newRecoveryCodes, newSecret, otpauth } from './totp';

const B = API_BASE;
const SELF_EDITABLE = ['display_name', 'locale', 'theme', 'ui_brand', 'ui_prefs'];
/** The code the mock "mails" to a requested new address (there is no mail in the mock). */
export const MOCK_EMAIL_CODE = 'ABCD-2345';
const ADMIN_OWNED = ['email', 'phone', 'employee_id', 'status', 'team', 'teams', 'region', 'region_id', 'region_ids', 'regions', 'role', 'roles', 'role_ids', 'assignments', 'department', 'department_id', 'manager', 'manager_id', 'position', 'title', 'groups'];
const E164 = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const iso = () => new Date().toISOString();

const acct = () => db().session!.account;
const isLocal = () => db().session?.method === 'local' && !!cred(acct())?.enabled;
const over = (key = acct()) => (db().profiles ??= {})[key] ??= { version: 1 };
const changes = () => (db().emailChanges ??= []);
const phoneChanges = () => (db().phoneChanges ??= []);
const emailOf = (key: string) => over(key).email ?? whoOf(key).email ?? ACCOUNTS[key]?.email ?? '';
const nameOf = (key: string) => over(key).display_name ?? ACCOUNTS[key]?.name ?? db().admin.users.find((x) => accountKeyOf(x) === key)?.local?.display_name ?? '';
const notLocal = (detail: string) => problem(403, 'action_forbidden', 'Not a local account', { detail });

/** The emails and phones already used by any account (demo accounts, created users, registry staff), lower case. */
function usedPhones(except: string): Set<string> {
  const out = new Set<string>();
  for (const s of STAFF) if (s.employee_id !== ACCOUNTS[except]?.employee_id && s.phone) out.add(s.phone.replace(/[\s().-]/g, ''));
  for (const [k, o] of Object.entries(db().profiles ?? {})) if (k !== except && o.phone) out.add(o.phone);
  return out;
}
const phoneOf = (key: string): string | null => { const o = over(key); return o.phone !== undefined ? o.phone : (whoOf(key).phone ?? '').replace(/[\s().-]/g, '') || null; };
const emailBody = (x: (ReturnType<typeof changes>)[number]) => ({
  id: x.id, old_email: x.old_email, new_email: x.new_email, status: x.status, requested_at: x.requested_at, decided_at: x.decided_at, decision_reason: x.decision_reason,
  verified_at: x.verified_at ?? null, verified_via: x.verified_via ?? null, verify_sent_at: x.verify_sent_at ?? null, verify_expires_at: x.verify_expires_at ?? null,
});
const phoneBody = (x: (ReturnType<typeof phoneChanges>)[number]) => ({
  id: x.id, old_phone: x.old_phone, new_phone: x.new_phone, status: x.status, requested_at: x.requested_at, decided_at: x.decided_at, decision_reason: x.decision_reason,
});
const sendCode = (x: (ReturnType<typeof changes>)[number]) => {
  Object.assign(x, { code: MOCK_EMAIL_CODE, attempts: 0, verify_sent_at: iso(), verify_expires_at: new Date(Date.now() + 24 * 3600_000).toISOString() });
};

function usedEmails(except: string): Set<string> {
  const out = new Set<string>();
  for (const k of Object.keys(ACCOUNTS)) if (k !== except) out.add(emailOf(k).toLowerCase());
  for (const u of db().admin.users) { const k = accountKeyOf(u); if (k !== except) out.add(emailOf(k).toLowerCase()); }
  for (const s of STAFF) out.add(s.email.toLowerCase());
  out.delete(emailOf(except).toLowerCase());
  return out;
}

export function profileBody(): MyProfile {
  const v = viewer()!, key = acct(), c = cred(key), o = over(key);
  const state = tfLabel(c), enforced = !!c?.tf?.on && !!c.tf.enforced, local = isLocal();
  const mine = changes().filter((x) => x.account === key).sort((a, b) => (a.requested_at < b.requested_at ? 1 : -1))[0];
  const minePhone = phoneChanges().filter((x) => x.account === key).sort((a, b) => (a.requested_at < b.requested_at ? 1 : -1))[0];
  return {
    id: sessionBody().user!.id, display_name: nameOf(key) || v.name, email: emailOf(key) || v.email, employee_id: v.employee_id,
    phone: phoneOf(key), locale: o.locale ?? 'en', theme: o.theme ?? 'light', status: v.status,
    ui_brand: o.ui_brand ?? null, brand: effectiveBrand(o.ui_brand), ui_prefs: o.ui_prefs ?? {}, appearance: effectivePrefs(o.ui_prefs),
    identity: { default_brand: identity().default_brand, allow_user_choice: identity().allow_user_choice, defaults: identity().defaults, pref_options: identity().pref_options },
    auth_method: db().session!.method ?? 'm365', local_sign_in: !!c?.enabled, editable_fields: SELF_EDITABLE as MyProfile['editable_fields'],
    admin_owned: { roles: v.key === 'pm' ? [{ id: '0f000000-0000-4000-8000-000000000001', code: 'PM', name_en: 'Project Manager', name_ar: 'مدير المشروع' }] : [], teams: [], region_ids: 'all', department: null, manager: null },
    two_factor: { state, enforced, recovery_codes_remaining: state === 'on' ? c!.tf!.codes.length : 0, can_enable: local && state === 'off', can_disable: local && state === 'on' && !enforced },
    email_change: mine ? emailBody(mine) : null,
    phone_change: minePhone ? phoneBody(minePhone) : null,
    version: o.version,
  };
}
const withEtag = (p: MyProfile) => HttpResponse.json(p, { headers: { ETag: `"${p.version}"` } });
const json = async (r: Request) => (await r.json().catch(() => ({}))) as Record<string, unknown>;

function adminRow(x: (ReturnType<typeof changes>)[number]) {
  const u = db().admin.users.find((y) => accountKeyOf(y) === x.account);
  return {
    ...emailBody(x), identity_check: x.identity_check ?? null,
    user: { id: sessionBodyIdOf(x.account), display_name: nameOf(x.account), employee_id: u?.employee_id || ACCOUNTS[x.account]?.employee_id || null },
    decided_by: x.decided_by ? { id: sessionBodyIdOf(x.decided_by), display_name: nameOf(x.decided_by), employee_id: ACCOUNTS[x.decided_by]?.employee_id ?? null } : null,
  };
}
function phoneAdminRow(x: (ReturnType<typeof phoneChanges>)[number]) {
  const u = db().admin.users.find((y) => accountKeyOf(y) === x.account);
  return {
    ...phoneBody(x),
    user: { id: sessionBodyIdOf(x.account), display_name: nameOf(x.account), employee_id: u?.employee_id || ACCOUNTS[x.account]?.employee_id || null },
    decided_by: x.decided_by ? { id: sessionBodyIdOf(x.decided_by), display_name: nameOf(x.decided_by), employee_id: ACCOUNTS[x.decided_by]?.employee_id ?? null } : null,
  };
}
const sessionBodyIdOf = (key: string) => {
  const u = db().admin.users.find((y) => accountKeyOf(y) === key);
  return u?.local?.id ?? `00000000-0000-4000-8000-${(u?.employee_id || ACCOUNTS[key]?.employee_id || '0').padStart(12, '0')}`;
};

let MY_SESSIONS = [
  { session_id: '00000000-0000-4000-8000-0000000000c1', signed_in_at: '2026-11-27T08:00:00Z', last_activity_at: '2026-11-27T09:00:00Z', ip: '10.0.0.5', device: { browser: 'Chrome', os: 'Windows', type: 'desktop' }, auth_method: 'local', is_current: true },
  { session_id: '00000000-0000-4000-8000-0000000000c2', signed_in_at: '2026-11-26T08:00:00Z', last_activity_at: '2026-11-26T18:00:00Z', ip: '10.0.0.9', device: { browser: 'Safari', os: 'iOS', type: 'mobile' }, auth_method: 'local', is_current: false },
];

// Contract 0.15.531: personal notification settings (the real check is the database, migration 0583). Synthetic: a small catalogue, one in-memory row.
const NP_TYPES = [
  { code: 'task_assigned', label_en: 'Task assigned to me', label_ar: 'إسناد مهمة إليّ', kind: 'task_assigned', category: 'tasks', mandatory: false },
  { code: 'approval_due', label_en: 'Approval waiting', label_ar: 'اعتماد بانتظار الإجراء', kind: 'approval_due', category: 'approvals', mandatory: false },
  { code: 'security_alert', label_en: 'Security alert', label_ar: 'تنبيه أمني', kind: 'security_alert', category: 'security', mandatory: true },
];
const npState = { version: 0, types: {} as Record<string, { in_app: boolean; email: boolean }>, dnd: { enabled: false, start: 1320, end: 420, days: [0, 1, 2, 3, 4, 5, 6], timezone: null as string | null }, snooze_until: null as string | null,
  org: { allow_personal: true, allow_dnd: true, dedupe_minutes: 10, decision_retention_days: 30, version: 0 }, decisions: [] as { id: number; kind: string; channel: string; reason: string; title: string | null; link: string | null; created_at: string }[] };
const npBody = () => ({
  version: npState.version,
  types: NP_TYPES.map((x) => ({ ...x, in_app: x.mandatory ? true : (npState.types[x.code]?.in_app ?? true), email: x.mandatory ? true : (npState.types[x.code]?.email ?? true) })),
  dnd: { ...npState.dnd, effective_timezone: 'Africa/Tripoli' },
  snooze_until: npState.snooze_until, quiet_now: !!npState.snooze_until && new Date(npState.snooze_until) > new Date(),
  org: { allow_personal: npState.org.allow_personal, allow_dnd: npState.org.allow_dnd, dedupe_minutes: npState.org.dedupe_minutes },
});
let npLastTest = 0;
const npHandlers = [
  http.get(`${B}/me/notification-prefs`, () => { const g = guard(); if (g) return g; return HttpResponse.json(npBody()); }),
  http.put(`${B}/me/notification-prefs`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!npState.org.allow_personal) return problem(403, 'field_read_only', 'Switched off');
    if (request.headers.get('if-match') !== `"${npState.version}"`) return problem(412, 'precondition_failed', 'Changed since read');
    const b = (await request.json()) as { types?: Record<string, { in_app?: boolean; email?: boolean }>; dnd?: Partial<typeof npState.dnd> };
    if (b.types) {
      npState.types = {};
      for (const [k, v] of Object.entries(b.types)) {
        const t = NP_TYPES.find((x) => x.code === k);
        if (!t) return problem(422, 'validation_failed', 'Unknown type');
        if (!t.mandatory && (v.in_app === false || v.email === false)) npState.types[k] = { in_app: v.in_app ?? true, email: v.email ?? true };
      }
    }
    if (b.dnd) npState.dnd = { ...npState.dnd, ...b.dnd } as typeof npState.dnd;
    npState.version += 1;
    return HttpResponse.json(npBody());
  }),
  http.post(`${B}/me/notification-prefs/snooze`, async ({ request }) => {
    const g = guard(); if (g) return g;
    npState.snooze_until = ((await request.json()) as { until: string | null }).until; npState.version += 1;
    return HttpResponse.json(npBody());
  }),
  http.post(`${B}/me/notification-prefs/test`, () => {
    const g = guard(); if (g) return g;
    if (Date.now() - npLastTest < 30_000) return problem(429, 'rate_limited', 'Wait 30 seconds');
    npLastTest = Date.now();
    return HttpResponse.json({ notification_id: '00000000-0000-4000-8000-0000000000d1', quiet_now: npBody().quiet_now });
  }),
  http.get(`${B}/me/notification-prefs/decisions`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ items: npState.decisions }); }),
  http.get(`${B}/admin/notification-personal`, () => { const g = guard(); if (g) return g; return HttpResponse.json(npState.org); }),
  http.put(`${B}/admin/notification-personal`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (request.headers.get('if-match') !== `"${npState.org.version}"`) return problem(412, 'precondition_failed', 'Changed since read');
    const b = { ...((await request.json()) as Record<string, unknown>) };
    delete b.reason;
    npState.org = { ...npState.org, ...b, version: npState.org.version + 1 } as typeof npState.org;
    return HttpResponse.json(npState.org);
  }),
];
/** D4: the mock feed of the signed-in person (one link at a time, like the real one). */
const FEED: { token: string | null; at: string; n: number } = { token: null, at: '', n: 0 };
export const profileHandlers = [
  ...npHandlers,
  http.get(`${B}/me/sessions`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ items: MY_SESSIONS }); }),
  http.post(`${B}/me/sessions/revoke-others`, () => { const g = guard(); if (g) return g; const n = MY_SESSIONS.filter((s) => !s.is_current).length; MY_SESSIONS = MY_SESSIONS.filter((s) => s.is_current); return HttpResponse.json({ revoked_count: n }); }),
  http.post(`${B}/me/sessions/:id/revoke`, ({ params }) => { const g = guard(); if (g) return g; MY_SESSIONS = MY_SESSIONS.filter((s) => s.session_id !== params.id || s.is_current); return HttpResponse.json({ revoked_count: 1 }); }),
  http.get(`${B}/me/calendar-feed`, () => { const g = guard(); if (g) return g; return HttpResponse.json(FEED.token ? { enabled: true, created_at: FEED.at, rotated_at: null, last_read_at: null, read_count: 0 } : { enabled: false }); }),
  http.post(`${B}/me/calendar-feed`, () => { const g = guard(); if (g) return g; const rotated = FEED.token !== null; FEED.token = `mockfeedtoken${(FEED.n += 1)}`.padEnd(43, 'x'); FEED.at = new Date().toISOString(); return HttpResponse.json({ enabled: true, rotated, path: `/me/calendar-feed/${FEED.token}.ics` }); }),
  http.delete(`${B}/me/calendar-feed`, () => { const g = guard(); if (g) return g; const removed = FEED.token ? 1 : 0; FEED.token = null; return HttpResponse.json({ enabled: false, removed }); }),
  http.get(`${B}/me/push`, () => { const g = guard(); if (g) return g; return HttpResponse.json({ enabled: false, public_key: null, count: 0, this_browser: false }); }),
  http.get(`${B}/me/profile`, () => { const g = guard(); if (g) return g; return withEtag(profileBody()); }),

  http.patch(`${B}/me/profile`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const b = await json(request);
    const ro = Object.keys(b).filter((k) => ADMIN_OWNED.includes(k));
    if (ro.length) return problem(403, 'field_read_only', 'These fields are managed by an administrator', { errors: ro.map((k) => ({ path: `/${k}`, code: 'read_only', ...(k === 'phone' ? { message: 'Ask for a phone change instead (POST /me/phone-change).' } : {}) })) });
    const unknown = Object.keys(b).filter((k) => !SELF_EDITABLE.includes(k));
    if (unknown.length || !Object.keys(b).length) return problem(422, 'validation_failed', 'Validation failed', { errors: (unknown.length ? unknown : ['']).map((k) => ({ path: `/${k}`, code: 'invalid' })) });
    const h = request.headers.get('If-Match');
    if (!h) return problem(428, 'precondition_required', 'If-Match is required');
    const o = over();
    if (h.replace(/"/g, '') !== String(o.version)) return problem(412, 'precondition_failed', 'The profile changed since you read it');
    const errors: { path: string; code: string }[] = [];
    if ('display_name' in b && (typeof b.display_name !== 'string' || !b.display_name.trim() || b.display_name.trim().length > 200)) errors.push({ path: '/display_name', code: 'invalid' });
    if ('locale' in b && !['en', 'ar'].includes(b.locale as string)) errors.push({ path: '/locale', code: 'invalid' });
    if ('theme' in b && !['light', 'dark'].includes(b.theme as string)) errors.push({ path: '/theme', code: 'invalid' });
    if ('ui_brand' in b && b.ui_brand !== null && !isBrand(b.ui_brand)) errors.push({ path: '/ui_brand', code: 'invalid' });
    if ('ui_prefs' in b) {
      const p = b.ui_prefs;
      if (p === null || typeof p !== 'object' || Array.isArray(p)) errors.push({ path: '/ui_prefs', code: 'invalid' });
      else for (const [k, v] of Object.entries(p)) {
        if (k === 'sidebar') { if (v === null || typeof v !== 'object' || Array.isArray(v) || !navOk(v)) { errors.push({ path: '/ui_prefs', code: 'invalid' }); break; } continue; }
        const opts = (APPEARANCE_OPTIONS as Record<string, readonly string[]>)[k];
        if (!opts || typeof v !== 'string' || !opts.includes(v)) { errors.push({ path: '/ui_prefs', code: 'invalid' }); break; }
      }
    }
    if (errors.length) return problem(422, 'validation_failed', 'Validation failed', { errors });
    if (b.ui_brand != null && !identity().allow_user_choice) {
      return problem(403, 'field_read_only', 'The administrator set one design for everyone', { errors: [{ path: '/ui_brand', code: 'brand_choice_locked' }] });
    }
    if (b.ui_prefs != null && Object.keys(b.ui_prefs).some((k) => k !== 'sidebar') && !identity().allow_user_choice) {
      return problem(403, 'field_read_only', 'The administrator set one design for everyone', { errors: [{ path: '/ui_prefs', code: 'appearance_choice_locked' }] });
    }
    if ('ui_brand' in b) o.ui_brand = isBrand(b.ui_brand) ? b.ui_brand : null;
    // 0196 + 0197 (the door's rules): the dimensions are replaced when the body names one (or has no sidebar), a sidebar-only body
    // keeps them; the sidebar is replaced when the body carries it, kept otherwise.
    if (b.ui_prefs != null) {
      const p = b.ui_prefs as Record<string, unknown>;
      const cur = { ...(o.ui_prefs ?? {}) };
      const hasDim = Object.keys(p).some((k) => k !== 'sidebar');
      const next: Record<string, unknown> = hasDim ? {} : Object.fromEntries(Object.entries(cur).filter(([k]) => k in APPEARANCE_OPTIONS));
      for (const [k, v] of Object.entries(p)) if (k !== 'sidebar') next[k] = v;
      const side = 'sidebar' in p ? p.sidebar : cur.sidebar;
      if (side !== null && typeof side === 'object' && !Array.isArray(side) && Object.keys(side).length) next.sidebar = side;
      o.ui_prefs = next;
    }
    if (typeof b.display_name === 'string') o.display_name = b.display_name.trim();
    if (b.locale) o.locale = b.locale as 'en' | 'ar';
    if (b.theme) o.theme = b.theme as 'light' | 'dark';
    o.version += 1;
    save();
    return withEtag(profileBody());
  }),

  http.post(`${B}/me/password`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isLocal()) return notLocal('Your account signs in with Microsoft 365. Change your password there.');
    const c = cred(acct())!;
    const b = await json(request);
    if (c.locked_until && c.locked_until > Date.now()) return problem(429, 'account_locked', 'Account locked', {});
    if (b.current_password !== c.password) { recordFailure(acct()); save(); return GENERIC(); }
    const rules = passwordRules(String(b.new_password ?? ''), c.password, whoOf(acct()));
    if (rules.length) return problem(422, 'weak_password', 'The password does not meet the policy', { errors: rules.map((code) => ({ path: '/new_password', code })) });
    c.password = String(b.new_password); c.failures = 0;
    save();
    return HttpResponse.json(sessionBody());
  }),

  http.post(`${B}/me/email-change`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isLocal()) return notLocal('Your account signs in with Microsoft 365. Ask an administrator to change your email.');
    const key = acct(), c = cred(key)!;
    const b = await json(request);
    const email = String(b.new_email ?? '').trim().toLowerCase();
    if (!EMAIL.test(email) || typeof b.password !== 'string' || !b.password) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/new_email', code: 'invalid' }] });
    if (c.locked_until && c.locked_until > Date.now()) return problem(429, 'account_locked', 'Account locked', {});
    if (b.password !== c.password) { recordFailure(key); save(); return GENERIC(); }
    if (email === emailOf(key).toLowerCase()) return problem(422, 'validation_failed', 'This is already your email', { errors: [{ path: '/new_email', code: 'same_as_current' }] });
    if (changes().some((x) => x.account === key && x.status === 'pending')) return problem(409, 'invalid_transition', 'An email change is already waiting for approval');
    if (usedEmails(key).has(email) || changes().some((x) => x.status === 'pending' && x.new_email === email)) {
      return problem(409, 'duplicate', 'This email is already used or requested by another account', { errors: [{ path: '/new_email', code: 'duplicate' }] });
    }
    const r: (ReturnType<typeof changes>)[number] = { id: crypto.randomUUID(), account: key, old_email: emailOf(key), new_email: email, status: 'pending', requested_at: iso(), decided_at: null, decision_reason: null, decided_by: null };
    sendCode(r);
    changes().push(r);
    save();
    return HttpResponse.json(emailBody(r), { status: 201 });
  }),

  http.post(`${B}/me/email-change/verify`, async ({ request }) => {
    const g = guard(); if (g) return g;
    const r = changes().find((x) => x.account === acct() && x.status === 'pending');
    if (!r) return problem(404, 'not_found', 'No email change is waiting for a decision');
    if (r.verified_at) return HttpResponse.json(emailBody(r));
    if (!r.code) return problem(409, 'invalid_transition', 'No code was sent for this request: send a new one.');
    const b = await json(request);
    const typed = String(b.code ?? '').toUpperCase().replace(/[\s-]/g, '');
    const bad = (code: string, msg: string) => problem(422, 'invalid_code', msg, { errors: [{ path: '/code', code }] });
    if ((r.attempts ?? 0) >= 5) return bad('locked', 'Too many wrong codes: send a new code.');
    if (r.verify_expires_at && r.verify_expires_at < iso()) return bad('expired', 'The code has expired: send a new code.');
    if (typed !== r.code.replace('-', '')) { r.attempts = (r.attempts ?? 0) + 1; save(); return bad(r.attempts >= 5 ? 'locked' : 'invalid', 'The code is not correct.'); }
    Object.assign(r, { verified_at: iso(), verified_via: 'code', code: null });
    save();
    return HttpResponse.json(emailBody(r));
  }),

  http.post(`${B}/me/email-change/resend`, () => {
    const g = guard(); if (g) return g;
    const r = changes().find((x) => x.account === acct() && x.status === 'pending');
    if (!r) return problem(404, 'not_found', 'No email change is waiting for a decision');
    if (r.verified_at) return problem(409, 'invalid_transition', 'The new address is already confirmed.');
    sendCode(r);
    save();
    return HttpResponse.json(emailBody(r));
  }),

  http.post(`${B}/me/phone-change`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isLocal()) return notLocal('Your account signs in with Microsoft 365. Ask an administrator to change your phone.');
    const key = acct(), c = cred(key)!;
    const b = await json(request);
    const phone = b.new_phone === null ? null : String(b.new_phone ?? '').trim();
    if ((phone !== null && !E164.test(phone)) || typeof b.password !== 'string' || !b.password) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/new_phone', code: 'invalid' }] });
    if (c.locked_until && c.locked_until > Date.now()) return problem(429, 'account_locked', 'Account locked', {});
    if (b.password !== c.password) { recordFailure(key); save(); return GENERIC(); }
    if (phone === phoneOf(key)) return problem(422, 'validation_failed', 'This is already your phone', { errors: [{ path: '/new_phone', code: 'same_as_current' }] });
    if (phoneChanges().some((x) => x.account === key && x.status === 'pending')) return problem(409, 'invalid_transition', 'A phone change is already waiting for approval');
    if (phone && (usedPhones(key).has(phone) || phoneChanges().some((x) => x.status === 'pending' && x.new_phone === phone))) {
      return problem(409, 'duplicate', 'This phone is already used or requested by another account', { errors: [{ path: '/new_phone', code: 'duplicate' }] });
    }
    const r = { id: crypto.randomUUID(), account: key, old_phone: phoneOf(key), new_phone: phone, status: 'pending' as const, requested_at: iso(), decided_at: null, decision_reason: null, decided_by: null };
    phoneChanges().push(r);
    save();
    return HttpResponse.json(phoneBody(r), { status: 201 });
  }),

  http.delete(`${B}/me/phone-change`, () => {
    const g = guard(); if (g) return g;
    const r = phoneChanges().find((x) => x.account === acct() && x.status === 'pending');
    if (!r) return problem(404, 'not_found', 'No phone change is waiting for a decision');
    Object.assign(r, { status: 'cancelled', decided_at: iso(), decided_by: acct() });
    save();
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(`${B}/phone-change-requests`, ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const status = new URL(request.url).searchParams.get('status') ?? 'pending';
    const items = phoneChanges().filter((x) => status === 'all' || x.status === status).sort((a, b) => (a.requested_at < b.requested_at ? 1 : -1)).map(phoneAdminRow);
    return HttpResponse.json({ items, page: { limit: 200, next_cursor: null, total: items.length } });
  }),

  http.post(`${B}/phone-change-requests/:id/decide`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const r = phoneChanges().find((x) => x.id === params.id);
    if (!r) return problem(404, 'not_found', 'Request not found');
    const b = await json(request);
    if (!['approve', 'reject'].includes(b.decision as string) || String(b.reason ?? '').trim().length < 3) return problem(422, 'validation_failed', 'A decision and a reason are required', { errors: [{ path: '/reason', code: 'required' }] });
    if (r.account === acct()) return problem(403, 'self_beneficiary', 'You cannot decide a phone change on your own account');
    if (r.status !== 'pending') return problem(409, 'invalid_transition', 'This phone change is no longer waiting for a decision');
    if (b.decision === 'approve') {
      if (r.new_phone && usedPhones(r.account).has(r.new_phone)) return problem(409, 'duplicate', 'This phone is already used by another account', { errors: [{ path: '/new_phone', code: 'duplicate' }] });
      over(r.account).phone = r.new_phone;
    }
    Object.assign(r, { status: b.decision === 'approve' ? 'approved' : 'rejected', decided_at: iso(), decided_by: acct(), decision_reason: String(b.reason).trim() });
    save();
    return HttpResponse.json(phoneAdminRow(r));
  }),

  http.delete(`${B}/me/email-change`, () => {
    const g = guard(); if (g) return g;
    const r = changes().find((x) => x.account === acct() && x.status === 'pending');
    if (!r) return problem(404, 'not_found', 'No email change is waiting for a decision');
    Object.assign(r, { status: 'cancelled', decided_at: iso(), decided_by: acct() });
    save();
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${B}/me/two-factor/enrol/start`, () => {
    const g = guard(); if (g) return g;
    if (!isLocal()) return notLocal('Your account signs in with Microsoft 365, where two-factor is managed.');
    const c = cred(acct())!;
    if (tfLabel(c) !== 'off') return problem(409, 'invalid_transition', 'Two-factor is already on for your account');
    if (!stepUpValid()) return stepUp();
    const secret = newSecret();
    c.tf = { on: false, secret: null, pending: null, codes: [], lastStep: null, failures: c.tf?.failures ?? 0, enforced: false, selfPending: secret };
    save();
    const email = emailOf(acct());
    return HttpResponse.json({ secret, otpauth_uri: otpauth(secret, email), issuer: 'GSDN Workspace', account: email, algorithm: 'SHA1', digits: 6, period: 30 });
  }),

  http.post(`${B}/me/two-factor/enrol/confirm`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isLocal()) return notLocal('Your account signs in with Microsoft 365, where two-factor is managed.');
    const c = cred(acct())!;
    if (!c.tf?.selfPending || c.tf.on) return problem(409, 'invalid_transition', 'Start the set-up again: no QR code is waiting for this session.');
    const b = await json(request);
    const r = await checkCode(c, { code: String(b.code ?? '') }, c.tf.selfPending);
    if (r !== 'ok') { save(); return codeProblem(r); }
    c.tf = { on: true, secret: c.tf.selfPending, pending: null, codes: newRecoveryCodes(), lastStep: c.tf.lastStep, failures: 0, enforced: false, selfPending: null };
    save();
    return HttpResponse.json({ recovery_codes: [...c.tf.codes], two_factor: profileBody().two_factor, other_sessions_ended: 0 });
  }),

  http.post(`${B}/me/two-factor/disable`, async ({ request }) => {
    const g = guard(); if (g) return g;
    if (!isLocal()) return notLocal('Your account signs in with Microsoft 365, where two-factor is managed.');
    const c = cred(acct())!;
    const b = await json(request);
    if (typeof b.password !== 'string' || (b.code === undefined) === (b.recovery_code === undefined)) return problem(422, 'validation_failed', 'The password and a code are required', { errors: [{ path: '/code', code: 'required' }] });
    if (tfLabel(c) !== 'on') return problem(409, 'invalid_transition', 'Two-factor is not on for your account');
    if (c.tf!.enforced) return problem(403, 'two_factor_enforced', 'Two-factor is enforced by an administrator', { detail: 'An administrator enforces two-factor on your account, so you cannot turn it off.' });
    if (c.password !== b.password) { recordFailure(acct()); save(); return GENERIC(); }
    const r = await checkCode(c, b as { code?: string; recovery_code?: string }, c.tf!.secret);
    if (r !== 'ok') { save(); return codeProblem(r); }
    delete c.tf;
    save();
    return HttpResponse.json(profileBody().two_factor);
  }),

  http.get(`${B}/email-change-requests`, ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const status = new URL(request.url).searchParams.get('status') ?? 'pending';
    const items = changes().filter((x) => status === 'all' || x.status === status).sort((a, b) => (a.requested_at < b.requested_at ? 1 : -1)).map(adminRow);
    return HttpResponse.json({ items, page: { limit: 200, next_cursor: null, total: items.length } });
  }),

  http.post(`${B}/email-change-requests/:id/decide`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const r = changes().find((x) => x.id === params.id);
    if (!r) return problem(404, 'not_found', 'Request not found');
    const b = await json(request);
    if (!['approve', 'reject'].includes(b.decision as string) || String(b.reason ?? '').trim().length < 3) return problem(422, 'validation_failed', 'A decision and a reason are required', { errors: [{ path: '/reason', code: 'required' }] });
    if (r.account === acct()) return problem(403, 'self_beneficiary', 'You cannot decide an email change on your own account');
    if (r.status !== 'pending') return problem(409, 'invalid_transition', 'This email change is no longer waiting for a decision');
    const check = typeof b.identity_check === 'string' ? b.identity_check.trim() : '';
    if (b.decision === 'approve' && !r.verified_at && check.length < 3) {
      return problem(409, 'email_not_verified', 'The new email address is not confirmed', { errors: [{ path: '/identity_check', code: 'required' }] });
    }
    if (b.decision === 'approve' && !r.verified_at) Object.assign(r, { verified_at: iso(), verified_via: 'admin_check', identity_check: check, code: null });
    if (b.decision === 'approve') {
      if (usedEmails(r.account).has(r.new_email)) return problem(409, 'duplicate', 'This email is already used by another account', { errors: [{ path: '/new_email', code: 'duplicate' }] });
      over(r.account).email = r.new_email;
      const u = db().admin.users.find((x) => accountKeyOf(x) === r.account);
      if (u?.local) u.local.email = r.new_email;
    }
    Object.assign(r, { status: b.decision === 'approve' ? 'approved' : 'rejected', decided_at: iso(), decided_by: acct(), decision_reason: String(b.reason).trim() });
    save();
    return HttpResponse.json(adminRow(r));
  }),

  http.put(`${B}/users/:id/two-factor/enforced`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const u = userByParam(params.id);
    if (!u) return problem(404, 'not_found', 'User not found');
    const b = await json(request);
    if (typeof b.enforced !== 'boolean' || String(b.reason ?? '').trim().length < 3) return problem(422, 'validation_failed', 'enforced and a reason are required', { errors: [{ path: typeof b.enforced !== 'boolean' ? '/enforced' : '/reason', code: 'required' }] });
    if (u.employee_id && u.employee_id === viewer()!.employee_id) return problem(403, 'self_beneficiary', 'You cannot change your own two-factor');
    const c = cred(accountKeyOf(u));
    if (!c?.tf?.on) return problem(409, 'invalid_transition', 'Two-factor is off for this user: turn it on first');
    c.tf.enforced = b.enforced;
    save();
    return HttpResponse.json({ two_factor: tfLabel(c), enforced: b.enforced });
  }),
];
