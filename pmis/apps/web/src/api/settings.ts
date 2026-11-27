import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, ApiError, downloadFile, type RequestOptions } from './client';
import type { PasskeyItem, PasskeySetting, MyPasskeys, AlertRuleInput, AlertRuleSaved, AlertRulesResponse, IssueStoppedRowList, IssueTaskMapItem, IssueTaskMapList,
  ActiveSession, ActOnBehalfRequest, DownloadLocks, UiAsset, UiPublicIdentity, Calendar, CalendarConfirmation, MailNotificationKinds, ImportsSettings, ContractorPerformanceReport, ContractorPerformanceThresholds, ContractorPerformanceSettings, NavLayoutSetting, UiIdentity, UiBrand, LoginPage, SecurityLocks, SupportAccessSetting, Delegation, LoginPagePublic, SupportLink, NavLayoutT, ContractorRules, ContractorRulesInput, GecolHlcCounts, ContractorsCompletenessReport, TeamScopeMismatchReport, DeletedUser, PurgedUser, DlpSettings, DlpVersion, DlpVersionInput, Holiday, HolidayChangeResult, HolidayInput, HolidayPatch, HolidaySummary, IdleTaskAlertSetting, Job, LogIntegrity, LogRetention, LogRetentionInput, NewDeviceCodeSetting,
  NotificationPolicy, NotificationPolicyInput, NotificationTypeDef, Page, ReassignmentAlert, SecurityLogEntry, SessionRevokeResult, SlaPublishPreview, SlaRuleSet, SlaRuleSetPublishResult, SlaRuleSetSummary, SlaTaskRule, StaffCard, StaffVisibility, StructuralFreeze,
  TaskDefinition, TeamScopeMatch, TeamScopeMatchInput, TransitionResultT, User, UserDetail, WeekendDaysResult, WeightSet, WeightSetCode, WeightSetInput, WeightSetPreview, WeightSetPublishResult, WorkflowVersion, WorkflowVersionSummary,
} from './types';

const refresh = (qc: QueryClient, ...ks: string[]) => ks.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
type Snap = { rollback: () => void };

// ---------------------------------------------------------------- calendar
export const useHolidays = (year: number | null) =>
  useQuery({ queryKey: ['holidays', year], queryFn: () => api.get<{ items: Holiday[]; summary: HolidaySummary }>('/settings/holidays', { query: { year } }) });
export const useCalendar = () => useQuery({ queryKey: ['calendars'], queryFn: () => api.get<{ items: Calendar[] }>('/settings/calendars').then((r) => r.items[0]) });

