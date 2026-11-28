import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAgileTrend } from "@/api/dashboard";
import { EChart, type Palette } from "@/components/EChart";
import { agileRows, burnupSeries, coneForecast, finishDate, flowSeries, meanDone, weeklyDone } from "@/lib/agile";
import { Pill } from "./dashboardAgilePill";

const FONT = "Cairo, system-ui, sans-serif";
export type AgileMode = "burnup" | "cfd" | "velocity" | "cone";
export const AGILE_MODES: AgileMode[] = ["burnup", "cfd", "velocity", "cone"];

/**
 * The agile views of the progress card: burn-up, cumulative flow, velocity and the cone of uncertainty. They read the
 * same frozen weekly per-site snapshots as the progress curve (`GET /project-status/agile-trend`), in Project Status
 * items and sites; the weighted completion percentage stays in the progress views. Read only, no figure is recomputed.
 */
export function AgileView({ mode, windowWeeks }: { mode: AgileMode; windowWeeks: number }) {
  const { t, i18n } = useTranslation();
  const q = useAgileTrend(true);
  const rows = useMemo(() => agileRows(q.data?.items ?? []), [q.data]);
  const last = rows[rows.length - 1];
  const weeks = useMemo(() => weeklyDone(rows), [rows]);
  const pace = useMemo(() => meanDone(weeks, windowWeeks), [weeks, windowWeeks]);
  const burn = useMemo(() => burnupSeries(rows), [rows]);
  const flow = useMemo(() => flowSeries(rows), [rows]);
  const cone = useMemo(() => coneForecast(rows, windowWeeks), [rows, windowWeeks]);
  const fmtDate = (d: string | null) => (d === null ? "–" : new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(new Date(`${d}T00:00:00Z`)));
  const num = (v: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(v);
  const status = (c: string) => t(`dash.agile.status_${c}`, { defaultValue: c });
  const scopeMarks = burn.filter((r) => r.scopeChange !== 0);

  const build = useMemo(
    () => (p: Palette, rtl: boolean) => {
      const common = {
        textStyle: { fontFamily: FONT },
        aria: { enabled: true },
        tooltip: { trigger: "axis" },
        legend: { top: 0, textStyle: { color: p.mute } },
        grid: { left: 16, right: 16, top: 32, bottom: 8, containLabel: true },
      };
      const x = (data: string[]) => ({ type: "category", data, axisLabel: { color: p.mute, hideOverlap: true }, axisLine: { lineStyle: { color: p.line } } });
      const y = { type: "value", min: 0, position: rtl ? "right" : "left", axisLabel: { color: p.mute }, splitLine: { lineStyle: { color: p.line } } };
      if (mode === "burnup") {
        return {
          ...common, xAxis: x(burn.map((r) => r.date)), yAxis: y,
          series: [
            { name: t("dash.agile.scope"), type: "line", step: "end", symbol: "none", lineStyle: { color: p.mute, width: 2 }, itemStyle: { color: p.mute }, data: burn.map((r) => r.scope),
              markPoint: { symbolSize: 36, data: scopeMarks.map((r) => ({ name: r.date, coord: [r.date, r.scope], value: (r.scopeChange > 0 ? "+" : "") + r.scopeChange })) } },
            { name: t("dash.agile.planned_items"), type: "line", symbol: "none", lineStyle: { type: "dashed", color: p.mute, width: 2 }, itemStyle: { color: p.mute }, data: burn.map((r) => r.planned) },
            { name: t("dash.agile.done"), type: "line", symbol: "circle", symbolSize: 5, lineStyle: { color: p.accent, width: 3 }, itemStyle: { color: p.accent }, areaStyle: { color: p.accent, opacity: 0.08 }, data: burn.map((r) => r.done) },
          ],
        };
      }
      if (mode === "cfd") {
        return {
          ...common, tooltip: { trigger: "axis" }, xAxis: x(flow.dates), yAxis: y,
          series: flow.statuses.map((c) => ({ name: status(c), type: "line", stack: "sites", symbol: "none", areaStyle: { opacity: 0.55 }, lineStyle: { width: 1 }, data: flow.counts[c] })),
        };
      }
      if (mode === "velocity") {
        return {
          ...common, xAxis: x(weeks.map((w) => w.date)), yAxis: y,
          series: [
            { name: t("dash.agile.done_per_week"), type: "bar", itemStyle: { color: p.accent }, data: weeks.map((w) => Number(w.done.toFixed(1))) },
            ...(pace === null ? [] : [{ name: t("dash.agile.average"), type: "line", symbol: "none", lineStyle: { type: "dashed", color: p.mute, width: 2 }, itemStyle: { color: p.mute }, data: weeks.map(() => Number(pace.toFixed(1))) }]),
          ],
        };
      }
      const dates = [...burn.map((r) => r.date), ...(cone?.dates.slice(1) ?? [])];
      const pad = (v: (number | null)[]) => [...burn.slice(0, -1).map(() => null), ...v];
      return {
        ...common, xAxis: x(dates), yAxis: y,
        series: [
          { name: t("dash.agile.scope"), type: "line", symbol: "none", lineStyle: { color: p.mute, width: 2 }, itemStyle: { color: p.mute }, data: dates.map(() => cone?.scope ?? null) },
          { name: t("dash.agile.done"), type: "line", symbol: "circle", symbolSize: 5, lineStyle: { color: p.accent, width: 3 }, itemStyle: { color: p.accent }, data: burn.map((r) => r.done) },
          { name: t("dash.agile.fast"), type: "line", symbol: "none", lineStyle: { type: "dotted", color: p.accent, width: 2 }, itemStyle: { color: p.accent }, data: pad(cone?.fast ?? []) },
          { name: t("dash.agile.mean"), type: "line", symbol: "none", lineStyle: { type: "dashed", color: p.accent, width: 2 }, itemStyle: { color: p.accent }, data: pad(cone?.mean ?? []) },
          { name: t("dash.agile.slow"), type: "line", symbol: "none", lineStyle: { type: "dotted", color: p.mute, width: 2 }, itemStyle: { color: p.mute }, data: pad(cone?.slow ?? []) },
        ],
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, burn, flow, weeks, pace, cone, t],
  );

  if (q.isLoading) return <p className="py-6 text-center text-sm text-mute">{t("common.loading")}</p>;
  if (!last || rows.length < 2) return <p className="py-6 text-center text-sm text-mute" data-testid="dash-agile-empty">{t("dash.agile.empty")}</p>;
  const label = rows.map((r) => `${r.taken_on}: ${num(r.items_done)}/${num(r.items_applicable)}`).join(", ");
  return (
    <div data-testid={`dash-agile-${mode}`}>
      <div className="mb-3 flex flex-wrap gap-2">
        <Pill testid="dash-agile-done" label={t("dash.agile.done")} value={`${num(last.items_done)} / ${num(last.items_applicable)}`} hint={t("dash.agile.done_hint")} />
        <Pill testid="dash-agile-pace" label={t("dash.agile.pace")} value={pace === null ? "–" : `${num(pace)} ${t("dash.agile.per_week")}`} hint={t("dash.agile.pace_hint", { n: windowWeeks })} />
        {mode === "burnup" && (
          <Pill testid="dash-agile-scope-change" label={t("dash.agile.scope_change")} value={scopeMarks.length ? scopeMarks.map((r) => `${r.date}: ${r.scopeChange > 0 ? "+" : ""}${num(r.scopeChange)}`).join(" · ") : t("dash.agile.none")} hint={t("dash.agile.scope_change_hint")} />
        )}
        {(mode === "burnup" || mode === "cone") && <Pill testid="dash-agile-finish" label={t("dash.agile.finish")} value={fmtDate(finishDate(last, pace))} hint={t("dash.agile.finish_hint")} />}
        {mode === "cone" && cone && (
          <Pill testid="dash-agile-range" label={t("dash.agile.range")} value={`${fmtDate(cone.finish.fast)} – ${fmtDate(cone.finish.slow)}`} hint={t("dash.agile.range_hint")} />
        )}
        {mode === "cfd" && <Pill testid="dash-agile-sites" label={t("dash.agile.sites")} value={num(last.sites)} hint={t("dash.agile.sites_hint")} />}
      </div>
      <EChart build={build} height={260} label={t(`dash.agile.chart_${mode}`, { list: label })} testid={`dash-agile-chart-${mode}`} />
      <p className="mt-2 text-xs text-mute" data-testid="dash-agile-basis">{t("dash.agile.basis", { n: rows.length })}</p>
    </div>
  );
}
