import type { Concept } from '@/lib/icons';

export const NAV: { key: string; to: string; icon: Concept; group: 'home' | 'work' | 'site_register' | 'registers' | 'data' | 'library' | 'admin' | 'logs' }[] = [
  { key: 'my_work', to: '/my-work', icon: 'home', group: 'work' },
  // 0149 (W7): My Work > Daily Plan
  { key: 'daily_plan', to: '/my-work/daily-plan', icon: 'dailyPlan', group: 'work' },
  { key: 'inbox', to: '/inbox', icon: 'inbox', group: 'work' },
  { key: 'approvals', to: '/approvals', icon: 'approval', group: 'work' },
  { key: 'workload', to: '/workload', icon: 'workload', group: 'work' },
  { key: 'status_updates', to: '/status-updates', icon: 'weekly', group: 'work' },
  { key: 'dashboard', to: '/dashboard', icon: 'dashboard', group: 'home' },
  { key: 'messages', to: '/messages', icon: 'message', group: 'work' },
  { key: 'sites', to: '/sites', icon: 'site', group: 'site_register' },
  { key: 'dismantle', to: '/registers/dismantle', icon: 'dismantle', group: 'registers' },
  { key: 'procurement', to: '/registers/procurement', icon: 'procurement', group: 'registers' },
  { key: 'gecol', to: '/registers/gecol', icon: 'power', group: 'registers' },
  { key: 'hlc', to: '/registers/hlc', icon: 'fiber', group: 'registers' },
  { key: 'permits_hse', to: '/registers/permits_hse', icon: 'permit', group: 'registers' },
  { key: 'incidents', to: '/registers/incidents', icon: 'issue', group: 'registers' },
  { key: 'lessons_learned', to: '/registers/lessons_learned', icon: 'handover', group: 'registers' },
  { key: 'invoices', to: '/registers/invoices', icon: 'handover', group: 'registers' },
  { key: 'deliverables', to: '/registers/deliverables', icon: 'handover', group: 'registers' },
  { key: 'warehouse', to: '/warehouse', icon: 'warehouse', group: 'registers' },
  { key: 'quality', to: '/registers/quality', icon: 'quality', group: 'registers' },
  { key: 'issues', to: '/registers/issues', icon: 'issue', group: 'registers' },
  { key: 'risks', to: '/registers/risks', icon: 'late', group: 'registers' },
  { key: 'change_control', to: '/registers/change_control', icon: 'change', group: 'registers' },
  { key: 'readiness', to: '/registers/readiness_handover', icon: 'handover', group: 'registers' },
  { key: 'as_built', to: '/registers/as_built', icon: 'asbuilt', group: 'registers' },
  { key: 'meetings', to: '/registers/meetings', icon: 'meeting', group: 'registers' },
  { key: 'rf_design', to: '/registers/rf_design', icon: 'rf', group: 'registers' },
  { key: 'acquisition', to: '/registers/acquisition', icon: 'acquisition', group: 'registers' },
  { key: 'contractors', to: '/registers/contractors', icon: 'contractor', group: 'registers' },
  { key: 'car_dispatcher', to: '/registers/car_dispatcher', icon: 'dismantle', group: 'registers' },
  { key: 'financial_advances', to: '/registers/financial_advances', icon: 'procurement', group: 'registers' },
  { key: 'contractor_reports', to: '/reports/contractors', icon: 'report', group: 'registers' },
  { key: 'data_hub', to: '/data-hub', icon: 'dataHub', group: 'data' },
  { key: 'templates', to: '/templates', icon: 'document', group: 'data' },
  { key: 'master_import', to: '/templates/master-import', icon: 'compare', group: 'data' },
  { key: 'column_mapping', to: '/templates/mapping', icon: 'columnMap', group: 'data' },
  { key: 'data_reset', to: '/admin/settings/data/reset', icon: 'dataReset', group: 'data' },
  { key: 'recycle_bin', to: '/admin/settings/registers/recycle', icon: 'recycleBin', group: 'data' },
  // W5 (owner decision 2026-11-23): the main menu Library, between Data entry and Administration
  { key: 'library.forms', to: '/library/forms', icon: 'forms', group: 'library' },
  { key: 'library.archive', to: '/library/archive', icon: 'archive', group: 'library' },
  { key: 'admin.users', to: '/admin/users', icon: 'people', group: 'admin' },
  { key: 'admin.roles', to: '/admin/roles', icon: 'role', group: 'admin' },
  { key: 'admin.groups', to: '/admin/groups', icon: 'group', group: 'admin' },
  { key: 'admin.delegation', to: '/admin/delegation', icon: 'delegation', group: 'admin' },
  { key: 'absence', to: '/absence', icon: 'absence', group: 'work' },
  { key: 'admin.matrix', to: '/admin/matrix', icon: 'matrix', group: 'admin' },
  { key: 'admin.settings', to: '/admin/settings', icon: 'settings', group: 'admin' },
  { key: 'admin.online', to: '/admin/online', icon: 'online', group: 'admin' },
  { key: 'announcements', to: '/admin/announcements', icon: 'announcement', group: 'admin' },
  { key: 'audit', to: '/audit', icon: 'audit', group: 'logs' },
  { key: 'logs.field_changes', to: '/admin/logs/field-changes', icon: 'fieldChanges', group: 'logs' },
  { key: 'admin.security_log', to: '/admin/security-log', icon: 'securityLog', group: 'logs' },
  { key: 'logs.system', to: '/admin/logs/system', icon: 'issue', group: 'logs' },
  { key: 'logs.online', to: '/admin/logs/online', icon: 'online', group: 'logs' },
  { key: 'logs.alerts', to: '/admin/logs/alerts', icon: 'alerts', group: 'logs' },
  { key: 'logs.job_runs', to: '/admin/logs/job-runs', icon: 'jobRuns', group: 'logs' },
  { key: 'logs.deployments', to: '/admin/logs/deployments', icon: 'deployments', group: 'logs' },
  { key: 'logs.activity_report', to: '/admin/logs/activity-report', icon: 'report', group: 'logs' },
  { key: 'logs.integrity', to: '/admin/logs/integrity', icon: 'integrity', group: 'logs' },
  { key: 'logs.mail', to: '/admin/logs/mail', icon: 'mail', group: 'logs' },
];

