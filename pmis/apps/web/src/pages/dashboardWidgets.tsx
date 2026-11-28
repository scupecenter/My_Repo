import { ArrowDown, ArrowUp, BookmarkPlus, LayoutGrid, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useMyDashboardTemplates,
  useMyDashboardWidgetOps,
  type WidgetTab,
} from "@/api/dashboardWidgets";
import {
  effectiveLayout,
  moveRow,
  tabRows,
  templateLayouts,
  toLayout,
  type CardRow,
  type TabLayout,
} from "./dashboardLayout";

/**
 * Per-user dashboard widgets (contract 0.15.585, migration 0713). The caller arranges and hides the
 * cards of the tab in view and keeps named templates of the three tab layouts. Rows, moves and the stored shape are the F20 functions of
 * dashboardLayout.ts (no second layout model). Personal: it changes only what the caller sees; the data of every card is still the caller's own.
 */
const TABS: WidgetTab[] = ["pmo", "cw", "te"];

export function DashboardWidgets({
  tab,
  cards,
  personal,
  versions,
  global,
}: {
  tab: WidgetTab;
  cards: { code: string; label: string }[];
  personal: Record<string, TabLayout> | undefined;
  versions: Record<string, number>;
  global: Record<string, TabLayout> | undefined;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CardRow[] | null>(null);
  const [name, setName] = useState("");
  const ops = useMyDashboardWidgetOps();
  const tpls = useMyDashboardTemplates();
  const codes = cards.map((c) => c.code);
  const labelOf = Object.fromEntries(cards.map((c) => [c.code, c.label]));
  const base = effectiveLayout(tab, personal, global);
  const rows = draft ?? tabRows(base, codes);
  const mine = !!personal?.[tab];
  const err = ops.save.error ?? ops.saveTemplate.error ?? ops.applyTemplate.error;

  const set = (next: CardRow[]) => setDraft(next);
  const done = () => setDraft(null);

  return (
    <div className="print:hidden" data-testid="dash-widgets">
      <button
        type="button"
        className="btn"
        aria-expanded={open}
        title={t("dashWidgets.open_hint")}
        data-testid="dash-widgets-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <LayoutGrid size={16} aria-hidden />
        {t("dashWidgets.open")}
      </button>
      {open && (
        <section className="card mt-2 grid gap-4 p-4 md:grid-cols-2" aria-label={t("dashWidgets.title")} data-testid="dash-widgets-panel">
          <div>
            <h2 className="font-bold">{t("dashWidgets.title")}</h2>
            <p className="mb-2 text-sm text-mute" data-testid="dash-widgets-source">
              {mine ? t("dashWidgets.source_mine") : t("dashWidgets.source_global")}
            </p>
            <ol className="grid gap-1">
              {rows.map((r, i) => (
                <li key={r.code} className="flex items-center gap-2 rounded border border-line px-2 py-1" data-testid={`dw-row-${r.code}`}>
                  <label className="flex flex-1 items-center gap-2" title={t("dashWidgets.show_hint")}>
                    <input
                      type="checkbox"
                      data-testid={`dw-shown-${r.code}`}
                      checked={r.shown}
                      onChange={(e) => set(rows.map((x) => (x.code === r.code ? { ...x, shown: e.target.checked } : x)))}
                    />
                    <span className={r.shown ? "" : "text-mute line-through"}>{labelOf[r.code] ?? r.code}</span>
                  </label>
                  <button type="button" className="btn btn-ghost p-1" disabled={i === 0} title={t("dashWidgets.up_hint")} aria-label={t("dashWidgets.up", { name: labelOf[r.code] ?? r.code })} data-testid={`dw-up-${r.code}`} onClick={() => set(moveRow(rows, i, -1))}>
                    <ArrowUp size={14} />
                  </button>
                  <button type="button" className="btn btn-ghost p-1" disabled={i === rows.length - 1} title={t("dashWidgets.down_hint")} aria-label={t("dashWidgets.down", { name: labelOf[r.code] ?? r.code })} data-testid={`dw-down-${r.code}`} onClick={() => set(moveRow(rows, i, 1))}>
                    <ArrowDown size={14} />
                  </button>
                </li>
              ))}
            </ol>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-accent"
                disabled={!draft || ops.save.isPending}
                title={t("dashWidgets.save_hint")}
                data-testid="dw-save"
                onClick={() => ops.save.mutate({ tab, ...toLayout(rows), version: versions[tab] ?? 0 }, { onSuccess: done })}
              >
                {t("dashWidgets.save")}
              </button>
              <button type="button" className="btn" disabled={!draft} title={t("dashWidgets.discard_hint")} data-testid="dw-discard" onClick={done}>
                {t("dashWidgets.discard")}
              </button>
              <button type="button" className="btn" disabled={!mine || ops.reset.isPending} title={t("dashWidgets.reset_hint")} data-testid="dw-reset" onClick={() => ops.reset.mutate(tab, { onSuccess: done })}>
                <RotateCcw size={14} aria-hidden />
                {t("dashWidgets.reset")}
              </button>
            </div>
          </div>
          <div>
            <h3 className="font-bold">{t("dashWidgets.templates")}</h3>
            <p className="mb-2 text-sm text-mute">{t("dashWidgets.templates_note")}</p>
            <div className="flex gap-2">
              <input
                className="input flex-1"
                value={name}
                maxLength={80}
                placeholder={t("dashWidgets.template_name")}
                aria-label={t("dashWidgets.template_name")}
                data-testid="dw-template-name"
                onChange={(e) => setName(e.target.value)}
              />
              <button
                type="button"
                className="btn"
                disabled={!name.trim() || ops.saveTemplate.isPending}
                title={t("dashWidgets.template_save_hint")}
                data-testid="dw-template-save"
                onClick={() => ops.saveTemplate.mutate({ name: name.trim(), layouts: templateLayouts(TABS, personal, global, { tab, rows }) }, { onSuccess: () => setName("") })}
              >
                <BookmarkPlus size={14} aria-hidden />
                {t("dashWidgets.template_save")}
              </button>
            </div>
            <ul className="mt-2 grid gap-1">
              {(tpls.data ?? []).length === 0 && <li className="text-sm text-mute" data-testid="dw-template-empty">{t("dashWidgets.no_templates")}</li>}
              {(tpls.data ?? []).map((tp) => (
                <li key={tp.id} className="flex items-center gap-2 rounded border border-line px-2 py-1" data-testid={`dw-template-${tp.id}`}>
                  <span className="flex-1 truncate">{tp.name}</span>
                  <button type="button" className="btn" title={t("dashWidgets.template_apply_hint")} data-testid={`dw-template-apply-${tp.id}`} onClick={() => ops.applyTemplate.mutate(tp.id, { onSuccess: done })}>
                    {t("dashWidgets.template_apply")}
                  </button>
                  <button type="button" className="btn btn-ghost p-1" title={t("dashWidgets.template_delete_hint")} aria-label={t("dashWidgets.template_delete", { name: tp.name })} data-testid={`dw-template-delete-${tp.id}`} onClick={() => ops.deleteTemplate.mutate(tp.id)}>
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {err && (
            <p role="alert" className="text-sm text-lateInk md:col-span-2" data-testid="dw-error">
              {err.status === 412 ? t("dashWidgets.stale") : err.message}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
