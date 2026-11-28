import type { Palette } from "@/components/EChart";

/** The cumulative share at which the Pareto marker is drawn (the 80/20 rule). */
export const PARETO_MARKER = 80;

export interface ParetoInput {
  label_en?: string | null;
  label_ar?: string | null;
  count: number;
  sites: number;
}
export interface ParetoRow<T extends ParetoInput> {
  row: T;
  /** Cumulative share of all rows up to and including this one, 0 to 100, one decimal. */
  cum: number;
}
export interface Pareto<T extends ParetoInput> {
  /** The first `limit` rows, biggest first, each with the cumulative share over ALL rows (not only the shown ones). */
  rows: ParetoRow<T>[];
  total: number;
  /** How many of the biggest rows it takes to reach the marker: the "vital few". 0 when there is nothing. */
  vital: number;
}

/** Sorts biggest first (ties keep their order), and adds the running share of the whole list. */
export function pareto<T extends ParetoInput>(rows: T[], limit = 8): Pareto<T> {
  const sorted = rows.map((row, i) => ({ row, i })).sort((a, b) => b.row.count - a.row.count || a.i - b.i).map((x) => x.row);
  const total = sorted.reduce((n, r) => n + r.count, 0);
  let run = 0;
  let vital = 0;
  const all = sorted.map((row, i) => {
    run += row.count;
    const cum = total > 0 ? Math.round((1000 * run) / total) / 10 : 0;
    if (vital === 0 && total > 0 && cum >= PARETO_MARKER) vital = i + 1;
    return { row, cum };
  });
  return { rows: all.slice(0, limit), total, vital };
}

type Labeller<T> = (r: T) => string;

/**
 * Horizontal Pareto: the bars are the counts (and the sites, as before), the line is the cumulative share on a second 0 to 100 axis along the top,
 * with a dashed marker at 80 %. The chart reads rows in the same order as the legend text, biggest first.
 */
export function paretoOption<T extends ParetoInput>(p: Palette, rtl: boolean, font: string, data: Pareto<T>, label: Labeller<T>, texts: { cum: string; count: string; marker: string }, ar: boolean) {
  const rows = data.rows;
  return {
    textStyle: { fontFamily: font },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: { show: false },
    grid: { left: 16, right: 40, top: 28, bottom: 8, containLabel: true },
    xAxis: [
      { type: "value", inverse: rtl, minInterval: 1, axisLabel: { color: p.mute }, splitLine: { lineStyle: { color: p.line } } },
      { type: "value", inverse: rtl, position: "top", min: 0, max: 100, axisLabel: { color: p.mute, formatter: "{value}%" }, splitLine: { show: false } },
    ],
    yAxis: {
      type: "category",
      inverse: true,
      position: rtl ? "right" : "left",
      data: rows.map((r) => label(r.row)),
      axisLabel: { color: p.ink, width: ar ? 160 : 100, overflow: "truncate", ellipsis: "…", align: rtl ? "left" : "right", margin: 10 },
    },
    series: [
      {
        name: texts.count,
        type: "bar",
        xAxisIndex: 0,
        itemStyle: { color: p.open },
        data: rows.map((r) => r.row.count),
        label: {
          show: true,
          position: rtl ? "left" : "right",
          color: p.ink,
          formatter: (pt: { dataIndex: number }) => `${rows[pt.dataIndex]?.row.count ?? 0} · ${rows[pt.dataIndex]?.row.sites ?? 0}`,
        },
      },
      {
        name: texts.cum,
        type: "line",
        xAxisIndex: 1,
        yAxisIndex: 0,
        symbol: "circle",
        symbolSize: 6,
        lineStyle: { color: p.wait, width: 2 },
        itemStyle: { color: p.wait },
        data: rows.map((r) => r.cum),
        tooltip: { valueFormatter: (v: number) => `${v}%` },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: p.late, type: "dashed" },
          label: { formatter: texts.marker, color: p.late },
          data: [{ xAxis: PARETO_MARKER }],
        },
      },
    ],
  };
}

export interface TrendWeek {
  week_start: string;
  opened: number;
  closed: number;
  open_end: number;
}

/** Opened against closed per week as paired columns, with the open-at-week-end count as a line. */
export function trendOption(p: Palette, rtl: boolean, font: string, weeks: TrendWeek[], names: { opened: string; closed: string; open: string }) {
  return {
    textStyle: { fontFamily: font },
    tooltip: { trigger: "axis" },
    legend: { top: 0, textStyle: { color: p.ink } },
    grid: { left: 16, right: 16, top: 32, bottom: 8, containLabel: true },
    xAxis: { type: "category", inverse: rtl, data: weeks.map((w) => w.week_start.slice(5)), axisLabel: { color: p.mute } },
    yAxis: { type: "value", minInterval: 1, position: rtl ? "right" : "left", axisLabel: { color: p.mute }, splitLine: { lineStyle: { color: p.line } } },
    series: [
      { name: names.opened, type: "bar", itemStyle: { color: p.late }, data: weeks.map((w) => w.opened) },
      { name: names.closed, type: "bar", itemStyle: { color: p.done }, data: weeks.map((w) => w.closed) },
      { name: names.open, type: "line", symbol: "circle", lineStyle: { color: p.open, width: 2 }, itemStyle: { color: p.open }, data: weeks.map((w) => w.open_end) },
    ],
  };
}
