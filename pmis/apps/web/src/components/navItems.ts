import type { Concept } from '@/lib/icons';

export const NAV: { key: string; to: string; icon: Concept; group: 'work' | 'registers' | 'data' | 'admin' | 'logs' }[] = [
  { key: 'my_work', to: '/my-work', icon: 'home', group: 'work' },
  { key: 'inbox', to: '/inbox', icon: 'inbox', group: 'work' },
  { key: 'approvals', to: '/approvals', icon: 'approval', group: 'work' },
  { key: 'sites', to: '/sites', icon: 'site', group: 'work' },
  { key: 'workload', to: '/workload', icon: 'workload', group: 'work' },
  { key: 'status_updates', to: '/status-updates', icon: 'weekly', group: 'work' },
  { key: 'dashboard', to: '/dashboard', icon: 'dashboard', group: 'work' },
  { key: 'messages', to: '/messages', icon: 'message', group: 'work' },
  { key: 'procurement', to: '/registers/procurement', icon: 'procurement', group: 'registers' },
  { key: 'gecol', to: '/registers/gecol', icon: 'power', group: 'registers' },
  { key: 'hlc', to: '/registers/hlc', icon: 'fiber', group: 'registers' },
  { key: 'permits_hse', to: '/registers/permits_hse', icon: 'permit', group: 'registers' },
  { key: 'dismantle', to: '/registers/dismantle', icon: 'dismantle', group: 'registers' },
  { key: 'contractors', to: '/registers/contractors', icon: 'contractor', group: 'registers' },
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
  { key: 'templates', to: '/templates', icon: 'document', group: 'data' },
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
  { key: 'logs.online', to: '/admin/logs/online', icon: 'online', group: 'logs' },
  { key: 'logs.alerts', to: '/admin/logs/alerts', icon: 'alerts', group: 'logs' },
  { key: 'logs.job_runs', to: '/admin/logs/job-runs', icon: 'jobRuns', group: 'logs' },
  { key: 'logs.deployments', to: '/admin/logs/deployments', icon: 'deployments', group: 'logs' },
  { key: 'logs.activity_report', to: '/admin/logs/activity-report', icon: 'report', group: 'logs' },
];

/** Entries opened by a grant rather than by the server's module list (security log, online now). */
export const BY_GRANT: Record<string, string> = {
  'admin.security_log': 'view_security_log', 'admin.online': 'manage_users', audit: 'view_audit', 'logs.field_changes': 'view_audit', 'logs.activity_report': 'view_audit',
};
/** Entries only a System Admin sees (the server answers 403 to anyone else). */
export const ADMIN_ONLY = new Set(['logs.online', 'logs.alerts', 'logs.job_runs', 'logs.deployments']);
export type NavItem = (typeof NAV)[number];
