import { Check, ChevronDown, Download, Link2, MonitorPlay, PencilLine, Printer, RotateCcw, Share2 } from "lucide-react";
import { loadPref, savePref } from "@/lib/localPref";
import { useDownloadGate } from '@/lib/downloadGate';
import { useEffect, useMemo, useState, type ReactNode, Fragment } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { fmtDate } from "@/lib/time";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMe } from "@/api/hooks";
import {
  downloadDashboard,
  useDashboard,
  useDashboardExtras,
  useDashboardOps,
  useProjectStatusSnapshots,
  type Dashboard as Dash,
  type DashboardExtras,
  type DashboardQuery,
  type ExportFormat,
} from "@/api/dashboard";
import type { PipelineNode } from "@/api/types";
import { useRegions } from "@/api/sites";
import { useRegionHealth } from "@/api/x";
import { EChart, type Palette } from "@/components/EChart";
import { errText } from "@/components/FormDialog";
import { Pipeline } from "@/components/Pipeline";
import { SiteMap } from "@/components/SiteMap";
import { ScreenSettingsLink } from "@/components/ScreenSettingsLink";
import { EmptyState } from "@/components/States";
import { useToast } from "@/components/Toast";
import { streamName } from "@/lib/streams";
import { tripoliToday } from "@/lib/today";
import { effectiveLayout, orderedVisible, type TabLayout } from "./dashboardLayout";
import { DashboardWidgets } from "./dashboardWidgets";
import { useMyDashboardLayouts } from "@/api/dashboardWidgets";
import {
  Bar,
  Card,
  Kpi,
  MiniShare,
  MoreLine,
  num,
  pct,
  signed,
} from "./dashboardBits";
import { OpsProcurementCard } from "./dashboardOps";
import { OpsPhaseCard } from "./dashboardPhase";
import { PinnedViewsCard } from "./dashboardPins";
import { OpsScurveCard } from "./dashboardScurve";
import { OpsPermitsCard } from "./dashboardPermits";
import { OpsReadinessCard } from "./dashboardReadiness";
import { OpsScorecardCard } from "./dashboardScorecard";
import { OpsQualityCard } from "./dashboardQuality";
import { OpsApprovalsCard } from "./dashboardApprovals";
import { OpsChangesCard } from "./dashboardChanges";
import { OpsFinanceCard } from "./dashboardFinance";
import { useDashboardSettings, useProgressRag } from "@/api/dashboardSettings";
import { RAG_CLASS, ragTone } from "@/lib/progressRag";
import { GoalsPanel } from "@/components/GoalsPanel";
import { SavedViews } from "@/components/SavedViews";
import { UnifiedFilter } from "@/components/UnifiedFilter";
import { decodeFilter, encodeFilter, type FilterTree } from "@/api/views";
import {
  DASH_TABS,
  readRemembered,
  resolveTab,
  allowedTabs,
  clampTab,
  tabView,
  teamTabs,
  writeRemembered,
  type DashTab,
} from "./dashboardTabs";
import { DateInput } from '@/components/DateInput';

type DashMilestone = Dash["pipeline"]["nodes"][number];
const STATUSES = [
  "not_started",
  "in_progress",
  "on_hold",
  "completed",
  "cancelled",
] as const;
const STATUS_TONE: Record<string, string> = {
  completed: "bg-doneBg text-doneInk",
  in_progress: "bg-openBg text-openInk",
  on_hold: "bg-waitBg text-waitInk",
  not_started: "bg-lockBg text-lockInk",
  cancelled: "bg-lateBg text-lateInk",
};
const BAND_TONE: Record<string, string> = {
  green: "bg-doneBg text-doneInk",
  amber: "bg-waitBg text-waitInk",
  red: "bg-lateBg text-lateInk",
};
const FONT = "Cairo, system-ui, sans-serif";


const BAND_CELL: Record<string, string> = {
  low: "bg-doneBg text-doneInk",
  medium: "bg-waitBg text-waitInk",
  high: "bg-lateBg text-lateInk",
  critical: "bg-lateBg text-lateInk font-bold",
};

/** F13 (owner decisions 2026-11-15): the sections added to the dashboard. Read only; each figure links to the grid it counts. */
/** F20 (contract 0.15.24): the counters, coloured by the saved KPI thresholds (dashboard settings). */
const COUNTER_TONE: Record<string, string> = {
  green: "bg-doneBg text-doneInk",
  amber: "bg-waitBg text-waitInk",
  red: "bg-lateBg text-lateInk",
  none: "text-mute",
};

