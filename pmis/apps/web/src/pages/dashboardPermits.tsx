import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { DashboardOps } from "@/api/dashboard";
import { Bar, Card } from "./dashboardBits";

type Ops = DashboardOps | undefined;
type Permits = NonNullable<NonNullable<Ops>["permits_hse"]>;

/**
 * Item 3 (contract 0.15.200; owner approval 2026-11-26, dashboard proposals): permits and HSE. The status mix, the
 * permits waiting for approval, the validity pressure (expiring within 30 days, expired), the open stop-work orders
 * and the safety-check gaps of the open PTWs. Read only; links to the Permits and HSE register. The incident side of
 * item 3 lands with the Incidents register. Ordered and hidden per tab from Settings > Dashboard, like every card.
 */
export function OpsPermitsCard({ ops }: { ops: Ops }) {
  const { t } = useTranslation();
  if (!ops)
    return (
      <p className="text-mute" role="status" data-testid="dash-permits-loading">
        {t("common.loading")}
      </p>
    );
  const p: Permits = ops.permits_hse;
  if (!p.available) {
    return (
      <Card
        title={t("dash.ops.permits_title")}
        testid="dash-ops-permits"
        className="print:break-inside-avoid"
      >
        <p className="text-mute" data-testid="dash-permits-unavailable">
          {t("dash.ops.unavailable_permits")}
        </p>
      </Card>
    );
  }
  const status = p.by_status ?? [];
  const maxStatus = Math.max(1, ...status.map((r) => r.count));
  const ptw = p.ptw;
  const gaps = ptw?.gaps ?? [];
  const maxGap = Math.max(1, ...gaps.map((g) => g.count));
  return (
    <Card
      title={t("dash.ops.permits_title")}
      testid="dash-ops-permits"
      className="print:break-inside-avoid"
      aside={
        <Link to="/registers/permits_hse" className="text-sm text-accent underline">
          {t("dash.ops.open_register")}
        </Link>
      }
    >
      <p className="mb-3 text-sm text-mute">{t("dash.ops.permits_hint")}</p>
      <div className="mb-3 flex flex-wrap gap-2 text-sm">
        <span className="chip border border-line" data-testid="dash-permits-waiting">
          {t("dash.ops.waiting")} <b className="ms-1 tnum">{p.waiting ?? 0}</b>
        </span>
        <span className="chip border border-line" data-testid="dash-permits-no-permit">
          {t("dash.ops.no_permit")}{" "}
          <b className={`ms-1 tnum ${(p.sites_without_permit ?? 0) > 0 ? "text-waitInk" : ""}`}>
            {p.sites_without_permit ?? 0}
          </b>
        </span>
        <span className="chip border border-line" data-testid="dash-permits-expiring">
          {t("dash.ops.expiring_14")}{" "}
          <b className={`ms-1 tnum ${(p.expiring_14 ?? 0) > 0 ? "text-waitInk" : ""}`}>
            {p.expiring_14 ?? 0}
          </b>
        </span>
        <span className="chip border border-line" data-testid="dash-permits-expired">
          {t("dash.ops.expired")}{" "}
          <b className={`ms-1 tnum ${(p.expired ?? 0) > 0 ? "text-lateInk" : ""}`}>
            {p.expired ?? 0}
          </b>
        </span>
        <span className="chip border border-line" data-testid="dash-permits-stop-work">
          {t("dash.ops.stop_work_active")}{" "}
          <b className={`ms-1 tnum ${(p.stop_work_active ?? 0) > 0 ? "text-lateInk" : ""}`}>
            {p.stop_work_active ?? 0}
          </b>
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold">{t("dash.ops.by_status")}</h3>
          {status.length === 0 ? (
            <p className="text-sm text-mute" data-testid="dash-permits-empty">
              {t("dash.ops.permits_empty")}
            </p>
          ) : (
            <ul className="space-y-1" data-testid="dash-permits-status-list">
              {status.map((r) => (
                <li
                  key={r.status}
                  className="flex items-center gap-2 text-sm"
                  data-testid={`dash-permits-status-${r.status}`}
                >
                  <span className="w-24 shrink-0 truncate text-xs text-mute">
                    {r.status}
                  </span>
                  <span className="flex-1">
                    <Bar value={(r.count / maxStatus) * 100} />
                  </span>
                  <span className="w-8 text-end tnum">{r.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold">{t("dash.ops.ptw_title")}</h3>
          {!ptw || ptw.open === 0 ? (
            <p className="text-sm text-mute" data-testid="dash-permits-ptw-none">
              {t("dash.ops.ptw_none")}
            </p>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap gap-2 text-sm">
                <span className="chip border border-line" data-testid="dash-permits-ptw-open">
                  {t("dash.ops.ptw_open")} <b className="ms-1 tnum">{ptw.open}</b>
                </span>
                <span className="chip border border-line" data-testid="dash-permits-ptw-with-gaps">
                  {t("dash.ops.ptw_with_gaps")}{" "}
                  <b className={`ms-1 tnum ${ptw.with_gaps > 0 ? "text-lateInk" : ""}`}>
                    {ptw.with_gaps}
                  </b>
                </span>
              </div>
              {gaps.length === 0 ? (
                <p className="text-sm text-mute" data-testid="dash-permits-ptw-clear">
                  {t("dash.ops.ptw_clear")}
                </p>
              ) : (
                <ul className="space-y-1" data-testid="dash-permits-gaps">
                  {gaps.map((g) => (
                    <li
                      key={g.key}
                      className="flex items-center gap-2 text-sm"
                      data-testid={`dash-permits-gap-${g.key}`}
                    >
                      <span className="w-24 shrink-0 truncate text-xs text-mute">
                        {t(`dash.ops.ptw_check.${g.key}`)}
                      </span>
                      <span className="flex-1">
                        <Bar value={(g.count / maxGap) * 100} tone="bg-lateInk" />
                      </span>
                      <span className="w-8 text-end tnum">{g.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
