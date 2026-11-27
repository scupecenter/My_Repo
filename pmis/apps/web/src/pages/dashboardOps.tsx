import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { DashboardOps } from "@/api/dashboard";
import { Bar, Card, pct } from "./dashboardBits";

type Ops = DashboardOps | undefined;
type Aging = NonNullable<
  NonNullable<Ops>["procurement"]["pr_wait"]
>;

/**
 * The follow-up sections of the dashboard (contract 0.15.98; owner approval 2026-11-26, dashboard proposals).
 * Read only; each figure links to the register it counts. Card primitives come from dashboardBits (the same design
 * system as the existing cards). Ordered and hidden per tab from Settings > Dashboard, like every other card.
 */

function AgingRow({
  label,
  aging,
  testid,
}: {
  label: string;
  aging: Aging;
  testid: string;
}) {
  const { t } = useTranslation();
  const max = Math.max(1, ...aging.buckets.map((b) => b.count));
  return (
    <div data-testid={testid}>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
        <span className="font-semibold">{label}</span>
        <span className="text-mute tnum">
          {t("dash.ops.aging_total", { n: aging.total })}
          {aging.oldest_days !== null && (
            <> · {t("dash.ops.oldest", { n: aging.oldest_days })}</>
          )}
        </span>
      </div>
      <ul className="space-y-1" data-testid={`${testid}-buckets`}>
        {aging.buckets.map((b) => (
          <li
            key={b.key}
            className="flex items-center gap-2 text-sm"
            data-testid={`${testid}-bucket-${b.key}`}
          >
            <span className="w-20 shrink-0 text-xs text-mute">
              {t(`dash.ops.bucket.${b.key}`)}
            </span>
            <span className="flex-1">
              <span
                className={`block h-2 rounded-full ${b.count > 0 ? (b.key === "over_30" ? "bg-lateInk" : b.key === "d15_30" ? "bg-waitInk" : "bg-accent") : "bg-lockBg"}`}
                style={{ width: `${Math.max(2, (b.count / max) * 100)}%` }}
                aria-hidden
              />
            </span>
            <span className="w-8 text-end tnum">{b.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Item 1: procurement and materials (open PR/PO aging, the receive rate and the shortage per contractor). */
export function OpsProcurementCard({ ops }: { ops: Ops }) {
  const { t } = useTranslation();
  if (!ops)
    return (
      <p className="text-mute" role="status" data-testid="dash-ops-loading">
        {t("common.loading")}
      </p>
    );
  const pr = ops.procurement;
  if (!pr.available) {
    return (
      <Card
        title={t("dash.ops.procurement_title")}
        testid="dash-ops-procurement"
        className="xl:col-span-2 print:break-inside-avoid"
      >
        <p className="text-mute" data-testid="dash-ops-proc-unavailable">
          {t("dash.ops.unavailable_orders")}
        </p>
      </Card>
    );
  }
  const m = pr.materials;
  return (
    <Card
      title={t("dash.ops.procurement_title")}
      testid="dash-ops-procurement"
      className="xl:col-span-2 print:break-inside-avoid"
      aside={
        <Link to="/registers/procurement" className="text-sm text-accent underline">
          {t("dash.ops.open_register")}
        </Link>
      }
    >
      <p className="mb-3 text-sm text-mute">{t("dash.ops.procurement_hint")}</p>
      <div className="mb-3 flex flex-wrap gap-2 text-sm">
        <span className="chip border border-line" data-testid="dash-ops-open-orders">
          {t("dash.ops.open_orders")} <b className="ms-1 tnum">{pr.open_total ?? 0}</b>
        </span>
        <span className="chip border border-line" data-testid="dash-ops-pr-waiting">
          {t("dash.ops.pr_wait")} <b className="ms-1 tnum">{pr.pr_wait?.total ?? 0}</b>
        </span>
        <span className="chip border border-line" data-testid="dash-ops-po-waiting">
          {t("dash.ops.po_wait")} <b className="ms-1 tnum">{pr.po_wait?.total ?? 0}</b>
        </span>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {pr.pr_wait && (
          <AgingRow
            label={t("dash.ops.pr_wait")}
            aging={pr.pr_wait}
            testid="dash-ops-pr-aging"
          />
        )}
        {pr.po_wait && (
          <AgingRow
            label={t("dash.ops.po_wait")}
            aging={pr.po_wait}
            testid="dash-ops-po-aging"
          />
        )}
      </div>

      <h3 className="mt-4 mb-2 text-sm font-semibold">
        {t("dash.ops.materials_title")}
      </h3>
      {!m.available ? (
        <p className="text-mute" data-testid="dash-ops-materials-unavailable">
          {t("dash.ops.unavailable_materials")}
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
            <span
              className="flex min-w-40 flex-1 items-center gap-2"
              data-testid="dash-ops-receive"
            >
              <span className="flex-1">
                <Bar value={m.receive_pct ?? 0} />
              </span>
              <span className="tnum font-semibold">{pct(m.receive_pct)}</span>
              <span className="text-mute">{t("dash.ops.receive_rate")}</span>
            </span>
            <span className="chip border border-line" data-testid="dash-ops-sites-short">
              {t("dash.ops.sites_short")}{" "}
              <b className={`ms-1 tnum ${(m.sites_short ?? 0) > 0 ? "text-lateInk" : ""}`}>
                {m.sites_short ?? 0}
              </b>
            </span>
          </div>
          {(m.top_shortages ?? []).length === 0 ? (
            <p className="text-sm text-mute" data-testid="dash-ops-no-shortage">
              {t("dash.ops.no_shortage")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table
                className="w-full text-sm"
                data-testid="dash-ops-shortages"
              >
                <caption className="sr-only">
                  {t("dash.ops.top_shortages")}
                </caption>
                <thead>
                  <tr className="text-start text-mute">
                    <th scope="col" className="text-start font-normal">
                      {t("dash.ops.col_site")}
                    </th>
                    <th scope="col" className="text-start font-normal">
                      {t("dash.ops.col_item")}
                    </th>
                    <th scope="col" className="text-end font-normal">
                      {t("dash.ops.col_missing")}
                    </th>
                    <th scope="col" className="text-start font-normal">
                      {t("dash.ops.col_contractor")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(m.top_shortages ?? []).map((r) => (
                    <tr
                      key={`${r.site_id}-${r.item_code}`}
                      className="border-t border-line"
                      data-testid={`dash-ops-short-${r.site_code}-${r.item_code}`}
                    >
                      <td className="py-1 pe-2">
                        <Link
                          className="mono font-bold hover:underline"
                          to={`/sites/${r.site_id}`}
                        >
                          {r.site_code}
                        </Link>
                      </td>
                      <td className="py-1 pe-2">
                        {r.item_code} · {r.item_name}
                      </td>
                      <td className="py-1 pe-2 text-end tnum text-lateInk">
                        {r.missing}
                      </td>
                      <td className="py-1">
                        {r.contractor ?? t("dash.ops.unattributed")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(m.by_contractor ?? []).length > 0 && (
            <>
              <h4 className="mt-3 mb-1 text-sm font-semibold">
                {t("dash.ops.by_contractor")}
              </h4>
              <ul
                className="grid gap-1 text-sm md:grid-cols-2"
                data-testid="dash-ops-by-contractor"
              >
                {(m.by_contractor ?? []).map((c) => (
                  <li
                    key={c.party_id ?? "none"}
                    className="flex items-center justify-between gap-2 rounded-md border border-line p-2"
                    data-testid={`dash-ops-contractor-${c.party_id ?? "none"}`}
                  >
                    <span>{c.name || t("dash.ops.unattributed")}</span>
                    <span className="text-mute tnum">
                      {t("dash.ops.contractor_row", {
                        qty: c.missing_qty,
                        lines: c.missing_lines,
                        sites: c.sites,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Card>
  );
}
