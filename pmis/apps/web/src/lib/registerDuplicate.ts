import type { RegisterDefinition, RegisterRecord } from '@/api/types';

/**
 * "Duplicate record": the new-record form opens filled from an existing record. Nothing is saved until the person saves or submits, so the create goes through the
 * normal create endpoint (the server checks who may create, the step and field history record it) and the new record gets its own id, version chain and
 * entry state. The source rides in this small module because the row menu, the bulk bar and both record screens start the copy from different places.
 */
let source: { key: string; record: RegisterRecord } | null = null;

export function setDuplicateSource(key: string, record: RegisterRecord): void { source = { key, record }; }
/** The record being copied for this register, or null. */
export function duplicateSource(registerKey: string, id: string | null): RegisterRecord | null {
  return id === 'new' && source && source.key === registerKey ? source.record : null;
}
export const clearDuplicateSource = (): void => { source = null; };

/** The window event the row menu raises ({ id }): the register page listens and starts the copy of that row. */
export const DUPLICATE_EVENT = 'register:duplicate';

/** The field values to copy: everything the person can type, but not the fields the server owns (read only), files, or the rows of a child list. */
export function copyData(def: RegisterDefinition, rec: RegisterRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (f.read_only || f.type === 'file' || f.type === 'child_list') continue;
    const v = rec.data[f.code];
    if (v !== undefined) out[f.code] = v;
  }
  return out;
}
