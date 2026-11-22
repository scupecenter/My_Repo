import * as Popover from "@radix-ui/react-popover";
import { ArrowLeft, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useFilterFields,
  type FilterCondition,
  type FilterOperator,
  type FilterTree,
  type FilterValue,
  type UnifiedField,
} from "@/api/views";
import {
  conditionText,
  countConditions,
  FilterTreeEditor,
  isGroup,
  label as fieldLabel,
  optLabel,
} from "./FilterBuilder";
import { FormDialog } from "./FormDialog";

/**
 * The unified filter (owner request 2026-11-22): ONE "+ Filter" button opens one dropdown (Radix Popover) with a search box and the fields grouped
 * (Site, Status and stage, Dates, Menu columns / Register fields, Work). Picking a field shows the value input of its type; the applied filters
 * are chips beside the button (click to edit, x to remove, "Clear all"). "Advanced (AND/OR)" opens the group builder of FilterBuilder.tsx on the
 * same field list. Simple chips and groups are ONE tree (`FilterTree`) that the page keeps in the URL (`adv`) and sends as `filter`.
 *
 * `extras` are the filters of a page that are not columns of the server list (Assigned to me, Late, Workflow locks, Data gaps, Stage, Site IDs
 * list) or older URL parameters (region_id, q, ...): the page owns their URL parameters, so behaviour does not change. An extra with `hidden`
 * is a chip only (it is not offered in the dropdown).
 */
export type ExtraField = {
  key: string;
  label: string;
  group?: string;
  kind: "bool" | "enum" | "list" | "text";
  options?: { value: string; label: string }[];
  /** the current URL value; empty = not applied. A bool is applied with any non-empty value. */
  value: string;
  set: (v: string) => void;
  /** chip text when the default one does not fit */
  chip?: string;
  hidden?: boolean;
};

type Entry = {
  id: string;
  label: string;
  group: string;
  groupLabel: string;
  extra?: ExtraField;
  field?: UnifiedField;
};
/** The group of a server field comes from the API (`group`: key and the two labels); a field without one falls back to Dates, Register fields or Menu columns. */
function groupOf(
  f: UnifiedField,
  screen: string,
  lang: string,
  t: ReturnType<typeof useTranslation>["t"],
): { key: string; label: string } {
  if (f.group)
    return {
      key: f.group.key,
      label: (lang === "ar" && f.group.label_ar) || f.group.label_en,
    };
  const key =
    f.type === "date"
      ? "dates"
      : screen.startsWith("register-")
        ? "fields"
        : "columns";
  return { key, label: t(`filters.group.${key}`) };
}

const toList = (v: FilterCondition["value"]): string[] =>
  Array.isArray(v)
    ? v.map(String)
    : v === undefined || v === null || v === ""
      ? []
      : [String(v)];

/** The chip text of a condition: "Delivery batch: B3, B4" for a choice list, the operator form for the rest. */
function chipText(
  c: FilterCondition,
  fields: UnifiedField[],
  t: ReturnType<typeof useTranslation>["t"],
  lang: string,
): string {
  const f = fields.find((x) => x.key === c.field);
  if (f?.type === "enum" && (c.operator === "is" || c.operator === "in"))
    return `${fieldLabel(f, lang, c.field)}: ${toList(c.value)
      .map((v) => optLabel(f, v, lang))
      .join(", ")}`;
  return conditionText(c, fields, t, lang);
}