/** Entries opened by a grant rather than by the server's module list (security log, online now). */
export const BY_GRANT: Record<string, string> = {
  'admin.security_log': 'view_security_log', 'admin.online': 'manage_users', audit: 'view_audit', 'logs.field_changes': 'view_audit', 'logs.activity_report': 'view_audit',
};
/** Entries shown when the caller may use any one of these modules (0.12.9, P4b: the contractors reports and the read-only match table, Q147). */
export const ANY_OF: Record<string, string[]> = { contractor_reports: ['procurement', 'contractors'], data_hub: ['templates'], column_mapping: ['templates'] };
/**
 * Entries opened by `view` on a module that is not a screen of the server's module list (the rule of the API: a System Admin, or view on the module; a full
 * delegation holds view on every module). The System Log (owner request 2026-11-09): GET /system-log answers 403 to anyone else (log_can_read_ops).
 */
export const BY_MODULE_VIEW: Record<string, string> = { 'logs.system': 'admin.system_log', 'library.forms': 'sites.documents', 'library.archive': 'sites.documents' };
/** Entries only a System Admin sees (the server answers 403 to anyone else). */
export const ADMIN_ONLY = new Set(['master_import', 'data_reset', 'recycle_bin', 'logs.online', 'logs.alerts', 'logs.job_runs', 'logs.deployments', 'logs.integrity', 'logs.mail']);
export type NavItem = (typeof NAV)[number];
