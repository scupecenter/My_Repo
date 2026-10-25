import { STAFF, type StaffRow } from './staff';

export const uid = (employeeId: string) => `00000000-0000-4000-8000-00000000${employeeId.padStart(4, '0')}`;
export const staffRef = (s: StaffRow) => ({ id: uid(s.employee_id), display_name: s.name_en, employee_id: s.employee_id });
export const byId = (id: string) => STAFF.find((s) => s.employee_id === id)!;
