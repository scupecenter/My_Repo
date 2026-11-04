// Logs and monitoring (CHANGELOG 74). The paths marked "not in the contract yet" use the hand-written types below,
// so they are easy to swap for the generated ones once contracts/openapi.yaml has them.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { api, ApiError, downloadFile } from './client';
import { trackRealJob } from '@/lib/hybrid';
import type { Job, UserPickerItem } from './types';
import type { components } from './schema';

export type AuditEntry = components['schemas']['AuditEntry'];

export type Via = 'manual' | 'template' | 'bulk' | 'api' | 'job';
export const VIAS: Via[] = ['manual', 'template', 'bulk', 'api', 'job'];
export type DeviceInfo = { browser: string; os: string; type: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'other' };
export type LogActor = { id: string; name: string; employee_id: string | null };
export type PagedList<T> = { items: T[]; page: { limit: number; next_cursor: string | null; total?: number } };

/** Fields the Audit Log rows carry once the server adds them; the contract's AuditEntry does not have them yet. */
export type AuditRow = AuditEntry & { via?: Via | null; device?: DeviceInfo | null; user_agent?: string | null; session_id?: string | null; auth_method?: 'local' | 'oidc' | null };

export type FieldChange = {
  id: string; audit_id: number; at: string; actor: LogActor; on_behalf_of: LogActor | null;
  entity_type: string; entity_id: string; entity_label: string; site_id: string | null; site_code: string | null; region_id: number | null;
  field: string; field_label_en: string; field_label_ar: string; old_value: unknown; new_value: unknown;
  via: Via; batch_id: string | null; ip: string | null; device: DeviceInfo; user_agent: string | null; session_id: string | null;
  auth_method: 'local' | 'oidc'; mfa: boolean; reason: string | null;
};

export type AdminSession = {
  session_id: string; user: { id: string; display_name: string; employee_id: string | null }; started_at: string; last_activity_at: string;
  ip: string | null; device: DeviceInfo; current_screen: string | null; auth_method: 'local' | 'oidc'; mfa: boolean;
};
export type JobRun = { id: string; name: string; started_at: string; finished_at: string | null; outcome: 'ok' | 'failed' | 'running'; rows: number | null; error: string | null };
export type Deployment = { id: string; at: string; version: string; git_sha: string; migrations: string[]; by: string };
export type SecurityAlert = { id: string; at: string; rule: string; severity: 'info' | 'low' | 'medium' | 'high' | 'critical'; summary: string; detail: string | null; status: 'open' | 'acknowledged'; ack_by: string | null; ack_at: string | null };
export type ActivityReport = {
  month: string;
  users: { user: { id: string; display_name: string; employee_id: string | null }; actions: number; field_changes: number; approvals: number; sign_ins: number; failed_sign_ins: number }[];
  sensitive: { at: string; actor: { id: string; display_name: string; employee_id: string | null }; action: string; entity_type: string; entity_label: string; summary: string }[];
};

// ---------------------------------------------------------------- filters shared by the Audit Log and Field changes
export type LogFilter = {
  actor: UserPickerItem | null; site: { id: string; code: string } | null; region: string; entity_type: string; entity_id: string; action: string; field: string;
  from: string; to: string; via: string; ip: string; q: string;
};
export const EMPTY_FILTER: LogFilter = { actor: null, site: null, region: '', entity_type: '', entity_id: '', action: '', field: '', from: '', to: '', via: '', ip: '', q: '' };

/** Query parameters of one screen; empty values are dropped by the client. `kind` decides which of the filters the path knows. */
export function filterQuery(f: LogFilter, kind: 'audit' | 'field') {
  return {
    actor_id: f.actor?.id, site_id: f.site?.id, region_id: f.region, entity_type: f.entity_type, entity_id: f.entity_id,
    from: f.from ? `${f.from}T00:00:00Z` : '', to: f.to ? `${f.to}T23:59:59Z` : '', via: f.via, ip: f.ip,
    ...(kind === 'audit' ? { action: f.action, q: f.q } : { field: f.field }),
  };
}

function usePaged<T>(key: string, path: string, query: Record<string, string | number | undefined | null>, opts: { enabled?: boolean; limit?: number; live?: boolean } = {}) {
  const q = useInfiniteQuery({
    queryKey: [key, query], enabled: opts.enabled ?? true, initialPageParam: '' as string,
    queryFn: ({ pageParam }) => api.get<PagedList<T>>(path, { query: { ...query, limit: opts.limit ?? 50, cursor: pageParam || undefined }, headers: opts.live ? { 'X-PMIS-Live': '1' } : undefined }),
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
  });
  return Object.assign(q, { items: q.data?.pages.flatMap((p) => p.items) ?? [] });
}