export const useCreateHoliday = () => {
  const qc = useQueryClient();
  return useMutation<HolidayChangeResult, ApiError, HolidayInput>({ mutationFn: (body) => api.post('/settings/holidays', { body }), onSettled: () => refresh(qc, 'holidays', 'calendars') });
};
/** Edit or confirm a holiday; the row changes in the list at once and goes back if the server refuses. */
export function useHolidayChange() {
  const qc = useQueryClient();
  return useMutation<HolidayChangeResult, ApiError, { h: Holiday; patch: HolidayPatch | { reason: string; date?: string; confirm: true } }, Snap>({
    mutationFn: ({ h, patch }) => ('confirm' in patch
      ? api.post(`/settings/holidays/${h.id}/confirm`, { version: h.version, body: { reason: patch.reason, ...(patch.date ? { date: patch.date } : {}) } })
      : api.patch(`/settings/holidays/${h.id}`, { version: h.version, body: patch })),
    onMutate: async ({ h, patch }) => {
      await qc.cancelQueries({ queryKey: ['holidays'] });
      const snaps = qc.getQueriesData<{ items: Holiday[] }>({ queryKey: ['holidays'] });
      const { reason: _r, confirm, ...rest } = patch as Record<string, unknown>; void _r;
      snaps.forEach(([k, d]) => d && qc.setQueryData(k, { ...d, items: d.items.map((x) => (x.id === h.id ? { ...x, ...rest, ...(confirm ? { tentative: false } : {}) } : x)) }));
      return { rollback: () => snaps.forEach(([k, d]) => qc.setQueryData(k, d)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'holidays', 'calendars'),
  });
}
export function useDeleteHoliday() {
  const qc = useQueryClient();
  return useMutation<HolidayChangeResult, ApiError, { h: Holiday; reason: string }, Snap>({
    mutationFn: ({ h, reason }) => api.del(`/settings/holidays/${h.id}`, { version: h.version, query: { reason } }),
    onMutate: async ({ h }) => {
      await qc.cancelQueries({ queryKey: ['holidays'] });
      const snaps = qc.getQueriesData<{ items: Holiday[] }>({ queryKey: ['holidays'] });
      snaps.forEach(([k, d]) => d && qc.setQueryData(k, { ...d, items: d.items.filter((x) => x.id !== h.id) }));
      return { rollback: () => snaps.forEach(([k, d]) => qc.setQueryData(k, d)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'holidays', 'calendars'),
  });
}
export const useImportHolidays = () => {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, { file: File; reason: string }>({
    mutationFn: ({ file, reason }) => { const fd = new FormData(); fd.append('file', file); fd.append('reason', reason); return api.post('/settings/holidays/import', { idempotencyKey: crypto.randomUUID(), body: fd }); },
    onSettled: () => refresh(qc, 'holidays', 'calendars'),
  });
};
export const useSetWeekend = () => {
  const qc = useQueryClient();
  return useMutation<WeekendDaysResult, ApiError, { weekend_days: number[]; reason: string }>({ mutationFn: (body) => api.put('/settings/weekend-days', { body }), onSettled: () => refresh(qc, 'calendars') });
};

/** 0.14.2 (Q440): confirm or withdraw the official calendar. The ETag of the read is the If-Match of the write. */
export const useCalendarConfirmation = () => useQuery({ queryKey: ['calendar-confirmation'], queryFn: () => api.get<CalendarConfirmation>('/settings/calendar-confirmation') });
export const useSetCalendarConfirmation = () => {
  const qc = useQueryClient();
  return useMutation<CalendarConfirmation, ApiError, { version: number; confirmed: boolean; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/calendar-confirmation', { version, body }),
    onSettled: () => refresh(qc, 'calendar-confirmation', 'holidays', 'calendars'),
  });
};

/** 0.14.2 (Q441): the notification kinds that are also mailed (System Admin only; step-up on save). */
export const useMailKinds = () => useQuery({ queryKey: ['mail-kinds'], retry: false, queryFn: () => api.get<MailNotificationKinds>('/settings/mail-notification-kinds') });
export const useSetMailKinds = () => {
  const qc = useQueryClient();
  return useMutation<MailNotificationKinds, ApiError, { version: number; kinds: string[]; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/mail-notification-kinds', { version, body }), onSettled: () => refresh(qc, 'mail-kinds'),
  });
};

/** 0.15.261 (migration 0364): the mail policy (global switch, internal or external recipients, per kind). System Admin only; step-up on save. */
export type MailPolicyDoc = import('./schema').components['schemas']['MailPolicy'];
export type MailPolicySave = import('./schema').components['schemas']['MailPolicyInput'] & { reason: string };
export const useMailPolicy = () => useQuery({ queryKey: ['mail-policy'], retry: false, queryFn: () => api.get<MailPolicyDoc>('/settings/mail-policy') });
export const useSetMailPolicy = () => {
  const qc = useQueryClient();
  return useMutation<MailPolicyDoc, ApiError, { version: number } & MailPolicySave>({
    mutationFn: ({ version, ...body }) => api.put('/settings/mail-policy', { version, body }), onSettled: () => refresh(qc, 'mail-policy'),
  });
};

/** 0.14.6: the background threshold of batches (imports.async_rows). Read by everyone; changed by a System Admin or an all-regions delegate of settings, with a reason. */
/** 0.15.41 (migration 0130): Settings, Identity & themes. Saving refreshes /me so the design of the page follows at once. */
export const useUiIdentity = () => useQuery({ queryKey: ['ui-identity'], queryFn: () => api.get<UiIdentity>('/settings/identity') });
export const useSetUiIdentity = () => {
  const qc = useQueryClient();
  return useMutation<UiIdentity, ApiError, { version: number; default_brand: UiBrand; allow_user_choice: boolean; defaults?: UiIdentity['defaults']; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/identity', { version, body }), onSettled: () => refresh(qc, 'ui-identity', 'me', 'my-profile'),
  });
};
/** 0.15.97 (migration 0197): Settings, Screens, Login page. The public read answers only what the signed-out pages render. */
export const useLoginPage = () => useQuery({ queryKey: ['login-page'], queryFn: () => api.get<LoginPage>('/settings/login-page') });
export const useLoginPagePublic = () => useQuery({ queryKey: ['login-page-public'], queryFn: () => api.get<LoginPagePublic>('/settings/login-page/public'), staleTime: 30_000, retry: 1 });
export const useSetLoginPage = () => {
  const qc = useQueryClient();
  return useMutation<LoginPage, ApiError, { version: number; announcement_en: string; announcement_ar: string; announcement_kind: 'info' | 'maintenance'; animation: boolean; default_locale: 'en' | 'ar' | null; support_links: SupportLink[]; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/login-page', { version, body }), onSettled: () => refresh(qc, 'login-page', 'login-page-public'),
  });
};
/** 0.15.190 (migration 0290): the admin lock keys (setting security.locks). Read by everyone, changed by a System Admin only, with a reason and a step-up. */
export const useSecurityLocks = () => useQuery({ queryKey: ['security-locks'], queryFn: () => api.get<SecurityLocks>('/settings/security-locks') });
export const useSetSecurityLocks = () => {
  const qc = useQueryClient();
  return useMutation<SecurityLocks, ApiError, { version: number; block_public_sharing: boolean; disable_export: boolean; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/security-locks', { version, body }), onSettled: () => refresh(qc, 'security-locks'),
  });
};
/** 0.15.193 (migration 0293): the download lock categories (setting security.download_locks): templates, uploaded files, generated documents. */
export const useDownloadLocks = () => useQuery({ queryKey: ['download-locks'], queryFn: () => api.get<DownloadLocks>('/settings/download-locks') });
export const useSetDownloadLocks = () => {
  const qc = useQueryClient();
  return useMutation<DownloadLocks, ApiError, { version: number; templates: boolean; uploaded_files: boolean; generated_documents: boolean; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/download-locks', { version, body }), onSettled: () => refresh(qc, 'download-locks'),
  });
};
/** 0.15.191 (migration 0291): support access (setting security.support_access) and the support grants. System Admin only; a grant is a time-limited delegation. */
export const useSupportAccess = () => useQuery({ queryKey: ['support-access-setting'], queryFn: () => api.get<SupportAccessSetting>('/settings/support-access') });
export const useSetSupportAccess = () => {
  const qc = useQueryClient();
  return useMutation<SupportAccessSetting, ApiError, { version: number; enabled: boolean; max_hours: number; default_hours: number; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/support-access', { version, body }), onSettled: () => refresh(qc, 'support-access-setting'),
  });
};
export const useSupportGrants = (enabled = true) => useQuery({ queryKey: ['support-grants'], enabled, queryFn: () => api.get<{ items: Delegation[] }>('/support-access').then((r) => r.items) });
export const useGrantSupport = () => {
  const qc = useQueryClient();
  return useMutation<Delegation, ApiError, { to_user_id: string; rights: string[]; hours?: number; reason: string }>({
    mutationFn: (body) => api.post('/support-access', { body }), onSettled: () => refresh(qc, 'support-grants'),
  });
};
export const useRevokeSupport = () => {
  const qc = useQueryClient();
  return useMutation<Delegation, ApiError, { id: string; reason: string }>({
    mutationFn: ({ id, reason }) => api.post(`/support-access/${id}/revoke`, { body: { reason } }), onSettled: () => refresh(qc, 'support-grants'),
  });
};
export const useRevokeAllSupport = () => {
  const qc = useQueryClient();
  return useMutation<{ revoked: number }, ApiError, { reason: string }>({
    mutationFn: (body) => api.post('/support-access/revoke-all', { body }), onSettled: () => refresh(qc, 'support-grants'),
  });
};
/** 0.15.192 (migration 0292): the new-device email code (setting security.new_device_code) and its recovery path. System Admin only. */
export const useNewDeviceCode = () => useQuery({ queryKey: ['new-device-code-setting'], queryFn: () => api.get<NewDeviceCodeSetting>('/settings/new-device-code') });
export const useSetNewDeviceCode = () => {
  const qc = useQueryClient();
  return useMutation<NewDeviceCodeSetting, ApiError, { version: number; enabled: boolean; code_minutes: number; include_admins: boolean; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/new-device-code', { version, body }), onSettled: () => refresh(qc, 'new-device-code-setting'),
  });
};
export const useBypassNewDevice = () =>
  useMutation<{ until: string }, ApiError, { user_id: string; minutes?: number; reason: string }>({ mutationFn: (body) => api.post('/settings/new-device-code/bypass', { body }) });