function Check({
  on,
  children,
  testid,
  onClick,
  radio,
}: {
  on: boolean;
  children: ReactNode;
  testid: string;
  onClick: () => void;
  radio?: boolean;
}) {
  return (
    <button
      type="button"
      role={radio ? "radio" : "checkbox"}
      aria-checked={on}
      data-testid={testid}
      onClick={onClick}
      className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-hover focus-visible:bg-hover"
    >
      <span
        aria-hidden
        className={`flex size-4 shrink-0 items-center justify-center border ${radio ? "rounded-full" : "rounded"} ${on ? "border-accent bg-accent text-accentInk" : "border-line"}`}
      >
        {on ? <span className="size-1.5 rounded-full bg-accentInk" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

/** A multi-select checklist with its own search (the real values of the column). */
function ChoiceList({
  options,
  selected,
  onToggle,
  truncated,
  single,
  idp,
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (v: string) => void;
  truncated?: boolean;
  single?: boolean;
  idp: string;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const shown = options.filter(
    (o) =>
      !q.trim() ||
      o.label.toLowerCase().includes(q.trim().toLowerCase()) ||
      o.value.toLowerCase().includes(q.trim().toLowerCase()),
  );
  return (
    <div className="space-y-1">
      {(options.length > 6 || truncated) && (
        <input
          type="search"
          className="input min-h-11"
          placeholder={t("filters.search_values")}
          aria-label={t("filters.search_values")}
          data-testid={`${idp}-search`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      )}
      <div
        role={single ? "radiogroup" : "group"}
        aria-label={t("filters.values")}
        className="max-h-60 overflow-auto"
        data-testid={`${idp}-options`}
      >
        {shown.map((o) => (
          <Check
            key={o.value}
            radio={single}
            on={selected.includes(o.value)}
            testid={`${idp}-opt-${o.value}`}
            onClick={() => onToggle(o.value)}
          >
            {o.label}
          </Check>
        ))}
        {!shown.length && (
          <p className="p-2 text-sm text-mute">{t("filters.no_values")}</p>
        )}
      </div>
      {truncated && (
        <p className="px-2 text-xs text-mute" data-testid={`${idp}-truncated`}>
          {t("filters.truncated")}
        </p>
      )}
    </div>
  );
}

function ApplyBar({
  onApply,
  disabled,
  onRemove,
}: {
  onApply: () => void;
  disabled?: boolean;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-2 pt-2">
      {onRemove ? (
        <button
          type="button"
          className="btn min-h-11"
          data-testid="filter-value-remove"
          onClick={onRemove}
        >
          {t("filters.remove")}
        </button>
      ) : (
        <span />
      )}
      <button
        type="button"
        className="btn btn-primary min-h-11"
        data-testid="filter-apply"
        disabled={disabled}
        onClick={onApply}
      >
        {t("filters.apply")}
      </button>
    </div>
  );
}

const has = (f: UnifiedField, op: string) =>
  f.operators.includes(op as FilterOperator);

/** The value input of one server field. `apply` sets the condition (null removes it); `done` closes the dropdown. */
function FieldEditor({
  f,
  cond,
  apply,
  done,
}: {
  f: UnifiedField;
  cond: FilterCondition | undefined;
  apply: (c: FilterCondition | null) => void;
  done: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const remove = cond
    ? () => {
        apply(null);
        done();
      }
    : undefined;
  const sel = toList(cond?.value);
  const [negate, setNegate] = useState(
    cond?.operator === "is_not" || cond?.operator === "not_in",
  );
  const [mode, setMode] = useState<"between" | "last" | "next" | "rel">(
    cond?.operator === "in_last_days"
      ? "last"
      : cond?.operator === "in_next_days"
        ? "next"
        : cond && ["is", "before", "after"].includes(cond.operator)
          ? "rel"
          : "between",
  );
  const pair = Array.isArray(cond?.value) ? (cond!.value as FilterValue[]) : [];
  const [from, setFrom] = useState(
    cond?.operator === "between" && typeof pair[0] === "string" ? pair[0] : "",
  );
  const [to, setTo] = useState(
    cond?.operator === "between" && typeof pair[1] === "string" ? pair[1] : "",
  );
  const [days, setDays] = useState(
    cond &&
      (cond.operator === "in_last_days" || cond.operator === "in_next_days")
      ? String(cond.value)
      : "7",
  );
  const [relOp, setRelOp] = useState<string>(
    cond && ["is", "before", "after"].includes(cond.operator)
      ? cond.operator
      : "is",
  );
  const [offset, setOffset] = useState(
    cond &&
      cond.value &&
      typeof cond.value === "object" &&
      !Array.isArray(cond.value)
      ? String((cond.value as { offset?: number }).offset ?? 0)
      : "0",
  );
  const nums =
    cond?.operator === "between" && Array.isArray(cond.value)
      ? cond.value.map(String)
      : cond && ["gte", "gt"].includes(cond.operator)
        ? [String(cond.value), ""]
        : cond && ["lte", "lt"].includes(cond.operator)
          ? ["", String(cond.value)]
          : cond && cond.operator === "eq"
            ? [String(cond.value), String(cond.value)]
            : ["", ""];
  const [min, setMin] = useState(nums[0] ?? "");
  const [max, setMax] = useState(nums[1] ?? "");
  const [textOp, setTextOp] = useState<string>(
    cond && ["is", "contains"].includes(cond.operator)
      ? cond.operator
      : has(f, "contains")
        ? "contains"
        : "is",
  );
  const [text, setText] = useState(
    cond && !Array.isArray(cond.value) && typeof cond.value === "string"
      ? cond.value
      : "",
  );
  const idp = "filter-value";

  if (f.type === "enum" && f.options?.length) {
    const opts = f.options.map((o) => ({
      value: o.value,
      label: optLabel(f, o.value, lang),
    }));
    const setList = (list: string[], neg: boolean) =>
      apply(
        list.length
          ? {
              field: f.key,
              operator: (neg ? "not_in" : "in") as FilterOperator,
              value: list,
            }
          : null,
      );
    return (
      <div>
        {(has(f, "not_in") || has(f, "is_not")) && (
          <div
            role="radiogroup"
            aria-label={t("filters.match_kind")}
            className="mb-2 inline-flex overflow-hidden rounded-md border border-line"
            data-testid="filter-negate"
          >
            {[false, true].map((n) => (
              <button
                key={String(n)}
                type="button"
                role="radio"
                aria-checked={negate === n}
                data-testid={n ? "filter-negate-not" : "filter-negate-any"}
                className={`min-h-11 px-3 text-xs font-semibold ${negate === n ? "bg-accent text-accentInk" : "bg-card text-ink"}`}
                onClick={() => {
                  setNegate(n);
                  if (sel.length) setList(sel, n);
                }}
              >
                {t(n ? "filters.none_of" : "filters.any_of")}
              </button>
            ))}
          </div>
        )}
        <ChoiceList
          idp={idp}
          options={opts}
          selected={sel}
          truncated={f.truncated}
          onToggle={(v) =>
            setList(
              sel.includes(v) ? sel.filter((x) => x !== v) : [...sel, v],
              negate,
            )
          }
        />
        {cond && (
          <div className="pt-2">
            <button
              type="button"
              className="btn min-h-11"
              data-testid="filter-value-remove"
              onClick={() => {
                apply(null);
                done();
              }}
            >
              {t("filters.remove")}
            </button>
          </div>
        )}
      </div>
    );
  }
  if (f.type === "bool") {
    return (
      <div
        role="radiogroup"
        aria-label={t("filters.values")}
        data-testid={`${idp}-bool`}
      >
        {[true, false].map((b) => (
          <Check
            key={String(b)}
            radio
            on={cond?.value === b}
            testid={`${idp}-bool-${b ? "yes" : "no"}`}
            onClick={() => {
              apply({ field: f.key, operator: "is", value: b });
              done();
            }}
          >
            {t(b ? "filterBuilder.yes" : "filterBuilder.no")}
          </Check>
        ))}
        {cond && (
          <div className="pt-2">
            <button
              type="button"
              className="btn min-h-11"
              data-testid="filter-value-remove"
              onClick={() => {
                apply(null);
                done();
              }}
            >
              {t("filters.remove")}
            </button>
          </div>
        )}
      </div>
    );
  }
  if (f.type === "date") {
    const modes = [
      ["between", "filters.date_between", has(f, "between")],
      ["last", "filters.date_last", has(f, "in_last_days")],
      ["next", "filters.date_next", has(f, "in_next_days")],
      [
        "rel",
        "filters.date_rel",
        has(f, "is") || has(f, "before") || has(f, "after"),
      ],
    ] as const;
    const go = () => {
      if (mode === "between")
        apply({ field: f.key, operator: "between", value: [from, to] });
      else if (mode === "last" || mode === "next")
        apply({
          field: f.key,
          operator: mode === "last" ? "in_last_days" : "in_next_days",
          value: Math.max(0, Number(days) || 0),
        });
      else
        apply({
          field: f.key,
          operator: relOp as FilterOperator,
          value: { rel: "today", offset: Number(offset) || 0 },
        });
      done();
    };
    return (
      <div className="space-y-2">
        <div
          role="radiogroup"
          aria-label={t("filterBuilder.date_kind")}
          className="flex flex-wrap gap-1"
          data-testid="filter-date-mode"
        >
          {modes
            .filter((m) => m[2])
            .map(([k, l]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={mode === k}
                data-testid={`filter-date-mode-${k}`}
                onClick={() => setMode(k)}
                className={`min-h-11 rounded-md border px-3 text-xs font-semibold ${mode === k ? "border-accent bg-accentSoft text-accentText" : "border-line"}`}
              >
                {t(l)}
              </button>
            ))}
        </div>
        {mode === "between" && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              className="input min-h-11 w-40"
              aria-label={t("filterBuilder.from")}
              data-testid="filter-date-from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <span className="text-mute">{t("filterBuilder.and_word")}</span>
            <input
              type="date"
              className="input min-h-11 w-40"
              aria-label={t("filterBuilder.to")}
              data-testid="filter-date-to"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        )}
        {(mode === "last" || mode === "next") && (
          <label className="flex items-center gap-2 text-sm">
            {t(mode === "last" ? "filters.last_n" : "filters.next_n")}
            <input
              type="number"
              min={0}
              max={3650}
              className="input min-h-11 w-24"
              aria-label={t("filterBuilder.days_label")}
              data-testid="filter-date-days"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
            {t("filters.days_word")}
          </label>
        )}
        {mode === "rel" && (
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="input min-h-11 w-auto"
              aria-label={t("filterBuilder.operator")}
              data-testid="filter-date-relop"
              value={relOp}
              onChange={(e) => setRelOp(e.target.value)}
            >
              {(["is", "before", "after"] as const)
                .filter((o) => has(f, o))
                .map((o) => (
                  <option key={o} value={o}>
                    {t(`filterBuilder.op.${o}`)}
                  </option>
                ))}
            </select>
            <span className="text-sm">{t("filterBuilder.today")}</span>
            <input
              type="number"
              className="input min-h-11 w-24"
              aria-label={t("filterBuilder.offset_label")}
              data-testid="filter-date-offset"
              value={offset}
              onChange={(e) => setOffset(e.target.value)}
            />
          </div>
        )}
        <ApplyBar
          onApply={go}
          onRemove={remove}
          disabled={mode === "between" && (!from || !to)}
        />
      </div>
    );
  }
  if (f.type === "number") {
    const go = () => {
      const a = min.trim() === "" ? null : Number(min),
        b = max.trim() === "" ? null : Number(max);
      if (a !== null && b !== null)
        apply({ field: f.key, operator: "between", value: [a, b] });
      else if (a !== null) apply({ field: f.key, operator: "gte", value: a });
      else if (b !== null) apply({ field: f.key, operator: "lte", value: b });
      else apply(null);
      done();
    };
    return (
      <div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            className="input min-h-11"
            placeholder={t("filters.min")}
            aria-label={t("filters.min")}
            data-testid="filter-num-min"
            value={min}
            onChange={(e) => setMin(e.target.value)}
          />
          <span className="text-mute">{t("filterBuilder.and_word")}</span>
          <input
            type="number"
            className="input min-h-11"
            placeholder={t("filters.max")}
            aria-label={t("filters.max")}
            data-testid="filter-num-max"
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
        </div>
        <ApplyBar
          onApply={go}
          onRemove={remove}
          disabled={min.trim() === "" && max.trim() === ""}
        />
      </div>
    );
  }
  // text (and an enum without a list of values)
  const go = () => {
    const v = text.trim();
    if (!v) apply(null);
    else apply({ field: f.key, operator: textOp as FilterOperator, value: v });
    done();
  };
  return (
    <div className="space-y-2">
      <div
        role="radiogroup"
        aria-label={t("filterBuilder.operator")}
        className="inline-flex overflow-hidden rounded-md border border-line"
      >
        {(["contains", "is"] as const)
          .filter((o) => has(f, o))
          .map((o) => (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={textOp === o}
              data-testid={`filter-text-op-${o}`}
              onClick={() => setTextOp(o)}
              className={`min-h-11 px-3 text-xs font-semibold ${textOp === o ? "bg-accent text-accentInk" : "bg-card text-ink"}`}
            >
              {t(o === "is" ? "filters.equals" : "filterBuilder.op.contains")}
            </button>
          ))}
      </div>
      <input
        className="input min-h-11"
        maxLength={200}
        aria-label={t("filterBuilder.value")}
        data-testid="filter-text-value"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && text.trim()) go();
        }}
      />
      <ApplyBar onApply={go} onRemove={remove} disabled={!text.trim()} />
    </div>
  );
}

/** The value input of a page extra (its own URL parameter). */
function ExtraEditor({ x, done }: { x: ExtraField; done: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(
    x.value.split(",").join(x.kind === "list" ? "\n" : ","),
  );
  if (x.kind === "bool") {
    return (
      <div role="radiogroup" aria-label={x.label}>
        <Check
          radio
          on={!!x.value}
          testid="filter-extra-on"
          onClick={() => {
            x.set("1");
            done();
          }}
        >
          {t("filterBuilder.yes")}
        </Check>
        <Check
          radio
          on={!x.value}
          testid="filter-extra-off"
          onClick={() => {
            x.set("");
            done();
          }}
        >
          {t("filterBuilder.no")}
        </Check>
      </div>
    );
  }
  if (x.kind === "enum") {
    return (
      <ChoiceList
        idp="filter-value"
        single
        options={x.options ?? []}
        selected={x.value ? [x.value] : []}
        onToggle={(v) => {
          x.set(x.value === v ? "" : v);
          done();
        }}
      />
    );
  }
  const go = () => {
    x.set(
      x.kind === "list"
        ? text
            .split(/[\s,]+/)
            .map((v) => v.trim())
            .filter(Boolean)
            .join(",")
        : text.trim(),
    );
    done();
  };
  return (
    <div className="space-y-2">
      {x.kind === "list" ? (
        <textarea
          rows={4}
          className="input font-mono text-xs"
          placeholder={t("filters.site_ids_placeholder")}
          aria-label={x.label}
          data-testid="filter-extra-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <input
          className="input min-h-11"
          aria-label={x.label}
          data-testid="filter-extra-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      <ApplyBar
        onApply={go}
        onRemove={
          x.value
            ? () => {
                x.set("");
                done();
              }
            : undefined
        }
      />
    </div>
  );
}

export function UnifiedFilter({
  screen,
  value,
  onChange,
  extras = [],
  onClearAll,
}: {
  screen: string;
  value: FilterTree | null;
  onChange: (t: FilterTree | null) => void;
  extras?: ExtraField[];
  /** "Clear all" calls only this when given: the page clears the tree, the extras and its other parameters in one URL update */
  onClearAll?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const q = useFilterFields(screen);
  const fields = useMemo(
    () => (q.data?.items ?? []) as UnifiedField[],
    [q.data],
  );
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<{ id: string } | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [adv, setAdv] = useState<FilterTree | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const entries: Entry[] = useMemo(
    () => [
      ...fields.map((f) => {
        const g = groupOf(f, screen, lang, t);
        return {
          id: `f:${f.key}`,
          label: fieldLabel(f, lang, f.key),
          group: g.key,
          groupLabel: g.label,
          field: f,
        };
      }),
      ...extras
        .filter((x) => !x.hidden)
        .map((x) => ({
          id: `x:${x.key}`,
          label: x.label,
          group: x.group ?? "work",
          groupLabel: t(`filters.group.${x.group ?? "work"}`, {
            defaultValue: x.group ?? "work",
          }),
          extra: x,
        })),
    ],
    [fields, extras, lang, screen, t],
  );
  const shown = useMemo(() => {
    const n = query.trim().toLowerCase();
    return entries.filter(
      (e) =>
        !n ||
        e.label.toLowerCase().includes(n) ||
        (e.field &&
          (e.field.label_en.toLowerCase().includes(n) ||
            (e.field.label_ar ?? "").toLowerCase().includes(n) ||
            e.field.key.toLowerCase().includes(n))),
    );
  }, [entries, query]);
  const groups = useMemo(() => {
    // the server order of the groups; the page's own "Work" group comes last
    const names = [...new Set(shown.map((e) => e.group))].sort(
      (a, b) => Number(a === "work") - Number(b === "work"),
    );
    return names.map((g) => {
      const items = shown.filter((e) => e.group === g);
      return { g, label: items[0]!.groupLabel, items };
    });
  }, [shown]);
  const flat = groups.flatMap((x) => x.items);
  const close = () => {
    setOpen(false);
    setStep(null);
    setQuery("");
  };
  useEffect(() => {
    if (open && !step) searchRef.current?.focus();
  }, [open, step]);

  if (!q.isSuccess) return null;

  const orMixed = !!value && value.op === "or" && value.items.length > 1;
  const condOf = (key: string) =>
    value?.items.find(
      (x): x is FilterCondition => !isGroup(x) && x.field === key,
    );
  const applyField = (key: string) => (c: FilterCondition | null) => {
    const base: FilterTree = value ?? { op: "and", items: [] };
    const has0 = base.items.some((x) => !isGroup(x) && x.field === key);
    const items = c
      ? has0
        ? base.items.map((x) => (!isGroup(x) && x.field === key ? c : x))
        : [...base.items, c]
      : base.items.filter((x) => isGroup(x) || x.field !== key);
    onChange(items.length ? { ...base, items } : null);
  };
  const entry = step ? entries.find((e) => e.id === step.id) : undefined;
  const pick = (e: Entry) => setStep({ id: e.id });

  const tree = value;
  const chips: {
    id: string;
    text: string;
    testid: string;
    remove: () => void;
    edit: () => void;
    title: string;
  }[] = [
    ...(tree?.items ?? []).map((it, i) => ({
      id: `t${i}`,
      testid: `filter-chip-${i}`,
      text: isGroup(it)
        ? `( ${it.items.map((c) => conditionText(c, fields, t, lang)).join(` ${t(`filterBuilder.${it.op}`)} `)} )`
        : chipText(it, fields, t, lang),
      remove: () => {
        const items = tree!.items.filter((_, j) => j !== i);
        onChange(items.length ? { ...tree!, items } : null);
      },
      edit: () =>
        isGroup(it)
          ? openAdvanced()
          : (setStep({ id: `f:${it.field}` }), setOpen(true)),
      title: isGroup(it) ? t("filters.edit_group") : t("filters.edit_chip"),
    })),
    ...extras
      .filter((x) => !!x.value)
      .map((x) => ({
        id: `x${x.key}`,
        testid: `filter-chip-x-${x.key}`,
        text:
          x.chip ??
          (x.kind === "bool"
            ? x.label
            : x.kind === "list"
              ? `${x.label}: ${x.value.split(",").filter(Boolean).length}`
              : `${x.label}: ${x.options?.find((o) => o.value === x.value)?.label ?? x.value}`),
        remove: () => x.set(""),
        edit: () => {
          if (!x.hidden) {
            setStep({ id: `x:${x.key}` });
            setOpen(true);
          }
        },
        title: t("filters.edit_chip"),
      })),
  ];
  // the router does not queue functional URL updates, so a page that passes onClearAll clears everything in one update
  const clearAll = () => {
    if (onClearAll) {
      onClearAll();
      return;
    }
    onChange(null);
    for (const x of extras) if (x.value) x.set("");
  };
  function openAdvanced() {
    setAdv(value ?? { op: "and", items: [] });
    close();
  }
  const nCond = tree ? countConditions(tree) : 0;
  const hasGroup = !!tree?.items.some(isGroup);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, flat.length - 1));
    } else if (e.key === "Enter" && flat[active]) {
      e.preventDefault();
      pick(flat[active]!);
    }
  };

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="unified-filter"
      data-screen={screen}
    >
      <Popover.Root open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
          <span className="inline-flex">
            <Popover.Trigger asChild>
              <button
                type="button"
                className="btn min-h-11"
                data-testid="filter-add"
                aria-haspopup="dialog"
                aria-label={t("filters.add_aria")}
              >
                <Plus size={14} aria-hidden /> {t("filters.add")}
                {nCond ? (
                  <span
                    className="chip bg-accentSoft text-accentText"
                    aria-hidden
                  >
                    {nCond}
                  </span>
                ) : null}
              </button>
            </Popover.Trigger>
          </span>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            collisionPadding={8}
            aria-label={t("filters.title")}
            data-testid="filter-popover"
            className="card z-[70] flex max-h-[min(34rem,var(--radix-popover-content-available-height))] w-[min(26rem,calc(100vw-1rem))] flex-col overflow-hidden p-2 text-sm shadow-lg max-sm:w-[calc(100vw-1rem)]"
          >
            {!step ? (
              <>
                <div className="relative">
                  <Search
                    size={14}
                    aria-hidden
                    className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-mute"
                  />
                  <input
                    ref={searchRef}
                    role="combobox"
                    aria-expanded
                    aria-controls="filter-fields-list"
                    aria-activedescendant={
                      flat[active] ? `filter-field-${active}` : undefined
                    }
                    className="input min-h-11 ps-9"
                    placeholder={t("filters.search_fields")}
                    aria-label={t("filters.search_fields")}
                    data-testid="filter-search"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setActive(0);
                    }}
                    onKeyDown={onKey}
                  />
                </div>
                {orMixed && (
                  <p
                    className="p-2 text-xs text-mute"
                    data-testid="filter-or-note"
                  >
                    {t("filters.or_note")}
                  </p>
                )}
                <div
                  id="filter-fields-list"
                  role="listbox"
                  aria-label={t("filters.fields")}
                  className="mt-1 min-h-0 flex-1 overflow-auto"
                  data-testid="filter-fields"
                >
                  {groups.map(({ g, label, items }) => (
                    <div
                      key={g}
                      role="group"
                      aria-label={label}
                      data-testid={`filter-group-${g}`}
                    >
                      <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase text-mute">
                        {label}
                      </div>
                      {items.map((e) => {
                        const i = flat.indexOf(e);
                        const on = e.extra
                          ? !!e.extra.value
                          : !!condOf(e.field!.key);
                        return (
                          <div
                            key={e.id}
                            id={`filter-field-${i}`}
                            role="option"
                            aria-selected={i === active}
                            tabIndex={-1}
                            data-testid={`filter-field-${e.id.slice(2)}`}
                            aria-disabled={
                              orMixed && !e.extra ? true : undefined
                            }
                            className={`flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-md px-2 ${i === active ? "bg-hover" : ""} ${orMixed && !e.extra ? "opacity-50" : ""}`}
                            onMouseEnter={() => setActive(i)}
                            onClick={() => {
                              if (!(orMixed && !e.extra)) pick(e);
                            }}
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {e.label}
                            </span>
                            {on && (
                              <span
                                className="chip bg-accentSoft text-accentText"
                                aria-label={t("filters.applied_mark")}
                              >
                                ●
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {!flat.length && (
                    <p className="p-3 text-mute" data-testid="filter-no-fields">
                      {t("filters.no_fields")}
                    </p>
                  )}
                </div>
                <div className="border-t border-line pt-2">
                  <button
                    type="button"
                    className="btn min-h-11 w-full justify-start border-transparent"
                    data-testid="filter-advanced"
                    onClick={openAdvanced}
                  >
                    <SlidersHorizontal size={14} aria-hidden />{" "}
                    {t("filters.advanced")}
                  </button>
                </div>
              </>
            ) : (
              <div
                className="flex min-h-0 flex-1 flex-col"
                data-testid="filter-editor"
              >
                <div className="mb-2 flex items-center gap-2">
                  <button
                    type="button"
                    className="btn min-h-11 px-3"
                    aria-label={t("filters.back")}
                    data-testid="filter-back"
                    onClick={() => setStep(null)}
                  >
                    <ArrowLeft
                      size={14}
                      aria-hidden
                      className="rtl:rotate-180"
                    />
                  </button>
                  <h3
                    className="min-w-0 flex-1 truncate font-semibold"
                    data-testid="filter-editor-title"
                  >
                    {entry?.label ?? ""}
                  </h3>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-1">
                  {entry?.field && (
                    <FieldEditor
                      key={entry.id}
                      f={entry.field}
                      cond={condOf(entry.field.key)}
                      apply={applyField(entry.field.key)}
                      done={close}
                    />
                  )}
                  {entry?.extra && (
                    <ExtraEditor
                      key={entry.id}
                      x={entry.extra}
                      done={close}
                    />
                  )}
                </div>
              </div>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {chips.length > 0 && (
        <ul
          className="flex flex-wrap items-center gap-1"
          data-testid="filter-chips"
          aria-label={t("filterBuilder.applied")}
        >
          {chips.map((c) => (
            <li key={c.id}>
              <span
                className={`chip min-h-8 gap-1 ${c.id.startsWith("t") && hasGroup && c.text.startsWith("(") ? "bg-waitBg text-waitInk" : "bg-accentSoft text-accentText"}`}
                data-testid={c.testid}
              >
                <button
                  type="button"
                  className="max-w-64 truncate text-start"
                  title={c.title}
                  aria-label={`${c.title}: ${c.text}`}
                  data-testid={`${c.testid}-edit`}
                  onClick={c.edit}
                >
                  {c.text}
                </button>
                <button
                  type="button"
                  className="ms-1 inline-flex size-6 items-center justify-center rounded hover:bg-hover"
                  aria-label={`${t("filterBuilder.remove_chip")}: ${c.text}`}
                  data-testid={`${c.testid.replace("filter-chip-", "filter-chip-remove-")}`}
                  onClick={c.remove}
                >
                  <X size={12} aria-hidden />
                </button>
              </span>
            </li>
          ))}
          <li>
            <button
              type="button"
              className="btn min-h-11 px-2 text-xs"
              data-testid="filter-clear-all"
              onClick={clearAll}
            >
              {t("filters.clear_all")}
            </button>
          </li>
        </ul>
      )}
      <FormDialog
        open={!!adv}
        onClose={() => setAdv(null)}
        title={t("filterBuilder.title")}
        testid="filter-dialog"
        withReason={false}
        wide
        submitLabel={t("filterBuilder.apply")}
        onSubmit={() => {
          const d = adv;
          setAdv(null);
          onChange(d && d.items.length ? d : null);
        }}
      >
        <p className="text-sm text-mute">{t("filterBuilder.hint")}</p>
        {adv && (
          <FilterTreeEditor tree={adv} fields={fields} onChange={setAdv} />
        )}
        {!!adv?.items.length && (
          <button
            type="button"
            className="btn text-xs"
            data-testid="filter-clear"
            onClick={() => setAdv({ op: "and", items: [] })}
          >
            {t("filterBuilder.clear")}
          </button>
        )}
      </FormDialog>
    </div>
  );
}
