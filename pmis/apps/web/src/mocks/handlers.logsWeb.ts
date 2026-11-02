// MSW handlers for the logs and monitoring screens (CHANGELOG 74): the Audit Log list and export,
// field changes and field history, sessions, alerts, job runs, deployments and the monthly activity report.
// The state is per mock database, so resetDb() (test teardown) starts it again.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import type { AdminSession, AuditRow, Deployment, FieldChange, JobRun, SecurityAlert } from '@/api/logs';
import { db, save, stepUpValid, viewer, type Db } from './db';
import { guard, problem, stepUp } from './handlers';
import { buildAlerts, buildAudit, buildDeployments, buildFieldChanges, buildJobRuns, buildReport, buildSessions } from './logsWebData';

const B = API_BASE;
type State = { audit: AuditRow[]; fc: FieldChange[]; sessions: AdminSession[]; alerts: SecurityAlert[]; jobs: JobRun[]; deps: Deployment[]; reads: number };
const states = new WeakMap<Db, State>();
const S = (): State => {
  const d = db();
  let s = states.get(d);
  if (!s) { s = { audit: buildAudit(), fc: buildFieldChanges(), sessions: buildSessions(), alerts: buildAlerts(), jobs: buildJobRuns(), deps: buildDeployments(), reads: 0 }; states.set(d, s); }
  return s;
};
const isAdmin = () => viewer()?.key === 'pm';
const canRead = () => isAdmin() || viewer()?.key === 'auditor';
const needRead = () => guard() ?? (canRead() ? null : problem(403, 'action_forbidden', 'Needs view_audit'));
const needAdmin = () => guard() ?? (isAdmin() ? null : problem(403, 'action_forbidden', 'Administrators only'));
const fields = (path: string, code: string) => problem(422, 'validation_failed', 'Validation failed', { errors: [{ path, code }] });
const PAGE = 25;

/** Offset cursor over an already filtered, newest-first list. */
function paged<T>(all: T[], u: URLSearchParams) {
  const start = Number(u.get('cursor') || 0) || 0, size = Math.min(Number(u.get('limit')) || PAGE, PAGE);
  const items = all.slice(start, start + size), next = start + size < all.length ? String(start + size) : null;
  return HttpResponse.json({ items, page: { limit: size, next_cursor: next, total: all.length } });
}

type Row = { at: string; actor?: { id: string } | null; entity_type: string; entity_id?: string | null; site_id?: string | null; region_id?: number | string | null; via?: string | null; ip?: string | null };
function common<T extends Row>(rows: T[], u: URLSearchParams): T[] {
  const g = (k: string) => u.get(k) ?? '';
  const from = g('from'), to = g('to');
  return rows.filter((r) => (!g('actor_id') || r.actor?.id === g('actor_id')) && (!g('site_id') || r.site_id === g('site_id')) && (!g('region_id') || String(r.region_id) === g('region_id'))
    && (!g('entity_type') || r.entity_type === g('entity_type')) && (!g('entity_id') || r.entity_id === g('entity_id')) && (!g('via') || r.via === g('via'))
    && (!g('ip') || (r.ip ?? '').startsWith(g('ip'))) && (!from || r.at >= from) && (!to || r.at <= to));
}
const monthOk = (m: string | null) => !!m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

export const logsWebHandlers = [
  http.get(`${B}/audit-log/field-changes`, ({ request }) => {
    const g = needRead(); if (g) return g;
    const u = new URL(request.url).searchParams;
    S().reads += 1;
    const rows = common(S().fc, u).filter((r) => !u.get('field') || r.field === u.get('field'));
    return paged(rows, u);
  }),
  http.get(`${B}/audit-log/field-history`, ({ request }) => {
    const g = needRead(); if (g) return g;
    const u = new URL(request.url).searchParams;
    if (!u.get('entity_type') || !u.get('entity_id') || !u.get('field')) return fields('/field', 'required');
    const items = S().fc.filter((f) => f.entity_type === u.get('entity_type') && f.entity_id === u.get('entity_id') && f.field === u.get('field'));
    return HttpResponse.json({ items });
  }),
  http.get(`${B}/audit-log`, ({ request }) => {
    const g = needRead(); if (g) return g;
    const u = new URL(request.url).searchParams, a = u.get('action'), q = (u.get('q') ?? '').toLowerCase();
    S().reads += 1; // every read of the Audit Log is audited server-side
    const rows = common(S().audit, u)
      .filter((r) => (!a || r.action === a) && (!q || `${r.action} ${r.site_code ?? ''} ${r.actor?.display_name ?? ''} ${r.reason ?? ''}`.toLowerCase().includes(q)));
    return paged(rows, u);
  }),
  http.post(`${B}/audit-log/exports`, async ({ request }) => {
    const g = needRead(); if (g) return g;
    await request.json().catch(() => ({}));
    const id = `job-${crypto.randomUUID().slice(0, 8)}`;
    db().cfg.jobs[id] = { polls: 0 }; save();
    return HttpResponse.json({ id, kind: 'audit_export', status: 'queued' }, { status: 202 });
  }),

  http.get(`${B}/admin/sessions`, () => { const g = needAdmin(); if (g) return g; return HttpResponse.json({ items: S().sessions }); }),
  http.post(`${B}/admin/sessions/:id/end`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const s = S().sessions.find((x) => x.session_id === params.id);
    if (!s) return problem(404, 'not_found', 'Session not found');
    if (s.user.employee_id === viewer()!.employee_id) return problem(403, 'self_beneficiary', 'Use sign out for your own session');
    if (!stepUpValid()) return stepUp();
    const reason = ((await request.json().catch(() => ({}))) as { reason?: string }).reason ?? '';
    if (reason.trim().length < 3) return fields('/reason', 'required');
    S().sessions = S().sessions.filter((x) => x.session_id !== s.session_id);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(`${B}/admin/security-alerts`, ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const u = new URL(request.url).searchParams, st = u.get('status');
    return paged(S().alerts.filter((a) => !st || a.status === st), u);
  }),
  http.post(`${B}/admin/security-alerts/:id/ack`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const a = S().alerts.find((x) => x.id === params.id);
    if (!a) return problem(404, 'not_found', 'Alert not found');
    const note = ((await request.json().catch(() => ({}))) as { note?: string }).note ?? '';
    if (note.trim().length < 3) return fields('/note', 'required');
    Object.assign(a, { status: 'acknowledged', ack_by: viewer()!.name, ack_at: new Date().toISOString() });
    return HttpResponse.json(a);
  }),
  http.get(`${B}/admin/job-runs`, ({ request }) => { const g = needAdmin(); if (g) return g; return paged(S().jobs, new URL(request.url).searchParams); }),
  http.get(`${B}/admin/deployments`, ({ request }) => { const g = needAdmin(); if (g) return g; return paged(S().deps, new URL(request.url).searchParams); }),

  http.get(`${B}/reports/activity`, ({ request }) => {
    const g = needRead(); if (g) return g;
    const m = new URL(request.url).searchParams.get('month');
    if (!monthOk(m)) return fields('/month', 'invalid_month');
    return HttpResponse.json(buildReport(m!));
  }),
];
