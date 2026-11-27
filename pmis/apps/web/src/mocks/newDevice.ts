/** 0.15.192: the new-device email code in the mock server. Off by default, kept in memory (like the lock keys). `known` stands for the browsers a person has already used. */
export const newDeviceState: { enabled: boolean; code_minutes: number; include_admins: boolean; version: number; updated_at: string | null; updated_by: { id: string; display_name: string; employee_id: string | null } | null; known: Set<string>; bypass: Set<string> } =
  { enabled: false, code_minutes: 10, include_admins: false, version: 1, updated_at: null, updated_by: null, known: new Set(), bypass: new Set() };
export const NEW_DEVICE_MOCK_CODE = '123456';
