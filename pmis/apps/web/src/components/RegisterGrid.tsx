import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { RegisterRecord } from '@/api/types';

export interface GridColumn {
  id: string;
  label: string;
}

/**
 * The Grid view of a register list (F16): the records the list already loaded, one row each, one column per shown field, in a table with a
 * sticky header and first column. It reads the same records as the Vertical list, so it adds no store and no request; a click or Enter opens
 * the record drawer like the list does.
 */
export function RegisterGrid({
  columns,
  rows,
  cell,
  onOpen,
  testid = "register-grid",
}: {
  columns: GridColumn[];
  rows: RegisterRecord[];
  cell: (columnId: string, r: RegisterRecord) => ReactNode;
  onOpen: (id: string) => void;
  testid?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="card relative max-h-[calc(100vh-18rem)] min-h-40 overflow-auto"
      data-testid={testid}
    >
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{t("viewMode.grid")}</caption>
        <thead className="sticky top-0 z-10 bg-card">
          <tr>
            {columns.map((c, i) => (
              <th
                key={c.id}
                scope="col"
                data-col={c.id}
                className={`whitespace-nowrap border-b border-line px-2 py-2 text-start font-semibold ${i === 0 ? "sticky start-0 bg-card" : ""}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              data-testid={`reg-grid-row-${r.id}`}
              data-state={r.state}
              tabIndex={0}
              className="cursor-pointer border-b border-line hover:bg-hover focus-visible:bg-hover"
              onClick={() => onOpen(r.id)}
              onKeyDown={(e) => {
                if (
                  (e.key === "Enter" || e.key === " ") &&
                  e.target === e.currentTarget
                ) {
                  e.preventDefault();
                  onOpen(r.id);
                }
              }}
            >
              {columns.map((c, i) => (
                <td
                  key={c.id}
                  data-col={c.id}
                  className={`min-w-0 px-2 py-2 align-middle ${i === 0 ? "sticky start-0 bg-card" : ""}`}
                >
                  {cell(c.id, r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
