import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { DashboardOps } from "@/api/dashboard";
import { Card } from "./dashboardBits";
import { AgingRow } from "./dashboardOps";

type Ops = DashboardOps | undefined;

function Loading({ id }: { id: string }) {
  const { t } = useTranslation();
  return (
    <p className="text-mute" role="status" data-testid={id}>
      {t("common.loading")}
    </p>
  );
}

/** L4 (contract 0.15.563): the open invoices, their ages, due dates and the overdue. Read only, counts and ages, no amounts. */
export function OpsInvoicesCard({ ops }: { ops: Ops }) {
  const { t } = useTranslation();
  if (!ops) return <Loading id="dash-invoices-loading" />;
  const c = ops.invoices_due;
  return (
    <Card
      title={t("dash.ops.inv_title")}
      testid="dash-ops-invoices"
      className="print:break-inside-avoid"
      aside={
        c.available && (
          <Link to="/registers/invoices" className="text-sm text-accent underline">
            {t("dash.ops.open_invoices")}
          </Link>
        )
      }
    >
      {!c.available ? (
        <p className="text-mute" data-testid="dash-invoices-unavailable">
          {t("dash.ops.unavailable_invoices")}
        </p>
      ) : (
        <div>
          <p className="mb-3 text-sm text-mute">{t("dash.ops.inv_hint")}</p>
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            <span className="chip border border-line" data-testid="dash-invoices-open">
              {t("dash.ops.inv_open")} <b className="ms-1 tnum">{c.open ?? 0}</b>
            </span>
            <span className="chip border border-line" data-testid="dash-invoices-overdue">
              {t("dash.ops.inv_overdue")} <b className={`ms-1 tnum ${(c.overdue ?? 0) > 0 ? "text-waitInk" : ""}`}>{c.overdue ?? 0}</b>
            </span>
            <span className="chip border border-line" data-testid="dash-invoices-soon">
              {t("dash.ops.inv_soon")} <b className="ms-1 tnum">{c.due_soon ?? 0}</b>
            </span>
            {(c.no_due_date ?? 0) > 0 && (
              <span className="chip border border-line" data-testid="dash-invoices-nodue">
                {t("dash.ops.inv_nodue")} <b className="ms-1 tnum">{c.no_due_date}</b>
              </span>
            )}
          </div>
          {c.overdue_aging && <AgingRow label={t("dash.ops.inv_overdue")} aging={c.overdue_aging} testid="dash-invoices-overdue-aging" />}
          {c.age_aging && (
            <div className="mt-3">
              <AgingRow label={t("dash.ops.inv_age")} aging={c.age_aging} testid="dash-invoices-age-aging" />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** L4: the warehouse movements still in entry, review or approval. */
export function OpsWarehouseCard({ ops }: { ops: Ops }) {
  const { t } = useTranslation();
  if (!ops) return <Loading id="dash-warehouse-loading" />;
  const c = ops.warehouse_pending;
  return (
    <Card
      title={t("dash.ops.wh_title")}
      testid="dash-ops-warehouse"
      className="print:break-inside-avoid"
      aside={
        c.available && (
          <Link to="/warehouse" className="text-sm text-accent underline">
            {t("dash.ops.open_warehouse")}
          </Link>
        )
      }
    >
      {!c.available ? (
        <p className="text-mute" data-testid="dash-warehouse-unavailable">
          {t("dash.ops.unavailable_warehouse")}
        </p>
      ) : (
        <div>
          <p className="mb-3 text-sm text-mute">{t("dash.ops.wh_hint")}</p>
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            <span className="chip border border-line" data-testid="dash-warehouse-pending">
              {t("dash.ops.wh_pending")} <b className={`ms-1 tnum ${(c.pending ?? 0) > 0 ? "text-waitInk" : ""}`}>{c.pending ?? 0}</b>
            </span>
            {(c.by_state ?? []).map((s) => (
              <span key={s.state} className="chip border border-line" data-testid={`dash-warehouse-state-${s.state}`}>
                {t(`dash.ops.wh_state_${s.state}`)} <b className="ms-1 tnum">{s.count}</b>
              </span>
            ))}
          </div>
          {c.aging && <AgingRow label={t("dash.ops.wh_pending")} aging={c.aging} testid="dash-warehouse-aging" />}
        </div>
      )}
    </Card>
  );
}

/** L4: the open risks and issues that have not changed for a month or more. Each part answers only with its own view right. */
export function OpsStaleCard({ ops }: { ops: Ops }) {
  const { t } = useTranslation();
  if (!ops) return <Loading id="dash-stale-loading" />;
  const c = ops.stale_open;
  return (
    <Card
      title={t("dash.ops.stale_title")}
      testid="dash-ops-stale"
      className="print:break-inside-avoid"
      aside={
        <span className="flex gap-3 text-sm">
          {c.risks && (
            <Link to="/registers/risks" className="text-accent underline">
              {t("dash.ops.open_risks")}
            </Link>
          )}
          {c.issues && (
            <Link to="/registers/issues" className="text-accent underline">
              {t("dash.ops.open_issues")}
            </Link>
          )}
        </span>
      }
    >
      {!c.available ? (
        <p className="text-mute" data-testid="dash-stale-unavailable">
          {t("dash.ops.unavailable_risks")}
        </p>
      ) : (
        <div>
          <p className="mb-3 text-sm text-mute">{t("dash.ops.stale_hint", { days: c.stale_days ?? 30 })}</p>
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            {(["risks", "issues"] as const).map((k) =>
              c[k] ? (
                <span key={k} className="chip border border-line" data-testid={`dash-stale-${k}`}>
                  {t(`dash.ops.stale_${k}`)}{" "}
                  <b className={`ms-1 tnum ${c[k]!.stale > 0 ? "text-waitInk" : ""}`}>{t("dash.ops.stale_of", { stale: c[k]!.stale, open: c[k]!.open })}</b>
                </span>
              ) : (
                <span key={k} className="text-mute" data-testid={`dash-stale-${k}-unavailable`}>
                  {t(`dash.ops.unavailable_${k}`)}
                </span>
              ),
            )}
          </div>
          {c.idle_aging && <AgingRow label={t("dash.ops.stale_idle")} aging={c.idle_aging} testid="dash-stale-aging" />}
        </div>
      )}
    </Card>
  );
}
