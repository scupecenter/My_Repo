// MSW handlers of work package P9 (contract 0.12.3, migration 0055): mail delivery (status, test mail, outbox, retry), the integrity checks run as
// jobs, and the health check. Synthetic data only. The alert rules and the activity workbook extend handlers.logs.ts.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { LogIntegrityRun, MailOutboxItem, MailStatus } from '@/api/logs';
import { viewer } from './db';
import { guard, problem } from './handlers';

const B = API_BASE;
const needAdmin = () => guard() ?? (viewer()?.key === 'pm' ? null : problem(403, 'action_forbidden', 'Administrators only'));

let status: MailStatus = {
  enabled: true, state: 'unverified', verified_at: null, last_sent_at: '2026-11-03T08:00:00.000000Z', last_error: '451 4.3.0 try later',
  settings: { host: 'relay.aljeel.local', port: 587, tls: 'starttls', from: 'GSDN PMIS <pmis@aljeel.example>', auth: true, verify_certificate: true },
  counts: { queued: 1, retrying: 1, sending: 0, dead: 1, dead_24h: 1, sent_24h: 12, logged_24h: 0, suppressed_24h: 0 },
};
let outbox: MailOutboxItem[] = [
  { id: '9c000000-0000-4000-8000-000000000001', created_at: '2026-11-03T09:00:00.000000Z', kind: 'security_alert', to: 'sara.benali@example.test', to_user_id: null,
    subject: '[PMIS] HIGH security alert: The System Admins changed', sensitive: false, status: 'sent', attempts: 1, next_attempt_at: null, last_error: null, sent_at: '2026-11-03T09:00:02.000000Z' },
  { id: '9c000000-0000-4000-8000-000000000002', created_at: '2026-11-03T09:10:00.000000Z', kind: 'notification.task_assigned', to: 'omar.haddad@example.test', to_user_id: null,
    subject: '[PMIS] Task B5 is yours', sensitive: false, status: 'retrying', attempts: 1, next_attempt_at: '2026-11-03T09:11:00.000000Z', last_error: 'RCPT TO refused: 451 4.3.0 try later', sent_at: null },
  { id: '9c000000-0000-4000-8000-000000000003', created_at: '2026-11-03T09:20:00.000000Z', kind: 'identity.email_verify', to: 'new.address@example.test', to_user_id: null,
    subject: '(hidden)', sensitive: true, status: 'dead', attempts: 1, next_attempt_at: null, last_error: 'RCPT TO refused: 550 5.1.1 no such user', sent_at: null },
];
let runs: LogIntegrityRun[] = [
  { id: '9d000000-0000-4000-8000-000000000001', log: 'audit', trigger: 'nightly', status: 'ok', started_at: '2026-11-03T01:00:00.000000Z', finished_at: '2026-11-03T01:00:09.000000Z',
    requested_by: null, from_seq: 1, to_seq: 905, checked_through: 905, row_count: 905, progress: 100, break_count: 0, breaks: [], head_hash: 'a'.repeat(64),
    anchor_check: { seq: 880, ok: true, ref: 'anchor-audit.jsonl#3:0123456789abcdef' }, anchor_ref: 'anchor-audit.jsonl#4:fedcba9876543210', error: null, job_run_id: null },
];

/** Resets the state between tests. */
export function resetP9Mocks(): void {
  status = { ...status, state: 'unverified', verified_at: null };
  outbox = outbox.map((m) => (m.id.endsWith('3') ? { ...m, status: 'dead' } : m));
  runs = runs.slice(-1);
}

export const p9Handlers = [
  http.get(`${B}/admin/mail/status`, () => needAdmin() ?? HttpResponse.json(status)),
  http.post(`${B}/admin/mail/test`, () => {
    const g = needAdmin(); if (g) return g;
    if (!status.enabled) return problem(422, 'mail_not_configured', 'Mail is not configured');
    const at = new Date().toISOString();
    status = { ...status, state: 'verified', verified_at: at, last_sent_at: at };
    return HttpResponse.json({ mail_id: crypto.randomUUID(), outcome: 'sent', error: null, to: 's***@example.test' });
  }),
  http.get(`${B}/admin/mail/outbox`, ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const s = new URL(request.url).searchParams.get('status');
    const items = outbox.filter((m) => !s || m.status === s);
    return HttpResponse.json({ items, page: { limit: 50, next_cursor: null } });
  }),
  http.post(`${B}/admin/mail/outbox/:id/retry`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const b = (await request.json().catch(() => ({}))) as { reason?: string };
    if ((b.reason ?? '').trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'too_small' }] });
    const m = outbox.find((x) => x.id === params.id);
    if (!m) return problem(404, 'not_found', 'Mail not found');
    if (m.status !== 'dead') return problem(409, 'invalid_transition', 'Only a mail that was given up can be sent again');
    outbox = outbox.map((x) => (x.id === m.id ? { ...x, status: 'queued', attempts: 0, last_error: null } : x));
    return HttpResponse.json({ id: m.id, status: 'queued' });
  }),
  http.get(`${B}/admin/log-integrity/runs`, () => needAdmin() ?? HttpResponse.json({ items: runs, page: { limit: 20, next_cursor: null } })),
  http.get(`${B}/admin/log-integrity/runs/:id`, ({ params }) => {
    const g = needAdmin(); if (g) return g;
    const r = runs.find((x) => x.id === params.id);
    return r ? HttpResponse.json(r) : problem(404, 'not_found', 'Not found');
  }),
  http.post(`${B}/admin/log-integrity/runs`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const b = (await request.json().catch(() => ({}))) as { log?: string };
    if (b.log !== 'audit' && b.log !== 'security') return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/log', code: 'invalid' }] });
    if (runs.some((r) => r.log === b.log && r.status === 'running')) return problem(409, 'invalid_transition', 'An integrity check of this log is running already');
    const run: LogIntegrityRun = { id: crypto.randomUUID(), log: b.log, trigger: 'manual', status: 'running', started_at: new Date().toISOString(), finished_at: null, requested_by: null,
      from_seq: 1, to_seq: 905, checked_through: 0, row_count: 0, progress: 0, break_count: 0, breaks: [], head_hash: null, anchor_check: null, anchor_ref: null, error: null, job_run_id: null };
    // the job "finishes" after the first poll
    runs = [run, ...runs];
    setTimeout(() => { runs = runs.map((r) => (r.id === run.id ? { ...r, status: 'ok', progress: 100, checked_through: 905, row_count: 905, head_hash: 'b'.repeat(64), finished_at: new Date().toISOString() } : r)); }, 50);
    return HttpResponse.json(run, { status: 202 });
  }),
  http.get(`${B}/health`, () => HttpResponse.json({ status: 'ok', checks: { database: 'ok', mail: status.enabled ? 'ok' : 'disabled', integrity: 'ok', jobs: 'ok' } })),
];
