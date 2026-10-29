/**
 * The permission catalogue: the modules and screens the grid editor offers, and the closed list of delegable rights with
 * the (module, action) grants each right is stored as. There is no catalogue table in the database (module keys are free
 * text in permission_grants, delegation_grants and the assignment modules), so the list lives here. It uses the same
 * vocabulary as the reference seed (migration 0013) and the keys the database functions check (app_can, idm_actor,
 * app_actor_is_admin).
 */

export interface ModuleDef {
  key: string;
  name_en: string;
  screens?: { key: string; name_en: string }[];
  /** Actions that make sense for the module; the editor offers these. */
  actions: string[];
}

const OPERATIONAL = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'import', 'download_documents', 'view_audit'];
const READ_ONLY = ['view', 'export'];
const CONFIG = ['view', 'create', 'edit', 'delete'];

export const MODULES: ModuleDef[] = [
  { key: 'sites', name_en: 'Sites', screens: [{ key: 'sites.documents', name_en: 'Site documents' }], actions: OPERATIONAL },
  { key: 'approvals', name_en: 'Approvals', actions: ['view', 'approve', 'view_audit'] },
  { key: 'my_work', name_en: 'My Work', actions: ['view'] },
  { key: 'dashboard', name_en: 'Dashboard', actions: READ_ONLY },
  { key: 'reports', name_en: 'Reports', actions: READ_ONLY },
  { key: 'templates', name_en: 'Templates', actions: ['view', 'create', 'edit', 'import', 'download_documents'] },
  { key: 'procurement', name_en: 'Procurement (PR/PO/WO)', actions: OPERATIONAL },
  { key: 'contractors', name_en: 'Contractors', actions: OPERATIONAL },
  { key: 'rf_design', name_en: 'RF survey and design', actions: OPERATIONAL },
  { key: 'acquisition', name_en: 'Acquisition', actions: OPERATIONAL },
  { key: 'gecol', name_en: 'GECOL power', actions: OPERATIONAL },
  { key: 'hlc', name_en: 'HLC fiber', actions: OPERATIONAL },
  { key: 'permits_hse', name_en: 'Permits and HSE', actions: OPERATIONAL },
  { key: 'warehouse', name_en: 'Warehouse', actions: OPERATIONAL },
  { key: 'quality', name_en: 'Quality', actions: OPERATIONAL },
  { key: 'issues', name_en: 'Issue Log', actions: OPERATIONAL },
  { key: 'risks', name_en: 'Risk Register', actions: OPERATIONAL },
  { key: 'change_control', name_en: 'Change Control', actions: OPERATIONAL },
  { key: 'readiness', name_en: 'Readiness and Handover', actions: OPERATIONAL },
  { key: 'as_built', name_en: 'As-Built', actions: OPERATIONAL },
  { key: 'meetings', name_en: 'Meetings', actions: OPERATIONAL },
  { key: 'dismantle', name_en: 'Dismantle', actions: OPERATIONAL },
  { key: 'absence', name_en: 'Absence', actions: ['view', 'create', 'edit', 'delete'] },
  { key: 'messages', name_en: 'Messages', actions: ['view', 'create'] },
  { key: 'announcements', name_en: 'Announcements', actions: ['view', 'create'] },
  { key: 'audit', name_en: 'Audit Log', actions: ['view', 'view_audit', 'export'] },
  {
    key: 'admin',
    name_en: 'Administration',
    screens: [
      { key: 'admin.users', name_en: 'Users and roles' },
      { key: 'admin.roles', name_en: 'Roles and permission profiles' },
      { key: 'admin.groups', name_en: 'Groups' },
      { key: 'admin.delegation', name_en: 'Delegation' },
      { key: 'admin.matrix', name_en: 'Responsibility Matrix' },
      { key: 'admin.workflow', name_en: 'Workflow' },
      { key: 'admin.settings', name_en: 'Settings' },
      { key: 'admin.security_log', name_en: 'Sign-in and security log' },
      { key: 'admin.online', name_en: 'Online now' },
      { key: 'admin.announcements', name_en: 'Announcements results' },
    ],
    actions: ['view', 'create', 'edit', 'delete', 'administer', 'manage_users', 'view_security_log'],
  },
  // Configuration modules the database checks on its own tables (app_can) and in the idm_* / admin_* functions.
  { key: 'users', name_en: 'Users (configuration)', actions: CONFIG },
  { key: 'assignments', name_en: 'Role assignments (configuration)', actions: CONFIG },
  { key: 'groups', name_en: 'Groups (configuration)', actions: CONFIG },
  { key: 'roles', name_en: 'Roles (configuration)', actions: CONFIG },
  { key: 'permission_profiles', name_en: 'Permission profiles (configuration)', actions: CONFIG },
  { key: 'regions', name_en: 'Regions (configuration)', actions: CONFIG },
  { key: 'workflow_versions', name_en: 'Workflow versions (configuration)', actions: ['view', 'create', 'edit', 'delete', 'administer'] },
  { key: 'task_definitions', name_en: 'Task definitions (configuration)', actions: CONFIG },
  { key: 'document_types', name_en: 'Document Library (configuration)', actions: CONFIG },
  { key: 'calendars', name_en: 'Work calendar (configuration)', actions: CONFIG },
  { key: 'sla_rules', name_en: 'SLA rules (configuration)', actions: CONFIG },
  { key: 'weights', name_en: 'Weight sets (configuration)', actions: CONFIG },
  { key: 'baseline', name_en: 'Baseline (configuration)', actions: CONFIG },
  { key: 'settings', name_en: 'Settings (configuration)', actions: CONFIG },
  { key: 'fields', name_en: 'Custom fields (configuration)', actions: CONFIG },
  { key: 'lists', name_en: 'Lists (configuration)', actions: CONFIG },
  { key: 'warehouse_items', name_en: 'Warehouse item master (configuration)', actions: CONFIG },
  { key: 'matrix', name_en: 'Matrix (configuration)', actions: CONFIG },
];