function CountersPanel({ ex }: { ex: DashboardExtras | undefined }) {
  const { t, i18n } = useTranslation();
  if (!ex)
    return (
      <p
        className="text-mute"
        role="status"
        data-testid="dash-counters-loading"
      >
        {t("common.loading")}
      </p>
    );
  const c = ex.counters;
  if (!c.available) {
    return (
      <Card
        title={t("dash.counters.title")}
        testid="dash-counters"
        className="print:break-inside-avoid"
      >
        <p className="text-mute">{t("dash.counters.unavailable")}</p>
      </Card>
    );
  }
  const kpis = c.kpis ?? [];
  const stages = c.sla_by_stage ?? [];
  const totals = c.sla_totals;
  const stageName = (s: { stage_name: string; stage_name_ar: string }) =>
    i18n.language.startsWith("ar") ? s.stage_name_ar : s.stage_name;
  const unitText = (k: { unit: string; value: number | null }) =>
    k.value === null
      ? t("dash.counters.pending")
      : k.unit === "pct"
        ? `${k.value}%`
        : k.unit === "days"
          ? `${k.value} ${t("dash.counters.days")}`
          : `${k.value}`;
  return (
    <Card
      title={t("dash.counters.title")}
      testid="dash-counters"
      className="xl:col-span-2 print:break-inside-avoid"
    >
      <p className="mb-3 text-sm text-mute">{t("dash.counters.hint")}</p>
      <ul className="grid gap-2 md:grid-cols-3" data-testid="dash-counter-kpis">
        {kpis.map((k) => (
          <li
            key={k.code}
            className={`rounded p-2 ${COUNTER_TONE[k.colour] ?? COUNTER_TONE.none}`}
            data-testid={`dash-counter-${k.code}`}
            data-colour={k.colour}
          >
            <div className="text-xs">{t(`dash.counters.kpi.${k.code}`)}</div>
            <div className="text-xl font-bold">{unitText(k)}</div>
            <div className="text-xs">
              {t("dash.counters.thresholds", {
                green: k.green,
                amber: k.amber,
                colour: t(`dash.counters.colour.${k.colour}`),
              })}
            </div>
          </li>
        ))}
      </ul>
      {totals && (
        <p className="mt-3 text-sm" data-testid="dash-counters-totals">
          {t("dash.counters.totals", {
            open: totals.open_tasks,
            breach: totals.breach,
            at_risk: totals.at_risk,
          })}
        </p>
      )}
      {stages.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm" data-testid="dash-counters-stages">
            <caption className="sr-only">
              {t("dash.counters.stage_caption")}
            </caption>
            <thead>
              <tr className="text-mute">
                <th scope="col" className="text-start font-normal">
                  {t("dash.counters.stage")}
                </th>
                <th scope="col" className="font-normal">
                  {t("dash.counters.open")}
                </th>
                <th scope="col" className="font-normal">
                  {t("dash.counters.breach")}
                </th>
                <th scope="col" className="font-normal">
                  {t("dash.counters.at_risk")}
                </th>
              </tr>
            </thead>
            <tbody>
              {stages.map((s) => (
                <tr
                  key={s.stage_code}
                  data-testid={`dash-counter-stage-${s.stage_code}`}
                >
                  <th scope="row" className="text-start font-normal">
                    {stageName(s)}
                  </th>
                  <td className="text-center">{s.open_tasks}</td>
                  <td
                    className={`text-center ${s.breach > 0 ? COUNTER_TONE.red : ""}`}
                  >
                    {s.breach}
                  </td>
                  <td className="text-center">{s.at_risk}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {c.pending_kpis && c.pending_kpis.length > 0 && (
        <p
          className="mt-3 text-xs text-mute"
          data-testid="dash-counters-pending"
        >
          {t("dash.counters.pending_note", { n: c.pending_kpis.length })}
        </p>
      )}
    </Card>
  );
}

function F13Panel({
  ex,
  sitesLink,
}: {
  ex: DashboardExtras | undefined;
  sitesLink: (extra?: Record<string, string>) => string;
}) {
  const { t } = useTranslation();
  if (!ex)
    return (
      <p className="text-mute" role="status" data-testid="dash-f13-loading">
        {t("common.loading")}
      </p>
    );
  const rm = ex.risk_matrix;
  const dq = ex.data_quality;
  const sw = ex.swap_relocation;
  const dec = ex.decisions;
  return (
    <div
      className="grid gap-3 print:gap-2 md:grid-cols-2 xl:grid-cols-4"
      data-testid="dash-f13"
    >
      <Card
        title={t("dash.f13.risk_title")}
        testid="dash-risk-matrix"
        className="xl:col-span-2 print:break-inside-avoid"
        aside={
          rm.available && (
            <Link
              to="/registers/risks"
              className="text-sm text-accent underline"
            >
              {t("dash.f13.open_risks_link")}
            </Link>
          )
        }
      >
        {!rm.available ? (
          <p className="text-mute">{t("dash.f13.risk_unavailable")}</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-mute">{t("dash.f13.risk_hint")}</p>
            <table
              className="w-full table-fixed text-center text-sm"
              data-testid="dash-risk-grid"
            >
              <thead>
                <tr>
                  <th className="p-1 text-start text-xs text-mute">
                    {t("dash.f13.probability")} / {t("dash.f13.impact")}
                  </th>
                  {[1, 2, 3, 4, 5].map((i) => (
                    <th key={i} className="p-1 text-xs text-mute">
                      {i}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[5, 4, 3, 2, 1].map((p) => (
                  <tr key={p}>
                    <th className="p-1 text-start text-xs text-mute">{p}</th>
                    {[1, 2, 3, 4, 5].map((i) => {
                      const c = (rm.cells ?? []).find(
                        (x) => x.probability === p && x.impact === i,
                      );
                      return (
                        <td
                          key={i}
                          className={`h-9 rounded-sm tnum ${BAND_CELL[c?.band ?? "low"]}`}
                          data-testid={`dash-risk-cell-${p}-${i}`}
                          data-band={c?.band}
                          title={`${p} x ${i} = ${p * i}`}
                        >
                          {c?.count ?? 0}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {(rm.bands ?? []).map((b) => (
                <span key={b.band} className={`chip ${BAND_CELL[b.band]}`}>
                  {t(`dash.f13.band.${b.band}`)}: {b.count}
                </span>
              ))}
            </div>
            <p className="mt-2 text-sm" data-testid="dash-risk-open">
              {t("dash.f13.open_total", { n: rm.open_total ?? 0 })}
              {(rm.invalid_total ?? 0) > 0 && (
                <> · {t("dash.f13.invalid", { n: rm.invalid_total })}</>
              )}
            </p>
            <h3 className="mt-3 mb-1 text-sm font-semibold">
              {t("dash.f13.top_risks")}
            </h3>
            {(rm.top_open_risks ?? []).length === 0 ? (
              <p className="text-sm text-mute">{t("dash.f13.no_risks")}</p>
            ) : (
              <ol className="space-y-1 text-sm" data-testid="dash-risk-top">
                {(rm.top_open_risks ?? []).map((r) => (
                  <li
                    key={r.risk_code}
                    className="flex flex-wrap items-center gap-2"
                    data-testid="dash-risk-item"
                  >
                    <span className="font-mono text-xs">{r.risk_code}</span>
                    <span className="flex-1">{r.statement}</span>
                    <span className={`chip ${BAND_CELL[r.band]}`}>
                      {t(`dash.f13.band.${r.band}`)} {r.score}
                    </span>
                    {r.risk_owner && (
                      <span className="text-xs text-mute">
                        {t("dash.f13.owner", { owner: r.risk_owner })}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </Card>

      <Card
        title={t("dash.f13.dq_title")}
        testid="dash-data-quality"
        className="print:break-inside-avoid"
      >
        {!dq.available ? (
          <p className="text-mute">{t("dash.f13.dq_unavailable")}</p>
        ) : (
          <>
            <dl className="grid grid-cols-3 gap-2 text-center">
              <div>
                <dt className="text-xs text-mute">
                  {t("dash.f13.dq_checked")}
                </dt>
                <dd className="text-2xl font-bold tnum">
                  <Link to={sitesLink()}>{dq.sites_checked}</Link>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-mute">
                  {t("dash.f13.dq_with_gaps")}
                </dt>
                <dd
                  className="text-2xl font-bold tnum"
                  data-testid="dash-dq-with-gaps"
                >
                  {dq.sites_with_gaps}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-mute">{t("dash.f13.dq_gaps")}</dt>
                <dd
                  className="text-2xl font-bold tnum"
                  data-testid="dash-dq-gaps"
                >
                  {dq.gaps_total}
                </dd>
              </div>
            </dl>
            {(dq.by_kind ?? []).length === 0 ? (
              <p className="mt-2 text-sm text-mute">{t("dash.f13.dq_none")}</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {(dq.by_kind ?? []).map((k) => (
                  <li
                    key={`${k.kind}|${k.field ?? ""}`}
                    className="flex justify-between gap-2"
                  >
                    <span>
                      {k.kind === "missing_field"
                        ? t("dash.f13.dq_missing_field", {
                            field: k.field ?? "",
                          })
                        : t("dash.f13.dq_missing_date")}
                    </span>
                    <b className="tnum">{k.count}</b>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      <Card
        title={t("dash.f13.decisions_title")}
        testid="dash-decisions"
        className="print:break-inside-avoid"
      >
        {!dec.available ? (
          <p className="text-mute">{t("dash.f13.decisions_unavailable")}</p>
        ) : (
          <>
            {(dec.items ?? []).length === 0 ? (
              <p className="text-sm text-mute">{t("dash.f13.no_decisions")}</p>
            ) : (
              <ul
                className="space-y-2 text-sm"
                data-testid="dash-decision-list"
              >
                {(dec.items ?? []).map((d) => (
                  <li
                    key={d.risk_code}
                    className="flex flex-wrap items-start gap-2"
                    data-testid="dash-decision-item"
                    data-tag={d.tag}
                  >
                    <span
                      className={`chip ${d.tag === "act_now" ? "bg-lateBg text-lateInk" : "bg-waitBg text-waitInk"}`}
                    >
                      {t(`dash.f13.${d.tag}`)}
                    </span>
                    <span className="flex-1">{d.statement}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-mute">
              {t("dash.f13.decisions_note")}
            </p>
          </>
        )}
      </Card>

      <Card
        title={t("dash.f13.sw_title")}
        testid="dash-swap"
        className="xl:col-span-2 print:break-inside-avoid"
      >
        {!sw.available ? (
          <p className="text-mute">{t("dash.f13.sw_unavailable")}</p>
        ) : (
          <>
            <table className="w-full text-sm" data-testid="dash-swap-table">
              <thead>
                <tr className="text-start text-mute">
                  <th className="text-start">{t("dash.f13.sw_scenario")}</th>
                  <th className="text-end">{t("dash.f13.sw_total")}</th>
                  <th className="text-end">
                    {t("dash.f13.overall.in_progress")}
                  </th>
                  <th className="text-end">
                    {t("dash.f13.overall.completed")}
                  </th>
                  <th className="text-end">{t("dash.f13.overall.on_hold")}</th>
                  <th className="text-end">
                    {t("dash.f13.overall.cancelled")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {(sw.rows ?? []).map((r) => (
                  <tr
                    key={r.scenario}
                    className="border-t border-line"
                    data-testid="dash-swap-row"
                    data-scenario={r.scenario}
                  >
                    <td>{t(`dash.f13.scen.${r.scenario}`)}</td>
                    <td className="text-end tnum">
                      <Link
                        to={sitesLink({ scenario: r.scenario })}
                        className="underline"
                      >
                        {r.sites_total}
                      </Link>
                    </td>
                    <td className="text-end tnum">
                      {r.by_overall_status.in_progress}
                    </td>
                    <td className="text-end tnum">
                      {r.by_overall_status.completed}
                    </td>
                    <td className="text-end tnum">
                      {r.by_overall_status.on_hold}
                    </td>
                    <td className="text-end tnum">
                      {r.by_overall_status.cancelled}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(sw.unscenarioed ?? 0) > 0 && (
              <p className="mt-2 text-xs text-waitInk">
                {t("dash.f13.sw_unscenarioed", { n: sw.unscenarioed })}
              </p>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

/** What a saved view of the dashboard keeps (0.15.49): the quick parameters; the filter tree is the key `advanced`. */
const DASH_VIEW_EMPTY = { region_id: "", cluster_code: "", scenario: "", stream: "", view: "" };

export function Dashboard() {
  const gate = useDownloadGate();
  const { t, i18n } = useTranslation();
  const ar = i18n.language === "ar";
  const [issuesBy, setIssuesBy] = useState<"owner" | "category" | "reason">("owner");
  const toast = useToast();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const me = useMe(true);
  const today = tripoliToday();
  const userId = me.data?.user?.id;
  // F6: the tab (PMO, CW, TE) is the view filter; an explicit ?tab= wins, then the team, then the last tab used
  // 0163: the role limits the tabs (Settings > Roles); a tab outside them is not shown and cannot be reached by the URL either
  const tabsAllowed = allowedTabs(me.data?.effective.dashboard_tabs);
  const tab: DashTab = clampTab(
    resolveTab(
      sp.get("tab"),
      readRemembered(userId),
      teamTabs((me.data?.assignments ?? []).map((a) => a.team)),
    ),
    tabsAllowed,
  );
  const dashSettings = useDashboardSettings();
  const myLayouts = useMyDashboardLayouts();
  const rag = useProgressRag().data?.items;
  const q: DashboardQuery = {
    ref_date: sp.get("ref_date") ?? "",
    region_id: sp.get("region_id") ?? "",
    cluster_code: sp.get("cluster_code") ?? "",
    scenario: sp.get("scenario") ?? "",
    stream: sp.get("stream") ?? "",
    view: tab === "pmo" ? (sp.get("view") ?? "") : tabView(tab),
    // 0.15.45: the unified filter tree (screen `dashboard`) goes to every dashboard endpoint as `filter`
    filter: encodeFilter(decodeFilter(sp.get("adv"))),
  };
  const advTree = decodeFilter(sp.get("adv"));
  const refDate = q.ref_date || today;
  const dash = useDashboard(q);
  const d = dash.data;
  const extras = useDashboardExtras(q, !!d);
  const ops = useDashboardOps(q, !!d);
  const snaps = useProjectStatusSnapshots(!!d);
  const [exporting, setExporting] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [format, setFormat] = useState<ExportFormat>(() => (loadPref<string>("dash.exportFormat", "xlsx") === "csv" ? "csv" : "xlsx"));
  const [shareOpen, setShareOpen] = useState(false);
  // the Share / Export menu closes on Escape and on a click outside it
  useEffect(() => {
    if (!shareOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShareOpen(false); };
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement | null)?.closest?.('[data-testid="dash-share-wrap"]')) setShareOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [shareOpen]);
  // Q116: a local preview of the other pipeline style; the style in force is the setting (meta.pipeline_variant)
  const [preview, setPreview] = useState<"A" | "B" | null>(null);
  const canExport =
    !!me.data &&
    (!!me.data.is_system_admin ||
      me.data.effective.grants.some(
        (g) =>
          g.module_key === "dashboard" && (g.action as string) === "export",
      ));
  const setParam = (kv: Record<string, string>) =>
    setSp(
      (p) => {
        const n = new URLSearchParams(p);
        for (const [k, v] of Object.entries(kv)) {
          if (v) n.set(k, v);
          else n.delete(k);
        }
        return n;
      },
      { replace: true },
    );
  const selectTab = (next: DashTab) => {
    writeRemembered(userId, next);
    setParam({ tab: next });
  };
  const activeFilters =
    ["region_id", "cluster_code", "scenario", "stream", "view"].filter((k) =>
      sp.get(k),
    ).length + (q.ref_date ? 1 : 0) + (advTree ? 1 : 0);
  const name = (x: { name_en: string; name_ar?: string | null }) =>
    ar && x.name_ar ? x.name_ar : x.name_en;

  /** Link to the Site Register with the filters of this view and the given ones (the register reads region_id, cluster_code, scenario, overall_status, stage_code, bucket and stream). */
  const sites = (extra: Record<string, string> = {}): string => {
    const p = new URLSearchParams();
    for (const k of ["region_id", "cluster_code", "scenario", "stream", "view"] as const)
      if (q[k]) p.set(k, q[k] as string);
    // the dashboard tree is a sites tree: a card opens the Site Master with the same tree
    if (q.filter) p.set("adv", q.filter);
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    // 0.15.33 (audit E section 2): a card's own set (derived status, milestone reached) is counted as of the dashboard's reference date
    if ((extra.dashboard_status || extra.milestone_reached) && q.ref_date) p.set("ref_date", q.ref_date);
    const s = p.toString();
    return `/sites${s ? `?${s}` : ""}`;
  };

  const doExport = () => {
    setExporting(true);
    downloadDashboard(q, format)
      .then(
        () => toast(t("dash.export_done")),
        (e) => toast(errText(e, t), "err"),
      )
      .finally(() => setExporting(false));
  };

  // ---- charts (memoised on the data; EChart redraws on theme and direction changes)
  const statusRing = useMemo(
    () => (p: Palette) => ({
      textStyle: { fontFamily: FONT },
      tooltip: { trigger: "item" },
      series: [
        {
          type: "pie",
          radius: ["58%", "82%"],
          avoidLabelOverlap: true,
          label: { show: false },
          itemStyle: { borderColor: p.card, borderWidth: 2 },
          data: STATUSES.filter((s) => s !== "cancelled").map((s) => ({
            name: t(`status.${s}`),
            value: d?.headline.by_overall_status[s] ?? 0,
            itemStyle: {
              color: {
                completed: p.done,
                in_progress: p.open,
                on_hold: p.wait,
                not_started: p.lock,
              }[s],
            },
          })),
        },
      ],
    }),
    [d, t],
  );

  const streamBars = useMemo(
    () => (p: Palette, rtl: boolean) => {
      const items = d?.streams.items ?? [];
      const s = (key: string, color: string, f: (c: DashStream) => number) => ({
        name: t(`dash.streams.${key}`),
        type: "bar",
        stack: "n",
        itemStyle: { color },
        emphasis: { focus: "series" },
        data: items.map((x) => f(x.counts)),
      });
      return {
        textStyle: { fontFamily: FONT },
        aria: { enabled: true },
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
        legend: { top: 0, textStyle: { color: p.mute } },
        grid: { left: 16, right: 16, top: 32, bottom: 8, containLabel: true },
        xAxis: {
          type: "value",
          inverse: rtl,
          axisLabel: { color: p.mute },
          splitLine: { lineStyle: { color: p.line } },
        },
        yAxis: {
          type: "category",
          inverse: true,
          position: rtl ? "right" : "left",
          data: items.map((x) => streamName(t, i18n.language, x)),
          axisLabel: {
            color: p.ink,
            align: rtl ? "left" : "right",
            margin: 10,
          },
        },
        series: [
          s("done", p.done, (c) => c.done ?? 0),
          s("in_progress", p.open, (c) => c.in_progress ?? 0),
          s("waiting", p.lock, (c) => (c.not_due ?? 0) + (c.not_started ?? 0)),
        ],
      };
    },
    [d, t, i18n.language],
  );

  const slaBars = useMemo(
    () => (p: Palette, rtl: boolean) => {
      const rows = d?.sla.by_stage ?? [];
      const s = (
        key: string,
        color: string,
        f: (r: (typeof rows)[number]) => number,
      ) => ({
        name: t(`dash.sla.${key}`),
        type: "bar",
        stack: "n",
        itemStyle: { color },
        data: rows.map(f),
      });
      return {
        textStyle: { fontFamily: FONT },
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
        legend: { top: 0, textStyle: { color: p.mute } },
        grid: { left: 8, right: 8, top: 32, bottom: 24, containLabel: true },
        xAxis: {
          type: "category",
          inverse: rtl,
          data: rows.map((r) => r.stage_code),
          axisLabel: { color: p.mute },
        },
        yAxis: {
          type: "value",
          position: rtl ? "right" : "left",
          axisLabel: { color: p.mute },
          splitLine: { lineStyle: { color: p.line } },
        },
        series: [
          s("on_time", p.done, (r) => r.open_on_time),
          s("at_risk", p.wait, (r) => r.open_at_risk),
          s("late", p.late, (r) => r.open_late),
        ],
      };
    },
    [d, t],
  );

  const ownerBars = useMemo(
    () => (p: Palette, rtl: boolean) => {
      const rows = d?.issues?.by_owner.slice(0, 8) ?? [];
      return {
        textStyle: { fontFamily: FONT },
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
        grid: { left: 16, right: 24, top: 8, bottom: 8, containLabel: true },
        xAxis: {
          type: "value",
          inverse: rtl,
          minInterval: 1,
          axisLabel: { color: p.mute },
          splitLine: { lineStyle: { color: p.line } },
        },
        yAxis: {
          type: "category",
          inverse: true,
          position: rtl ? "right" : "left",
          data: rows.map((r) => r.owner_name ?? t("dash.issues.no_owner")),
          axisLabel: {
            color: p.ink,
            width: ar ? 160 : 100,
            overflow: "truncate",
            ellipsis: "…",
            align: rtl ? "left" : "right",
            margin: 10,
          },
        },
        series: [
          {
            type: "bar",
            itemStyle: { color: p.open },
            data: rows.map((r) => r.count),
            label: {
              show: true,
              position: rtl ? "left" : "right",
              color: p.ink,
            },
          },
        ],
      };
    },
    [d, t, ar],
  );

  const catBars = useMemo(
    () => (p: Palette, rtl: boolean) => {
      const rows = d?.issues?.by_category.slice(0, 8) ?? [];
      const label = (r: (typeof rows)[number]) =>
        (ar && r.label_ar ? r.label_ar : r.label_en) ??
        t("dash.issues.no_category");
      return {
        textStyle: { fontFamily: FONT },
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
        grid: { left: 16, right: 24, top: 8, bottom: 8, containLabel: true },
        xAxis: {
          type: "value",
          inverse: rtl,
          minInterval: 1,
          axisLabel: { color: p.mute },
          splitLine: { lineStyle: { color: p.line } },
        },
        yAxis: {
          type: "category",
          inverse: true,
          position: rtl ? "right" : "left",
          data: rows.map(label),
          axisLabel: {
            color: p.ink,
            width: ar ? 160 : 100,
            overflow: "truncate",
            ellipsis: "…",
            align: rtl ? "left" : "right",
            margin: 10,
          },
        },
        series: [
          {
            type: "bar",
            itemStyle: { color: p.open },
            data: rows.map((r) => r.count),
            label: {
              show: true,
              position: rtl ? "left" : "right",
              color: p.ink,
              formatter: (pt: { dataIndex: number }) =>
                `${rows[pt.dataIndex]?.count ?? 0} · ${
                  rows[pt.dataIndex]?.sites ?? 0
                }`,
            },
          },
        ],
      };
    },
    [d, t, ar],
  );

  const reasonBars = useMemo(
    () => (p: Palette, rtl: boolean) => {
      const rows = d?.issues?.by_reason.slice(0, 8) ?? [];
      const label = (r: (typeof rows)[number]) =>
        (ar && r.label_ar ? r.label_ar : r.label_en) ??
        t("dash.issues.no_reason");
      return {
        textStyle: { fontFamily: FONT },
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
        grid: { left: 16, right: 24, top: 8, bottom: 8, containLabel: true },
        xAxis: {
          type: "value",
          inverse: rtl,
          minInterval: 1,
          axisLabel: { color: p.mute },
          splitLine: { lineStyle: { color: p.line } },
        },
        yAxis: {
          type: "category",
          inverse: true,
          position: rtl ? "right" : "left",
          data: rows.map(label),
          axisLabel: {
            color: p.ink,
            width: ar ? 160 : 100,
            overflow: "truncate",
            ellipsis: "…",
            align: rtl ? "left" : "right",
            margin: 10,
          },
        },
        series: [
          {
            type: "bar",
            itemStyle: { color: p.open },
            data: rows.map((r) => r.count),
            label: {
              show: true,
              position: rtl ? "left" : "right",
              color: p.ink,
              formatter: (pt: { dataIndex: number }) =>
                `${rows[pt.dataIndex]?.count ?? 0} · ${
                  rows[pt.dataIndex]?.sites ?? 0
                }`,
            },
          },
        ],
      };
    },
    [d, t, ar],
  );

  const delayBars = useMemo(
    () => (p: Palette, rtl: boolean) => {
      const rows = d?.delay.items.slice(0, 8) ?? [];
      const label = (r: DelayItem) => delayName(t, r);
      return {
        textStyle: { fontFamily: FONT },
        tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
        grid: { left: 16, right: 24, top: 8, bottom: 8, containLabel: true },
        xAxis: {
          type: "value",
          inverse: rtl,
          axisLabel: { color: p.mute },
          splitLine: { lineStyle: { color: p.line } },
        },
        yAxis: {
          type: "category",
          inverse: true,
          position: rtl ? "right" : "left",
          data: rows.map(label),
          axisLabel: {
            color: p.ink,
            width: ar ? 170 : 110,
            overflow: "truncate",
            ellipsis: "…",
            align: rtl ? "left" : "right",
            margin: 10,
          },
        },
        series: [
          {
            type: "bar",
            itemStyle: { color: p.late },
            data: rows.map((r) => r.late_working_days),
          },
        ],
      };
    },
    [d, t, ar],
  );

  const gauge = useMemo(
    () => (p: Palette) => {
      const h = d?.health;
      const band = h?.bands ?? { green: 85, amber: 70 };
      return {
        textStyle: { fontFamily: FONT },
        series: [
          {
            type: "gauge",
            min: 0,
            max: 100,
            radius: "95%",
            startAngle: 200,
            endAngle: -20,
            pointer: { show: true, length: "60%", width: 4 },
            axisLine: {
              lineStyle: {
                width: 12,
                color: [
                  [band.amber / 100, p.late],
                  [band.green / 100, p.wait],
                  [1, p.done],
                ],
              },
            },
            axisTick: { show: false },
            splitLine: { show: false },
            axisLabel: { show: false },
            detail: {
              valueAnimation: false,
              formatter: (v: number) =>
                h?.score === null || h?.score === undefined
                  ? "–"
                  : `${Math.round(v)}`,
              fontSize: 26,
              fontWeight: 700,
              color: p.ink,
              offsetCenter: [0, "55%"],
            },
            data: [{ value: h?.score ?? 0 }],
          },
        ],
      };
    },
    [d],
  );

  const delayLabel = (r: DelayItem): string => delayName(t, r);

  if (dash.isError && !d) {
    return (
      <div data-testid="page-dashboard">
        <div className="mb-3 flex flex-wrap items-center gap-2"><h1 className="text-2xl font-bold">{t("dash.title")}</h1><span className="ms-auto"><ScreenSettingsLink screen="dashboard" /></span></div>
        <EmptyState
          title={
            dash.error instanceof Error &&
            "status" in dash.error &&
            (dash.error as { status: number }).status === 403
              ? t("dash.forbidden")
              : t("dash.error")
          }
          action={
            <button
              className="btn"
              data-testid="dash-retry"
              onClick={() => void dash.refetch()}
            >
              {t("errors.retry")}
            </button>
          }
        />
      </div>
    );
  }

  const nodes: PipelineNode[] = (d?.pipeline.nodes ?? []).map((m) => ({
    code: m.code,
    kind: "milestone",
    name_en: m.name_en,
    name_ar: m.name_ar,
    state:
      m.sites_total === 0
        ? "na"
        : m.completed >= m.sites_total
          ? "done"
          : (m.late ?? 0) > 0
            ? "late"
            : m.completed > 0 || m.in_progress > 0 || (m.blocked ?? 0) > 0
              ? "current"
              : "planned",
    progress: m.sites_total > 0 ? m.completed / m.sites_total : 0,
  }));
  const byCode = new Map<string, DashMilestone>(
    (d?.pipeline.nodes ?? []).map((m) => [m.code, m]),
  );
  const ms = (code: string) =>
    d?.headline.milestones.find((m) => m.code === code);
  const regionName = (r: {
    region_id: number;
    region_name: string;
    region_name_ar?: string | null;
  }) => (ar && r.region_name_ar ? r.region_name_ar : r.region_name);
  const ps = d?.headline.project_status;
  // contract 0.15.432: the colours of the SPI and of the progress against plan, only for the figures an admin turned on (`rag` is read at the top of the component)
  const spiValue = ps?.progress_vs_plan_index ?? ps?.spi ?? null;
  const spiTone = ragTone(rag, "spi", spiValue === null ? null : Number(spiValue));
  const gapTone = ragTone(rag, "progress_gap", ps?.progress_pct != null && ps?.planned_pct != null ? ps.progress_pct - ps.planned_pct : null);
  const fc = d?.headline.final_closure;
  const basis = d?.basis;
  /** The data basis of a card. The headline, pipeline and stream figures come from a snapshot when one exists; SLA, issues, delay and health are computed as of the date. */
  const basisNote = (group: "headline" | "dated"): string | undefined => {
    if (!basis) return undefined;
    const kind =
      basis.source === "live"
        ? "live"
        : group === "headline" && basis.source === "snapshot"
          ? "snapshot"
          : "computed";
    return t(`dash.card_basis.${kind}`, { date: basis.ref_date });
  };
  const mileKpi = (code: string, key: string) => {
    const m = ms(code);
    return (
      <Kpi
        key={code}
        testid={`dash-kpi-${key}`}
        title={m ? name(m) : code}
        to={sites({ milestone_reached: code })}
        value={m ? pct(m.done_pct) : "–"}
        sub={
          m ? (
            <>
              {t("dash.pipeline.done_of", { done: m.done, app: m.applicable })}{" "}
              ·{" "}
              <span
                className={m.vs_plan < 0 ? "font-semibold text-lateInk" : ""}
              >
                {t("dash.kpi.vs_plan", { n: signed(m.vs_plan) })}
              </span>
            </>
          ) : undefined
        }
      />
    );
  };

  return (
    <div className="space-y-4" data-testid="page-dashboard">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold">{t("dash.title")}</h1>
          {basis && (
            <span
              className={`chip ${basis.source === "live" ? "bg-doneBg text-doneInk" : "bg-waitBg text-waitInk"}`}
              data-testid="dash-basis"
              data-source={basis.source}
            >
              {t(`dash.basis.${basis.source}`, { date: basis.ref_date })}
            </span>
          )}
          {dash.isFetching && (
            <span className="text-sm text-mute" role="status">
              {t("common.loading")}
            </span>
          )}
          <span className="ms-auto print:hidden"><ScreenSettingsLink screen="dashboard" /></span>
        </div>
        <p className="text-mute">{t("dash.subtitle")}</p>
      </header>

      {/* F6: the three sections, as tabs (the tab sets the view filter) */}
      <div
        role="tablist"
        aria-label={t("dash.tabs.label")}
        className="flex flex-wrap gap-2 print:hidden"
        data-testid="dash-tabs"
      >
        {DASH_TABS.filter((k) => tabsAllowed.includes(k)).map((k) => {
          const on = tab === k;
          const available =
            k === "pmo" ||
            !d ||
            (d.filters.views ?? []).some((v) => v.code === tabView(k));
          return (
            <button
              key={k}
              role="tab"
              aria-selected={on}
              disabled={!available}
              title={available ? undefined : t("dash.tabs.unavailable")}
              className={`btn ${on ? "btn-primary" : ""}`}
              data-testid={`dash-tab-${k}`}
              onClick={() => selectTab(k)}
            >
              {t(`dash.tabs.${k}`)}
            </button>
          );
        })}
      </div>

      {/* filters, reference date, export */}
      <div
        role="toolbar"
        aria-label={t("dash.filters.label")}
        className="card flex flex-wrap items-end gap-3 p-3 print:hidden"
        data-testid="dash-filters"
      >
        {/* 0.15.49: saved views of the dashboard keep the filter tree and the quick parameters (region, cluster, scenario, stream, view); the reference date is not saved */}
        <SavedViews
          screen="dashboard"
          value={{ region_id: q.region_id ?? "", cluster_code: q.cluster_code ?? "", scenario: q.scenario ?? "", stream: q.stream ?? "", view: tab === "pmo" ? (q.view ?? "") : "", ...(advTree ? { advanced: advTree } : {}) }}
          empty={DASH_VIEW_EMPTY}
          onApply={(v) => {
            const r = v as Record<string, unknown>;
            setParam({
              region_id: String(r.region_id ?? ""),
              cluster_code: String(r.cluster_code ?? ""),
              scenario: String(r.scenario ?? ""),
              stream: String(r.stream ?? ""),
              ...(tab === "pmo" ? { view: String(r.view ?? "") } : {}),
              adv: encodeFilter(r.advanced as FilterTree | undefined),
            });
          }}
        />
        <div className="text-sm">
          <div>
            <UnifiedFilter
              screen="dashboard"
              value={advTree}
              onChange={(tree) => setParam({ adv: encodeFilter(tree) })}
              onClearAll={() => setParam({ adv: "", region_id: "", cluster_code: "", scenario: "" })}
              extras={[
                { key: "region_id", label: t("dash.filters.region"), kind: "text", hidden: true, value: q.region_id ?? "", set: (v) => setParam({ region_id: v }), chip: `${t("dash.filters.region")}: ${(d?.filters.regions ?? []).map((r) => (String(r.id) === q.region_id ? (ar && r.name_ar ? r.name_ar : r.name_en) : "")).join("") || q.region_id}` },
                { key: "cluster_code", label: t("dash.filters.cluster"), kind: "text", hidden: true, value: q.cluster_code ?? "", set: (v) => setParam({ cluster_code: v }), chip: `${t("dash.filters.cluster")}: ${q.cluster_code}` },
                { key: "scenario", label: t("dash.filters.scenario"), kind: "text", hidden: true, value: q.scenario ?? "", set: (v) => setParam({ scenario: v }), chip: `${t("dash.filters.scenario")}: ${q.scenario ? t(`scenario.${q.scenario}`) : ""}` },
              ]}
            />
          </div>
        </div>
        <label className="text-sm font-semibold">
          {t("dash.filters.stream")}
          <select
            className="input mt-1 w-auto font-normal"
            data-testid="dash-filter-stream"
            value={q.stream}
            onChange={(e) => setParam({ stream: e.target.value })}
          >
            <option value="">{t("dash.filters.all_streams")}</option>
            {(d?.filters.streams ?? []).map((s) => (
              <option key={s.code} value={s.code}>
                {streamName(t, i18n.language, s)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-semibold">
          {t("dash.filters.view")}
          <select
            className="input mt-1 w-auto font-normal"
            data-testid="dash-filter-view"
            disabled={tab !== "pmo"}
            value={q.view}
            onChange={(e) => setParam({ view: e.target.value })}
          >
            <option value="">{t("dash.filters.all_views")}</option>
            {(d?.filters.views ?? []).map((v) => (
              <option key={v.code} value={v.code}>
                {name(v)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-semibold">
          {t("dash.ref_date")}
          <DateInput
            className="input mt-1 w-auto font-normal"
            data-testid="dash-ref-date"
            max={today}
            value={refDate}
            onChange={(e) =>
              setParam({
                ref_date:
                  e.target.value && e.target.value < today
                    ? e.target.value
                    : "",
              })
            }
          />
        </label>
        <button
          className="btn"
          data-testid="dash-today"
          disabled={!q.ref_date}
          onClick={() => setParam({ ref_date: "" })}
        >
          {t("dash.today")}
        </button>
        <span className="ms-auto flex flex-wrap items-center gap-2">
          {activeFilters > 0 && (
            <button
              className="btn"
              data-testid="dash-reset"
              onClick={() =>
                setParam({
                  ref_date: "",
                  region_id: "",
                  cluster_code: "",
                  scenario: "",
                  adv: "",
                  stream: "",
                  view: "",
                })
              }
            >
              <RotateCcw size={16} />
              {t("dash.reset")}
            </button>
          )}
          {/* P2: the six output buttons live in one menu; the controls and their test ids are unchanged, only closed (hidden, not removed) */}
          <span className="relative print:hidden" data-testid="dash-share-wrap">
            <button
              type="button"
              className="btn"
              data-testid="dash-share"
              aria-haspopup="true"
              aria-expanded={shareOpen}
              onClick={() => setShareOpen((o) => !o)}
            >
              <Share2 size={16} />
              {t("dash.share_menu")}
              <ChevronDown size={14} aria-hidden />
            </button>
            <div
              role="group"
              aria-label={t("dash.share_menu")}
              data-testid="dash-share-panel"
              className={`${shareOpen ? "flex" : "hidden"} absolute end-0 top-full z-30 mt-1 min-w-56 flex-col gap-1 rounded-lg border border-line bg-surface p-2 shadow-lg`}
            >
              <Link className="btn justify-start" data-testid="dash-tv" to={`/dashboard?${new URLSearchParams([...sp.entries(), ["tv", "1"]]).toString()}`}>
                <MonitorPlay size={16} />
                {t("dash.tv")}
              </Link>
              <button
                className="btn justify-start"
                data-testid="dash-copy-link"
                title={t("dash.copy_link_hint")}
                onClick={() => {
                  // the address already carries the tab and every filter; it opens after the normal sign-in and the reader's own permissions apply
                  void navigator.clipboard?.writeText(window.location.href).then(() => {
                    setLinkCopied(true);
                    window.setTimeout(() => setLinkCopied(false), 2000);
                  });
                }}
              >
                {linkCopied ? <Check size={16} /> : <Link2 size={16} />}
                {linkCopied ? t("dash.link_copied") : t("dash.copy_link")}
              </button>
              <Link
                className="btn justify-start"
                to="/dashboard/manual-items"
                data-testid="dash-manual-link"
              >
                <PencilLine size={16} />
                {t("dash.manual_link")}
              </Link>
              {canExport && (
                <>
                  <label className="flex items-center justify-between gap-2 px-1 text-sm text-mute">
                    {t("dash.export_format")}
                    <select
                      className="input w-auto"
                      aria-label={t("dash.export_format")}
                      data-testid="dash-export-format"
                      value={format}
                      onChange={(e) => {
                        setFormat(e.target.value as ExportFormat);
                        savePref("dash.exportFormat", e.target.value);
                      }}
                    >
                      {(["xlsx", "csv"] as const).map((f) => (
                        <option key={f} value={f}>
                          {t(`dash.format.${f}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="btn justify-start print:hidden"
                    data-testid="dash-print"
                    disabled={gate.exportLocked}
                    title={gate.note(gate.exportLocked)}
                    onClick={() => window.print()}
                  >
                    <Printer size={16} />
                    {t("dash.print")}
                  </button>
                  <button
                    className="btn btn-primary justify-start"
                    data-testid="dash-export"
                    disabled={exporting || !d}
                    onClick={doExport}
                  >
                    <Download size={16} />
                    {t("dash.export")}
                  </button>
                </>
              )}
            </div>
          </span>
        </span>
        {!!basis?.snapshot_dates?.length && (
          <div
            className="flex w-full flex-wrap items-center gap-2 text-sm"
            data-testid="dash-snapshots"
          >
            <span className="text-mute">{t("dash.snapshots")}</span>
            {basis.snapshot_dates.slice(0, 6).map((s) => {
              const kind = basis.snapshot_kinds?.find(
                (k) => k.date === s,
              )?.kind;
              return (
                <button
                  key={s}
                  className={`chip border border-line ${refDate === s ? "bg-accentSoft text-accentText" : "bg-card"}`}
                  data-testid={`dash-snapshot-${s}`}
                  data-kind={kind ?? ""}
                  onClick={() => setParam({ ref_date: s })}
                >
                  <span className="mono">{s}</span>
                  {kind && (
                    <span
                      className="ms-1 text-mute"
                      data-testid={`dash-snapshot-kind-${s}`}
                    >
                      · {t(`dash.snapshot_kind.${kind}`)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {basis?.note && (
        <p
          role="note"
          className="rounded-md border border-line bg-waitBg p-3 text-sm text-waitInk"
          data-testid="dash-basis-note"
        >
          {t(`dash.basis_note.${basis.source}`, { date: basis.ref_date })}
        </p>
      )}
      {d && (d.meta.central_items_hidden ?? 0) > 0 && (
        <p
          role="note"
          className="text-sm text-mute"
          data-testid="dash-central-hidden"
        >
          {t("dash.central_hidden", { n: d.meta.central_items_hidden })}
        </p>
      )}
      {dashSettings.data && (
        <DashboardWidgets
          tab={tab}
          cards={dashSettings.data.catalogue.cards.map((c) => ({
            code: c.code,
            label: (i18n.language === "ar" && c.label_ar) || c.label_en,
          }))}
          personal={myLayouts.data}
          versions={Object.fromEntries(
            Object.entries(myLayouts.data ?? {}).map(([k, v]) => [k, v.version]),
          )}
          global={dashSettings.data.tabs}
        />
      )}
      {d && d.headline.sites_total === 0 && (
        <EmptyState title={t("dash.empty")} />
      )}

      {!d ? (
        <p className="text-mute" role="status" data-testid="dash-loading">
          {t("common.loading")}
        </p>
      ) : (
        <>
          {/* F20 (owner default 2026-11-15): the counters card is on the PMO tab only, until the tab's layout is saved in the settings. */}
          {orderBlocks(
            effectiveLayout(tab, myLayouts.data, dashSettings.data?.tabs),
            {
              site_map: (
                <>
                  {/* OV-12 (first card, owner request 2026-11-06): the sites on the map (contract 0.14.5); the dashboard filters above narrow it too */}
                  <SiteMap
                    testid="dash-site-map"
                    height={520}
                    outer={{
                      region_id: q.region_id,
                      cluster_code: q.cluster_code,
                      scenario: q.scenario,
                      stream: q.stream === "DISMANTLE" ? "" : q.stream,
                      filter: q.filter,
                    }}
                  />
                </>
              ),

              f13: (
                <>
                  {/* F13 (contract 0.15.16): risk matrix, data quality, swap and relocation, decisions; A4 landscape when printed */}
                  <F13Panel ex={extras.data} sitesLink={sites} />
                </>
              ),

              ops_procurement: (
                <>
                  {/* 0.15.98 (owner approval 2026-11-26, item 1): open PR/PO aging, receive rate and shortage per contractor */}
                  <OpsProcurementCard ops={ops.data} />
                </>
              ),

              pinned_views: (
                <>
                  {/* 0.15.245 (owner request 2026-11-27, research item 16): the caller's pinned views with counters */}
                  <PinnedViewsCard />
                </>
              ),
              ops_scurve: (
                <>
                  {/* owner approval 2026-11-26, item 2: planned vs actual of the saved weekly snapshots, weekly velocity and the 100% forecast */}
                  <OpsScurveCard snaps={snaps.data} />
                </>
              ),

              ops_permits_hse: (
                <>
                  {/* 0.15.200 (owner approval 2026-11-26, item 3): permit status mix, validity pressure, stop-work and the PTW check gaps */}
                  <OpsPermitsCard ops={ops.data} />
                </>
              ),

              ops_gecol_hlc: (
                <>
                  {/* 0.15.201 (owner approval 2026-11-26, item 4): GECOL/HLC readiness, the waiting sites by age, civilly ready but not electrified */}
                  <OpsReadinessCard ops={ops.data} />
                </>
              ),

              ops_contractors: (
                <>
                  {/* 0.15.202 (owner approval 2026-11-26, item 5): the contractor and supplier scorecard - levels, on-time rectification, avg delay, rejection, no amounts */}
                  <OpsScorecardCard ops={ops.data} />
                </>
              ),

              ops_quality: (
                <>
                  {/* 0.15.203 (owner approval 2026-11-26, item 6): open snags and NCR, average closure age, first-time acceptance */}
                  <OpsQualityCard ops={ops.data} />
                </>
              ),

              ops_approvals: (
                <>
                  {/* 0.15.204 (owner approval 2026-11-26, item 7): tasks waiting review or approval, ages per ball-in-court role */}
                  <OpsApprovalsCard ops={ops.data} />
                </>
              ),

              ops_finance: (
                <>
                  {/* 0.15.206 (owner approval 2026-11-26, item 9): restricted financial summary; renders nothing unless the caller is a configured reader */}
                  <OpsFinanceCard ops={ops.data} />
                </>
              ),

              ops_phase: (
                <>
                  {/* 0.15.367: sites per project phase with progress; targets derived from the scope */}
                  <OpsPhaseCard ops={ops.data} />
                </>
              ),

              ops_changes: (
                <>
                  {/* 0.15.205 (owner approval 2026-11-26, item 8): pending change requests and overdue meeting actions */}
                  <OpsChangesCard ops={ops.data} />
                </>
              ),

              headline: (
                <>
                  {/* needs-attention strip: only counts the dashboard already returned, each linking to its list; nothing new is read */}
                  {(() => {
                    const lateN = d.sla?.totals?.open_late ?? 0;
                    const issuesN = d.issues?.open_total ?? 0;
                    const actNow = (extras.data?.decisions?.items ?? []).filter((x) => x.tag === "act_now").length;
                    if (!lateN && !issuesN && !actNow) return null;
                    return (
                      <section className="mb-3 flex flex-wrap items-center gap-2 text-sm" data-testid="dash-attention" aria-label={t("dash.attention.title")}>
                        <b>{t("dash.attention.title")}</b>
                        {lateN > 0 && <Link className="chip bg-lateBg text-lateInk" data-testid="dash-attn-late" to={sites({ bucket: "late" })}>{t("dash.attention.late", { n: lateN })}</Link>}
                        {issuesN > 0 && <Link className="chip bg-waitBg text-waitInk" data-testid="dash-attn-issues" to="/registers/issues">{t("dash.attention.issues", { n: issuesN })}</Link>}
                        {actNow > 0 && <span className="chip bg-lateBg text-lateInk" data-testid="dash-attn-decisions">{t("dash.attention.decisions", { n: actNow })}</span>}
                      </section>
                    );
                  })()}
                  {/* headline */}
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <section
                      className="card p-4 xl:col-span-2"
                      data-testid="dash-kpi-progress"
                      aria-label={t("dash.kpi.progress")}
                    >
                      <div className="text-sm text-mute">
                        {t("dash.kpi.progress")}
                      </div>
                      <div className="flex flex-wrap items-baseline gap-3">
                        <span
                          className="text-5xl font-bold tnum"
                          data-testid="dash-progress-value"
                        >
                          {pct(ps?.progress_pct)}
                        </span>
                        <span
                          className={`chip border border-line ${gapTone ? RAG_CLASS[gapTone] : ""}`}
                          data-testid="dash-planned"
                          data-rag={gapTone ?? undefined}
                        >
                          {t("dash.kpi.planned")}:{" "}
                          {ps?.planned_pct === null ||
                          ps?.planned_pct === undefined
                            ? t("dash.kpi.na")
                            : pct(ps.planned_pct)}
                        </span>
                        <span
                          className={`chip border border-line ${spiTone ? RAG_CLASS[spiTone] : ""}`}
                          data-testid="dash-spi"
                          data-rag={spiTone ?? undefined}
                          title={t("dash.kpi.not_evm")}
                        >
                          {t("dash.kpi.spi")}:{" "}
                          {(ps?.progress_vs_plan_index ?? ps?.spi) == null
                            ? t("dash.kpi.na")
                            : (ps?.progress_vs_plan_index ?? ps?.spi)}
                        </span>
                      </div>
                      <div className="my-3">
                        <Bar
                          value={ps?.progress_pct ?? 0}
                          plan={ps?.planned_pct}
                        />
                      </div>
                      <div className="text-sm text-mute">
                        {t("dash.kpi.coverage", {
                          n: Math.round(ps?.plan_coverage_pct ?? 0),
                        })}{" "}
                        · {t("dash.kpi.ends_hoto")}
                      </div>
                      {ps?.partial_index &&
                        ps.partial_index.value != null &&
                        ps.planned_pct == null && (
                          <div
                            className="text-sm text-mute"
                            data-testid="dash-partial-index"
                          >
                            {t("dash.kpi.partial", {
                              v: ps.partial_index.value,
                              c: Math.round(ps.partial_index.coverage_pct),
                            })}
                          </div>
                        )}
                      {ps?.central_line && (
                        <div
                          className="mt-2 rounded-md border border-dashed border-line p-2 text-sm"
                          data-testid="dash-central-line"
                          role="note"
                        >
                          {t("dash.ps.central_line", {
                            m: ps.central_line.measured,
                            t: ps.central_line.total,
                          })}
                          {ps.central_line.progress_pct != null && (
                            <>
                              {" "}
                              ·{" "}
                              {t("dash.ps.central_pct", {
                                pct: Number(
                                  ps.central_line.progress_pct.toFixed(1),
                                ),
                              })}
                            </>
                          )}
                          <div className="text-xs text-mute">
                            {t("dash.ps.central_hint")}
                          </div>
                        </div>
                      )}
                    </section>
                    <section
                      className="card p-4 xl:col-span-2"
                      data-testid="dash-kpi-sites"
                      aria-label={t("dash.kpi.sites")}
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-32 shrink-0">
                          <EChart
                            build={statusRing}
                            height={128}
                            label={t("dash.kpi.status_chart", {
                              list: STATUSES.filter((s) => s !== "cancelled")
                                .map(
                                  (s) =>
                                    `${t(`status.${s}`)} ${d.headline.by_overall_status[s]}`,
                                )
                                .join(", "),
                            })}
                            testid="dash-status-chart"
                          />
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm text-mute">
                            {t("dash.kpi.sites")}
                          </div>
                          <Link
                            to={sites()}
                            className="text-4xl font-bold tnum hover:underline"
                            data-testid="dash-sites-total"
                          >
                            {d.headline.sites_total}
                          </Link>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {STATUSES.map((s) => (
                              <Link
                                key={s}
                                to={sites({ dashboard_status: s })}
                                className={`chip ${STATUS_TONE[s]}`}
                                data-testid={`dash-status-${s}`}
                              >
                                {t(`status.${s}`)}{" "}
                                <b className="ms-1 tnum">
                                  {d.headline.by_overall_status[s]}
                                </b>
                              </Link>
                            ))}
                          </div>
                          {d.headline.sites_cancelled > 0 && (
                            <div className="mt-1 text-xs text-mute">
                              {t("dash.kpi.cancelled_note", {
                                n: d.headline.sites_cancelled,
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    </section>
                    {mileKpi("MS4", "rfi")}
                    {d.headline.on_air ? (
                      <Kpi
                        testid="dash-kpi-onair"
                        title={t("dash.kpi.onair")}
                        to={sites({ milestone_reached: "MS6" })}
                        value={pct(d.headline.on_air.done_pct)}
                        sub={
                          <>
                            {t("dash.pipeline.done_of", {
                              done: d.headline.on_air.done,
                              app: d.headline.on_air.applicable,
                            })}{" "}
                            ·{" "}
                            <span
                              className={
                                (d.headline.on_air.vs_plan ?? 0) < 0
                                  ? "font-semibold text-lateInk"
                                  : ""
                              }
                            >
                              {t("dash.kpi.vs_plan", {
                                n: signed(d.headline.on_air.vs_plan ?? 0),
                              })}
                            </span>
                          </>
                        }
                      />
                    ) : (
                      mileKpi("MS6", "onair")
                    )}
                    {mileKpi("MS9", "hoto")}
                    <Kpi
                      testid="dash-kpi-closure"
                      title={t("dash.kpi.closure")}
                      to={sites({ milestone_reached: "MS10" })}
                      value={pct(fc?.closed_pct)}
                      sub={
                        <div data-testid="dash-closure-detail">
                          {t("dash.kpi.closed_of", {
                            closed: fc?.sites_closed ?? 0,
                            base: fc?.sites_total ?? 0,
                          })}
                          <div>
                            {t("dash.kpi.fac_cw")}:{" "}
                            <b data-testid="dash-fac-cw">
                              {fc?.pending_cw_fac.count ?? 0}
                            </b>{" "}
                            {fc?.pending_cw_fac.oldest_age_days != null && (
                              <>
                                (
                                {t("dash.kpi.oldest", {
                                  n: fc.pending_cw_fac.oldest_age_days,
                                })}
                                )
                              </>
                            )}{" "}
                            ·{" "}
                            {t("dash.kpi.not_due", {
                              n: fc?.pending_cw_fac.not_due ?? 0,
                            })}
                          </div>
                          <div>
                            {t("dash.kpi.fac_te")}:{" "}
                            <b data-testid="dash-fac-te">
                              {fc?.pending_te_fac.count ?? 0}
                            </b>{" "}
                            {fc?.pending_te_fac.oldest_age_days != null && (
                              <>
                                (
                                {t("dash.kpi.oldest", {
                                  n: fc.pending_te_fac.oldest_age_days,
                                })}
                                )
                              </>
                            )}{" "}
                            ·{" "}
                            {t("dash.kpi.not_due", {
                              n: fc?.pending_te_fac.not_due ?? 0,
                            })}
                          </div>
                        </div>
                      }
                    />
                  </div>
                </>
              ),

              pipeline: (
                <>
                  {/* pipeline */}
                  <Card
                    title={t("dash.pipeline.title")} basisNote={basisNote("headline")}
                    testid="dash-pipeline"
                    aside={
                      <span className="flex flex-wrap items-center gap-2 text-sm text-mute">
                        <span>{t("dash.pipeline.hint")}</span>
                        <span
                          role="radiogroup"
                          aria-label={t("dash.pipeline.preview")}
                          className="inline-flex overflow-hidden rounded-md border border-line"
                          data-testid="dash-pipe-preview"
                        >
                          {(["A", "B"] as const).map((v) => {
                            const on =
                              (preview ?? d.meta.pipeline_variant ?? "A") === v;
                            return (
                              <button
                                key={v}
                                type="button"
                                role="radio"
                                aria-checked={on}
                                data-testid={`dash-pipe-variant-${v}`}
                                className={`px-2 py-1 text-xs ${on ? "bg-accentSoft text-accentText font-semibold" : "bg-card text-ink"}`}
                                onClick={() =>
                                  setPreview(
                                    v === (d.meta.pipeline_variant ?? "A")
                                      ? null
                                      : v,
                                  )
                                }
                              >
                                {t(`dash.pipeline.variant_${v}`)}
                              </button>
                            );
                          })}
                        </span>
                      </span>
                    }
                  >
                    {preview &&
                      preview !== (d.meta.pipeline_variant ?? "A") && (
                        <p
                          className="mb-2 text-xs text-waitInk"
                          role="note"
                          data-testid="dash-pipe-preview-note"
                        >
                          {t("dash.pipeline.preview_note", {
                            v: d.meta.pipeline_variant ?? "A",
                          })}
                        </p>
                      )}
                    {nodes.length === 0 ? (
                      <p className="text-mute">{t("dash.empty")}</p>
                    ) : (
                      <Pipeline
                        nodes={nodes}
                        variant={preview ?? d.meta.pipeline_variant ?? "A"}
                        label={(m) => {
                          const n = byCode.get(m.code);
                          return `${ar && m.name_ar ? m.name_ar : m.name_en}: ${n ? t("dash.pipeline.done_of", { done: n.completed, app: n.sites_total }) : ""}`;
                        }}
                        onSelect={(code) => nav(sites({ stage_code: code }))}
                        stats={(m) => {
                          const n = byCode.get(m.code);
                          if (!n) return null;
                          return (
                            <span data-testid={`dash-node-${m.code}`}>
                              <span className="mono">
                                {n.completed}/{n.sites_total}
                              </span>
                              {(n.vs_plan ?? 0) !== 0 && (
                                <span
                                  className={(n.vs_plan ?? 0) < 0 ? "late" : ""}
                                >
                                  {" "}
                                  {signed(n.vs_plan ?? 0)}
                                </span>
                              )}
                              <br />
                              {n.in_progress > 0 && (
                                <>
                                  {t("dash.pipeline.in_work", {
                                    n: n.in_progress,
                                  })}{" "}
                                </>
                              )}
                              {n.not_started > 0 && (
                                <>
                                  {t("dash.pipeline.waiting", {
                                    n: n.not_started,
                                  })}{" "}
                                </>
                              )}
                              {n.blocked_available === false ? (
                                <span
                                  className="text-mute"
                                  data-testid={`dash-node-blocked-unknown-${m.code}`}
                                >
                                  {t("dash.pipeline.blocked_unknown")}{" "}
                                </span>
                              ) : (
                                (n.blocked ?? 0) > 0 && (
                                  <b className="late">
                                    {t("dash.pipeline.blocked", {
                                      n: n.blocked,
                                    })}{" "}
                                  </b>
                                )
                              )}
                              {(n.overdue_open ?? 0) > 0 && (
                                <b className="late">
                                  {t("dash.pipeline.overdue", {
                                    n: n.overdue_open,
                                  })}
                                </b>
                              )}
                            </span>
                          );
                        }}
                      />
                    )}
                  </Card>
                </>
              ),

              health_ps: (
                <>
                  {/* health + activities */}
                  <div className="grid gap-3 lg:grid-cols-2">
                    <Card title={t("dash.health.title")} basisNote={basisNote("dated")} testid="dash-health">
                      <div className="grid items-center gap-3 sm:grid-cols-[180px_1fr]">
                        <div className="text-center">
                          <EChart
                            build={gauge}
                            height={150}
                            label={t("dash.health.chart", {
                              score: d.health.score ?? "–",
                            })}
                            testid="dash-health-gauge"
                          />
                          {d.health.band && (
                            <span
                              className={`chip ${BAND_TONE[d.health.band]}`}
                              data-testid="dash-health-band"
                              data-band={d.health.band}
                            >
                              {t(`dash.health.band.${d.health.band}`)}
                            </span>
                          )}
                          <div
                            className="mt-1 text-xs text-mute"
                            data-testid="dash-health-bands"
                          >
                            {t("dash.health.bands", {
                              green: d.health.bands.green,
                              amber: d.health.bands.amber,
                            })}
                          </div>
                        </div>
                        <ul
                          className="space-y-1 text-sm"
                          data-testid="dash-health-components"
                        >
                          {d.health.components.map((c) => (
                            <li
                              key={c.code}
                              className="flex items-center justify-between gap-2"
                              data-testid={`dash-health-${c.code}`}
                            >
                              <span>
                                {ar && c.name_ar ? c.name_ar : c.name_en}{" "}
                                <span className="text-mute">
                                  ({Number(c.weight.toFixed(1))}%)
                                </span>
                                {c.draft && (
                                  <span
                                    className="chip ms-1 bg-waitBg text-waitInk text-xs"
                                    data-testid={`dash-health-draft-${c.code}`}
                                  >
                                    {t("dash.health.draft_factor")}
                                  </span>
                                )}
                              </span>
                              {c.excluded ? (
                                <span className="chip bg-lockBg text-lockInk">
                                  {t("dash.health.excluded")}
                                </span>
                              ) : (
                                <b className="tnum">
                                  {c.value === null
                                    ? "–"
                                    : Number(c.value.toFixed(1))}
                                </b>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <p className="mt-2 text-xs text-mute">
                        {t("dash.health.note")}
                      </p>
                      {d.health.components.some((c) => c.draft) && (
                        <p
                          className="text-xs text-mute"
                          data-testid="dash-health-draft-note"
                        >
                          {t("dash.health.draft_note")}
                        </p>
                      )}
                    </Card>
                    <Card title={t("dash.ps.title")} basisNote={basisNote("headline")} testid="dash-ps">
                      <ul className="space-y-2">
                        {(ps?.activities ?? []).map((a) => (
                          <li key={a.code} data-testid={`dash-ps-${a.code}`}>
                            <div className="flex justify-between text-sm">
                              <span>
                                {name(a)}{" "}
                                <span className="text-mute">({a.weight}%)</span>
                              </span>
                              {a.measured ? (
                                <b className="tnum">{pct(a.progress_pct)}</b>
                              ) : (
                                <span className="chip bg-lockBg text-lockInk">
                                  {t("dash.ps.no_data")}
                                </span>
                              )}
                            </div>
                            <Bar
                              value={a.measured ? a.progress_pct : 0}
                              tone="bg-open"
                            />
                          </li>
                        ))}
                      </ul>
                    </Card>
                  </div>
                </>
              ),

              streams: (
                <>
                  {/* streams */}
                  <Card
                    title={t("dash.streams.title")} basisNote={basisNote("headline")}
                    testid="dash-streams"
                    aside={
                      <span className="text-sm text-mute">
                        {t("dash.streams.hint")}
                      </span>
                    }
                  >
                    <EChart
                      build={streamBars}
                      height={44 + d.streams.items.length * 40}
                      label={t("dash.streams.chart", {
                        list: d.streams.items
                          .map(
                            (s) =>
                              `${streamName(t, i18n.language, s)}: ${s.counts.done ?? 0}/${s.counts.in_progress ?? 0}/${(s.counts.not_due ?? 0) + (s.counts.not_started ?? 0)}`,
                          )
                          .join("; "),
                      })}
                      testid="dash-streams-chart"
                    />
                    <div className="overflow-x-auto">
                      <table
                        className="mt-2 w-full text-sm"
                        data-testid="dash-streams-table"
                      >
                        <thead>
                          <tr className="text-start text-mute">
                            <th className="py-1 text-start">
                              {t("dash.streams.stream")}
                            </th>
                            {[
                              "done",
                              "in_progress",
                              "not_due",
                              "not_started",
                              "na",
                              "on_hold",
                            ].map((k) => (
                              <th key={k} className="px-2 text-end">
                                {t(`dash.streams.${k}`)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {d.streams.items.map((s) => (
                            <tr
                              key={s.code}
                              className="border-t border-line"
                              data-testid={`dash-stream-${s.code}`}
                            >
                              <td className="py-1">
                                <Link
                                  className="font-semibold hover:underline"
                                  to={sites({ stream: s.code })}
                                >
                                  {streamName(t, i18n.language, s)}
                                </Link>
                              </td>
                              {(
                                [
                                  "done",
                                  "in_progress",
                                  "not_due",
                                  "not_started",
                                  "na",
                                  "on_hold",
                                ] as const
                              ).map((k) => (
                                <td
                                  key={k}
                                  className="px-2 text-end tnum"
                                  data-testid={`dash-stream-${s.code}-${k}`}
                                >
                                  {s.counts[k] ?? 0}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {d.streams.items.some((s) => s.by_region.length > 1) && (
                      <details
                        className="mt-2"
                        data-testid="dash-streams-regions"
                      >
                        <summary className="cursor-pointer text-sm font-semibold">
                          {t("dash.streams.by_region")}
                        </summary>
                        <div className="overflow-x-auto">
                          <table className="mt-1 w-full text-sm">
                            <thead>
                              <tr className="text-mute">
                                <th className="py-1 text-start">
                                  {t("dash.streams.stream")}
                                </th>
                                {d.filters.regions.map((r) => (
                                  <th key={r.id} className="px-2 text-end">
                                    {ar && r.name_ar ? r.name_ar : r.name_en}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {d.streams.items.map((s) => (
                                <tr
                                  key={s.code}
                                  className="border-t border-line"
                                >
                                  <td className="py-1">
                                    {streamName(t, i18n.language, s)}
                                  </td>
                                  {d.filters.regions.map((r) => {
                                    const c = s.by_region.find(
                                      (x) => x.region_id === r.id,
                                    );
                                    return (
                                      <td
                                        key={r.id}
                                        className="px-2 text-end tnum"
                                      >
                                        {c
                                          ? `${c.done ?? 0}/${c.in_progress ?? 0}/${(c.not_due ?? 0) + (c.not_started ?? 0)}`
                                          : "–"}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <p className="text-xs text-mute">
                          {t("dash.streams.triple")}
                        </p>
                      </details>
                    )}
                  </Card>
                </>
              ),

              sla: (
                <>
                  {/* SLA */}
                  <div className="grid gap-3 lg:grid-cols-2">
                    <Card
                      title={t("dash.sla.title")} basisNote={basisNote("dated")}
                      testid="dash-sla"
                      aside={
                        <Link
                          className="text-sm text-link hover:underline"
                          to={sites({ bucket: "late" })}
                          data-testid="dash-sla-late-link"
                        >
                          {t("dash.sla.open_late", {
                            n: d.sla.totals.open_late,
                          })}
                        </Link>
                      }
                    >
                      <div
                        className="mb-2 flex flex-wrap gap-2 text-sm"
                        data-testid="dash-sla-totals"
                      >
                        <span className="chip bg-doneBg text-doneInk">
                          {t("dash.sla.on_time")}{" "}
                          <b className="ms-1 tnum">
                            {d.sla.totals.open_on_time}
                          </b>
                        </span>
                        <span className="chip bg-waitBg text-waitInk">
                          {t("dash.sla.at_risk")}{" "}
                          <b className="ms-1 tnum">
                            {d.sla.totals.open_at_risk}
                          </b>
                        </span>
                        <span className="chip bg-lateBg text-lateInk">
                          {t("dash.sla.late")}{" "}
                          <b className="ms-1 tnum">{d.sla.totals.open_late}</b>
                        </span>
                        <span className="chip border border-line">
                          {t("dash.sla.completed")}{" "}
                          <b className="ms-1 tnum">
                            {d.sla.totals.completed_on_time}
                          </b>
                          /
                          <b className="tnum">
                            {d.sla.totals.completed_on_time +
                              d.sla.totals.completed_late}
                          </b>
                        </span>
                      </div>
                      {d.sla.by_stage.length === 0 ? (
                        <p className="text-mute">{t("dash.sla.none")}</p>
                      ) : (
                        <EChart
                          build={slaBars}
                          height={230}
                          label={t("dash.sla.chart", {
                            list: d.sla.by_stage
                              .map(
                                (s) =>
                                  `${s.stage_code} ${s.open_on_time}/${s.open_at_risk}/${s.open_late}`,
                              )
                              .join("; "),
                          })}
                          testid="dash-sla-chart"
                        />
                      )}
                    </Card>
                    <Card title={t("dash.sla.top_late")} testid="dash-top-late">
                      {d.sla.top_late.length === 0 ? (
                        <p className="text-mute">{t("dash.sla.no_late")}</p>
                      ) : (
                        <ol className="space-y-1 text-sm">
                          {d.sla.top_late.map((x) => (
                            <li
                              key={x.task_id}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-2"
                              data-testid={`dash-late-${x.task_id}`}
                            >
                              <span>
                                <Link
                                  className="mono font-bold hover:underline"
                                  to={`/sites/${x.site_id}`}
                                >
                                  {x.site_code}
                                </Link>{" "}
                                {x.task_code} · {x.task_name}
                              </span>
                              <span className="chip bg-lateBg text-lateInk">
                                {t("dash.sla.days_late", { n: x.days_late_wd })}
                              </span>
                            </li>
                          ))}
                        </ol>
                      )}
                    </Card>
                  </div>
                </>
              ),

              gates_issues_delay: (
                <>
                  {/* gates, issues, delay */}
                  <div className="grid gap-3 lg:grid-cols-3">
                    <Card
                      title={t("dash.gates.title")}
                      testid="dash-gates"
                      aside={
                        <span
                          className="chip border border-line tnum"
                          data-testid="dash-gates-total"
                        >
                          {d.gates.blocked_total ?? "–"}
                        </span>
                      }
                    >
                      {d.gates.status === "historically_unavailable" ? (
                        <p
                          className="text-mute"
                          data-testid="dash-gates-unavailable"
                          data-status="historically_unavailable"
                        >
                          {t("dash.gates.historically_unavailable", {
                            date: refDate,
                          })}
                        </p>
                      ) : d.gates.status === "snapshot" ? (
                        <p
                          className="text-mute"
                          data-testid="dash-gates-unavailable"
                          data-status="snapshot"
                        >
                          {t("dash.gates.snapshot", {
                            date: refDate,
                            n: d.gates.blocked_total ?? 0,
                          })}
                        </p>
                      ) : !d.gates.available ? (
                        <p
                          className="text-mute"
                          data-testid="dash-gates-unavailable"
                        >
                          {t("dash.gates.unavailable")}
                        </p>
                      ) : d.gates.items.length === 0 ? (
                        <p className="text-mute">{t("dash.gates.none")}</p>
                      ) : (
                        <ul className="space-y-2 text-sm">
                          {d.gates.items.slice(0, 8).map((g) => (
                            <li
                              key={`${g.site_id}-${g.gate_code}`}
                              className="rounded-md border border-line p-2"
                              data-testid={`dash-gate-${g.site_code}-${g.gate_code}`}
                            >
                              <div>
                                <Link
                                  className="mono font-bold hover:underline"
                                  to={`/sites/${g.site_id}`}
                                >
                                  {g.site_code}
                                </Link>{" "}
                                · {g.gate_code}{" "}
                                {ar && g.name_ar ? g.name_ar : g.name_en}
                              </div>
                              <ul className="mt-1 list-disc ps-5 text-mute">
                                {g.reasons.length ? (
                                  g.reasons.map((r, i) => (
                                    <li key={i}>{r.message}</li>
                                  ))
                                ) : (
                                  <li>{t("dash.gates.no_reason")}</li>
                                )}
                              </ul>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Card>
                    <Card
                      title={t("dash.issues.title")} basisNote={basisNote("dated")}
                      testid="dash-issues"
                      aside={
                        d.issues ? (
                          <Link
                            className="text-sm text-link hover:underline"
                            to="/registers/issues"
                            data-testid="dash-issues-link"
                          >
                            {t("dash.issues.open_register")}
                          </Link>
                        ) : undefined
                      }
                    >
                      {!d.issues ? (
                        <p
                          className="text-mute"
                          data-testid="dash-issues-hidden"
                        >
                          {t("dash.issues.hidden")}
                        </p>
                      ) : (
                        <>
                          <div className="mb-2 flex flex-wrap gap-2 text-sm">
                            <span
                              className="chip border border-line"
                              data-testid="dash-issues-open"
                            >
                              {t("dash.issues.open")}{" "}
                              <b className="ms-1 tnum">{num(d.issues.open_total)}</b>
                            </span>
                            <span
                              className="chip border border-line"
                              data-testid="dash-issues-sites"
                            >
                              {t("dash.issues.sites")}{" "}
                              <b className="ms-1 tnum">
                                {num(d.issues.sites_with_open_issue)}
                              </b>
                            </span>
                            {d.issues.oldest_age_wd != null && (
                              <span className="chip border border-line">
                                {t("dash.issues.oldest", {
                                  n: d.issues.oldest_age_wd,
                                })}
                              </span>
                            )}
                          </div>
                          <div
                            className="mb-2 flex flex-wrap gap-1"
                            role="group"
                            aria-label={t("dash.issues.switch")}
                            data-testid="dash-issues-switch"
                          >
                            {(["owner", "category", "reason"] as const).map((k) => (
                              <button
                                key={k}
                                type="button"
                                className={`btn ${issuesBy === k ? "btn-primary" : ""}`}
                                aria-pressed={issuesBy === k}
                                data-testid={`dash-issues-by-${k}`}
                                onClick={() => setIssuesBy(k)}
                              >
                                {t(`dash.issues.by_${k}`)}
                              </button>
                            ))}
                          </div>
                          {d.issues.by_owner.length > 0 && (
                            <div className={issuesBy === "owner" ? "" : "hidden"}>
                            <EChart
                              build={ownerBars}
                              height={Math.max(
                                90,
                                Math.min(8, d.issues.by_owner.length) * 28 + 16,
                              )}
                              label={t("dash.issues.chart", {
                                list: d.issues.by_owner
                                  .map(
                                    (o) =>
                                      `${o.owner_name ?? t("dash.issues.no_owner")} ${o.count}`,
                                  )
                                  .join("; "),
                              })}
                              testid="dash-issues-chart"
                            />
                            <MoreLine total={d.issues.by_owner.length} testid="dash-issues-more-owner" />
                            </div>
                          )}
                          {d.issues.by_category.length > 0 && (
                            <div className={issuesBy === "category" ? "" : "hidden"}>
                              <h3 className="mb-1 text-sm font-semibold">
                                {t("dash.issues.by_category")}
                              </h3>
                              <p className="mb-1 text-xs text-mute">
                                {t("dash.issues.issues_sites")}
                              </p>
                              <EChart
                                build={catBars}
                                height={Math.max(
                                  90,
                                  Math.min(8, d.issues.by_category.length) *
                                    28 +
                                    16,
                                )}
                                label={t("dash.issues.cat_chart", {
                                  list: d.issues.by_category
                                    .map((r) =>
                                      t("dash.issues.breakdown_row", {
                                        label:
                                          (ar && r.label_ar
                                            ? r.label_ar
                                            : r.label_en) ??
                                          t("dash.issues.no_category"),
                                        n: r.count,
                                        s: r.sites,
                                      }),
                                    )
                                    .join("; "),
                                })}
                                testid="dash-issues-cat-chart"
                              />
                              <MoreLine total={d.issues.by_category.length} testid="dash-issues-more-category" />
                            </div>
                          )}
                          {d.issues.by_reason.length > 0 && (
                            <div className={issuesBy === "reason" ? "" : "hidden"}>
                              <h3 className="mb-1 text-sm font-semibold">
                                {t("dash.issues.by_reason")}
                              </h3>
                              <p className="mb-1 text-xs text-mute">
                                {t("dash.issues.issues_sites")}
                              </p>
                              <EChart
                                build={reasonBars}
                                height={Math.max(
                                  90,
                                  Math.min(8, d.issues.by_reason.length) * 28 +
                                    16,
                                )}
                                label={t("dash.issues.reason_chart", {
                                  list: d.issues.by_reason
                                    .map((r) =>
                                      t("dash.issues.breakdown_row", {
                                        label:
                                          (ar && r.label_ar
                                            ? r.label_ar
                                            : r.label_en) ??
                                          t("dash.issues.no_reason"),
                                        n: r.count,
                                        s: r.sites,
                                      }),
                                    )
                                    .join("; "),
                                })}
                                testid="dash-issues-reason-chart"
                              />
                              <MoreLine total={d.issues.by_reason.length} testid="dash-issues-more-reason" />
                            </div>
                          )}
                          <ul
                            className="mt-2 flex flex-wrap gap-2 text-xs"
                            data-testid="dash-issues-ages"
                          >
                            {d.issues.age_buckets.map((b) => (
                              <li
                                key={b.key}
                                className="chip border border-line"
                              >
                                {t(`dash.issues.age.${b.key}`)}{" "}
                                <b className="ms-1 tnum">{num(b.count)}</b>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </Card>
                    <Card
                      title={t("dash.delay.title")} basisNote={basisNote("dated")}
                      testid="dash-delay"
                      aside={
                        <span
                          className="chip bg-waitBg text-waitInk"
                          data-testid="dash-delay-draft"
                        >
                          {t("dash.delay.draft")}
                        </span>
                      }
                    >
                      {d.delay.items.length === 0 ? (
                        <p className="text-mute">{t("dash.delay.none")}</p>
                      ) : (
                        <>
                          <EChart
                            build={delayBars}
                            height={Math.max(
                              90,
                              Math.min(8, d.delay.items.length) * 28 + 16,
                            )}
                            label={t("dash.delay.chart", {
                              list: d.delay.items
                                .map(
                                  (i) =>
                                    `${delayLabel(i)} ${i.late_working_days}`,
                                )
                                .join("; "),
                            })}
                            testid="dash-delay-chart"
                          />
                          <MoreLine total={d.delay.items.length} testid="dash-delay-more" />
                          <div
                            className="mt-2 text-xs text-mute"
                            data-testid="dash-delay-note"
                          >
                            <span data-testid="dash-delay-total">
                              {t("dash.delay.total", {
                                n: num(d.delay.total_late_working_days),
                                a: d.delay.attributed_pct ?? 0,
                                u: d.delay.unattributed_pct,
                              })}
                            </span>{" "}
                            {(d.delay.suspended_working_days ?? 0) > 0 && (
                              <span data-testid="dash-delay-suspended">
                                {t("dash.delay.suspended", {
                                  n: num(d.delay.suspended_working_days),
                                })}{" "}
                              </span>
                            )}
                            {(d.delay.proposed_working_days ?? 0) > 0 && (
                              <span data-testid="dash-delay-proposed">
                                {t("dash.delay.proposed", {
                                  n: num(d.delay.proposed_working_days),
                                })}{" "}
                              </span>
                            )}
                            {(d.delay.data_gap_working_days ?? 0) > 0 && (
                              <span data-testid="dash-delay-gap">
                                {t("dash.delay.gap", {
                                  n: num(d.delay.data_gap_working_days),
                                })}{" "}
                              </span>
                            )}
                            {t("dash.delay.note")}
                          </div>
                        </>
                      )}
                    </Card>
                  </div>
                </>
              ),

              counters: <CountersPanel ex={extras.data} />,
              goals: <GoalsPanel />,
              regions: (
                <>
                  {/* regions */}
                  <Card title={t("dash.regions.title")} testid="dash-regions">
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[640px] text-sm">
                        <thead>
                          <tr className="text-mute">
                            <th className="py-1 text-start">
                              {t("sites.region")}
                            </th>
                            <th className="px-2 text-end">
                              {t("dash.regions.sites")}
                            </th>
                            {STATUSES.slice(0, 4).map((s) => (
                              <th key={s} className="px-2 text-end">
                                {t(`status.${s}`)}
                              </th>
                            ))}
                            <th className="px-2 text-end">
                              {t("dash.regions.late")}
                            </th>
                            <th className="px-2 text-start">
                              {t("dash.regions.progress")}
                            </th>
                            <th className="px-2 text-end">
                              {t("dash.regions.forecast")}
                            </th>
                            <th className="px-2 text-end">
                              {t("dash.regions.health")}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.regions.items.map((r) => (
                            <tr
                              key={r.region_id}
                              className="border-t border-line"
                              data-testid={`dash-region-${r.region_id}`}
                            >
                              <td className="py-1">
                                <Link
                                  className="font-semibold hover:underline"
                                  to={`/sites?region_id=${r.region_id}`}
                                >
                                  {regionName(r)}
                                </Link>
                              </td>
                              <td className="px-2 text-end tnum">
                                {num(r.sites_total)}
                              </td>
                              {STATUSES.slice(0, 4).map((s) => (
                                <td key={s} className="px-2 text-end tnum">
                                  {num(r.by_overall_status?.[s] ?? 0)}
                                  <MiniShare part={r.by_overall_status?.[s] ?? 0} total={r.sites_total} />
                                </td>
                              ))}
                              <td className="px-2 text-end tnum">
                                {num(r.late ?? 0)}
                                <MiniShare part={r.late ?? 0} total={r.sites_total} tone="bg-late" />
                              </td>
                              <td className="min-w-32 px-2">
                                <div className="flex items-center gap-2">
                                  <div className="flex-1">
                                    <Bar value={r.progress_pct} />
                                  </div>
                                  <span className="tnum">
                                    {pct(r.progress_pct)}
                                  </span>
                                </div>
                              </td>
                              <td className="px-2 text-end tnum" data-testid={`dash-region-forecast-${r.region_id}`}>
                                {fmtDate(r.forecast_date, i18n.language) || "–"}
                              </td>
                              <td className="px-2 text-end tnum">
                                {r.health_score == null
                                  ? "–"
                                  : Number(r.health_score.toFixed(0))}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                </>
              ),

              region_health: <RegionHealthCard />,
            },
          )}
        </>
      )}
    </div>
  );
}

const REGION_HEALTH_TONE: Record<string, string> = { on_track: "bg-openBg text-openInk", at_risk: "bg-waitBg text-waitInk", off_track: "bg-lateBg text-lateInk" };

/** Item 12 (0.15.241): the region health card — the current-week Weekly-status health of every visible region, with the missing-update flag. */
function RegionHealthCard() {
  const { t, i18n } = useTranslation();
  const q = useRegionHealth();
  const regions = useRegions();
  const name = (id: number) => { const r = regions.data?.find((x) => x.id === id); return (i18n.language === "ar" && r?.name_ar) || r?.name_en || String(id); };
  return (
    <Card title={t("dash.region_health.title")} testid="dash-region-health">
      {!q.data ? (
        <p className="text-mute" role="status" data-testid="dash-region-health-loading">
          {t("common.loading")}
        </p>
      ) : (
        <>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {q.data.items.map((r) => (
              <li
                key={r.region_id}
                className="flex items-center gap-2 rounded-lg border border-line px-2 py-1"
                data-testid={`dash-region-health-${r.region_id}`}
                data-health={r.health ?? "missing"}
              >
                <span className="font-semibold">{name(r.region_id)}</span>
                {r.health ? (
                  <span className={`chip ${REGION_HEALTH_TONE[r.health]}`} data-testid={`dash-region-health-chip-${r.region_id}`}>
                    {t(`weekly.health_${r.health}`)}
                  </span>
                ) : (
                  <span className="chip bg-waitBg text-waitInk" data-testid={`dash-region-health-chip-${r.region_id}`}>
                    {t("weekly.missing_update")}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm">
            <Link className="hover:underline" to="/status-updates" data-testid="dash-region-health-link">
              {t("dash.region_health.open")}
            </Link>
            <span className="text-mute"> · {t("dash.region_health.week", { date: q.data.week_start })}</span>
          </p>
        </>
      )}
    </Card>
  );
}

/** F20: the dashboard blocks of one tab in the order and visibility of the saved settings (a block the layout hides is not rendered). */
function orderBlocks(
  layout: TabLayout | undefined,
  blocks: Record<string, ReactNode>,
): ReactNode[] {
  return orderedVisible(layout, Object.keys(blocks)).map((code) => (
    <Fragment key={code}>{blocks[code]}</Fragment>
  ));
}

type DashStream = NonNullable<Dash["streams"]["items"][number]["counts"]>;
type DelayItem = Dash["delay"]["items"][number];

/** A delay row in words: the period's party (or its named external party); unattributed days with their suggested party (Q7) or a data gap (Q181). */
function delayName(t: TFunction, r: DelayItem): string {
  if (r.kind === "unattributed") {
    if (r.data_gap) return t("dash.delay.data_gap");
    const sug = r.suggested_party;
    if (!sug) return t("dash.delay.unattributed");
    const name =
      sug.kind === "default_type"
        ? t(`dash.delay.type.${sug.name}`, { defaultValue: sug.name })
        : sug.name;
    return `${t("dash.delay.unattributed")} (${t("dash.delay.suggested", { name })})`;
  }
  if (r.kind === "unassigned") return t("dash.delay.unassigned");
  if (r.kind === "default_type")
    return t(`dash.delay.type.${r.party}`, { defaultValue: r.party });
  if (r.kind === "period" && !r.external_party_id && r.period_party)
    return t(`dash.delay.period.${r.period_party}`, { defaultValue: r.party });
  return r.party;
}