/** 0.15.232 (migration 0243): the workspace logo of the identity. Uploading always enables it; hiding keeps the row (hide never delete). */
export const usePutUiLogo = () => {
  const qc = useQueryClient();
  return useMutation<UiAsset, ApiError, { file: File; reason: string; version: number | null }>({
    mutationFn: ({ file, reason, version }) => {
      const f = new FormData();
      f.append('file', file);
      f.append('reason', reason);
      return api.put('/settings/identity/logo', version === null ? { body: f } : { body: f, version });
    },
    onSettled: () => refresh(qc, 'ui-identity', 'me', 'my-profile'),
  });
};
export const useSetUiLogoEnabled = () => {
  const qc = useQueryClient();
  return useMutation<UiAsset, ApiError, { version: number; enabled: boolean; reason: string }>({
    mutationFn: ({ version, ...body }) => api.patch('/settings/identity/logo', { version, body }),
    onSettled: () => refresh(qc, 'ui-identity', 'me', 'my-profile'),
  });
};
/** 0.15.232 (0243): where the logo shows outside the app (sign-in pages, browser tab icon); both off by default. */
export const useSetUiLogoDisplay = () => {
  const qc = useQueryClient();
  return useMutation<UiAsset, ApiError, { version: number; show_on_login: boolean; use_as_favicon: boolean; reason: string }>({
    mutationFn: ({ version, ...body }) => api.patch('/settings/identity/logo/display', { version, body }),
    onSettled: () => refresh(qc, 'ui-identity', 'me', 'my-profile', 'ui-public-identity'),
  });
};
/** The public read (no session): which public pages show the logo. Both null until an admin switches one on. */
export const useUiPublicIdentity = () => useQuery({ queryKey: ['ui-public-identity'], queryFn: () => api.get<UiPublicIdentity>('/ui/public/identity'), staleTime: 30_000, retry: 1 });
/** 0.15.194 (migration 0294): passkeys as an alternative second step (setting security.passkeys), the own passkeys, and the admin recovery. */
export const usePasskeySetting = () => useQuery({ queryKey: ['passkey-setting'], queryFn: () => api.get<PasskeySetting>('/settings/passkeys') });
export const useSetPasskeys = () => {
  const qc = useQueryClient();
  return useMutation<PasskeySetting, ApiError, { version: number; enabled: boolean; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/passkeys', { version, body }), onSettled: () => refresh(qc, 'passkey-setting', 'my-passkeys'),
  });
};
export const useMyPasskeys = () => useQuery({ queryKey: ['my-passkeys'], queryFn: () => api.get<MyPasskeys>('/me/passkeys') });
export const usePasskeyRegisterOptions = () => useMutation<Record<string, unknown>, ApiError, void>({ gcTime: 0, mutationFn: () => api.post('/me/passkeys/register/options') });
export const usePasskeyRegisterVerify = () => {
  const qc = useQueryClient();
  return useMutation<PasskeyItem, ApiError, { label: string; response: Record<string, unknown> }>({ mutationFn: (body) => api.post('/me/passkeys/register/verify', { body }), onSettled: () => refresh(qc, 'my-passkeys') });
};
export const useRemovePasskey = () => {
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({ mutationFn: (id) => api.del(`/me/passkeys/${id}`), onSettled: () => refresh(qc, 'my-passkeys') });
};
export const useAdminRevokePasskeys = (userId: string) =>
  useMutation<{ revoked: number }, ApiError, { reason: string }>({ mutationFn: (body) => api.post(`/users/${userId}/passkeys/revoke`, { body }) });
