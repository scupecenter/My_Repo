import type { Me } from '@/api/types';

export type MeT = Me | undefined;
/** A grant is held by a System Admin or by an effective-permission row with that action. */
export const hasGrant = (me: MeT, action: string) => !!me && (!!me.is_system_admin || me.effective.grants.some((g) => (g.action as string) === action));
export const isAdmin = (me: MeT) => !!me?.is_system_admin;
/** A System Admin, or a `view` grant on the module (or on every module, `*`). */
/** View on a module or a screen; a grant on a module covers its screens (`sites` covers `sites.documents`), as app_has_permission does on the server. */
export const canViewModule = (me: MeT, module: string) => !!me && (!!me.is_system_admin || me.effective.grants.some((g) => g.action === 'view' && (g.module_key === module || g.module_key === '*' || module.startsWith(`${g.module_key}.`))));
