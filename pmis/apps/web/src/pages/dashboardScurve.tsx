import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { ProjectStatusSnapshot } from "@/api/dashboard";
import { EChart, type Palette } from "@/components/EChart";
import { useForecastWindow } from "@/api/dashboardSettings";
import { forecastFull, scurveSeries, VELOCITY_WINDOW, weeklyVelocity } from "@/lib/scurve";
import { Card, pct, signed } from "./dashboardBits";

const FONT = "Cairo, system-ui, sans-serif";

/**
 * The progress curve card (owner approval 2026-11-26, dashboard proposals item 2): planned against actual of the
 * saved weekly Project Status snapshots (their frozen values, `GET /project-status/snapshots`, contract 0.7.2), the
 * weekly velocity of the last real gaps and the date the actual curve reaches 100 % at that velocity. Read only; the
 * card uses the dormant snapshots endpoint, so nothing new is read and no figure is recomputed. Card primitives come
 * from dashboardBits (the same design system as the existing cards). Ordered and hidden per tab from Settings >
 * Dashboard, like every other card.
 */
export function OpsScurveCard({ snaps }: { snaps: { items?: ProjectStatusSnapshot[] } | undefined }) {
  const { t, i18n } = useTranslation();
  const points = useMemo(
    () =>
      (snaps?.items ?? [])
        .filter((s) => s.scope !== "region")
        .map((s) => ({ date: s.taken_on, actual: s.progress_pct ?? null, planned: s.planned_pct ?? null })),
    [snaps],
  );
  const series = useMemo(() => scurveSeries(points), [points]);
  // contract 0.15.431: the number of weeks is the setting dashboard.forecast_window_weeks (default 4); until it is read the old fixed value is used
  const windowWeeks = useForecastWindow().data?.weeks ?? VELOCITY_WINDOW;
  const velocity = useMemo(() => weeklyVelocity(points, windowWeeks), [points, windowWeeks]);
  const forecast = useMemo(() => forecastFull(points, velocity), [points, velocity]);
  const last = series[series.length - 1];
  const lastSnap = (snaps?.items ?? []).filter((s) => s.scope !== "region").sort((a, b) => (a.taken_on < b.taken_on ? 1 : -1))[0];
  const fmtDate = (iso: string | null) =>
    iso === null ? "–" : new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(new Date(`${iso}T00:00:00Z`));

  const build = useMemo(
    () => (p: Palette, rtl: boolean) => ({
      textStyle: { fontFamily: FONT },
      aria: { enabled: true },
      tooltip: { trigger: "axis", valueFormatter: (v: unknown) => (typeof v === "number" ? pct(v) : "–") },
      legend: { top: 0, textStyle: { color: p.mute } },
      grid: { left: 16, right: 16, top: 32, bottom: 8, containLabel: true },
      xAxis: {
        type: "category",
        data: series.map((s) => s.date),
        axisLabel: { color: p.mute, hideOverlap: true },
        axisLine: { lineStyle: { color: p.line } },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: 100,
        position: rtl ? "right" : "left",
        axisLabel: { color: p.mute, formatter: "{value}%" },
        splitLine: { lineStyle: { color: p.line } },
      },
      series: [
        {
          name: t("dash.scurve.planned"),
          type: "line",
          smooth: true,
          symbol: "none",
          lineStyle: { type: "dashed", color: p.mute, width: 2 },
          itemStyle: { color: p.mute },
          data: series.map((s) => s.planned),
          connectNulls: true,
        },
        {
          name: t("dash.scurve.actual"),
          type: "line",
          smooth: true,
          symbol: "circle",
          symbolSize: 5,
          lineStyle: { color: p.accent, width: 3 },
          itemStyle: { color: p.accent },
          areaStyle: { color: p.accent, opacity: 0.08 },
          data: series.map((s) => s.actual),
        },
      ],
    }),
    [series, t],
  );

  return (
    <Card
      title={t("dash.scurve.title")}
      testid="dash-scurve"
      aside={
        <Link to="/settings/weight-sets" className="text-sm text-accent hover:underline">
          {t("dash.scurve.open_project_status")}
        </Link>
      }
      className="print:break-inside-avoid"
    >
      <p className="mb-3 text-sm text-mute">{t("dash.scurve.hint")}</p>
      {series.length === 0 ? (
        <p className="py-6 text-center text-sm text-mute" data-testid="dash-scurve-empty">
          {t("dash.scurve.empty")}
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <span className="card px-3 py-1.5 text-sm" data-testid="dash-scurve-actual">
              {t("dash.scurve.actual")} <b className="tnum">{pct(last?.actual ?? null)}</b>
            </span>
            <span className="card px-3 py-1.5 text-sm" data-testid="dash-scurve-planned">
              {t("dash.scurve.planned")} <b className="tnum">{pct(last?.planned ?? null)}</b>
            </span>
            <span className="card px-3 py-1.5 text-sm" data-testid="dash-scurve-spi">
              {t("dash.scurve.spi")} <b className="tnum">{lastSnap?.spi === null || lastSnap?.spi === undefined ? "–" : lastSnap.spi.toFixed(3)}</b>
            </span>
            <span className="card px-3 py-1.5 text-sm" data-testid="dash-scurve-velocity">
              {t("dash.scurve.velocity")}{" "}
              <b className="tnum">
                {velocity === null ? "–" : `${signed(Number(velocity.toFixed(1)))}${t("dash.scurve.per_week")}`}
              </b>
            </span>
            <span className="card px-3 py-1.5 text-sm" data-testid="dash-scurve-forecast">
              {t("dash.scurve.forecast")} <b className="tnum">{fmtDate(forecast)}</b>
            </span>
          </div>
          <EChart
            build={build}
            height={260}
            label={t("dash.scurve.chart_label", {
              list: series.map((s) => `${s.date}: ${pct(s.actual)}`).join(", "),
            })}
            testid="dash-scurve-chart"
          />
          <p className="mt-2 text-xs text-mute" data-testid="dash-scurve-basis">
            {t("dash.scurve.basis", { n: series.length })}
          </p>
        </>
      )}
    </Card>
  );
}