export const useImportsSettings = () => useQuery({ queryKey: ['imports-settings'], queryFn: () => api.get<ImportsSettings>('/settings/imports') });
export const useSetImportsSettings = () => {
  const qc = useQueryClient();
  return useMutation<ImportsSettings, ApiError, { version: number; async_rows: number; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/imports', { version, body }), onSettled: () => refresh(qc, 'imports-settings'),
  });
};

/** 0.15.203 (P3): the notice of a new template version (templates.change_notice). Read by everyone; changed by a System Admin or an all-regions delegate of settings, with a reason. */
export const useTemplateNoticeSettings = () => useQuery({ queryKey: ['template-notice-settings'], queryFn: () => api.get<TemplateChangeNotice>('/settings/template-change-notice') });
export const useSetTemplateNoticeSettings = () => {
  const qc = useQueryClient();
  return useMutation<TemplateChangeNotice, ApiError, { version: number; enabled: boolean; days: number; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/template-change-notice', { version, body }), onSettled: () => refresh(qc, 'template-notice-settings'),
  });
};

/** 0.15.1: the shared layout of the side menu (nav.layout). Read by everyone; changed by a System Admin or an all-regions delegate of settings, with a reason. */
export const useNavLayout = (enabled = true) =>
  useQuery({ queryKey: ['nav-layout'], queryFn: () => api.get<NavLayoutSetting>('/settings/nav-layout'), enabled, staleTime: 60_000 });
export const useSetNavLayout = () => {
  const qc = useQueryClient();
  return useMutation<NavLayoutSetting, ApiError, { version: number; layout: NavLayoutT | null; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/nav-layout', { version, body }),
    onSuccess: (data) => qc.setQueryData(['nav-layout'], data),
    onSettled: () => refresh(qc, 'nav-layout'),
  });
};

// ---------------------------------------------------------------- rules
export const useFreeze = () => useQuery({ queryKey: ['freeze'], queryFn: () => api.get<StructuralFreeze>('/settings/structural-freeze') });
export const useLiftFreeze = () => {
  const qc = useQueryClient();
  return useMutation<StructuralFreeze, ApiError, { version: number; reason: string; confirm_text: string }>({
    mutationFn: ({ version, ...body }) => api.post('/settings/structural-freeze/lift', { version, body }), onSettled: () => refresh(qc, 'freeze'),
  });
};
/** Set the window of the structural freeze; after a lift this locks again (0.15.16). */
export const useSetFreeze = () => {
  const qc = useQueryClient();
  return useMutation<StructuralFreeze, ApiError, { version: number; starts_on: string; ends_on: string; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/settings/structural-freeze', { version, body }), onSettled: () => { void refresh(qc, 'freeze'); },
  });
};
export const useDlp = () => useQuery({ queryKey: ['dlp'], queryFn: () => api.get<DlpSettings>('/settings/dlp') });
export const usePublishDlp = () => {
  const qc = useQueryClient();
  return useMutation<DlpVersion, ApiError, DlpVersionInput>({ mutationFn: (body) => api.post('/settings/dlp/versions', { body }), onSettled: () => refresh(qc, 'dlp') });
};
export const useIdle = () => useQuery({ queryKey: ['idle'], queryFn: () => api.get<IdleTaskAlertSetting>('/settings/idle-task-alert') });
export const useSetIdle = () => {
  const qc = useQueryClient();
  return useMutation<IdleTaskAlertSetting, ApiError, { version: number; enabled: boolean; working_days: number; reason: string }, Snap>({
    mutationFn: ({ version, ...body }) => api.put('/settings/idle-task-alert', { version, body }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['idle'] });
      const before = qc.getQueryData<IdleTaskAlertSetting>(['idle']);
      qc.setQueryData(['idle'], { ...before, enabled: v.enabled, working_days: v.working_days });
      return { rollback: () => qc.setQueryData(['idle'], before) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'idle'),
  });
};

// ---------------------------------------------------------------- team / scope match of Procurement (0.9.1, Q97)
export const useTeamScopeMatch = () => useQuery({ queryKey: ['teamScopeMatch'], queryFn: () => api.get<TeamScopeMatch>('/settings/team-scope-match') });
// 0.15.84: the read-only GECOL / HLC counts (Settings > Data > GECOL / HLC counts)
export const useGecolHlcCounts = () => useQuery({ queryKey: ['gecolHlcCounts'], queryFn: () => api.get<GecolHlcCounts>('/reports/gecol-hlc-counts') });
// 0.12.9 (P4b): the contractor rules and the two reports
export const useContractorRules = () => useQuery({ queryKey: ['contractorRules'], queryFn: () => api.get<ContractorRules>('/settings/contractor-rules') });
export const useSetContractorRules = () => {
  const qc = useQueryClient();
  return useMutation<ContractorRules, ApiError, { version: number; body: ContractorRulesInput & { reason: string } }>({
    mutationFn: ({ version, body }) => api.put('/settings/contractor-rules', { version, body }), onSettled: () => refresh(qc, 'contractorRules'),
  });
};
export const useContractorPerformance = (enabled = true) =>
  useQuery({ queryKey: ['contractorPerformance'], enabled, retry: false, queryFn: () => api.get<ContractorPerformanceReport>('/reports/contractor-performance') });
