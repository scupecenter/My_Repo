import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Site360MenuItem } from "@/api/site360";

export interface Site360GridRow {
  id: string;
  site_code: string;
  name?: string;
  /** The running number of the row in view (the # column); the index + 1 when not sent. */
  row_no?: number;
  /** The Master value of each column, keyed by the column order (ord); null when the column has no value. */
  values?: Record<string, string | null>;
  /** Inline edit targets of the task-backed columns, keyed by ord (contract 0.15.21, item 3). */
  cells?: Record<string, Site360CellTarget>;
}

/** The task behind a task-backed cell: the save goes to PATCH /tasks/{task_id} with the version (If-Match). */
export interface Site360CellTarget {
  task_id: string;
  version: number;
  editable: boolean;
  field?: "planned_date" | "actual_date" | "actual_start";
  values?: string;
}

/** A value typed into a cell: the target and the new value (an empty text clears the value). */
export interface Site360CellEdit {
  row: Site360GridRow;
  ord: number;
  target: Site360CellTarget;
  value: string;
}

/** Status columns drawn as pills (Progress: Current Milestone is text, Overall Status is one of five values). */
const STATUS_ORD = 182;
const STATUS_TONE: Record<string, string> = {
  not_started: "bg-hover text-mute",
  in_progress: "bg-sideOn text-accentText",
  on_hold: "bg-hover text-mute",
  completed: "text-done",
  cancelled: "bg-hover text-mute line-through",
};
/** Identity columns that must not be empty: an empty one is tinted. */
const MANDATORY = [2, 4];
/** A tint per phase band: the same band always gets the same colour; the group row is the lighter tint of it. */
const BAND_HUES = [210, 150, 35, 280, 190, 0, 95];
function bandHue(name: string | null): number {
  if (!name) return 0;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BAND_HUES[h % BAND_HUES.length]!;
}
const bandTint = (name: string | null, group: boolean) =>
  `hsl(${bandHue(name)} ${group ? 55 : 60}% ${group ? 94 : 86}%)`;

const W_FROZEN = 120;
const W_FIELD = 150;
const W_NUM = 60;
const W_GATE = 72;
/** # (ord 1), Site ID (ord 2) and Site Name (ord 4) are frozen in every menu and cannot be unfrozen. */
const PINNED = [1, 2, 4];

/**
 * The SITE 360 grid (F15), shared by the menus and the registers (F16): the Excel Master look.
 * Dense rows, thin borders, three sticky header rows (phase band, group, field), Phase Gate columns narrow and shaded,
 * frozen identity columns with a shadow divider, collapsible phase bands, a totals row and a footer that reads
 * "N of M sites". The # column is the running number of the rows in view.
 */
