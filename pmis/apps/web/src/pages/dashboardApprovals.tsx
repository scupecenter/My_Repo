import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { DashboardOps } from "@/api/dashboard";
import { Card } from "./dashboardBits";
import { AgingRow } from "./dashboardOps";

type Ops = DashboardOps | undefined;
type Approvals = NonNullable<NonNullable<Ops>["approvals"]>;

/**
 * Item 7 (contract 0.15.204; owner approval 2026-11-26, dashboard proposals): the pending approvals bottleneck. The
 * tasks waiting for review or approval (the population of the Approvals inbox), aged since the level opened, split
 * review against approve and grouped by the ball-in-court role. Read only. Answers unavailable without the approvals
 * and sites view rights.
 */
export function OpsApprovalsCard({ ops }: { ops: Ops }) {
  const { t, i18n } = useTranslation();
  if (!ops)
    return (
      <p className="text-mute" role="status" data-testid="dash-approvals-loading">
        {t("common.loading")}
      </p>
    );
  const a: Approvals = ops.approvals;
  return (
    <Card
      title={t("dash.ops.approvals_title")}
      testid="dash-ops-approvals"
      className="print:break-inside-avoid"
      aside={
        <Link to="/approvals" className="text-sm text-accent underline">
          {t("dash.ops.open_approvals")}
        </Link>
      }
    >
      <p className="mb-3 text-sm text-mute">{t("dash.ops.approvals_hint")}</p>
      {!a.available ? (
        <p className="text-mute" data-testid="dash-approvals-unavailable">
          {t("dash.ops.unavailable_approvals")}
        </p>
      ) : (
        <div data-testid="dash-approvals">
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            <span className="chip border border-line" data-testid="dash-approvals-total">
              {t("dash.ops.approvals_total")}{" "}
              <b className={`ms-1 tnum ${(a.total ?? 0) > 0 ? "text-waitInk" : ""}`}>{a.total ?? 0}</b>
            </span>
            <span className="chip border border-line" data-testid="dash-approvals-review">
              {t("dash.ops.approvals_review")} <b className="ms-1 tnum">{a.review ?? 0}</b>
            </span>
            <span className="chip border border-line" data-testid="dash-approvals-approve">
              {t("dash.ops.approvals_approve")} <b className="ms-1 tnum">{a.approve ?? 0}</b>
            </span>
            {(a.unassigned ?? 0) > 0 && (
              <span className="chip border border-line" data-testid="dash-approvals-unassigned">
                {t("dash.ops.approvals_unassigned")}{" "}
                <b className="ms-1 tnum">{a.unassigned}</b>
              </span>
            )}
          </div>
          {a.waiting && (
            <div className="mb-3">
              <AgingRow
                label={t("dash.ops.approvals_total")}
                aging={a.waiting}
                testid="dash-approvals-waiting"
              />
            </div>
          )}
          <ul className="space-y-3" data-testid="dash-approvals-roles">
            {(a.by_role ?? []).map((r) => (
              <li key={r.role_id} data-testid={`dash-approvals-role-${r.role_id}`}>
                <AgingRow
                  label={i18n.language === "ar" && r.name_ar ? r.name_ar : r.name_en}
                  aging={{ buckets: r.buckets, total: r.count, oldest_days: r.oldest_days }}
                  testid={`dash-approvals-aging-${r.role_id}`}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
