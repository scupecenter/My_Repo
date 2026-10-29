// Synthetic state for users, assignments, groups, delegation, absence and exports (phase 3a). Lives inside the mock db.
import type { Assignment, Group, MasterExport, Role } from '@/api/types';
import { byId, uid } from './ids';
import { GROUPS, ROLES } from './matrixData';
import { STAFF } from './staff';

export type MockUser = { employee_id: string; status: 'pending_assignment' | 'active' | 'suspended' | 'disabled'; version: number; mfa: { exempt: boolean; until: string | null; reason: string | null; by: string | null };
  /** Account created in the PMIS with a password (employee_id is '' when none was given). */
  local?: { id: string; display_name: string; email: string; phone: string | null } };
export type MockDeleted = { employee_id: string; name_en: string; email: string; status: MockUser['status']; deleted_at: string; deleted_by: string; reason: string; version: number };
export type MockProfile = { id: string; code: string; name_en: string; name_ar: string; description: string | null; is_active: boolean; grants: { module_key: string; action: string }[]; field_rules: { field_id: string; access: string }[]; version: number; assignment_count: number };
export type MockExport = MasterExport & { polls: number; size: number };

export const PROFILES: MockProfile[] = [
  { id: '93000000-0000-4000-8000-000000000001', code: 'ENTRY_STD', name_en: 'Data entry standard', name_ar: 'إدخال بيانات قياسي' },
  { id: '93000000-0000-4000-8000-000000000002', code: 'REVIEW_STD', name_en: 'Reviewer standard', name_ar: 'مراجع قياسي' },
].map((p, i): MockProfile => ({
  ...p, description: null, is_active: true, version: 1, assignment_count: 0, field_rules: [],
  grants: [{ module_key: 'sites', action: 'view' }, { module_key: 'my_work', action: 'view' }, ...(i === 0 ? [{ module_key: 'sites', action: 'edit' }] : [{ module_key: 'approvals', action: 'approve' }])],
}));

export const PENDING_IDS = ['1210', '1211'];
const at = '2026-10-01T08:00:00Z';

const roleFor = (i: number): Role => ROLES[i % ROLES.length] as Role;

export function initAdmin() {
  const users: MockUser[] = STAFF.filter((s) => s.status === 'active').map((s) => ({
    employee_id: s.employee_id, status: PENDING_IDS.includes(s.employee_id) ? 'pending_assignment' : 'active', version: 1,
    mfa: s.employee_id === '1305' ? { exempt: true, until: null, reason: 'Field device without authenticator', by: '1001' } : { exempt: false, until: null, reason: null, by: null },
  }));
  const assignments: Assignment[] = users.filter((u) => u.status === 'active').map((u, i) => {
    const s = byId(u.employee_id), role = u.employee_id === '1001' ? ROLES[0] : roleFor(i + 1);
    return {
      id: `94000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, user: { id: uid(s.employee_id), display_name: s.name_en, employee_id: s.employee_id },
      role: { id: role.id, code: role.code, name_en: role.name_en, name_ar: role.name_ar }, permission_level: u.employee_id === '1001' ? 'admin' : i % 3 === 0 ? 'review' : 'entry',
      team: 'both', region_ids: i % 4 === 0 ? 'all' : [(i % 7) + 1], module_keys: 'all', profile_ids: [PROFILES[i % 2].id], is_primary: true, valid_from: at, valid_to: null, is_active_now: true, version: 1,
    } as Assignment;
  });
  const groups = GROUPS.map((g, i) => ({ ...g, members: (i === 0 ? ['1001', '1102', '1203'] : i === 1 ? ['1204', '1205', '1206', '1207'] : ['1305', '1306', '1307']).map((e) => e) })) as (Group & { members: string[] })[];
  return {
    users, assignments, roles: ROLES.map((r) => ({ ...r, version: 1, default_profile_id: PROFILES[0].id, default_region_ids: 'all', default_module_keys: 'all' })) as Role[], groups,
    profiles: PROFILES.map((p) => ({ ...p })) as MockProfile[],
    delegations: [] as { id: string; from: string; to: string | null; target_kind: 'user' | 'role' | 'group'; target_id: string; label: string; region_codes: number[]; module_codes: string[]; allow_redelegate: boolean; scope: 'full' | 'partial'; rights: string[]; valid_from: string; valid_to: string | null; revoked_at: string | null; reason: string; group_id?: string; role_id?: string }[],
    absences: [{ id: '95000000-0000-4000-8000-000000000001', employee_id: '1102', kind: 'sick' as const, from_date: '2026-10-24', to_date: '2026-10-29', note: 'Sick leave', recorded_by: '1001', version: 1 }] as { id: string; employee_id: string; kind: 'annual' | 'sick' | 'emergency' | 'other'; from_date: string; to_date: string; note: string | null; recorded_by: string; version: number }[],
    reassigned: {} as Record<string, string>, kept: {} as Record<string, string>, onBehalf: {} as Record<string, string>,
    idleDays: 2,
    exports: [] as MockExport[],
    /** Soft-deleted accounts (B14). 9001 is synthetic: its email now belongs to another account, so it cannot be restored. */
    deleted: [
      { employee_id: '1104', name_en: byId('1104').name_en, email: byId('1104').email, status: 'disabled', deleted_at: '2026-10-10T09:00:00Z', deleted_by: '1001', reason: 'Left the company', version: 3 },
      { employee_id: '9001', name_en: 'Rami Tester', email: 'ahmed.salem@example.com', status: 'disabled', deleted_at: '2026-10-12T09:00:00Z', deleted_by: '1001', reason: 'Duplicate account', version: 2 },
    ] as MockDeleted[],
  };
}
export type AdminDb = ReturnType<typeof initAdmin>;
