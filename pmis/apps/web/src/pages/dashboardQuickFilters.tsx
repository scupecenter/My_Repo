import { useTranslation } from "react-i18next";
import { useFilterFields, type FilterTree } from "@/api/views";
import { isGroup } from "@/components/FilterBuilder";

/**
 * Item 10 (contract 0.15.207): quick dropdowns for the four site filters the proposal names. The filters already exist
 * in the unified filter (screen dashboard, 0.15.45); these selects read and write the SAME tree (`adv`), so a chip made in
 * the "+ Filter" menu shows here and the other way round. They need the field's value list (distinct values the caller can
 * see); a field with none is not shown. Nothing is stored apart from the tree in the URL.
 */
const QUICK = [
  { key: "project_phase", label: "dash.filters.quick_phase" },
  { key: "delivery_batch", label: "dash.filters.quick_batch" },
  { key: "site_type", label: "dash.filters.quick_site_type" },
  { key: "tower_owner", label: "dash.filters.quick_tower_owner" },
] as const;

const EMPTY: FilterTree = { op: "and", items: [] };

/** The single value a root condition `is` on this field holds, or "" (a list, another operator or a group is left alone). */
export function quickValue(tree: FilterTree | null, key: string): string {
  const c = (tree?.items ?? []).find((it) => !isGroup(it) && it.field === key && it.operator === "is");
  return c && !isGroup(c) && typeof c.value === "string" ? c.value : "";
}

export function withQuickValue(tree: FilterTree | null, key: string, value: string): FilterTree {
  let base: FilterTree = tree && tree.items.length ? tree : EMPTY;
  if (base.op === "or") {
    // an OR tree stays as it is: it becomes one group of an AND (only when it holds conditions alone: two levels at most)
    if (base.items.some(isGroup)) return base;
    base = { op: "and", items: [{ op: "or", items: base.items } as FilterTree["items"][number]] };
  }
  const rest = base.items.filter((it) => isGroup(it) || it.field !== key);
  return { op: "and", items: value ? [...rest, { field: key, operator: "is", value }] : rest };
}

export function QuickSiteFilters({ tree, onChange }: { tree: FilterTree | null; onChange: (t: FilterTree) => void }) {
  const { t, i18n } = useTranslation();
  const fields = useFilterFields("dashboard");
  const ar = i18n.language === "ar";
  return (
    <>
      {QUICK.map((q) => {
        const f = (fields.data?.items ?? []).find((x) => x.key === q.key);
        if (!f || !f.options || f.options.length === 0) return null;
        return (
          <label key={q.key} className="text-sm font-semibold">
            {t(q.label)}
            <select
              className="input mt-1 w-auto font-normal"
              data-testid={`dash-quick-${q.key}`}
              value={quickValue(tree, q.key)}
              onChange={(e) => onChange(withQuickValue(tree, q.key, e.target.value))}
            >
              <option value="">{t("dash.filters.quick_all")}</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {(ar && o.label_ar) || o.label_en}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </>
  );
}