export const useAuditLog = (f: LogFilter) => usePaged<AuditRow>('audit-log', '/audit-log', filterQuery(f, 'audit'));
export const useFieldChanges = (f: LogFilter) => usePaged<FieldChange>('field-changes', '/audit-log/field-changes', filterQuery(f, 'field'));

/** Fetches only when `enabled` (the popover is open). Newest first. */
export const useFieldHistory = (entityType: string, entityId: string, field: string, enabled: boolean) =>
  useQuery({
    queryKey: ['field-history', entityType, entityId, field], enabled,
    queryFn: () => api.get<{ items: FieldChange[] }>('/audit-log/field-history', { query: { entity_type: entityType, entity_id: entityId, field } }).then((r) => r.items),
  });

/** Starts a CSV export job and polls it; resolves with the downloaded file name. */
export async function runExport(path: string, body: Record<string, unknown>) {
  const job = await api.post<Job>(path, { idempotencyKey: crypto.randomUUID(), body });
  trackRealJob(job.id);
  for (let i = 0; i < 30; i++) {
    const j = await api.get<Job>(`/jobs/${job.id}`);
    if (j.status === 'failed') throw new ApiError(500, j.error ?? ({ type: 'about:blank', title: 'Export failed', status: 500, code: 'unknown' } as never));
    // log exports carry result.download_path (result_file_id stays null for them); other exports use the file id
    const dl = (j.result as { download_path?: string } | null | undefined)?.download_path;
    if (j.status === 'done' && dl) return downloadFile(dl);
    if (j.status === 'done' && j.result_file_id) return downloadFile(`/files/${j.result_file_id}/download`);
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('export timeout');
}
export const exportAuditLog = (f: LogFilter) => runExport('/audit-log/exports', Object.fromEntries(Object.entries(filterQuery(f, 'audit')).filter(([, v]) => v !== undefined && v !== '')));

// ---------------------------------------------------------------- who is online
export const ONLINE_POLL_MS = 15_000;
type Snap = { rollback: () => void };
export const useAdminSessions = () =>
  useQuery({ queryKey: ['admin-sessions'], refetchInterval: ONLINE_POLL_MS, refetchIntervalInBackground: false, queryFn: () => api.get<{ items: AdminSession[] }>('/admin/sessions', { headers: { 'X-PMIS-Live': '1' } }).then((r) => r.items) });
export function useEndSession() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { session: AdminSession; reason: string }, Snap>({
    mutationFn: ({ session, reason }) => api.post(`/admin/sessions/${session.session_id}/end`, { body: { reason } }),
    onMutate: async ({ session }) => {
      await qc.cancelQueries({ queryKey: ['admin-sessions'] });
      const prev = qc.getQueryData<AdminSession[]>(['admin-sessions']);
      qc.setQueryData<AdminSession[]>(['admin-sessions'], (d) => d?.filter((s) => s.session_id !== session.session_id));
      return { rollback: () => qc.setQueryData(['admin-sessions'], prev) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['admin-sessions'] }),
  });
}

// ---------------------------------------------------------------- alerts, job runs, deployments, report
export const useJobRuns = (enabled = true) => usePaged<JobRun>('job-runs', '/admin/job-runs', {}, { enabled });
export const useDeployments = (enabled = true) => usePaged<Deployment>('deployments', '/admin/deployments', {}, { enabled });
export const useAlerts = (status: string) => usePaged<SecurityAlert>('security-alerts', '/admin/security-alerts', { status }, { limit: 50 });
/** Open alerts for the badge in the menu. Timer-driven, so it never counts as activity. */
export const useOpenAlertCount = (enabled: boolean) =>
  useQuery({
    queryKey: ['security-alerts-open-count'], enabled, refetchInterval: 60_000, refetchIntervalInBackground: false,
    queryFn: () => api.get<PagedList<SecurityAlert>>('/admin/security-alerts', { query: { status: 'open', limit: 100 }, headers: { 'X-PMIS-Live': '1' } }).then((r) => r.page.total ?? r.items.length),
  });
