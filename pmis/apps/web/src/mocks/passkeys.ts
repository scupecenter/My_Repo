/** 0.15.194: passkeys in the mock server. Off by default, kept in memory (like the new-device code). `items` are the registered passkeys by account key; the item id doubles as the credential id. */
export type MockPasskey = { id: string; credential_id: string; label: string; created_at: string; last_used_at: string | null; device_type: 'singleDevice' | 'multiDevice'; backed_up: boolean };
export const passkeyState: { enabled: boolean; ready: boolean; version: number; updated_at: string | null; updated_by: { id: string; display_name: string; employee_id: string | null } | null; items: Record<string, MockPasskey[]> } =
  { enabled: false, ready: true, version: 1, updated_at: null, updated_by: null, items: {} };
export const passkeyDto = (p: MockPasskey) => ({ id: p.id, label: p.label, created_at: p.created_at, last_used_at: p.last_used_at, device_type: p.device_type, backed_up: p.backed_up });
