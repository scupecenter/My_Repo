// MSW handlers for the logs core (contract 0.10.0, migration 0045): Audit Log list and exports, field changes and field history,
// Online now for the logs screens, job runs, deployments, security alerts and their thresholds, the System Log and the monthly
// activity report. Synthetic data only. The security log, the integrity checks, /sessions/active and the retention stay in handlers.settings.ts.
import { http, HttpResponse } from 'msw';
import { API_BASE } from '@/api/client';
import { viewer } from './db';
import { guard, problem } from './handlers';

const B = API_BASE;
const isAdmin = () => viewer()?.key === 'pm';
const needAdmin = () => guard() ?? (isAdmin() ? null : problem(403, 'action_forbidden', 'Administrators only'));
const pageOf = <T,>(items: T[], limit = 50) => HttpResponse.json({ items: items.slice(0, limit), page: { limit, next_cursor: null, total: items.length } });
const lim = (u: URL) => Math.min(200, Math.max(1, Number(u.searchParams.get('limit') ?? 50) || 50));
const VIAS = ['manual', 'template', 'bulk', 'api', 'job'] as const;

const ACTOR = { id: '00000000-0000-4000-8000-000000001204', display_name: 'Sara Ben Ali (synthetic)', employee_id: '1204' };
const LEAD = { id: '00000000-0000-4000-8000-000000002301', display_name: 'Omar Haddad (synthetic)', employee_id: '2301' };
const CHROME = { browser: 'Chrome', os: 'Windows', type: 'desktop' } as const;
const PHONE = { browser: 'Safari', os: 'iOS', type: 'mobile' } as const;
const RECORD = '7a000000-0000-4000-8000-000000000001';

const audit = [
  { id: 905, at: '2026-11-02T09:41:12.004211Z', actor: ACTOR, on_behalf_of: null, on_behalf_kind: null, action: 'register_record_update', entity_type: 'register_record',
    entity_id: '7b000000-0000-4000-8000-000000000003', site_id: '5a000000-0000-4000-8000-000000000001', site_code: 'TR-0001', region_id: 1, module_key: 'gecol',
    before: { data: { pr_no: 'GP-1' } }, after: { data: { pr_no: 'GP-2' } }, reason: null, bulk_action_id: null, batch_id: null, batch_row: null, is_admin_override: false,
    privileged: false, stepup_verified: false, mfa: false, self_approval: false, ip: '10.20.1.15', user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0', request_id: 'req-905',
    session_id: '6a000000-0000-4000-8000-000000000001', auth_method: 'local', via: 'manual', device: CHROME, job_name: null, chain_seq: 905 },
  { id: 904, at: '2026-11-02T09:10:00.000000Z', actor: LEAD, on_behalf_of: null, on_behalf_kind: null, action: 'register_record_approve', entity_type: 'register_record',
    entity_id: '7b000000-0000-4000-8000-000000000002', site_id: '5a000000-0000-4000-8000-000000000001', site_code: 'TR-0001', region_id: 1, module_key: 'gecol',
    before: { state: 'in_approval' }, after: { state: 'approved' }, reason: null, bulk_action_id: null, batch_id: '8a000000-0000-4000-8000-000000000001', batch_row: null,
    is_admin_override: false, privileged: false, stepup_verified: true, mfa: true, self_approval: false, ip: '10.20.4.9', user_agent: 'Mozilla/5.0 (iPhone) Safari', request_id: 'req-904',
    session_id: '6a000000-0000-4000-8000-000000000002', auth_method: 'local', via: 'template', device: PHONE, job_name: null, chain_seq: 904 },
  { id: 903, at: '2026-11-02T02:00:03.120000Z', actor: null, on_behalf_of: null, on_behalf_kind: null, action: 'sla_set_applied', entity_type: 'sla_rule_set', entity_id: 'S-12',
    site_id: null, site_code: null, region_id: null, module_key: 'sla_rules', before: null, after: { tasks: 4 }, reason: null, bulk_action_id: null, batch_id: null, batch_row: null,
    is_admin_override: false, privileged: true, stepup_verified: false, mfa: false, self_approval: false, ip: null, user_agent: null, request_id: null, session_id: null,
    auth_method: null, via: 'job', device: null, job_name: 'daily', chain_seq: 903 },
];

