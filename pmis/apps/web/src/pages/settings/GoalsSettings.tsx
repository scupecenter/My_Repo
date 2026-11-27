import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useGoals, useSetGoals, type Goal } from "@/api/goals";
import { errText, FormDialog } from "@/components/FormDialog";
import { QueryFallback } from "@/components/States";
import { useToast } from "@/components/Toast";

const PERIODS = ["month", "quarter", "year"] as const;

/** A new id from the English name: lower case, a-z 0-9 and hyphen, unique in the list. */
export function goalId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "goal";
  let id = base.length >= 3 ? base : `${base}-goal`;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`.slice(0, 40);
  return id;
}

/**
 * Settings, Screens, Goals (contract 0.15.160): each goal counts the sites that reach a milestone task (in a region, or in all) during the current month,
 * quarter or year. The progress is counted by the system and shown in the Dashboard card Goals; nobody types it. Needs admin.settings edit and a reason.
 * The fixed targets of Settings, Screens, Dashboard (sites per batch, monthly On-Air) stay there and keep feeding the On-Air counter.
 */
export function GoalsSettings() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useGoals();
  const set = useSetGoals();
  const [draft, setDraft] = useState<Goal[] | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data)
    return (
      <section className="card p-4" data-testid="page-goals-settings">
        <QueryFallback queries={[q]} testid="goals-settings-loading" />
      </section>
    );
  const s = q.data;
  const rows = draft ?? s.goals;
  const ar = i18n.language.startsWith("ar");
  const change = (i: number, patch: Partial<Goal>) =>
    setDraft(rows.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  const add = () =>
    setDraft([
      ...rows,
      {
        id: goalId("goal", rows.map((g) => g.id)),
        name_en: "",
        name_ar: null,
        metric: s.catalogue.metrics.find((m) => m.code === "MS6")?.code ?? s.catalogue.metrics[0]?.code ?? "",
        region_id: null,
        period: "month",
        target: 1,
        active: true,
      },
    ]);
  const invalid = rows.some(
    (g) => g.name_en.trim() === "" || !Number.isInteger(g.target) || g.target < 1 || g.target > 100000,
  );
  return (
    <section className="card space-y-4 p-4" data-testid="page-goals-settings">
      <h2 className="font-bold">{t("goals.settings_title")}</h2>
      <p className="text-sm text-mute">{t("goals.settings_note")}</p>
      <p className="text-sm">
        <Link className="text-accent hover:underline" to="/admin/settings/screens/dashboard" data-testid="goals-link-dashboard-settings">
          {t("goals.link_dashboard_settings")}
        </Link>{" "}
        ·{" "}
        <Link className="text-accent hover:underline" to="/dashboard" data-testid="goals-link-dashboard">
          {t("goals.link_dashboard")}
        </Link>
      </p>
      <p className="mono text-xs text-mute" data-testid="goals-version">
        {t("scopeMatch.version", { version: s.version })}
        {draft && <span className="chip ms-2">{t("scopeMatch.unsaved")}</span>}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="text-mute">
              <th className="py-1 text-start">{t("goals.name_en")}</th>
              <th className="px-2 text-start">{t("goals.name_ar")}</th>
              <th className="px-2 text-start">{t("goals.metric")}</th>
              <th className="px-2 text-start">{t("goals.region")}</th>
              <th className="px-2 text-start">{t("goals.period")}</th>
              <th className="px-2 text-end">{t("goals.target")}</th>
              <th className="px-2 text-center">{t("goals.active")}</th>
              <th className="px-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((g, i) => (
              <tr key={g.id} className="border-t border-line" data-testid={`goal-row-${g.id}`}>
                <td className="py-1">
                  <input className="input w-full" aria-label={t("goals.name_en")} data-testid={`goal-name-en-${g.id}`} value={g.name_en} maxLength={120} onChange={(e) => change(i, { name_en: e.target.value })} />
                </td>
                <td className="px-2">
                  <input className="input w-full" dir="rtl" aria-label={t("goals.name_ar")} data-testid={`goal-name-ar-${g.id}`} value={g.name_ar ?? ""} maxLength={120} onChange={(e) => change(i, { name_ar: e.target.value || null })} />
                </td>
                <td className="px-2">
                  <select className="input" aria-label={t("goals.metric")} data-testid={`goal-metric-${g.id}`} value={g.metric} onChange={(e) => change(i, { metric: e.target.value })}>
                    {s.catalogue.metrics.map((m) => (
                      <option key={m.code} value={m.code}>{m.code} · {(ar && m.label_ar) || m.label_en}</option>
                    ))}
                  </select>
                </td>
                <td className="px-2">
                  <select className="input" aria-label={t("goals.region")} data-testid={`goal-region-${g.id}`} value={g.region_id ?? ""} onChange={(e) => change(i, { region_id: e.target.value === "" ? null : Number(e.target.value) })}>
                    <option value="">{t("goals.all_regions")}</option>
                    {s.catalogue.regions.map((r) => (
                      <option key={r.id} value={r.id}>{(ar && r.name_ar) || r.name_en}</option>
                    ))}
                  </select>
                </td>
                <td className="px-2">
                  <select className="input" aria-label={t("goals.period")} data-testid={`goal-period-${g.id}`} value={g.period} onChange={(e) => change(i, { period: e.target.value as Goal["period"] })}>
                    {PERIODS.map((p) => (
                      <option key={p} value={p}>{t(`goals.period_${p}`)}</option>
                    ))}
                  </select>
                </td>
                <td className="px-2 text-end">
                  <input type="number" min={1} max={100000} className="input w-24" aria-label={t("goals.target")} data-testid={`goal-target-${g.id}`} value={Number.isFinite(g.target) ? g.target : ""} onChange={(e) => change(i, { target: e.target.value === "" ? NaN : Number(e.target.value) })} />
                </td>
                <td className="px-2 text-center">
                  <input type="checkbox" aria-label={t("goals.active")} data-testid={`goal-active-${g.id}`} checked={g.active ?? true} onChange={(e) => change(i, { active: e.target.checked })} />
                </td>
                <td className="px-2 text-end">
                  <button className="btn" aria-label={t("goals.remove")} data-testid={`goal-remove-${g.id}`} onClick={() => setDraft(rows.filter((_, j) => j !== i))}>
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={8} className="py-3 text-mute" data-testid="goals-empty">{t("goals.none")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn" data-testid="goal-add" disabled={rows.length >= 50} onClick={add}>
          <Plus size={16} aria-hidden="true" /> {t("goals.add")}
        </button>
        <button className="btn btn-accent" data-testid="goals-save" disabled={!draft || invalid} onClick={() => setOpen(true)}>
          {t("common.save")}
        </button>
        {draft && (
          <button className="btn" data-testid="goals-discard" onClick={() => setDraft(null)}>
            {t("common.cancel")}
          </button>
        )}
      </div>
      <FormDialog
        inline
        open={open}
        onClose={() => setOpen(false)}
        title={t("goals.save_title")}
        testid="goals-save-dialog"
        busy={set.isPending}
        error={set.isError ? errText(set.error, t) : null}
        onSubmit={(reason) =>
          set.mutate(
            { version: s.version, body: { goals: rows.map((g) => ({ ...g, name_en: g.name_en.trim(), name_ar: g.name_ar?.trim() || null })), reason } },
            {
              onSuccess: () => {
                setDraft(null);
                setOpen(false);
                toast(t("settings.audited"));
              },
            },
          )
        }
      />
    </section>
  );
}