export function Site360Grid({
  menu,
  rows,
  total,
  filtered,
  testid = "site360-grid",
  onEditCell,
}: {
  menu: Site360MenuItem;
  rows: Site360GridRow[];
  /** Sites the caller may see (the footer's M). */
  total?: number;
  /** Sites that match the filters (the footer's N). */
  filtered?: number;
  testid?: string;
  /** Saves an inline edit of a task-backed cell; read-only cells never call it. */
  onEditCell?: (edit: Site360CellEdit) => void;
}) {
  const { i18n, t } = useTranslation();
  const ar = i18n.language === "ar";
  const [editing, setEditing] = useState<{ row: string; ord: number; draft: string } | null>(null);
  const [frozen, setFrozen] = useState<number[]>(() =>
    Array.from(new Set([...menu.frozen_ords, ...PINNED])),
  );
  const [collapsed, setCollapsed] = useState<number[]>([]);
  const byOrd = useMemo(
    () => new Map(menu.columns.map((c) => [c.ord, c])),
    [menu.columns],
  );

  const toggleBand = (i: number) =>
    setCollapsed((cur) =>
      cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i],
    );
  const toggleFreeze = (ord: number) => {
    if (PINNED.includes(ord)) return;
    setFrozen((cur) =>
      cur.includes(ord) ? cur.filter((x) => x !== ord) : [...cur, ord],
    );
  };

  const widthOf = (ord: number, gate: boolean) =>
    ord === 1
      ? W_NUM
      : gate
        ? W_GATE
        : frozen.includes(ord)
          ? W_FROZEN
          : W_FIELD;

  // Frozen columns keep their Master order; each one sits at the sum of the frozen widths before it.
  const frozenLeft = new Map<number, number>();
  let acc = 0;
  for (const c of menu.columns) {
    if (frozen.includes(c.ord)) {
      frozenLeft.set(c.ord, acc);
      acc += widthOf(c.ord, c.is_phase_gate);
    }
  }
  const lastFrozenOrd = Math.max(
    -1,
    ...Array.from(frozenLeft.keys()).map((o) => {
      const idx = menu.columns.findIndex((c) => c.ord === o);
      return menu.columns[idx]!.ord;
    }),
  );
  const stickyStyle = (ord: number) =>
    frozenLeft.has(ord)
      ? {
          position: "sticky" as const,
          left: frozenLeft.get(ord),
          zIndex: 2,
          boxShadow:
            ord === lastFrozenOrd
              ? "4px 0 6px -3px rgba(0,0,0,0.25)"
              : undefined,
        }
      : undefined;

  /** The text of a cell: # is the running row number, Site ID and Site Name are the identity, the rest are the Master values. */
  const value = (ord: number, index: number, row: Site360GridRow): string => {
    if (ord === 1) return String(row.row_no ?? index + 1);
    if (ord === 2) return row.site_code;
    if (ord === 4) return row.name ?? row.values?.["4"] ?? "";
    return row.values?.[String(ord)] ?? "";
  };

  const bandCols = (i: number) => menu.bands[i]!.groups.flatMap((g) => g.ords);
  const visibleOrds = menu.bands.flatMap((b, i) =>
    collapsed.includes(i) ? [] : bandCols(i),
  );

  const renderCell = (ord: number, text: string) => {
    if (text === "") return <span className="text-mute">-</span>;
    if (ord === STATUS_ORD) {
      return (
        <span
          data-testid={`${testid}-status`}
          className={`rounded px-1.5 py-px text-[11px] font-medium ${STATUS_TONE[text] ?? "bg-hover text-mute"}`}
        >
          {text.replace(/_/g, " ")}
        </span>
      );
    }
    return text;
  };

  return (
    <div
      className="card gx overflow-hidden"
      data-testid={testid}
      data-menu={menu.key}
    >
      <div className="overflow-auto" style={{ maxHeight: 560 }}>
        <table
          className="w-max border-separate border-spacing-0 text-xs"
          role="table"
          aria-label={ar ? menu.name_ar : menu.name_en}
        >
          <thead>
            <tr data-testid={`${testid}-band-row`}>
              {menu.bands.map((band, i) => {
                const open = !collapsed.includes(i);
                const span = open ? bandCols(i).length : 1;
                return (
                  <th
                    key={`band-${i}`}
                    colSpan={span}
                    scope="colgroup"
                    data-testid={`${testid}-band-${i}`}
                    data-gate={band.is_phase_gate ? "true" : "false"}
                    style={band.is_phase_gate ? undefined : { background: bandTint(band.name, false) }}
                    className={`sticky top-0 z-[3] border border-line px-2 py-0.5 text-start text-xs font-semibold ${band.is_phase_gate ? "bg-sideOn text-accentText" : "text-ink"}`}
                  >
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => toggleBand(i)}
                      className="font-semibold"
                    >
                      {open ? "▾" : "▸"} {band.name ?? ""}{" "}
                      {band.is_phase_gate ? `(${t("site360.gate")})` : ""}
                    </button>
                  </th>
                );
              })}
            </tr>
            <tr data-testid={`${testid}-group-row`}>
              {menu.bands.map((band, i) =>
                collapsed.includes(i) ? (
                  <th
                    key={`g-${i}`}
                    className="sticky top-[26px] z-[3] border border-line bg-card"
                  />
                ) : (
                  <Fragment key={`g-${i}`}>
                    {band.groups.map((g, gi) => (
                      <th
                        key={`g-${i}-${gi}`}
                        colSpan={g.ords.length}
                        style={band.is_phase_gate ? undefined : { background: bandTint(band.name, true) }}
                        className={`sticky top-[26px] z-[3] border border-line px-2 py-0.5 text-start text-xs ${band.is_phase_gate ? "bg-sideOn" : ""}`}
                      >
                        {g.name ?? ""}
                      </th>
                    ))}
                  </Fragment>
                ),
              )}
            </tr>
            <tr data-testid={`${testid}-field-row`}>
              {visibleOrds.map((ord) => {
                const c = byOrd.get(ord)!;
                const pinned = PINNED.includes(ord);
                return (
                  <th
                    key={ord}
                    data-ord={ord}
                    data-testid={`${testid}-field-${c.letter}`}
                    style={{
                      width: widthOf(ord, c.is_phase_gate),
                      minWidth: widthOf(ord, c.is_phase_gate),
                      top: 52,
                      ...stickyStyle(ord),
                    }}
                    className={`sticky z-[3] border border-line px-2 py-0.5 text-start text-xs font-bold ${c.is_phase_gate ? "bg-sideOn" : "bg-card"}`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate">{c.header}</span>
                      {pinned ? null : (
                        <button
                          type="button"
                          aria-pressed={frozen.includes(ord)}
                          onClick={() => toggleFreeze(ord)}
                          title={t("site360.freeze")}
                          className="text-[10px] text-mute"
                          data-testid={`${testid}-freeze-${c.letter}`}
                        >
                          {frozen.includes(ord) ? "■" : "□"}
                        </button>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={row.id}
                data-testid={`${testid}-row-${row.site_code}`}
                className="h-7 hover:bg-hover"
              >
                {visibleOrds.map((ord) => {
                  const c = byOrd.get(ord)!;
                  const num = ord === 1;
                  const target = row.cells?.[String(ord)];
                  const isEditing = editing?.row === row.id && editing.ord === ord;
                  const commit = () => {
                    if (!editing || !target || !onEditCell) return;
                    const draft = editing.draft;
                    setEditing(null);
                    if (draft !== (value(ord, index, row) ?? "")) onEditCell({ row, ord, target, value: draft });
                  };
                  return (
                    <td
                      key={ord}
                      data-ord={ord}
                      data-editable={target?.editable ? "true" : undefined}
                      data-testid={target ? `${testid}-cell-${row.site_code}-${ord}` : undefined}
                      onDoubleClick={
                        target?.editable && onEditCell && !isEditing
                          ? () => setEditing({ row: row.id, ord, draft: value(ord, index, row) ?? "" })
                          : undefined
                      }
                      className={`h-7 border border-line px-2 py-0 align-middle ${num ? "text-end tabular-nums text-mute" : ""} ${c.is_phase_gate ? "bg-sideOn/40" : "bg-card"}`}
                      style={{
                        ...stickyStyle(ord),
                        ...(MANDATORY.includes(ord) && !value(ord, index, row)
                          ? { background: "rgba(220, 38, 38, 0.08)" }
                          : {}),
                      }}
                    >
                      {isEditing && target ? (
                        <input
                          autoFocus
                          type={target.field ? "date" : "text"}
                          aria-label={c.header}
                          data-testid={`${testid}-input-${row.site_code}-${ord}`}
                          className="h-6 w-full bg-transparent text-xs outline-none"
                          value={editing.draft}
                          onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                          onBlur={commit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commit();
                            if (e.key === "Escape") setEditing(null);
                          }}
                        />
                      ) : (
                        renderCell(ord, value(ord, index, row))
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr data-testid={`${testid}-totals`}>
              {visibleOrds.map((ord, i) => (
                <td
                  key={ord}
                  className="border border-line bg-hover px-2 py-0.5 text-xs font-semibold"
                  style={{ ...stickyStyle(ord) }}
                >
                  {i === 0
                    ? t("site360.of", {
                        count: filtered ?? rows.length,
                        total: total ?? filtered ?? rows.length,
                      })
                    : ""}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
