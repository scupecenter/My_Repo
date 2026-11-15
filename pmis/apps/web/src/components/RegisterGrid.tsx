import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { RegisterRecord } from '@/api/types';

export interface GridColumn { id: string; label: string }

/**
 * The Grid view of a register list (F16): the records the list already loaded, one row each, one column per shown field, in a table with a
 * sticky header and first column. It reads the same records as the Vertical list, so it adds no store and no request; a click or Enter opens
 * the record drawer like the list does. A cell that canEdit takes an inline editor on click (the save goes through the record update).
 */
export function RegisterGrid({ columns, rows, cell, onOpen, canEdit, editing, onStartEdit, renderEditor, testid = 'register-grid' }: {
  columns: GridColumn[];
  rows: RegisterRecord[];
  cell: (columnId: string, r: RegisterRecord) => ReactNode;
  onOpen: (id: string) => void;
  /** Inline edit: true when the cell takes an editor (the record allows edit and the field is a simple type). */
  canEdit?: (columnId: string, r: RegisterRecord) => boolean;
  editing?: { id: string; col: string } | null;
  onStartEdit?: (id: string, col: string) => void;
  renderEditor?: (columnId: string, r: RegisterRecord) => ReactNode;
  testid?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="card relative max-h-[calc(100vh-18rem)] min-h-40 overflow-auto" data-testid={testid}>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{t('viewMode.grid')}</caption>
        <thead className="sticky top-0 z-10 bg-card">
          <tr>
            {columns.map((c, i) => (
              <th key={c.id} scope="col" data-col={c.id} className={`whitespace-nowrap border-b border-line px-2 py-2 text-start font-semibold ${i === 0 ? 'sticky start-0 bg-card' : ''}`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-testid={`reg-grid-row-${r.id}`} data-state={r.state} tabIndex={0} className="cursor-pointer border-b border-line hover:bg-hover focus-visible:bg-hover"
              onClick={() => onOpen(r.id)}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onOpen(r.id); } }}>
              {columns.map((c, i) => {
                const on = editing?.id === r.id && editing.col === c.id;
                const editable = !!onStartEdit && !on && !!canEdit?.(c.id, r);
                return (
                  <td key={c.id} data-col={c.id} data-editable={editable || undefined}
                    onClick={editable ? (e) => { e.stopPropagation(); onStartEdit?.(r.id, c.id); } : undefined}
                    className={`min-w-0 px-2 py-2 align-middle ${i === 0 ? 'sticky start-0 bg-card' : ''} ${editable ? 'cursor-text' : ''}`}>
                    {on && renderEditor ? renderEditor(c.id, r) : cell(c.id, r)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
