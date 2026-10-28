// MSW handlers for local sign-in (ADR 0012): login, change password, step-up by password, create user, admin reset. Synthetic only.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import { accountKeyOf, ACCOUNTS, attempts, cred, db, save, sessionBody, STAFF, stepUpValid, viewer } from './db';
import { guard, problem, stepUp } from './handlers';
import { userOf } from './handlers.admin';
import { uid } from './ids';

const B = API_BASE;
const LOCK_AFTER = 5, LOCK_MS = 15 * 60_000, RATE_PER_MIN = 10;
const GENERIC = () => problem(401, 'invalid_credentials', 'The identifier or the password is not correct');
const compact = (s: string) => s.replace(/[\s-]/g, '');
const COMMON = new Set(['password1234', 'password12345', 'passw0rd1234', 'qwertyuiop12', 'qwerty123456', '123456789012', '1234567890123', 'changeme1234', 'welcome12345', 'letmein12345', 'administrator']);

/** Account key for an employee ID, email or phone. Demo accounts, created local users and registry staff alike. */
export function findAccount(identifier: string): string | null {
  const id = identifier.trim(), low = id.toLowerCase(), ph = compact(id);
  if (!id) return null;
  for (const u of db().admin.users) {
    const s = u.local ?? STAFF.find((x) => x.employee_id === u.employee_id);
    if (!s) continue;
    if ((u.employee_id && u.employee_id === id) || s.email.toLowerCase() === low || (!!s.phone && compact(s.phone) === ph)) return accountKeyOf(u);
  }
  // Demo accounts that are not in the admin list (the first sign-in account has no employee ID yet).
  return Object.keys(ACCOUNTS).find((k) => ACCOUNTS[k].email === low) ?? null;
}

/** Policy of ADR 0012. Returns rule codes; the real API names the same rules in `errors[]`. */
export function passwordRules(pw: string, current: string | null, who: { email?: string; employee_id?: string | null; phone?: string | null }) {
  const out: string[] = [], low = pw.toLowerCase();
  if (pw.length < 12) out.push('too_short');
  if (pw.length > 128) out.push('too_long');
  if (current !== null && pw === current) out.push('same_as_current');
  const local = (who.email ?? '').split('@')[0].toLowerCase();
  if (local.length >= 3 && low.includes(local)) out.push('contains_email');
  if (who.employee_id && low.includes(who.employee_id)) out.push('contains_employee_id');
  const digits = compact(who.phone ?? '').replace('+', '');
  if (digits.length >= 6 && compact(pw).includes(digits)) out.push('contains_phone');
  if (COMMON.has(low)) out.push('common_password');
  return out;
}
const weak = (path: string, rules: string[]) => problem(422, 'weak_password', 'The password does not meet the policy', { errors: rules.map((code) => ({ path, code })) });

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export function generatePassword(n = 16) {
  const b = new Uint32Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join('');
}

function recordFailure(key: string) {
  const c = cred(key);
  if (!c) return;
  c.failures += 1;
  if (c.failures >= LOCK_AFTER) { c.locked_until = Date.now() + LOCK_MS; c.failures = 0; }
}
const isAdmin = () => viewer()?.key === 'pm';
const needAdmin = () => guard() ?? (isAdmin() ? null : problem(403, 'action_forbidden', 'Administrators only'));
const whoOf = (key: string) => {
  const u = db().admin.users.find((x) => accountKeyOf(x) === key);
  const s = u?.local ?? STAFF.find((x) => x.employee_id === u?.employee_id) ?? ACCOUNTS[key];
  return { email: s?.email, employee_id: u?.employee_id ?? ACCOUNTS[key]?.employee_id, phone: u?.local ? u.local.phone : STAFF.find((x) => x.employee_id === u?.employee_id)?.phone };
};