export const useContractorPerfThresholds = () => useQuery({ queryKey: ['contractorPerfThresholds'], queryFn: () => api.get<ContractorPerformanceThresholds>('/settings/contractor-performance') });
export const useSetContractorPerfThresholds = () => {
  const qc = useQueryClient();
  return useMutation<ContractorPerformanceThresholds, ApiError, { version: number; body: { reason: string; thresholds: ContractorPerformanceSettings } }>({
    mutationFn: ({ version, body }) => api.put('/settings/contractor-performance', { version, body }),
    onSettled: () => { refresh(qc, 'contractorPerfThresholds'); void qc.invalidateQueries({ queryKey: ['contractorPerformance'] }); },
  });
};
export const useTeamScopeMismatch = (enabled = true) =>
  useQuery({ queryKey: ['teamScopeMismatch'], enabled, retry: false, queryFn: () => api.get<TeamScopeMismatchReport>('/reports/team-scope-mismatch') });
export const useContractorsCompleteness = (enabled = true) =>
  useQuery({ queryKey: ['contractorsCompleteness'], enabled, retry: false, queryFn: () => api.get<ContractorsCompletenessReport>('/reports/contractors-completeness') });
export const useSetTeamScopeMatch = () => {
  const qc = useQueryClient();
  return useMutation<TeamScopeMatch, ApiError, { version: number; body: TeamScopeMatchInput & { reason: string } }>({
    mutationFn: ({ version, body }) => api.put('/settings/team-scope-match', { version, body }), onSettled: () => refresh(qc, 'teamScopeMatch'),
  });
};

// ---------------------------------------------------------------- notification policy and retention
export const usePolicy = () => useQuery({ queryKey: ['policy'], queryFn: () => api.get<NotificationPolicy>('/settings/notification-policy') });
export const useCatalogue = () => useQuery({ queryKey: ['notification-catalogue'], staleTime: Infinity, queryFn: () => api.get<{ items: NotificationTypeDef[] }>('/settings/notification-policy/catalogue').then((r) => r.items) });
export const useSetPolicy = () => {
  const qc = useQueryClient();
  return useMutation<NotificationPolicy, ApiError, { version: number; body: NotificationPolicyInput }>({
    mutationFn: ({ version, body }) => api.put('/settings/notification-policy', { version, body }), onSettled: () => refresh(qc, 'policy'),
  });
};
export const useRetention = () => useQuery({ queryKey: ['retention'], queryFn: () => api.get<LogRetention>('/settings/log-retention') });
export const useSetRetention = () => {
  const qc = useQueryClient();
  return useMutation<LogRetention, ApiError, { version: number; body: LogRetentionInput }>({
    mutationFn: ({ version, body }) => api.put('/settings/log-retention', { version, body }), onSettled: () => refresh(qc, 'retention', 'notifications'),
  });
};

// ---------------------------------------------------------------- staff visibility
export const useStaffVisibility = () => useQuery({ queryKey: ['staff-visibility'], queryFn: () => api.get<StaffVisibility>('/staff-registry/visibility') });
export const useSetStaffVisibility = () => {
  const qc = useQueryClient();
  return useMutation<StaffVisibility, ApiError, { version: number; fields: StaffVisibility['fields']; reason: string }>({
    mutationFn: ({ version, ...body }) => api.put('/staff-registry/visibility', { version, body }), onSettled: () => refresh(qc, 'staff-visibility', 'staff'),
  });
};
export const useHideStaffFields = () => {
  const qc = useQueryClient();
  // PATCH /staff-registry/{employee_id} needs If-Match (contract): the row version is read from the card first.
  return useMutation<unknown, ApiError, { employee_id: string; hidden_fields: ('email' | 'phone')[]; reason: string }>({
    mutationFn: async ({ employee_id, ...body }) => {
      const card = await api.get<StaffCard>(`/staff-registry/${employee_id}`);
      return api.patch(`/staff-registry/${employee_id}`, { version: card.version, body });
    },
    onSettled: () => refresh(qc, 'staff'),
  });
};

// ---------------------------------------------------------------- security log, integrity, sessions
export type SecFilter = { from: string; to: string; event: string[]; outcome: string; q: string };
export const useSecurityLog = (f: SecFilter, adv?: string) =>
  useQuery({
    queryKey: ['security-log', f, adv ?? ''],
    queryFn: () => api.get<Page<SecurityLogEntry> & { page: { filter_window?: { rows: number; full: boolean } } }>('/security-log', { query: { from: f.from ? `${f.from}T00:00:00Z` : '', to: f.to ? `${f.to}T23:59:59Z` : '', event: f.event.join(','), outcome: f.outcome, q: f.q, filter: adv || undefined } }).then((r) => Object.assign(r.items, { windowFull: r.page.filter_window?.full === true })),
  });