const changes = [
  { id: '3001', audit_id: 905, at: '2026-11-02T09:41:12.004211Z', actor: { ...ACTOR, name: ACTOR.display_name }, on_behalf_of: null, action: 'register_record_update',
    entity_type: 'register_record', entity_id: RECORD, record_id: '7b000000-0000-4000-8000-000000000003', entity_label: 'GECOL · TR-0001',
    site_id: '5a000000-0000-4000-8000-000000000001', site_code: 'TR-0001', region_id: 1, module_key: 'gecol', field: 'pr_no', field_label_en: 'GECOL PR No.',
    field_label_ar: 'رقم طلب الكهرباء', old_value: 'GP-1', new_value: 'GP-2', via: 'manual', batch_id: null, ip: '10.20.1.15', device: CHROME,
    user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0', session_id: '6a000000-0000-4000-8000-000000000001', request_id: 'req-905', auth_method: 'local', mfa: false, reason: null },
  { id: '2950', audit_id: 870, at: '2026-10-30T11:02:00.000000Z', actor: { ...LEAD, name: LEAD.display_name }, on_behalf_of: null, action: 'register_record_create',
    entity_type: 'register_record', entity_id: RECORD, record_id: '7b000000-0000-4000-8000-000000000001', entity_label: 'GECOL · TR-0001',
    site_id: '5a000000-0000-4000-8000-000000000001', site_code: 'TR-0001', region_id: 1, module_key: 'gecol', field: 'pr_no', field_label_en: 'GECOL PR No.',
    field_label_ar: 'رقم طلب الكهرباء', old_value: null, new_value: 'GP-1', via: 'template', batch_id: '8a000000-0000-4000-8000-000000000001', ip: '10.20.4.9', device: PHONE,
    user_agent: 'Mozilla/5.0 (iPhone) Safari', session_id: '6a000000-0000-4000-8000-000000000002', request_id: 'req-870', auth_method: 'local', mfa: true, reason: null },
];

type MockAlert = { id: string; at: string; rule: string; severity: string; summary: string; detail: string | null; data: Record<string, unknown> | null; status: string;
  user: typeof ACTOR | null; ip: string | null; ack_by: string | null; ack_by_user: typeof ACTOR | null; ack_at: string | null; ack_note: string | null };
let alerts: MockAlert[] = [
  { id: '9b000000-0000-4000-8000-000000000001', at: '2026-11-02T08:15:00.000000Z', rule: 'failed_sign_ins', severity: 'medium', summary: 'Repeated failed sign-ins for one account or identifier',
    detail: 'At least 5 failures within 15 minutes (key ?a***#3f9c01d2ab47).', data: { key: '?a***#3f9c01d2ab47', count_at_least: 5, minutes: 15 }, status: 'open', user: null, ip: null,
    ack_by: null, ack_by_user: null, ack_at: null, ack_note: null },
  { id: '9b000000-0000-4000-8000-000000000002', at: '2026-11-01T17:40:00.000000Z', rule: 'retention_reduced', severity: 'critical', summary: 'Log retention was reduced',
    detail: 'Retention reduced (audit row 880).', data: { audit_id: 880 }, status: 'acknowledged', user: ACTOR, ip: '10.20.1.15', ack_by: LEAD.display_name, ack_by_user: LEAD,
    ack_at: '2026-11-01T18:00:00.000000Z', ack_note: 'Agreed with the owner' },
];
const SEVS = ['info', 'low', 'medium', 'high', 'critical'];
const DEFAULT_SEV: Record<string, string> = { failed_sign_ins: 'medium', failed_sign_ins_ip: 'medium', new_ip: 'low', large_export: 'medium', admin_set_changed: 'high',
  alert_settings_weakened: 'high', malware_upload: 'high', break_glass_used: 'critical' };
let thresholds = { failed_sign_ins: { count: 5, minutes: 15 }, failed_by_ip: { count: 20, minutes: 15 }, large_export_rows: 5000, new_ip: true,
  severity: { ...DEFAULT_SEV }, mandatory_severity: { retention_reduced: 'critical', audit_integrity_failure: 'critical' }, email_min_severity: 'low', trusted_networks: [] as string[], version: 1, updated_at: null as string | null, updated_by: null as unknown };
let sessions = [
  { session_id: '6a000000-0000-4000-8000-000000000001', user: ACTOR, status: 'online', started_at: '2026-11-02T07:30:00Z', last_activity_at: '2026-11-02T09:41:12Z', ip: '10.20.1.15',
    device: CHROME, current_screen: '/registers/gecol', auth_method: 'local', mfa: false, is_current: false },
  { session_id: '6a000000-0000-4000-8000-000000000002', user: LEAD, status: 'idle', started_at: '2026-11-02T06:55:00Z', last_activity_at: '2026-11-02T09:10:00Z', ip: '10.20.4.9',
    device: PHONE, current_screen: '/approvals', auth_method: 'local', mfa: true, is_current: false },
];
const exportsDone = new Set<string>();

export const logsHandlers = [
  http.get(`${B}/audit-log`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url);
    const via = u.searchParams.get('via');
    if (via && !(VIAS as readonly string[]).includes(via)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/via', code: 'invalid' }] });
    const f = (k: string) => u.searchParams.get(k);
    const rows = audit.filter((a) => (!via || a.via === via) && (!f('region_id') || String(a.region_id) === f('region_id')) && (!f('ip') || a.ip === f('ip'))
      && (!f('entity_type') || a.entity_type === f('entity_type')) && (!f('action') || a.action === f('action')) && (!f('actor_id') || a.actor?.id === f('actor_id')));
    return pageOf(rows, lim(u));
  }),
  http.post(`${B}/audit-log/exports`, () => {
    const g = guard(); if (g) return g;
    const id = crypto.randomUUID(); exportsDone.add(id);
    return HttpResponse.json({ id, kind: 'audit_export', status: 'queued', progress: 0, result_file_id: null, created_at: new Date().toISOString(), finished_at: null }, { status: 202 });
  }),
  http.get(`${B}/jobs/:id`, ({ params }) => {
    const id = String(params.id);
    if (!exportsDone.has(id)) return undefined; // other jobs: the other mock files answer
    return HttpResponse.json({ id, kind: 'audit_export', status: 'done', progress: 1, result_file_id: null, created_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      result: { export_id: id, row_count: audit.length, size_bytes: 512, expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), download_path: `/audit-log/exports/${id}/download` } });
  }),
  http.get(`${B}/audit-log/exports/:id/download`, () => new HttpResponse('﻿"id","at","action"\r\n"905","2026-11-02T09:41:12.004211Z","register_record_update"\r\n',
    { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="GSDN_AuditLog_20261102.csv"' } })),
  http.get(`${B}/audit-log/field-changes`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url);
    const f = (k: string) => u.searchParams.get(k);
    return pageOf(changes.filter((c) => (!f('entity_type') || c.entity_type === f('entity_type')) && (!f('entity_id') || c.entity_id === f('entity_id')) && (!f('field') || c.field === f('field'))
      && (!f('via') || c.via === f('via'))), lim(u));
  }),
  http.get(`${B}/audit-log/field-history`, ({ request }) => {
    const g = guard(); if (g) return g;
    const u = new URL(request.url);
    const missing = ['entity_type', 'entity_id', 'field'].filter((k) => !u.searchParams.get(k));
    if (missing.length) return problem(422, 'validation_failed', 'Validation failed', { errors: missing.map((k) => ({ path: `/${k}`, code: 'required' })) });
    const items = changes.filter((c) => c.entity_type === u.searchParams.get('entity_type') && c.field === u.searchParams.get('field')
      && (c.entity_id === u.searchParams.get('entity_id') || u.searchParams.get('entity_type') === 'task'));
    return HttpResponse.json({ items });
  }),
  http.get(`${B}/system-log`, ({ request }) => {
    const g = needAdmin(); if (g) return g;
    return pageOf([
      { id: 77, at: '2026-11-02T09:00:01Z', level: 'warn', source: 'template-check', code: null, message: 'template rejected: tpl_invalid', request_id: 'req-77', user: ACTOR, route: 'POST /api/v1/import-batches', details: {} },
      { id: 76, at: '2026-11-02T02:00:04Z', level: 'info', source: 'job', code: null, message: 'daily job ran', request_id: null, user: null, route: null, details: { sla_applied: 4 } },
    ], lim(new URL(request.url)));
  }),
  http.get(`${B}/admin/sessions`, () => {
    const g = needAdmin(); if (g) return g;
    return pageOf(sessions);
  }),
  http.post(`${B}/admin/sessions/:id/end`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const b = (await request.json().catch(() => ({}))) as { reason?: string };
    if ((b.reason ?? '').trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/reason', code: 'required' }] });
    const s = sessions.find((x) => x.session_id === params.id);
    if (!s) return problem(404, 'not_found', 'Session not found');
    sessions = sessions.filter((x) => x !== s);
    return HttpResponse.json({ user: s.user, revoked_count: 1 });
  }),
  http.get(`${B}/admin/job-runs`, () => {
    const g = needAdmin(); if (g) return g;
    return pageOf([
      { id: '4a000000-0000-4000-8000-000000000003', name: 'security_alerts', started_at: '2026-11-02T09:40:00.000000Z', finished_at: '2026-11-02T09:40:00.210000Z', outcome: 'ok', rows: 0, error: null, detail: null, host: 'pmis-app' },
      { id: '4a000000-0000-4000-8000-000000000002', name: 'daily', started_at: '2026-11-02T00:00:00.000000Z', finished_at: '2026-11-02T00:00:03.400000Z', outcome: 'ok', rows: 4, error: null, detail: { sla_applied: 4 }, host: 'pmis-app' },
      { id: '4a000000-0000-4000-8000-000000000001', name: 'log_purge', started_at: '2026-11-01T00:01:00.000000Z', finished_at: '2026-11-01T00:01:00.900000Z', outcome: 'failed', rows: null, error: 'statement timeout', detail: null, host: 'pmis-app' },
    ]);
  }),
  http.get(`${B}/admin/deployments`, () => {
    const g = needAdmin(); if (g) return g;
    return pageOf([{ id: '3', at: '2026-11-02T06:00:00Z', version: '0.10.0', git_sha: 'e173644fb4c6', migrations: ['0045_logs_core'], by: 'admin.ops', host: 'pmis-app' }]);
  }),
  http.get(`${B}/admin/security-alerts`, ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const u = new URL(request.url);
    const st = u.searchParams.get('status');
    return pageOf(alerts.filter((a) => !st || a.status === st), lim(u));
  }),
  http.post(`${B}/admin/security-alerts/:id/ack`, async ({ params, request }) => {
    const g = needAdmin(); if (g) return g;
    const b = (await request.json().catch(() => ({}))) as { note?: string };
    if ((b.note ?? '').trim().length < 3) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/note', code: 'too_small' }] });
    const a = alerts.find((x) => x.id === params.id);
    if (!a) return problem(404, 'not_found', 'Alert not found');
    if (a.status !== 'open') return problem(409, 'invalid_transition', 'Already acknowledged');
    const done = { ...a, status: 'acknowledged', ack_by: viewer()?.name ?? 'Admin', ack_at: new Date().toISOString(), ack_note: b.note ?? null };
    alerts = alerts.map((x) => (x.id === a.id ? done : x));
    return HttpResponse.json(done);
  }),
  http.get(`${B}/settings/security-alerts`, () => {
    const g = needAdmin(); if (g) return g;
    return HttpResponse.json(thresholds, { headers: { ETag: `"${thresholds.version}"` } });
  }),
  http.put(`${B}/settings/security-alerts`, async ({ request }) => {
    const g = needAdmin(); if (g) return g;
    const h = request.headers.get('If-Match');
    if (!h) return problem(428, 'precondition_required', 'If-Match is required');
    if (Number(h.replace(/"/g, '')) !== thresholds.version) return problem(412, 'precondition_failed', 'Changed by someone else; reload');
    const b = (await request.json().catch(() => ({}))) as { reason?: string; failed_sign_ins?: { count: number; minutes: number }; failed_by_ip?: { count: number; minutes: number }; large_export_rows?: number; new_ip?: boolean;
      severity?: Record<string, string>; email_min_severity?: string; trusted_networks?: string[] };
    const errors: { path: string; code: string }[] = [];
    const inr = (v: unknown, a: number, z: number) => typeof v === 'number' && Number.isInteger(v) && v >= a && v <= z;
    if ((b.reason ?? '').trim().length < 3) errors.push({ path: '/reason', code: 'required' });
    if (!inr(b.failed_sign_ins?.count, 3, 100)) errors.push({ path: '/failed_sign_ins/count', code: 'out_of_range' });
    if (!inr(b.failed_sign_ins?.minutes, 1, 1440)) errors.push({ path: '/failed_sign_ins/minutes', code: 'out_of_range' });
    if (!inr(b.failed_by_ip?.count, 5, 1000)) errors.push({ path: '/failed_by_ip/count', code: 'out_of_range' });
    if (!inr(b.failed_by_ip?.minutes, 1, 1440)) errors.push({ path: '/failed_by_ip/minutes', code: 'out_of_range' });
    if (!inr(b.large_export_rows, 100, 1_000_000)) errors.push({ path: '/large_export_rows', code: 'out_of_range' });
    if (typeof b.new_ip !== 'boolean') errors.push({ path: '/new_ip', code: 'invalid' });
    for (const [k, v] of Object.entries(b.severity ?? {})) {
      if (!(k in DEFAULT_SEV)) errors.push({ path: `/severity/${k}`, code: k in thresholds.mandatory_severity ? 'mandatory_locked' : 'unknown_field' });
      else if (!SEVS.includes(v)) errors.push({ path: `/severity/${k}`, code: 'invalid' });
    }
    if (b.email_min_severity !== undefined && !SEVS.includes(b.email_min_severity)) errors.push({ path: '/email_min_severity', code: 'invalid' });
    for (const n of b.trusted_networks ?? []) if (!/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(n)) errors.push({ path: '/trusted_networks', code: 'invalid' });
    if (errors.length) return problem(422, 'validation_failed', 'Validation failed', { errors });
    thresholds = { ...thresholds, failed_sign_ins: b.failed_sign_ins!, failed_by_ip: b.failed_by_ip!, large_export_rows: b.large_export_rows!, new_ip: b.new_ip!,
      severity: { ...thresholds.severity, ...(b.severity ?? {}) }, email_min_severity: b.email_min_severity ?? thresholds.email_min_severity,
      trusted_networks: b.trusted_networks ?? thresholds.trusted_networks, version: thresholds.version + 1,
      updated_at: new Date().toISOString(), updated_by: ACTOR };
    return HttpResponse.json(thresholds, { headers: { ETag: `"${thresholds.version}"` } });
  }),
  http.get(`${B}/reports/activity`, ({ request }) => {
    const g = guard(); if (g) return g;
    const month = new URL(request.url).searchParams.get('month') ?? '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return problem(422, 'validation_failed', 'Validation failed', { errors: [{ path: '/month', code: 'invalid' }] });
    // 0.12.3 (Q169): the workbook; the mock answers a tiny placeholder file with the real headers
    if (new URL(request.url).searchParams.get('format') === 'xlsx') {
      return new HttpResponse(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="GSDN_ActivityReport_${month}.xlsx"` } });
    }
    return HttpResponse.json({
      month, from: `${month}-01T00:00:00+02:00`, to: `${month}-28T00:00:00+02:00`, scope: 'all', includes_security_log: true,
      users: [
        { user: ACTOR, actions: 42, field_changes: 118, approvals: 0, sign_ins: 19, failed_sign_ins: 1 },
        { user: LEAD, actions: 27, field_changes: 6, approvals: 21, sign_ins: 22, failed_sign_ins: 0 },
      ],
      sensitive: [
        { id: 880, at: `${month}-01T17:39:00Z`, actor: ACTOR, action: 'log_retention_reduced', entity_type: 'setting', entity_id: 'logs.retention', entity_label: 'setting logs.retention',
          kind: 'settings', reason: 'Agreed with the owner', is_admin_override: false, summary: 'log_retention_reduced: Agreed with the owner' },
      ],
    });
  }),
];
