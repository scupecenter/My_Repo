import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { DashboardOps } from "@/api/dashboard";
import { Card } from "./dashboardBits";
import { AgingRow } from "./dashboardOps";

type Ops = DashboardOps | undefined;
type Changes = NonNullable<Ops>["changes_meetings"];

/**
 * Item 8 (contract 0.15.205; owner approval 2026-11-26, dashboard proposals): the change requests still pending and the
 * meeting actions past their due date. Read only. Each part answers unavailable without its own module view right.
 */
export function OpsChangesCard({ ops }: { ops: Ops }) {
  const { t } = useTranslation();
  if (!ops)
    return (
      <p className="text-mute" role="status" data-testid="dash-changes-loading">
        {t("common.loading")}
      </p>
    );
  const c: Changes = ops.changes_meetings;
  return (
    <Card
      title={t("dash.ops.changes_title")}
      testid="dash-ops-changes"
      className="print:break-inside-avoid"
      aside={
        <span className="flex gap-3 text-sm">
          {c.changes.available && (
            <Link to="/registers/change_control" className="text-accent underline">
              {t("dash.ops.open_changes")}
            </Link>
          )}
          {c.actions.available && (
            <Link to="/registers/meetings" className="text-accent underline">
              {t("dash.ops.open_meetings")}
            </Link>
          )}
        </span>
      }
    >
      <p className="mb-3 text-sm text-mute">{t("dash.ops.changes_hint")}</p>
      <div className="grid gap-6 md:grid-cols-2">
        <section aria-label={t("dash.ops.changes_part")} data-testid="dash-changes-part">
          <h4 className="mb-2 text-sm font-semibold">{t("dash.ops.changes_part")}</h4>
          {!c.changes.available ? (
            <p className="text-mute" data-testid="dash-changes-unavailable">
              {t("dash.ops.unavailable_changes")}
            </p>
          ) : (
            <div>
              <div className="mb-3 flex flex-wrap gap-2 text-sm">
                <span className="chip border border-line" data-testid="dash-changes-pending">
                  {t("dash.ops.changes_pending")}{" "}
                  <b className={`ms-1 tnum ${(c.changes.pending ?? 0) > 0 ? "text-waitInk" : ""}`}>{c.changes.pending ?? 0}</b>
                </span>
                <span className="chip border border-line" data-testid="dash-changes-approved">
                  {t("dash.ops.changes_approved")} <b className="ms-1 tnum">{c.changes.approved_not_applied ?? 0}</b>
                </span>
              </div>
              {c.changes.pending_aging && (
                <div className="mb-3">
                  <AgingRow label={t("dash.ops.changes_pending")} aging={c.changes.pending_aging} testid="dash-changes-aging" />
                </div>
              )}
              <ul className="flex flex-wrap gap-2 text-sm" data-testid="dash-changes-kinds">
                {(c.changes.by_kind ?? []).map((k) => (
                  <li key={k.kind} className="chip border border-line" data-testid={`dash-changes-kind-${k.kind}`}>
                    {t(`dash.ops.kind_${k.kind}`)} <b className="ms-1 tnum">{k.count}</b>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
        <section aria-label={t("dash.ops.actions_part")} data-testid="dash-actions-part">
          <h4 className="mb-2 text-sm font-semibold">{t("dash.ops.actions_part")}</h4>
          {!c.actions.available ? (
            <p className="text-mute" data-testid="dash-actions-unavailable">
              {t("dash.ops.unavailable_actions")}
            </p>
          ) : (
            <div>
              <div className="mb-3 flex flex-wrap gap-2 text-sm">
                <span className="chip border border-line" data-testid="dash-actions-open">
                  {t("dash.ops.actions_open")} <b className="ms-1 tnum">{c.actions.open ?? 0}</b>
                </span>
                <span className="chip border border-line" data-testid="dash-actions-overdue">
                  {t("dash.ops.actions_overdue")}{" "}
                  <b className={`ms-1 tnum ${(c.actions.overdue ?? 0) > 0 ? "text-waitInk" : ""}`}>{c.actions.overdue ?? 0}</b>
                </span>
                {(c.actions.no_due_date ?? 0) > 0 && (
                  <span className="chip border border-line" data-testid="dash-actions-nodue">
                    {t("dash.ops.actions_no_due")} <b className="ms-1 tnum">{c.actions.no_due_date}</b>
                  </span>
                )}
              </div>
              {c.actions.overdue_aging && (
                <AgingRow label={t("dash.ops.actions_overdue")} aging={c.actions.overdue_aging} testid="dash-actions-aging" />
              )}
            </div>
          )}
        </section>
      </div>
    </Card>
  );
}
