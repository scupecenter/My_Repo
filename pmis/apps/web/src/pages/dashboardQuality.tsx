import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { DashboardOps } from "@/api/dashboard";
import { Card } from "./dashboardBits";

type Ops = DashboardOps | undefined;
type Quality = NonNullable<NonNullable<Ops>["quality"]>;

const pctText = (p: number | null | undefined) =>
  p === null || p === undefined ? "—" : `${p}%`;

/**
 * Item 6 (contract 0.15.203; owner approval 2026-11-26, dashboard proposals): quality, snags and NCR. The open snags
 * and NCRs of the sites in scope, the average closure age of each, and the first-time acceptance rate (Pass over
 * Pass + Fail of the decided inspections). Read only. Answers unavailable without the quality view right.
 */
export function OpsQualityCard({ ops }: { ops: Ops }) {
  const { t } = useTranslation();
  if (!ops)
    return (
      <p className="text-mute" role="status" data-testid="dash-quality-loading">
        {t("common.loading")}
      </p>
    );
  const q: Quality = ops.quality;
  return (
    <Card
      title={t("dash.ops.quality_title")}
      testid="dash-ops-quality"
      className="print:break-inside-avoid"
      aside={
        <Link to="/registers/quality" className="text-sm text-accent underline">
          {t("dash.ops.open_quality")}
        </Link>
      }
    >
      <p className="mb-3 text-sm text-mute">{t("dash.ops.quality_hint")}</p>
      {!q.available ? (
        <p className="text-mute" data-testid="dash-quality-unavailable">
          {t("dash.ops.unavailable_quality")}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2 text-sm" data-testid="dash-quality">
          <span className="chip border border-line" data-testid="dash-quality-snags-open">
            {t("dash.ops.quality_snags_open")}{" "}
            <b className={`ms-1 tnum ${(q.snags?.open ?? 0) > 0 ? "text-waitInk" : ""}`}>
              {q.snags?.open ?? 0}
            </b>
            <span className="ms-1 text-xs text-mute">
              {t("dash.ops.quality_snags_note", {
                closed: q.snags?.closed ?? 0,
                returned: q.snags?.returned_open ?? 0,
              })}
            </span>
          </span>
          <span className="chip border border-line" data-testid="dash-quality-snags-avg">
            {t("dash.ops.quality_avg_close")}{" "}
            <b className="ms-1 tnum">
              {q.snags?.avg_close_days ?? "—"}{" "}
              {q.snags?.avg_close_days !== null && q.snags?.avg_close_days !== undefined
                ? t("dash.ops.days")
                : ""}
            </b>
          </span>
          <span className="chip border border-line" data-testid="dash-quality-ncrs-open">
            {t("dash.ops.quality_ncrs_open")}{" "}
            <b className={`ms-1 tnum ${(q.ncrs?.open ?? 0) > 0 ? "text-lateInk" : ""}`}>
              {q.ncrs?.open ?? 0}
            </b>
            <span className="ms-1 text-xs text-mute">
              {t("dash.ops.quality_ncrs_note", { closed: q.ncrs?.closed ?? 0 })}
            </span>
          </span>
          <span className="chip border border-line" data-testid="dash-quality-ncrs-avg">
            {t("dash.ops.quality_avg_close")}{" "}
            <b className="ms-1 tnum">
              {q.ncrs?.avg_close_days ?? "—"}{" "}
              {q.ncrs?.avg_close_days !== null && q.ncrs?.avg_close_days !== undefined
                ? t("dash.ops.days")
                : ""}
            </b>
          </span>
          <span className="chip border border-line" data-testid="dash-quality-first-pass">
            {t("dash.ops.quality_first_pass")}{" "}
            <b className="ms-1 tnum">{pctText(q.first_pass_pct)}</b>
          </span>
        </div>
      )}
    </Card>
  );
}
