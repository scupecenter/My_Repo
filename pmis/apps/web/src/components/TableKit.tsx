import * as Popover from "@radix-ui/react-popover";
import {
  ArrowLeft,
  ArrowRight,
  Columns3,
  Minus,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import {
  useMemo,
  useState,
  type CSSProperties,
  type PointerEvent as RPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/api/hooks";
import {
  defaultHidden,
  dropCol,
  loadPrefs,
  moveCol,
  reconcile,
  resizeCol,
  storePrefs,
  toggleCol,
  visibleCols,
  type ColDef,
  type Density,
  type Prefs,
} from "@/lib/tablePrefs";
import { Tip } from "./Tip";

export const SEL_W = 36;
export const HEADER_H = 37;

/** Per-user, per-screen column prefs (order, hidden, width, density) in localStorage. Hiding or moving a column never touches a field, a permission or the Master export (plan G11). */
export function useTablePrefs(screen: string, defs: ColDef[]) {
  const user = useSession().data?.user?.id ?? "anon";
  const sig = `${screen}|${user}|${defs.map((d) => d.id + (d.forbidden ? "!" : "")).join(",")}`;
  const base = useMemo(() => loadPrefs(screen, user, defs), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const [own, setOwn] = useState<{ sig: string; p: Prefs } | null>(null);
  const prefs = own?.sig === sig ? own.p : base;
  const set = (fn: (p: Prefs) => Prefs) => {
    const n = reconcile(fn(prefs), defs);
    setOwn({ sig, p: n });
    storePrefs(screen, user, n);
  };
  return {
    prefs,
    defs,
    cols: visibleCols(prefs, defs),
    density: prefs.density,
    menuCols: prefs.order
      .map((id) => defs.find((d) => d.id === id))
      .filter((d): d is ColDef => !!d && !d.forbidden),
    move: (id: string, d: -1 | 1) => set((p) => moveCol(p, defs, id, d)),
    drop: (id: string, onto: string) => set((p) => dropCol(p, defs, id, onto)),
    toggle: (id: string) => set((p) => toggleCol(p, defs, id)),
    resize: (id: string, px: number) => set((p) => resizeCol(p, defs, id, px)),
    setDensity: (d: Density) => set((p) => ({ ...p, density: d })),
    reset: () =>
      set(() => ({ order: [], hidden: [], width: {}, density: "comfortable" })),
    /** Applies the columns of a saved view (P10): unknown or forbidden columns are dropped by reconcile. */
    apply: (c: Partial<Prefs>) =>
      set(() => ({
        order: c.order ?? [],
        hidden: c.hidden ?? defaultHidden(defs),
        width: c.width ?? {},
        density: c.density === "compact" ? "compact" : "comfortable",
      })),
  };
}
export type TableApi = ReturnType<typeof useTablePrefs>;

export const tracks = (cols: { px: number }[], sel: boolean) =>
  `${sel ? `${SEL_W}px ` : ""}${cols.map((c) => `${c.px}px`).join(" ")}`;
export const totalWidth = (cols: { px: number }[], sel: boolean) =>
  cols.reduce((n, c) => n + c.px, sel ? SEL_W : 0);
/** Pinned identity column: sticky at the inline start, so it stays in view when the table scrolls sideways (RTL too). */
export const pin = (
  c: { pinned?: boolean },
  sel: boolean,
): { className: string; style?: CSSProperties } =>
  c.pinned
    ? {
        className: "sticky z-10 bg-inherit",
        style: { insetInlineStart: sel ? SEL_W : 0 },
      }
    : { className: "" };

export function SelectBox({
  checked,
  indeterminate,
  onChange,
  label,
  testid,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  label: string;
  testid: string;
}) {
  return (
    <input
      type="checkbox"
      className="size-4 accent-[var(--accent)]"
      aria-label={label}
      data-testid={testid}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate && !checked;
      }}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

type SelectProps = {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  label: string;
  testid: string;
};
export function HeaderRow({
  api,
  label,
  select,
  testid,
}: {
  api: TableApi;
  label: (id: string) => string;
  select?: SelectProps;
  testid?: string;
}) {
  const { t } = useTranslation();
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const sel = !!select;
  const start = (e: RPointerEvent, id: string, w0: number) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX,
      dir = document.documentElement.dir === "rtl" ? -1 : 1;
    const mv = (ev: PointerEvent) =>
      api.resize(id, w0 + dir * (ev.clientX - x0));
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      role="row"
      data-testid={testid}
      className="sticky top-0 z-20 grid items-center border-b border-line bg-card2 text-sm font-semibold text-mute"
      style={{
        gridTemplateColumns: tracks(api.cols, sel),
        minWidth: totalWidth(api.cols, sel),
        height: HEADER_H,
      }}
    >
      {select && (
        <div
          role="columnheader"
          className="sticky start-0 z-10 flex justify-center bg-card2"
        >
          <SelectBox {...select} />
        </div>
      )}
      {api.cols.map((c) => {
        const p = pin(c, sel);
        return (
          <div
            key={c.id}
            role="columnheader"
            data-col={c.id}
            draggable={!c.pinned}
            title={undefined}
            onDragStart={(e) => {
              setDrag(c.id);
              e.dataTransfer.setData("text/plain", c.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (drag && !c.pinned && drag !== c.id) {
                e.preventDefault();
                setOver(c.id);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (drag) api.drop(drag, c.id);
              setDrag(null);
              setOver(null);
            }}
            onDragEnd={() => {
              setDrag(null);
              setOver(null);
            }}
            className={`relative truncate px-2 py-2 ${over === c.id ? "bg-accentSoft" : "bg-card2"} ${p.className}`}
            style={p.style}
          >
            {label(c.id)}
            <span
              role="separator"
              aria-orientation="vertical"
              tabIndex={0}
              aria-label={t("table.resize", { col: label(c.id) })}
              aria-valuenow={c.px}
              data-testid={`col-resize-${c.id}`}
              className="absolute inset-y-0 end-0 w-1.5 cursor-col-resize hover:bg-accent focus-visible:bg-accent"
              onPointerDown={(e) => start(e, c.id, c.px)}
              onKeyDown={(e) => {
                // keyboard alternative to the drag; the arrow that grows the column follows the reading direction
                const flip = document.documentElement.dir === "rtl" ? -1 : 1;
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  e.stopPropagation();
                  api.resize(
                    c.id,
                    c.px + (e.key === "ArrowRight" ? 16 : -16) * flip,
                  );
                }
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Column show/hide, reorder and width (menu alternative to dragging), density and reset. Pinned columns cannot be hidden or moved. */
export function ColumnMenu({
  api,
  label,
}: {
  api: TableApi;
  label: (id: string) => string;
}) {
  const { t } = useTranslation();
  const ico = "btn px-1.5 py-1";
  return (
    <Popover.Root>
      <Tip text={t("table.columns")}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="btn"
            data-testid="cols-menu"
            aria-label={t("table.columns")}
          >
            <Columns3 size={16} />
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="card z-50 w-80 p-3 text-sm shadow-lg"
          data-testid="cols-panel"
        >
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {api.menuCols.map((d, i) => {
              const shown = d.pinned || !api.prefs.hidden.includes(d.id),
                px = api.prefs.width[d.id] ?? d.w;
              return (
                <li key={d.id} className="flex items-center gap-1">
                  <label className="flex flex-1 items-center gap-2 truncate">
                    <input
                      type="checkbox"
                      checked={shown}
                      disabled={d.pinned}
                      data-testid={`col-toggle-${d.id}`}
                      onChange={() => api.toggle(d.id)}
                    />
                    {label(d.id)}
                  </label>
                  {!d.pinned && (
                    <>
                      <button
                        type="button"
                        className={ico}
                        aria-label={t("table.move_earlier", {
                          col: label(d.id),
                        })}
                        data-testid={`col-earlier-${d.id}`}
                        disabled={i === 0 || api.menuCols[i - 1]?.pinned}
                        onClick={() => api.move(d.id, -1)}
                      >
                        <ArrowLeft size={12} className="rtl:rotate-180" />
                      </button>
                      <button
                        type="button"
                        className={ico}
                        aria-label={t("table.move_later", { col: label(d.id) })}
                        data-testid={`col-later-${d.id}`}
                        disabled={i === api.menuCols.length - 1}
                        onClick={() => api.move(d.id, 1)}
                      >
                        <ArrowRight size={12} className="rtl:rotate-180" />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className={ico}
                    aria-label={t("table.narrower", { col: label(d.id) })}
                    data-testid={`col-narrower-${d.id}`}
                    onClick={() => api.resize(d.id, px - 16)}
                  >
                    <Minus size={12} />
                  </button>
                  <button
                    type="button"
                    className={ico}
                    aria-label={t("table.wider", { col: label(d.id) })}
                    data-testid={`col-wider-${d.id}`}
                    onClick={() => api.resize(d.id, px + 16)}
                  >
                    <Plus size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
          <div
            className="mt-3 flex items-center gap-2 border-t border-line pt-3"
            role="radiogroup"
            aria-label={t("table.density")}
          >
            {(["comfortable", "compact"] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={api.density === d}
                data-testid={`density-${d}`}
                className={`btn ${api.density === d ? "bg-accentSoft text-accentText" : ""}`}
                onClick={() => api.setDensity(d)}
              >
                {t(`table.${d}`)}
              </button>
            ))}
            <button
              type="button"
              className="btn ms-auto"
              data-testid="cols-reset"
              onClick={api.reset}
            >
              <RotateCcw size={14} />
              {t("table.reset")}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Truncated text with its full value in a tooltip (plan G5). Empty values are shown as "empty", never as N/A. */
export function Trunc({
  text,
  className = "",
}: {
  text?: string | number | null;
  className?: string;
}) {
  if (text === null || text === undefined || text === "") return <Empty />;
  const s = String(text);
  return (
    <Tip text={s}>
      <span className={`block truncate ${className}`}>{s}</span>
    </Tip>
  );
}
/** Plan G10: three different "no value" looks. Empty = nothing entered; N/A = does not apply (a state, not a gap). */
export function Empty() {
  const { t } = useTranslation();
  return (
    <span
      className="text-mute"
      data-value="empty"
      aria-label={t("table.empty")}
    >
      —
    </span>
  );
}
export function NotApplicable() {
  const { t } = useTranslation();
  return (
    <span className="chip bg-lockBg text-lockInk" data-value="na">
      {t("table.na")}
    </span>
  );
}

/** Contextual bar for the selected rows. States plainly how many rows are loaded versus how many match, so "visible" is never read as "all matching" (plan G7). */
export function BulkBar({
  count,
  loaded,
  total,
  onClear,
  children,
  testid,
}: {
  count: number;
  loaded: number;
  total: number;
  onClear: () => void;
  children?: ReactNode;
  testid: string;
}) {
  const { t } = useTranslation();
  if (!count) return null;
  return (
    <div
      role="region"
      aria-live="polite"
      aria-label={t("table.bulk")}
      data-testid={testid}
      className="card sticky bottom-2 z-30 mt-2 flex flex-wrap items-center gap-2 border-accent px-3 py-2 text-sm shadow-lg"
    >
      <b data-testid={`${testid}-count`}>{t("table.selected", { count })}</b>
      <span className="text-mute" data-testid={`${testid}-scope`}>
        {t("table.scope", { loaded, total })}
      </span>
      <span className="ms-auto flex flex-wrap items-center gap-2">
        {children}
        <button
          type="button"
          className="btn"
          data-testid={`${testid}-clear`}
          onClick={onClear}
        >
          <X size={14} />
          {t("table.clear_selection")}
        </button>
      </span>
    </div>
  );
}

export type Chip = { key: string; label: string; onRemove: () => void };
/** Active-filter chips: remove one, or clear all (plan F2). */
export function ActiveChips({
  chips,
  onClear,
}: {
  chips: Chip[];
  onClear: () => void;
}) {
  const { t } = useTranslation();
  if (!chips.length) return null;
  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-2"
      data-testid="active-chips"
      aria-label={t("table.active_filters", { count: chips.length })}
    >
      {chips.map((c) => (
        <span
          key={c.key}
          className="chip gap-1 bg-accentSoft text-accentText"
          data-testid={`chip-${c.key}`}
        >
          {c.label}
          <button
            type="button"
            aria-label={t("table.remove_filter", { label: c.label })}
            data-testid={`chip-remove-${c.key}`}
            onClick={c.onRemove}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <button
        type="button"
        className="btn px-2 py-0.5 text-xs"
        data-testid="chips-clear"
        onClick={onClear}
      >
        {t("states.clear_filters")}
      </button>
    </div>
  );
}

export function QuickFilter({
  on,
  onClick,
  children,
  testid,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  testid: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      data-testid={testid}
      onClick={onClick}
      className={`btn px-2 py-1 text-xs ${on ? "border-accent bg-accentSoft text-accentText" : ""}`}
    >
      {children}
    </button>
  );
}

/** Row-height class for the two densities of non-virtualised lists. */
export const rowPad = (d: Density) => (d === "compact" ? "py-1" : "py-3");