export const authHandlers = [
  http.post(`${B}/auth/local/login`, async ({ request }) => {
    const now = Date.now();
    while (attempts.length && now - attempts[0] > 60_000) attempts.shift();
    if (attempts.length >= RATE_PER_MIN) return problem(429, 'rate_limited', 'Too many attempts', {});
    attempts.push(now);
    const b = (await request.json().catch(() => ({}))) as { identifier?: string; password?: string };
    if (typeof b.identifier !== 'string' || typeof b.password !== 'string' || !b.identifier || !b.password) return problem(400, 'validation_failed', 'Identifier and password are required');
    // Unknown identifier, wrong password, locked, local sign-in off, suspended or disabled: the same 401.
    const key = findAccount(b.identifier), c = key ? cred(key) : null;
    if (!key || !c || !c.enabled || (c.locked_until && c.locked_until > now)) return GENERIC();
    const u = db().admin.users.find((x) => accountKeyOf(x) === key);
    if (u && (u.status === 'suspended' || u.status === 'disabled')) return GENERIC();
    if (c.password !== b.password) { recordFailure(key); save(); return GENERIC(); }
    c.failures = 0; c.locked_until = null;
    const employee_id = u ? u.employee_id || null : ACCOUNTS[key]?.employee_id ?? null;
    db().session = { account: key, linked: employee_id !== null, stepupAt: null, method: 'local' };
    save();
    return HttpResponse.json(sessionBody());
  }),

  http.post(`${B}/auth/local/password`, async ({ request }) => {
    const s = db().session;
    if (!s) return problem(401, 'unauthenticated', 'Sign in required');
    const c = cred(s.account);
    if (!c) return problem(401, 'unauthenticated', 'This session has no password');
    const b = (await request.json().catch(() => ({}))) as { current_password?: string; new_password?: string };
    if (b.current_password !== c.password) { recordFailure(s.account); save(); return GENERIC(); }
    const rules = passwordRules(b.new_password ?? '', c.password, whoOf(s.account));
    if (rules.length) return weak('/new_password', rules);
    c.password = b.new_password!; c.must_change = false; c.failures = 0;
    save();
    return HttpResponse.json(sessionBody());
  }),

  http.post(`${B}/auth/local/step-up`, async ({ request }) => {
    const s = db().session;
    if (!s) return problem(401, 'unauthenticated', 'Sign in required');
    const c = cred(s.account);
    const b = (await request.json().catch(() => ({}))) as { password?: string };
    if (!c || (c.locked_until && c.locked_until > Date.now()) || c.password !== b.password) { recordFailure(s.account); save(); return GENERIC(); }
    c.failures = 0; s.stepupAt = Date.now(); save();
    return HttpResponse.json(sessionBody());
  }),

  http.post(`${B}/users`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = (await request.json().catch(() => ({}))) as { display_name?: string; email?: string; employee_id?: string | null; phone?: string | null; temporary_password?: string; reason?: string };
    const errors: { path: string; code: string }[] = [];
    const name = (b.display_name ?? '').trim(), email = (b.email ?? '').trim(), emp = b.employee_id ?? null, phone = b.phone ? compact(b.phone) : null;
    if (!name) errors.push({ path: '/display_name', code: 'required' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push({ path: '/email', code: 'invalid' });
    if (emp !== null && !/^[0-9]{4}$/.test(emp)) errors.push({ path: '/employee_id', code: 'invalid' });
    if (phone !== null && !/^\+[1-9][0-9]{7,14}$/.test(phone)) errors.push({ path: '/phone', code: 'invalid' });
    if ((b.reason ?? '').trim().length < 3) errors.push({ path: '/reason', code: 'required' });
    if (errors.length) return problem(422, 'validation_failed', 'Validation failed', { errors });
    const dup: { path: string; code: string }[] = [];
    for (const u of db().admin.users) {
      const s = u.local ?? STAFF.find((x) => x.employee_id === u.employee_id);
      if (s?.email.toLowerCase() === email.toLowerCase()) dup.push({ path: '/email', code: 'duplicate' });
      if (emp && u.employee_id === emp) dup.push({ path: '/employee_id', code: 'duplicate' });
      if (phone && s?.phone && compact(s.phone) === phone) dup.push({ path: '/phone', code: 'duplicate' });
    }
    if (dup.length) return problem(409, 'duplicate', 'Email, employee ID or phone is already used', { errors: dup.filter((d, i) => dup.findIndex((x) => x.path === d.path) === i) });
    const typed = b.temporary_password;
    const id = crypto.randomUUID();
    if (typed !== undefined) {
      const rules = passwordRules(typed, null, { email, employee_id: emp, phone });
      if (rules.length) return weak('/temporary_password', rules);
    }
    const pw = typed ?? generatePassword();
    const u = { employee_id: emp ?? '', status: 'pending_assignment' as const, version: 1, mfa: { exempt: false, until: null, reason: null, by: null }, local: { id, display_name: name, email, phone } };
    db().admin.users.push(u);
    const c = cred(accountKeyOf(u), true)!;
    Object.assign(c, { password: pw, must_change: true, failures: 0, locked_until: null, enabled: true });
    save();
    return HttpResponse.json({ user: userOf(u), temporary_password: pw }, { status: 201 });
  }),

  http.post(`${B}/users/:id/password-reset`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    if (!stepUpValid()) return stepUp();
    const u = db().admin.users.find((x) => (x.local ? x.local.id : uid(x.employee_id)) === params.id);
    if (!u) return problem(404, 'not_found', 'User not found');
    if (u.employee_id && u.employee_id === viewer()!.employee_id) return problem(403, 'self_beneficiary', 'Use change password for your own account');
    const b = (await request.json().catch(() => ({}))) as { reason?: string; temporary_password?: string };
    if ((b.reason ?? '').trim().length < 3) return problem(422, 'validation_failed', 'A reason is required', { errors: [{ path: '/reason', code: 'required' }] });
    const key = accountKeyOf(u);
    if (b.temporary_password !== undefined) {
      const rules = passwordRules(b.temporary_password, null, whoOf(key));
      if (rules.length) return weak('/temporary_password', rules);
    }
    const pw = b.temporary_password ?? generatePassword();
    const c = cred(key, true)!;
    Object.assign(c, { password: pw, must_change: true, failures: 0, locked_until: null, enabled: true });
    save();
    return HttpResponse.json({ temporary_password: pw });
  }),
];
