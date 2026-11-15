import { Fragment, useEffect, useRef, useState } from "react";
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
const W_MIN = 40;
const W_MAX = 480;
/** # (ord 1), Site ID (ord 2) and Site Name (ord 4) are frozen in every menu and cannot be unfrozen or hidden. */
const PINNED = [1, 2, 4];
/** The value checklist of a filter lists at most this many distinct values. */
const MAX_FILTER_VALUES = 200;

type SortState = { ord: number; dir: "asc" | "desc" } | null;
type CellPos = { r: number; c: number };

/** A number read from a cell (commas allowed), or null when the text is not a number. */
function numeric(text: string): number | null {
  if (text.trim() === "") return null;
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * The SITE 360 grid (F15), shared by the menus and the registers (F16): the Excel Master look.
 * Dense rows, thin borders, three sticky header rows (phase band, group, field), Phase Gate columns narrow and shaded,
 * frozen identity columns with a shadow divider, collapsible phase bands, a totals row and a footer that reads
 * "N of M sites". The # column is the running number of the rows in view.
 *
 * Working features (F18, item 4): drag the right edge of a header to resize a column, double-click that edge to fit
 * the column to its text, and use the header menu (⋮) to sort, filter by a checklist of the values in the view, or hide
 * the column. Click a cell and shift-click another to select a rectangle; the footer then shows its cell count, its
 * numeric count and the sum. Sort and filter work on the rows loaded in this grid; the server pages the rest.
 */
export function Site360Grid({
  menu,
  rows,
  total,
  filtered,
  testid = "site360-grid",
  onEditCell,
  onSelectRows,
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
  /** The rows of the selected rectangle (empty when none), so a toolbar can act on those sites (lock, unlock). */
  onSelectRows?: (rows: Site360GridRow[]) => void;
}) {
  const { i18n, t } = useTranslation();
  const ar = i18n.language === "ar";
  const [editing, setEditing] = useState<{
    row: string;
    ord: number;
    draft: string;
  } | null>(null);
  const [frozen, setFrozen] = useState<number[]>(() =>
    Array.from(new Set([...menu.frozen_ords, ...PINNED])),
  );
  const [collapsed, setCollapsed] = useState<number[]>([]);
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [hidden, setHidden] = useState<number[]>([]);
  const [sort, setSort] = useState<SortState>(null);
  const [filters, setFilters] = useState<Record<number, string[]>>({});
  const [menuOrd, setMenuOrd] = useState<number | null>(null);
  const [filterSearch, setFilterSearch] = useState("");
  const [sel, setSel] = useState<{ a: CellPos; b: CellPos } | null>(null);
  const dragRef = useRef<{
    ord: number;
    startX: number;
    startW: number;
  } | null>(null);

  const byOrd = new Map(menu.columns.map((c) => [c.ord, c]));
  const isShown = (ord: number) =>
    PINNED.includes(ord) || !hidden.includes(ord);
  const groupOrds = (ords: number[]) => ords.filter(isShown);
  const bandCols = (i: number) =>
    groupOrds(menu.bands[i]!.groups.flatMap((g) => g.ords));
  const visibleOrds = menu.bands.flatMap((_, i) =>
    collapsed.includes(i) ? [] : bandCols(i),
  );
  const visibleSet = new Set(visibleOrds);

  // Drag a header edge to resize the column; the pointer listeners live only while a drag runs.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = (e.clientX - d.startX) * (ar ? -1 : 1);
      setWidths((w) => ({
        ...w,
        [d.ord]: Math.max(W_MIN, Math.min(W_MAX, d.startW + dx)),
      }));
    };
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [ar]);

  // A click anywhere outside the header menu closes it (its own clicks stop propagation).
  useEffect(() => {
    if (menuOrd === null) return;
    const close = () => setMenuOrd(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOrd]);

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
    widths[ord] ??
    (ord === 1
      ? W_NUM
      : gate
        ? W_GATE
        : frozen.includes(ord)
          ? W_FROZEN
          : W_FIELD);

  // Frozen columns keep their Master order; each one sits at the sum of the visible frozen widths before it.
  const frozenLeft = new Map<number, number>();
  let lastFrozen = -1;
  let acc = 0;
  for (const c of menu.columns) {
    if (visibleSet.has(c.ord) && frozen.includes(c.ord)) {
      frozenLeft.set(c.ord, acc);
      acc += widthOf(c.ord, c.is_phase_gate);
      lastFrozen = c.ord;
    }
  }
  const stickyStyle = (ord: number) =>
    frozenLeft.has(ord)
      ? {
          position: "sticky" as const,
          left: frozenLeft.get(ord),
          zIndex: 2,
          boxShadow:
            ord === lastFrozen ? "4px 0 6px -3px rgba(0,0,0,0.25)" : undefined,
        }
      : undefined;

  /** The text of a cell: # is the running row number, Site ID and Site Name are the identity, the rest are the Master values. */
  const value = (ord: number, index: number, row: Site360GridRow): string => {
    if (ord === 1) return String(row.row_no ?? index + 1);
    if (ord === 2) return row.site_code;
    if (ord === 4) return row.name ?? row.values?.["4"] ?? "";
    return row.values?.[String(ord)] ?? "";
  };

  // The rows in view: filtered by the checklists, then sorted (blanks always last).
  const indexed = rows.map((row, index) => ({ row, index }));
  let shown = indexed;
  for (const [key, allowed] of Object.entries(filters)) {
    const ord = Number(key);
    shown = shown.filter(({ row, index }) =>
      allowed.includes(value(ord, index, row)),
    );
  }
  if (sort) {
    const mul = sort.dir === "asc" ? 1 : -1;
    shown = [...shown].sort((a, b) => {
      const va = value(sort.ord, a.index, a.row);
      const vb = value(sort.ord, b.index, b.row);
      if (va === vb) return 0;
      if (va === "") return 1;
      if (vb === "") return -1;
      const na = numeric(va);
      const nb = numeric(vb);
      if (na !== null && nb !== null) return (na - nb) * mul;
      return va.localeCompare(vb, undefined, { numeric: true }) * mul;
    });
  }

  const distinctValues = (ord: number): string[] => {
    const seen = new Set<string>();
    for (const { row, index } of indexed) seen.add(value(ord, index, row));
    return Array.from(seen)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .slice(0, MAX_FILTER_VALUES);
  };

  const toggleValue = (ord: number, v: string) => {
    const all = distinctValues(ord);
    const cur = filters[ord] ?? all;
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    setFilters((f) => {
      const copy = { ...f };
      if (all.every((x) => next.includes(x))) delete copy[ord];
      else copy[ord] = next;
      return copy;
    });
  };

  const hideColumn = (ord: number) => {
    setHidden((h) => (h.includes(ord) ? h : [...h, ord]));
    setSort((s) => (s?.ord === ord ? null : s));
    setMenuOrd(null);
  };

  const autoFit = (ord: number) => {
    const c = byOrd.get(ord);
    let longest = c?.header.length ?? 0;
    for (const { row, index } of shown) {
      longest = Math.max(longest, value(ord, index, row).length);
    }
    const width = Math.min(
      W_MAX,
      Math.max(W_MIN, Math.round(longest * 7 + 24)),
    );
    setWidths((w) => ({ ...w, [ord]: width }));
  };

  const bandRow = (
    <tr data-testid={`${testid}-band-row`}>
      {menu.bands.map((band, i) => {
        const open = !collapsed.includes(i);
        const span = open ? bandCols(i).length : 1;
        if (span === 0) return null;
        return (
          <th
            key={`band-${i}`}
            colSpan={span}
            scope="colgroup"
            data-testid={`${testid}-band-${i}`}
            data-gate={band.is_phase_gate ? "true" : "false"}
            style={
              band.is_phase_gate
                ? undefined
                : { background: bandTint(band.name, false) }
            }
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
  );

  const groupRow = (
    <tr data-testid={`${testid}-group-row`}>
      {menu.bands.map((band, i) =>
        collapsed.includes(i) ? (
          <th
            key={`g-${i}`}
            className="sticky top-[26px] z-[3] border border-line bg-card"
          />
        ) : (
          <Fragment key={`g-${i}`}>
            {band.groups.map((g, gi) => {
              const n = groupOrds(g.ords).length;
              if (n === 0) return null;
              return (
                <th
                  key={`g-${i}-${gi}`}
                  colSpan={n}
                  style={
                    band.is_phase_gate
                      ? undefined
                      : { background: bandTint(band.name, true) }
                  }
                  className={`sticky top-[26px] z-[3] border border-line px-2 py-0.5 text-start text-xs ${band.is_phase_gate ? "bg-sideOn" : ""}`}
                >
                  {g.name ?? ""}
                </th>
              );
            })}
          </Fragment>
        ),
      )}
    </tr>
  );

  const menuPanel = (ord: number, letter: string) => {
    const all = distinctValues(ord);
    const allowed = filters[ord];
    const needle = filterSearch.trim().toLowerCase();
    const items = all.filter(
      (v) =>
        needle === "" ||
        (v === "" ? t("site360.blanks") : v).toLowerCase().includes(needle),
    );
    return (
      <div
        role="menu"
        data-testid={`${testid}-menu-panel-${letter}`}
        className="absolute end-0 top-full z-[5] mt-0.5 w-56 rounded border border-line bg-card p-2 text-start text-xs font-normal shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-1 border-b border-line pb-2">
          <button
            type="button"
            role="menuitem"
            data-testid={`${testid}-sort-asc-${letter}`}
            onClick={() => {
              setSort({ ord, dir: "asc" });
              setMenuOrd(null);
            }}
            className="text-start hover:underline"
          >
            {t("site360.sort_asc")}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid={`${testid}-sort-desc-${letter}`}
            onClick={() => {
              setSort({ ord, dir: "desc" });
              setMenuOrd(null);
            }}
            className="text-start hover:underline"
          >
            {t("site360.sort_desc")}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid={`${testid}-sort-clear-${letter}`}
            onClick={() => {
              setSort(null);
              setMenuOrd(null);
            }}
            className="text-start hover:underline"
          >
            {t("site360.sort_clear")}
          </button>
        </div>
        <div className="py-2">
          <div className="mb-1 font-semibold">{t("site360.filter")}</div>
          <input
            type="search"
            aria-label={t("site360.filter_search")}
            placeholder={t("site360.filter_search")}
            value={filterSearch}
            onChange={(e) => setFilterSearch(e.target.value)}
            className="mb-1 h-6 w-full rounded border border-line bg-transparent px-1"
            data-testid={`${testid}-filter-search-${letter}`}
          />
          <div className="mb-1 flex gap-2">
            <button
              type="button"
              data-testid={`${testid}-filter-all-${letter}`}
              onClick={() =>
                setFilters((f) => {
                  const c = { ...f };
                  delete c[ord];
                  return c;
                })
              }
              className="hover:underline"
            >
              {t("site360.all")}
            </button>
            <button
              type="button"
              data-testid={`${testid}-filter-none-${letter}`}
              onClick={() => setFilters((f) => ({ ...f, [ord]: [] }))}
              className="hover:underline"
            >
              {t("site360.none_value")}
            </button>
          </div>
          <ul className="max-h-48 overflow-auto">
            {items.map((v) => (
              <li key={v === "" ? "(blank)" : v}>
                <label className="flex items-center gap-1 py-px">
                  <input
                    type="checkbox"
                    checked={allowed === undefined || allowed.includes(v)}
                    onChange={() => toggleValue(ord, v)}
                    data-testid={`${testid}-filter-value-${letter}`}
                  />
                  <span className="truncate">
                    {v === "" ? t("site360.blanks") : v}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          role="menuitem"
          data-testid={`${testid}-hide-${letter}`}
          onClick={() => hideColumn(ord)}
          className="border-t border-line pt-2 text-start hover:underline"
        >
          {t("site360.hide")}
        </button>
      </div>
    );
  };

  const fieldRow = (
    <tr data-testid={`${testid}-field-row`}>
      {visibleOrds.map((ord) => {
        const c = byOrd.get(ord)!;
        const pinned = PINNED.includes(ord);
        const sorted =
          sort?.ord === ord ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
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
              <span className="truncate">
                {c.header}
                {sorted}
              </span>
              <span className="flex shrink-0 items-center gap-1">
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
                <button
                  type="button"
                  aria-label={t("site360.menu")}
                  aria-expanded={menuOrd === ord}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    setFilterSearch("");
                    setMenuOrd((m) => (m === ord ? null : ord));
                  }}
                  className={`text-[11px] ${filters[ord] !== undefined ? "text-accentText" : "text-mute"}`}
                  data-testid={`${testid}-menu-${c.letter}`}
                >
                  ⋮
                </button>
              </span>
            </div>
            {menuOrd === ord ? menuPanel(ord, c.letter) : null}
            <span
              role="separator"
              aria-orientation="vertical"
              aria-label={t("site360.resize")}
              title={t("site360.resize")}
              data-testid={`${testid}-resize-${c.letter}`}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                dragRef.current = {
                  ord,
                  startX: e.clientX,
                  startW: widthOf(ord, c.is_phase_gate),
                };
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                autoFit(ord);
              }}
              className="absolute inset-y-0 end-0 w-1.5 cursor-col-resize hover:bg-accent/40"
            />
          </th>
        );
      })}
    </tr>
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

  // The selected rectangle (rows of the view by visible columns) and its totals for the footer.
  const rect = sel
    ? {
        r0: Math.min(sel.a.r, sel.b.r),
        r1: Math.max(sel.a.r, sel.b.r),
        c0: Math.min(sel.a.c, sel.b.c),
        c1: Math.max(sel.a.c, sel.b.c),
      }
    : null;
  const inRect = (r: number, c: number) =>
    rect !== null &&
    r >= rect.r0 &&
    r <= rect.r1 &&
    c >= rect.c0 &&
    c <= rect.c1;
  let selCells = 0;
  let selNumbers = 0;
  let selSum = 0;
  if (rect) {
    for (let r = rect.r0; r <= rect.r1; r++) {
      const item = shown[r];
      if (!item) continue;
      for (let c = rect.c0; c <= rect.c1; c++) {
        const ord = visibleOrds[c];
        if (ord === undefined) continue;
        selCells++;
        const n = numeric(value(ord, item.index, item.row));
        if (n !== null) {
          selNumbers++;
          selSum += n;
        }
      }
    }
  }
  const hiddenCount = hidden.length;
  // Report the rows of the selection to the toolbar; keyed by the rectangle and the view, so it runs on change only.
  const selKey = rect ? `${rect.r0}:${rect.r1}:${rect.c0}:${rect.c1}` : "";
  useEffect(() => {
    if (!onSelectRows) return;
    onSelectRows(rect ? shown.slice(rect.r0, rect.r1 + 1).map((x) => x.row) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, rows, sort, filters, hidden]);

  return (
    <div
      className="card gx overflow-hidden"
      data-testid={testid}
      data-menu={menu.key}
    >
      {hiddenCount > 0 ? (
        <div className="flex items-center gap-2 border-b border-line px-2 py-1 text-xs">
          <button
            type="button"
            onClick={() => setHidden([])}
            data-testid={`${testid}-show-hidden`}
            className="text-accentText hover:underline"
          >
            {t("site360.show_hidden", { count: hiddenCount })}
          </button>
        </div>
      ) : null}
      <div className="overflow-auto" style={{ maxHeight: 560 }}>
        <table
          className="w-max border-separate border-spacing-0 text-xs"
          role="table"
          aria-label={ar ? menu.name_ar : menu.name_en}
        >
          <thead>
            {bandRow}
            {groupRow}
            {fieldRow}
          </thead>
          <tbody>
            {shown.map(({ row, index }, r) => (
              <tr
                key={row.id}
                data-testid={`${testid}-row-${row.site_code}`}
                className="h-7 hover:bg-hover"
              >
                {visibleOrds.map((ord, c) => {
                  const col = byOrd.get(ord)!;
                  const num = ord === 1;
                  const target = row.cells?.[String(ord)];
                  const isEditing =
                    editing?.row === row.id && editing.ord === ord;
                  const commit = () => {
                    if (!editing || !target || !onEditCell) return;
                    const draft = editing.draft;
                    setEditing(null);
                    if (draft !== (value(ord, index, row) ?? ""))
                      onEditCell({ row, ord, target, value: draft });
                  };
                  const selected = inRect(r, c);
                  return (
                    <td
                      key={ord}
                      data-ord={ord}
                      data-editable={target?.editable ? "true" : undefined}
                      data-selected={selected ? "true" : undefined}
                      data-testid={
                        target
                          ? `${testid}-cell-${row.site_code}-${ord}`
                          : undefined
                      }
                      onMouseDown={(e) => {
                        if (e.button !== 0 || isEditing) return;
                        if (e.shiftKey && sel)
                          setSel({ a: sel.a, b: { r, c } });
                        else setSel({ a: { r, c }, b: { r, c } });
                      }}
                      onDoubleClick={
                        target?.editable && onEditCell && !isEditing
                          ? () =>
                              setEditing({
                                row: row.id,
                                ord,
                                draft: value(ord, index, row) ?? "",
                              })
                          : undefined
                      }
                      className={`h-7 border border-line px-2 py-0 align-middle ${num ? "text-end tabular-nums text-mute" : ""} ${col.is_phase_gate ? "bg-sideOn/40" : "bg-card"} ${selected ? "ring-1 ring-inset ring-accent bg-accent/5" : ""}`}
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
                          aria-label={col.header}
                          data-testid={`${testid}-input-${row.site_code}-${ord}`}
                          className="h-6 w-full bg-transparent text-xs outline-none"
                          value={editing.draft}
                          onChange={(e) =>
                            setEditing({ ...editing, draft: e.target.value })
                          }
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
                        count: filtered ?? shown.length,
                        total: total ?? filtered ?? rows.length,
                      })
                    : ""}
                </td>
              ))}
            </tr>
            {rect ? (
              <tr data-testid={`${testid}-selection`}>
                <td
                  colSpan={Math.max(1, visibleOrds.length)}
                  className="border border-line bg-sideOn/40 px-2 py-0.5 text-xs"
                >
                  {t("site360.selection", {
                    count: selCells,
                    numbers: selNumbers,
                    sum: selSum.toLocaleString(ar ? "ar" : "en", {
                      maximumFractionDigits: 2,
                    }),
                  })}
                </td>
              </tr>
            ) : null}
          </tfoot>
        </table>
      </div>
    </div>
  );
}
