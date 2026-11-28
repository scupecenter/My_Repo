/**
 * Central map: screen id -> the Settings page that owns that screen's configuration (settings gear, owner approval 2026-11-27).
 * Adding a screen to the gear is one row here plus `<ScreenSettingsLink screen="..." />` in its header. `tab`/`section` are the keys of SETTINGS_TABS
 * (a test checks every row against it). `adminOnly` mirrors the section of the same name in SETTINGS_TABS. The destination name in the hint comes from
 * the existing settings.section_<tab>_<section> (or settings.tab_<tab>) texts, so nothing is typed twice.
 */
export interface ScreenSettingsTarget { tab: string; section?: string; adminOnly?: boolean }

export const SCREEN_SETTINGS = {
  dashboard: { tab: 'screens', section: 'dashboard' },
  daily_plan: { tab: 'screens', section: 'daily-plan' },
  inbox: { tab: 'alerts', section: 'policy' },
  approvals: { tab: 'workflow', section: 'editor' },
  sites: { tab: 'workflow', section: 'columns' },
  site_locks: { tab: 'workflow', section: 'sequence' },
  register: { tab: 'registers', section: 'columns' },
  register_gecol: { tab: 'registers', section: 'gecol' },
  register_issues: { tab: 'registers', section: 'issue-map' },
  register_contractors: { tab: 'registers', section: 'contractors' },
  contractor_reports: { tab: 'registers', section: 'contractors' },
  templates: { tab: 'data', section: 'imports' },
  template_mapping: { tab: 'data', section: 'mapping' },
  master_import: { tab: 'data', section: 'imports' },
  batch: { tab: 'data', section: 'imports' },
  library_forms: { tab: 'documents', section: 'forms' },
  library_archive: { tab: 'documents', section: 'archive' },
  library_templates: { tab: 'documents', section: 'types' },
  data_hub: { tab: 'screens', section: 'data-hub' },
  site_map: { tab: 'screens', section: 'map' },
  finance_hub: { tab: 'screens', section: 'finance-hub' },
  audit_log: { tab: 'security', section: 'retention' },
  security_alerts: { tab: 'security', section: 'alerts' },
  users: { tab: 'security', section: 'limits' },
  assignments: { tab: 'security', section: 'limits' },
  matrix: { tab: 'workflow', section: 'coverage', adminOnly: true },
  warehouse: { tab: 'screens', section: 'tables' },
  my_work: { tab: 'workflow', section: 'board' },
  site: { tab: 'workflow', section: 'freeze' },
  profile: { tab: 'security', section: 'newdevice' },
} as const satisfies Record<string, ScreenSettingsTarget>;

export type ScreenKey = keyof typeof SCREEN_SETTINGS;

export const screenSettingsPath = (k: ScreenKey) => {
  const r: ScreenSettingsTarget = SCREEN_SETTINGS[k];
  return `/admin/settings/${r.tab}${r.section ? `/${r.section}` : ''}`;
};

/** i18n key of the destination name shown on the second line of the hint. */
export const screenSettingsLabelKey = (k: ScreenKey) => {
  const r: ScreenSettingsTarget = SCREEN_SETTINGS[k];
  return r.section ? `settings.section_${r.tab}_${r.section}` : `settings.tab_${r.tab}`;
};

/** The gear is shown to whoever sees Settings in the side menu (me.effective.nav holds admin.settings); admin-only sections also need a System Admin. */
export function canOpenScreenSettings(me: { is_system_admin?: boolean; effective: { nav: readonly string[] } } | undefined, k: ScreenKey): boolean {
  const r: ScreenSettingsTarget = SCREEN_SETTINGS[k];
  if (!me) return false;
  if (r.adminOnly && !me.is_system_admin) return false;
  return !!me.is_system_admin || me.effective.nav.includes('admin.settings');
}
