import { useEffect, useRef, useState } from 'react';
import type { RegisterField } from '@/api/types';
import { FieldInput } from './RegisterFields';

/** The field types a grid cell edits inline (F16). Other types (people, sites, files) open the record drawer. */
export const INLINE_TYPES: RegisterField['type'][] = ['text', 'number', 'date', 'list'];

/**
 * The editor of one grid cell (F16): the drawer's own FieldInput. It saves on blur or Enter, reverts on Escape, and never saves the same
 * value twice. The server still decides: the caller only shows it when the record allows edit.
 */
export function GridCellEditor({ field, value, onSave, onClose }: { field: RegisterField; value: unknown; onSave: (next: unknown) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<unknown>(value);
  const done = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector<HTMLElement>('input, select')?.focus(); }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && draft !== value) onSave(draft);
    onClose();
  };
  return (
    <div ref={box} className="min-w-0" data-testid={`grid-edit-${field.code}`} onClick={(e) => e.stopPropagation()} onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if (e.key === 'Enter' && e.target instanceof HTMLInputElement) { e.preventDefault(); finish(true); }
      }}>
      <FieldInput field={field} value={draft} onChange={setDraft} />
    </div>
  );
}
