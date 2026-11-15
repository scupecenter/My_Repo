import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Site360MenuItem } from "@/api/site360";

export interface Site360GridRow {
  id: string;
  site_code: string;
  name: string;
}

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
  testid = "site360-grid",
}: {
  menu: Site360MenuItem;
  rows: Site360GridRow[];
  total?: number;
  testid?: string;
}) {
  const { i18n, t } = useTranslation();
  const ar = i18n.language === "ar";
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

  const value = (ord: number, index: number, row: Site360GridRow): string => {
    if (ord === 1) return String(index + 1);
    if (ord === 2) return row.site_code;
    if (ord === 4) return row.name;
    return "";
  };

  const bandCols = (i: number) => menu.bands[i]!.groups.flatMap((g) => g.ords);
  const visibleOrds = menu.bands.flatMap((b, i) =>
    collapsed.includes(i) ? [] : bandCols(i),
  );

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
                    className={`sticky top-0 z-[3] border border-line px-2 py-0.5 text-start text-xs font-semibold ${band.is_phase_gate ? "bg-sideOn text-accentText" : "bg-hover text-mute"}`}
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
                        className={`sticky top-[26px] z-[3] border border-line px-2 py-0.5 text-start text-xs ${band.is_phase_gate ? "bg-sideOn" : "bg-card"}`}
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
                  return (
                    <td
                      key={ord}
                      data-ord={ord}
                      className={`h-7 border border-line px-2 py-0 align-middle ${num ? "text-end tabular-nums text-mute" : ""} ${c.is_phase_gate ? "bg-sideOn/40" : "bg-card"}`}
                      style={{ ...stickyStyle(ord) }}
                    >
                      {value(ord, index, row) || (
                        <span className="text-mute">-</span>
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
                        count: rows.length,
                        total: total ?? rows.length,
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
