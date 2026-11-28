import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { DashboardOps } from "@/api/dashboard";
import { Card } from "./dashboardBits";

type Ops = DashboardOps | undefined;
type Scorecard = NonNullable<NonNullable<Ops>["contractor_scorecard"]>;
type Level = "ok" | "amber" | "red" | "insufficient";

const TONE: Record<Level, string> = {
  ok: "bg-card2",
  amber: "bg-lateBg text-lateInk",
  red: "bg-lateBg text-lateInk font-bold",
  insufficient: "bg-card2 text-mute",
};

const pctText = (p: number | null | undefined) =>
  p === null || p === undefined ? "—" : `${p}%`;

/**
 * Item 5 (contract 0.15.202; owner approval 2026-11-26, dashboard proposals): the contractor and supplier scorecard.
 * The aggregate of the contractor performance report, so this card and that screen never disagree: the parties per
 * level, the on-time rectification rate of snags, the average delay and the rejection (quality fail / NCR) rate, and
 * the five worst parties. No amounts anywhere. Answers unavailable without the contractors view right.
 */
export function OpsScorecardCard({ ops }: { ops: Ops }) {
  const { t } = useTranslation();
  if (!ops)
    return (
      <p className="text-mute" role="status" data-testid="dash-scorecard-loading">
        {t("common.loading")}
      </p>
    );
  const s: Scorecard = ops.contractor_scorecard;
  return (
    <Card
      title={t("dash.ops.scorecard_title")}
      testid="dash-ops-scorecard"
      className="xl:col-span-2 print:break-inside-avoid"
      aside={
        <Link to="/reports/contractors" className="text-sm text-accent underline">
          {t("dash.ops.open_performance")}
        </Link>
      }
    >
      <p className="mb-3 text-sm text-mute">{t("dash.ops.scorecard_hint")}</p>
      {!s.available ? (
        <p className="text-mute" data-testid="dash-scorecard-unavailable">
          {t("dash.ops.unavailable_scorecard")}
        </p>
      ) : (
        <div data-testid="dash-scorecard">
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            <span className="chip border border-line" data-testid="dash-scorecard-parties">
              {t("dash.ops.scorecard_parties")} <b className="ms-1 tnum">{s.parties ?? 0}</b>
            </span>
            {(["ok", "amber", "red", "insufficient"] as Level[]).map((lv) => (
              <span
                key={lv}
                className={`chip ${TONE[lv]}`}
                data-testid={`dash-scorecard-level-${lv}`}
                data-level={lv}
              >
                {t(`dash.ops.scorecard_level_${lv}`)}{" "}
                <b className="ms-1 tnum">{s.by_level?.[lv] ?? 0}</b>
              </span>
            ))}
            <span className="chip border border-line" data-testid="dash-scorecard-on-time">
              {t("dash.ops.scorecard_on_time")}{" "}
              <b className="ms-1 tnum">{pctText(s.on_time_pct)}</b>
            </span>
            <span className="chip border border-line" data-testid="dash-scorecard-avg-delay">
              {t("dash.ops.scorecard_avg_delay")}{" "}
              <b className="ms-1 tnum">
                {s.avg_delay_days ?? "—"} {s.avg_delay_days !== null ? t("dash.ops.days") : ""}
              </b>
            </span>
            <span className="chip border border-line" data-testid="dash-scorecard-late-days" title={t("dash.ops.scorecard_late_days_hint")}>
              {t("dash.ops.scorecard_late_days")}{" "}
              <b className="ms-1 tnum">{s.late_days_total} {t("dash.ops.days")}</b>
            </span>
            <span className="chip border border-line" data-testid="dash-scorecard-quality">
              {t("dash.ops.scorecard_rejection")}{" "}
              <b
                className={`ms-1 tnum ${
                  (s.quality?.failed ?? 0) > 0 ? "text-lateInk" : ""
                }`}
              >
                {pctText(s.quality_fail_pct)}
              </b>
              <span className="ms-1 text-xs text-mute">
                {s.quality?.failed ?? 0} / {s.quality?.total ?? 0}
              </span>
            </span>
            <span className="chip border border-line" data-testid="dash-scorecard-snags">
              {t("dash.ops.scorecard_snags")}{" "}
              <b
                className={`ms-1 tnum ${
                  (s.snags?.overdue ?? 0) > 0 ? "text-lateInk" : ""
                }`}
              >
                {s.snags?.overdue ?? 0}
              </b>
              <span className="ms-1 text-xs text-mute">
                {t("dash.ops.scorecard_snags_note", {
                  open: s.snags?.open ?? 0,
                  total: s.snags?.total ?? 0,
                  returned: s.snags?.returned ?? 0,
                })}
              </span>
            </span>
          </div>
          {s.worst && s.worst.length > 0 && (
            <table className="w-full text-sm" data-testid="dash-scorecard-worst">
              <thead className="text-mute">
                <tr>
                  <th className="p-1 text-start">{t("dash.ops.scorecard_col_party")}</th>
                  <th className="p-1 text-start">{t("dash.ops.scorecard_col_type")}</th>
                  <th className="p-1 text-start">{t("dash.ops.scorecard_col_level")}</th>
                  <th className="p-1 text-start">{t("dash.ops.scorecard_col_delay")}</th>
                  <th className="p-1 text-start">{t("dash.ops.scorecard_col_snags")}</th>
                  <th className="p-1 text-start">{t("dash.ops.scorecard_col_quality")}</th>
                </tr>
              </thead>
              <tbody>
                {s.worst.map((w) => (
                  <tr key={w.party_id} className="border-t border-line">
                    <td className="p-1" data-testid={`dash-scorecard-worst-${w.name}`}>
                      {w.name}
                    </td>
                    <td className="p-1">{w.type}</td>
                    <td className="p-1">
                      <span className={`chip ${TONE[w.level]}`} data-level={w.level}>
                        {t(`dash.ops.scorecard_level_${w.level}`)}
                      </span>
                    </td>
                    <td className="p-1 tnum">{w.delay_days}</td>
                    <td className="p-1 tnum">{w.snags_overdue}</td>
                    <td className="p-1 tnum">{w.quality_failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Card>
  );
}