export function useAckAlert() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { alert: SecurityAlert; note: string; by: string }, { rollback: () => void }>({
    mutationFn: ({ alert, note }) => api.post(`/admin/security-alerts/${alert.id}/ack`, { body: { note } }),
    onMutate: async ({ alert, by }) => {
      await qc.cancelQueries({ queryKey: ['security-alerts'] });
      const snaps = qc.getQueriesData<InfiniteData<PagedList<SecurityAlert>>>({ queryKey: ['security-alerts'] });
      const count = qc.getQueryData<number>(['security-alerts-open-count']);
      snaps.forEach(([k, d]) => d && qc.setQueryData(k, { ...d, pages: d.pages.map((p) => ({ ...p, items: p.items.map((a) => (a.id === alert.id ? { ...a, status: 'acknowledged' as const, ack_by: by, ack_at: new Date().toISOString() } : a)) })) }));
      if (count !== undefined) qc.setQueryData(['security-alerts-open-count'], Math.max(0, count - 1));
      return { rollback: () => { snaps.forEach(([k, d]) => qc.setQueryData(k, d)); qc.setQueryData(['security-alerts-open-count'], count); } };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['security-alerts'] }); void qc.invalidateQueries({ queryKey: ['security-alerts-open-count'] }); },
  });
}
export const useActivityReport = (month: string) => useQuery({ queryKey: ['activity-report', month], queryFn: () => api.get<ActivityReport>('/reports/activity', { query: { month } }) });

// ---------------------------------------------------------------- P9 (contract 0.12.3): mail delivery, integrity runs, alert rules, activity workbook
export type MailStatus = components['schemas']['MailStatus'];
export type MailOutboxItem = components['schemas']['MailOutboxItem'];
export type MailTestResult = components['schemas']['MailTestResult'];
export type LogIntegrityRun = components['schemas']['LogIntegrityRun'];
export type AlertSettings = components['schemas']['SecurityAlertSettings'];
export type AlertSettingsInput = components['schemas']['SecurityAlertSettingsInput'];
export type Severity = components['schemas']['AlertSeverity'];
export const SEVERITIES: Severity[] = ['info', 'low', 'medium', 'high', 'critical'];
export const RULES_WITH_SEVERITY = ['failed_sign_ins', 'failed_sign_ins_ip', 'new_ip', 'large_export', 'admin_set_changed', 'alert_settings_weakened', 'malware_upload', 'break_glass_used'] as const;

export const useMailStatus = () => useQuery({ queryKey: ['mail-status'], queryFn: () => api.get<MailStatus>('/admin/mail/status') });
export const useMailOutbox = (status: string) => usePaged<MailOutboxItem>('mail-outbox', '/admin/mail/outbox', { status: status || undefined });
export function useSendTestMail() {
  const qc = useQueryClient();
  return useMutation<MailTestResult, ApiError, void>({
    mutationFn: () => api.post<MailTestResult>('/admin/mail/test'),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['mail-status'] }); void qc.invalidateQueries({ queryKey: ['mail-outbox'] }); },
  });
}
export function useRetryMail() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { id: string; reason: string }>({
    mutationFn: ({ id, reason }) => api.post(`/admin/mail/outbox/${id}/retry`, { body: { reason } }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['mail-outbox'] }); void qc.invalidateQueries({ queryKey: ['mail-status'] }); },
  });
}

/** Polls every 2 s while a run of the list is still running. */
export const INTEGRITY_POLL_MS = 2_000;
export const useIntegrityRuns = () =>
  useQuery({
    queryKey: ['integrity-runs'],
    queryFn: () => api.get<PagedList<LogIntegrityRun>>('/admin/log-integrity/runs', { query: { limit: 20 }, headers: { 'X-PMIS-Live': '1' } }).then((r) => r.items),
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => r.status === 'running') ? INTEGRITY_POLL_MS : false),
  });
export function useStartIntegrityRun() {
  const qc = useQueryClient();
  return useMutation<LogIntegrityRun, ApiError, 'audit' | 'security'>({
    mutationFn: (log) => api.post<LogIntegrityRun>('/admin/log-integrity/runs', { body: { log } }),
    onSuccess: (run) => qc.setQueryData<LogIntegrityRun[]>(['integrity-runs'], (d) => [run, ...(d ?? []).filter((r) => r.id !== run.id)]),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['integrity-runs'] }),
  });
}

export const useAlertSettings = () => useQuery({ queryKey: ['alert-settings'], queryFn: () => api.get<AlertSettings>('/settings/security-alerts') });
export function useSetAlertSettings() {
  const qc = useQueryClient();
  return useMutation<AlertSettings, ApiError, { version: number; body: AlertSettingsInput }>({
    mutationFn: ({ version, body }) => api.put<AlertSettings>('/settings/security-alerts', { version, body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['alert-settings'] }),
  });
}

/** The monthly workbook (Q169): six sheets, no security log. Resolves with the file name. */
export const downloadActivityXlsx = (month: string) => downloadFile('/reports/activity', { month, format: 'xlsx' });
