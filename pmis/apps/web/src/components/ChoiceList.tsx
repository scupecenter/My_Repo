import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useFilterFieldValues } from "@/api/views";

/**
 * The value checklist of a filter (a multi-select or, with `single`, a radio list) with its own search, shared by the unified filter (UnifiedFilter.tsx)
 * and the AND/OR builder (FilterBuilder.tsx). When the server cut the list (`truncated`, 0.15.49) the search asks the server as the user types.
 */
export function Check({
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

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return v;
}

/**
 * A multi-select checklist with its own search (the real values of the column). When the list was cut by the server (`truncated`, 0.15.49) the search asks the
 * server as the user types (debounced), so a value beyond the first 500 is reachable; the values already chosen stay on the list.
 */
export function ChoiceList({
  options,
  selected,
  onToggle,
  truncated,
  single,
  idp,
  search,
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (v: string) => void;
  truncated?: boolean;
  single?: boolean;
  idp: string;
  search?: { screen: string; field: string; lang: string };
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 300);
  const remote = useFilterFieldValues(
    search?.screen ?? "",
    search?.field ?? "",
    term,
    !!search && !!truncated,
  );
  const server = !!search && !!truncated && q.trim() !== "" && !!remote.data;
  const pending = !!search && !!truncated && q.trim() !== "" && (term !== q.trim() || remote.isFetching);
  const found = server
    ? remote.data!.items.map((o) => ({
        value: o.value,
        label: (search!.lang === "ar" && o.label_ar) || o.label_en,
      }))
    : [];
  const chosen = server
    ? selected
        .filter((v) => !found.some((o) => o.value === v))
        .map((v) => ({ value: v, label: options.find((o) => o.value === v)?.label ?? v }))
    : [];
  const shown = server
    ? [...chosen, ...found]
    : options.filter(
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
        {!shown.length && !pending && (
          <p className="p-2 text-sm text-mute">{t("filters.no_values")}</p>
        )}
        {pending && (
          <p className="p-2 text-xs text-mute" data-testid={`${idp}-searching`}>
            {t("filters.searching")}
          </p>
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