export const verifyIntegrity = (log: 'audit' | 'security') => api.get<LogIntegrity>(`/${log}-log/integrity`);
export const useVerifyIntegrity = () => useMutation<LogIntegrity, ApiError, 'audit' | 'security'>({ mutationFn: verifyIntegrity });

/** Starts the CSV export and polls its job; resolves with the downloaded file name. */
export async function exportSecurityLog(f: SecFilter, onStart?: () => void) {
  const job = await api.post<Job>('/security-log/exports', {
    idempotencyKey: crypto.randomUUID(),
    body: { ...(f.from ? { from: `${f.from}T00:00:00Z` } : {}), ...(f.to ? { to: `${f.to}T23:59:59Z` } : {}), ...(f.event.length ? { event: f.event } : {}), ...(f.outcome ? { outcome: f.outcome } : {}), ...(f.q ? { q: f.q } : {}) },
  });
  onStart?.();
  for (let i = 0; i < 30; i++) {
    const j = await api.get<Job>(`/jobs/${job.id}`);
    if (j.status === 'failed') throw new ApiError(500, j.error ?? ({ type: 'about:blank', title: 'Export failed', status: 500, code: 'unknown' } as never));
    if (j.status === 'done' && j.result_file_id) return downloadFile(`/files/${j.result_file_id}/download`);
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('export timeout');
}

/** Polls every 15 s with X-PMIS-Live so the poll never counts as activity (cannot extend the session). */
export const LIVE_POLL_MS = 15_000;
export const useActiveSessions = (f: { q: string; status: string }) =>
  useQuery({
    queryKey: ['sessions', f], refetchInterval: LIVE_POLL_MS, refetchIntervalInBackground: false,
    queryFn: () => api.get<Page<ActiveSession>>('/sessions/active', { query: f, headers: { 'X-PMIS-Live': '1' } }).then((r) => r.items),
  });
export function useRevokeSessions() {
  const qc = useQueryClient();
  return useMutation<SessionRevokeResult, ApiError, { session?: ActiveSession; user?: { id: string }; reason: string }, Snap>({
    mutationFn: ({ session, user, reason }) => api.post(session ? `/sessions/${session.session_id}/revoke` : `/users/${user!.id}/sessions/revoke`, { body: { reason } }),
    onMutate: async ({ session, user }) => {
      await qc.cancelQueries({ queryKey: ['sessions'] });
      const snaps = qc.getQueriesData<ActiveSession[]>({ queryKey: ['sessions'] });
      snaps.forEach(([k, d]) => d && qc.setQueryData(k, d.filter((s) => (session ? s.session_id !== session.session_id : s.user.id !== user!.id || s.is_current))));
      return { rollback: () => snaps.forEach(([k, d]) => qc.setQueryData(k, d)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'sessions'),
  });
}

// ---------------------------------------------------------------- users: deactivate, delete, restore
export const useDeletedUsers = (enabled: boolean) => useQuery({ queryKey: ['users-deleted'], enabled, queryFn: () => api.get<Page<DeletedUser>>('/users/deleted').then((r) => r.items) });
export function useDeactivateUser() {
  const qc = useQueryClient();
  return useMutation<UserDetail, ApiError, { user: User; status: 'suspended' | 'disabled' | 'active'; reason: string }, Snap>({
    mutationFn: ({ user, status, reason }) => api.patch(`/users/${user.id}`, { version: user.version, body: { status, reason } }),
    onMutate: async ({ user, status }) => {
      await qc.cancelQueries({ queryKey: ['users'] });
      const snaps = qc.getQueriesData<Page<User>>({ queryKey: ['users'] });
      snaps.forEach(([k, d]) => d && qc.setQueryData(k, { ...d, items: d.items.map((x) => (x.id === user.id ? { ...x, status } : x)) }));
      return { rollback: () => snaps.forEach(([k, d]) => qc.setQueryData(k, d)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'users', 'user', 'sessions', 'alerts', 'site-tasks', 'approvals', 'matrix'),
  });
}
export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation<DeletedUser, ApiError, { user: User; reason: string }, Snap>({
    mutationFn: ({ user, reason }) => api.post(`/users/${user.id}/delete`, { version: user.version, body: { reason } }),
    onMutate: async ({ user }) => {
      await qc.cancelQueries({ queryKey: ['users'] });
      const snaps = qc.getQueriesData<Page<User>>({ queryKey: ['users'] });
      snaps.forEach(([k, d]) => d && qc.setQueryData(k, { ...d, items: d.items.filter((x) => x.id !== user.id) }));
      return { rollback: () => snaps.forEach(([k, d]) => qc.setQueryData(k, d)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'users', 'users-deleted', 'sessions', 'alerts', 'site-tasks', 'approvals', 'matrix'),
  });
}
export const useRestoreUser = () => {
  const qc = useQueryClient();
  return useMutation<UserDetail, ApiError, { user: DeletedUser; reason: string }>({
    mutationFn: ({ user, reason }) => api.post(`/users/${user.id}/restore`, { version: user.version, body: { reason } }),
    onSettled: () => refresh(qc, 'users', 'users-deleted', 'alerts', 'site-tasks', 'approvals', 'matrix'),
  });
};

/** 0.15.6: permanent delete of a soft-deleted user (System Admin, step-up, typed confirmation). */
export const usePurgeUser = () => {
  const qc = useQueryClient();
  return useMutation<PurgedUser, ApiError, { user: DeletedUser; reason: string; confirm_text: string }>({
    mutationFn: ({ user, reason, confirm_text }) => api.post(`/users/${user.id}/purge`, { body: { reason, confirm_text } }),
    onSettled: () => refresh(qc, 'users', 'users-deleted', 'staff', 'audit'),
  });
};

// ---------------------------------------------------------------- act on behalf (B12b choice 3)
export function useActOnBehalf() {
  const qc = useQueryClient();
  return useMutation<TransitionResultT, ApiError, { taskId: string; version: number; body: ActOnBehalfRequest }, Snap>({
    mutationFn: ({ taskId, version, body }) => api.post(`/tasks/${taskId}/act-on-behalf`, { version, body }),
    onMutate: async ({ taskId }) => {
      await qc.cancelQueries({ queryKey: ['alerts'] });
      const snaps = qc.getQueriesData<ReassignmentAlert[]>({ queryKey: ['alerts'] });
      snaps.forEach(([k, d]) => d && qc.setQueryData(k, d.filter((a) => a.task.id !== taskId)));
      return { rollback: () => snaps.forEach(([k, d]) => qc.setQueryData(k, d)) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSettled: () => refresh(qc, 'alerts', 'my-work', 'approvals', 'site-tasks', 'task'),
  });
}

// ---------------------------------------------------------------- SLA rule sets and weight sets (contract 0.2.6)
/** A body with the ETag it came with; the ETag goes back as If-Match on the next write. */
export type Tagged<T> = { data: T; etag: number };
const tag = async <T,>(call: (o: RequestOptions) => Promise<T>, o: RequestOptions = {}): Promise<Tagged<T>> => {
  let etag = 0;
  const data = await call({ ...o, onHeaders: (h) => { etag = Number((h.get('ETag') ?? '').replace(/\D/g, '')); } });
  return { data, etag };
};

export const useSlaSets = () => useQuery({ queryKey: ['sla-sets'], queryFn: () => api.get<Page<SlaRuleSetSummary>>('/settings/sla-rule-sets').then((r) => r.items) });
export const useSlaSet = (id?: string) => useQuery({ queryKey: ['sla-set', id], enabled: !!id, queryFn: () => tag((o) => api.get<SlaRuleSet>(`/settings/sla-rule-sets/${id}`, o)) });
export const useCreateSlaDraft = () => {
  const qc = useQueryClient();
  return useMutation<SlaRuleSet, ApiError, { reason: string }>({ mutationFn: (body) => api.post('/settings/sla-rule-sets', { body }), onSettled: () => refresh(qc, 'sla-sets', 'sla-set') });
};
/** Saves changed rules; the rows change on screen at once and go back if the server refuses. */
export function useSaveSlaDraft(id: string) {
  const qc = useQueryClient();
  return useMutation<Tagged<SlaRuleSet>, ApiError, { etag: number; reason: string; rules: SlaTaskRule[] }, Snap>({
    mutationFn: ({ etag, reason, rules }) => tag((o) => api.patch<SlaRuleSet>(`/settings/sla-rule-sets/${id}`, { ...o, version: etag, body: { reason, rules } })),
    onMutate: async ({ rules }) => {
      await qc.cancelQueries({ queryKey: ['sla-set', id] });
      const before = qc.getQueryData<Tagged<SlaRuleSet>>(['sla-set', id]);
      if (before) qc.setQueryData(['sla-set', id], { ...before, data: { ...before.data, rules: before.data.rules.map((r) => rules.find((x) => x.task_code === r.task_code) ?? r) } });
      return { rollback: () => qc.setQueryData(['sla-set', id], before) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSuccess: (res) => qc.setQueryData(['sla-set', id], res),
    onSettled: () => refresh(qc, 'sla-sets'),
  });
}
export const usePreviewSla = (id: string) => useMutation<SlaPublishPreview, ApiError, { effective_date: string }>({ mutationFn: (body) => api.post(`/settings/sla-rule-sets/${id}/preview`, { body }) });
// No optimistic flip here: the publish needs step-up and can be refused, and the dialog must stay open while it runs.
export function usePublishSla(id: string) {
  const qc = useQueryClient();
  return useMutation<SlaRuleSetPublishResult, ApiError, { etag: number; effective_date: string; reason: string; apply_to_open_tasks: boolean }>({
    mutationFn: ({ etag, ...body }) => api.post(`/settings/sla-rule-sets/${id}/publish`, { version: etag, idempotencyKey: crypto.randomUUID(), body }),
    onSettled: () => refresh(qc, 'sla-sets', 'sla-set', 'sla-rules'),
  });
}
/** Codes the start-event picker offers: tasks, milestones and gates of the workflow version in force. */
export const useStartEvents = () => useQuery({
  queryKey: ['start-events'], staleTime: Infinity,
  queryFn: async () => {
    const vs = (await api.get<{ items: WorkflowVersionSummary[] }>('/workflow/versions')).items;
    const cur = vs.find((v) => v.is_current) ?? vs[0];
    const [wf, td] = await Promise.all([api.get<WorkflowVersion>(`/workflow/versions/${cur.version}`), api.get<{ items: TaskDefinition[] }>('/settings/task-definitions', { query: { workflow_version: cur.version } })]);
    return { tasks: td.items, milestones: wf.milestones, gates: wf.gates };
  },
});

export const useWeightSetList = () => useQuery({ queryKey: ['weight-sets'], queryFn: () => api.get<{ items: WeightSet[] }>('/settings/weight-sets').then((r) => r.items) });
export const useWeightSet = (id?: string) => useQuery({ queryKey: ['weight-set', id], enabled: !!id, queryFn: () => tag((o) => api.get<WeightSet>(`/settings/weight-sets/${id}`, o)) });
export const useCreateWeightDraft = () => {
  const qc = useQueryClient();
  return useMutation<WeightSet, ApiError, { code: WeightSetCode; base_set_id?: string; reason: string }>({ mutationFn: (body) => api.post('/settings/weight-sets', { body }), onSettled: () => refresh(qc, 'weight-sets', 'weight-set') });
};
/** Saves the draft; the sets list shows the new weights at once and goes back if the server refuses. */
export function useSaveWeightDraft(id: string) {
  const qc = useQueryClient();
  return useMutation<Tagged<WeightSet>, ApiError, { etag: number; body: WeightSetInput }, Snap>({
    mutationFn: ({ etag, body }) => tag((o) => api.put<WeightSet>(`/settings/weight-sets/${id}`, { ...o, version: etag, body })),
    onMutate: async ({ body }) => {
      await qc.cancelQueries({ queryKey: ['weight-set', id] });
      const before = qc.getQueryData<Tagged<WeightSet>>(['weight-set', id]);
      if (before) qc.setQueryData(['weight-set', id], { ...before, data: { ...before.data, reason: body.reason, activities: body.activities.map((a) => ({ ...a, items: a.items ?? [] })) } });
      return { rollback: () => qc.setQueryData(['weight-set', id], before) };
    },
    onError: (_e, _v, c) => c?.rollback(),
    onSuccess: (res) => qc.setQueryData(['weight-set', id], res),
    onSettled: () => refresh(qc, 'weight-sets'),
  });
}
export const usePreviewWeights = (id: string) => useMutation<WeightSetPreview, ApiError, void>({ mutationFn: () => api.post(`/settings/weight-sets/${id}/preview`) });
export function usePublishWeights(id: string) {
  const qc = useQueryClient();
  return useMutation<WeightSetPublishResult, ApiError, { etag: number; effective_date: string; reason: string }>({
    mutationFn: ({ etag, ...body }) => api.post(`/settings/weight-sets/${id}/publish`, { version: etag, idempotencyKey: crypto.randomUUID(), body }),
    onSettled: () => refresh(qc, 'weight-sets', 'weight-set'),
  });
}

// 0.15.85: every task with its SLA status (Settings > SLA, "Tasks and their SLA") and the explicit "no SLA" choice
import type { SlaTaskList } from './types';
import type { TemplateChangeNotice } from './types';
export const useSlaTasks = () => useQuery({ queryKey: ['slaTasks'], queryFn: () => api.get<SlaTaskList>('/settings/sla-tasks') });
export const useSetSlaNoSla = () => {
  const qc = useQueryClient();
  return useMutation<{ task_code: string; is_none: boolean }, ApiError, { task: string; no_sla: boolean; reason: string }>({
    mutationFn: ({ task, no_sla, reason }) => api.put(`/settings/sla-tasks/${task}/no-sla`, { body: { no_sla, reason } }),
    onSettled: () => refresh(qc, 'slaTasks'),
  });
};
/** 0171 (contract 0.15.87): the editable map task code -> issue category and blocker reason, and the derived "stopped at" rows. */
export const useIssueTaskMap = () => useQuery({ queryKey: ['issueTaskMap'], queryFn: () => api.get<IssueTaskMapList>('/settings/issue-task-map') });
export const useSaveIssueTaskMap = () => {
  const qc = useQueryClient();
  return useMutation<IssueTaskMapItem, ApiError, { task: string; category: string; reason: string | null; is_active: boolean; why: string }>({
    mutationFn: ({ task, ...body }) => api.put(`/settings/issue-task-map/${task}`, { body }),
    onSettled: () => refresh(qc, 'issueTaskMap', 'issueStoppedRows'),
  });
};
export const useIssueStoppedRows = () => useQuery({ queryKey: ['issueStoppedRows'], queryFn: () => api.get<IssueStoppedRowList>('/issues/stopped-rows') });
export const useAlertRules = () => useQuery({ queryKey: ['alertRules'], queryFn: () => api.get<AlertRulesResponse>('/settings/alert-rules') });
export const useCreateAlertRule = () => {
  const qc = useQueryClient();
  return useMutation<AlertRuleSaved, ApiError, AlertRuleInput & { reason: string }>({
    mutationFn: (body) => api.post('/settings/alert-rules', { body }),
    onSettled: () => refresh(qc, 'alertRules'),
  });
};
export const useUpdateAlertRule = () => {
  const qc = useQueryClient();
  return useMutation<AlertRuleSaved, ApiError, { id: string; version: number; body: AlertRuleInput & { reason: string } }>({
    mutationFn: ({ id, version, body }) => api.put(`/settings/alert-rules/${id}`, { version, body }),
    onSettled: () => refresh(qc, 'alertRules'),
  });
};