/** Every key a grant, a role default or an assignment may name: modules, then their screens. */
export const MODULE_KEYS = new Set(MODULES.flatMap((m) => [m.key, ...(m.screens ?? []).map((s) => s.key)]));
/** Keys an assignment or a role default may name: the top level of a module (the database matches on split_part(key, '.', 1)). */
export const TOP_LEVEL_KEYS = new Set(MODULES.map((m) => m.key));

type Grant = readonly [module: string, action: string];
const edit = (module: string): Grant[] => [[module, 'create'], [module, 'edit'], [module, 'delete']];
const override = (right: string): Grant[] => [[`overrides.${right}`, 'administer']];

/**
 * Delegable right -> the grants stored in delegation_grants. A grant on "X" covers the checks on "X" and "X.*"
 * (deleg_covers). "<module>.edit" means every write on the module (create, edit, delete): the idm_* functions check
 * create, edit and delete separately. The admin overrides and reassign are stored as "overrides.<right>" with the action
 * `administer`, which the engine (P1-BE-14) will check.
 */
export const RIGHT_GRANTS: Record<string, Grant[]> = {
  unlock: override('unlock'),
  skip: override('skip'),
  mark_na: override('mark_na'),
  accept_without_document: override('accept_without_document'),
  accept_without_workflow: override('accept_without_workflow'),
  reopen: override('reopen'),
  edit_date: override('edit_date'),
  reassign: override('reassign'),
  'users.edit': edit('users'),
  'assignments.edit': edit('assignments'),
  'groups.edit': edit('groups'),
  'matrix.edit': edit('matrix'),
  'roles.edit': edit('roles'),
  'profiles.edit': edit('permission_profiles'),
  'settings.edit': ['settings', 'sla_rules', 'weights', 'calendars', 'baseline'].flatMap(edit),
  'documents.edit': edit('document_types'),
  'templates.edit': edit('templates'),
  'fields.edit': ['fields', 'lists'].flatMap(edit),
  'workflow.edit': [...['workflow_versions'].flatMap((m) => [[m, 'create'], [m, 'edit']] as Grant[]), ...edit('task_definitions')],
  // publish and migrate are both checked as workflow_versions.administer by the admin_* functions (migration 0009), so they are stored alike.
  'workflow.publish': [['workflow_versions', 'administer']],
  'workflow.migrate': [['workflow_versions', 'administer']],
  'warehouse.items.edit': edit('warehouse_items'),
};

export const DELEGABLE_RIGHTS = Object.keys(RIGHT_GRANTS);

/**
 * Rights a stored set of grants stands for. A right is present when its main grant (the `edit` or `administer` one) is, so a
 * delegation written by hand (for example only users.edit) still shows its right. workflow.publish and workflow.migrate share
 * their main grant and are therefore reported together.
 */
export function rightsFromGrants(grants: { module_key: string; action: string }[]): string[] {
  const have = new Set(grants.map((g) => `${g.module_key}\u0000${g.action}`));
  return DELEGABLE_RIGHTS.filter((r) => {
    const main = RIGHT_GRANTS[r]!.find(([, a]) => a === 'edit' || a === 'administer');
    return main !== undefined && have.has(`${main[0]}\u0000${main[1]}`);
  });
}

/** The grants of a list of rights, without duplicates. */
export function grantsFromRights(rights: string[]): { module: string; action: string }[] {
  const seen = new Map<string, { module: string; action: string }>();
  for (const r of rights) for (const [module, action] of RIGHT_GRANTS[r] ?? []) seen.set(`${module}\u0000${action}`, { module, action });
  return [...seen.values()];
}
