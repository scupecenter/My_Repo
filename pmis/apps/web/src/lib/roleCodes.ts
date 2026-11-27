/**
 * Role codes the platform names in its own rules (seeded roles and the ones registers refer to). The database locks them
 * (migration 0500, `role_code_protected`); this copy only tells the dialog which field to disable, the server decides.
 */
export const BUILT_IN_ROLE_CODES: readonly string[] = [
  'PM', 'RFD_ACQ_TL', 'CW_TL', 'TE_TL', 'INV_SUP', 'PROJ_SUPPORT', 'MANAGEMENT', 'RF_ENG', 'MW_ENG', 'ACQ_TEAM', 'POWER_ENG',
  'GECOL_TEAM', 'HLC_TEAM', 'SITE_ENG_CW', 'SITE_ENG_TE', 'HOTO_ENG', 'PROC_TEAM', 'QC_GENERAL', 'FLEET_DISPATCHER', 'FIN_OFFICER',
];
export const ROLE_CODE_RE = /^[A-Z][A-Z0-9_]{1,40}$/;
export const isBuiltInRoleCode = (code: string): boolean => BUILT_IN_ROLE_CODES.includes(code);
