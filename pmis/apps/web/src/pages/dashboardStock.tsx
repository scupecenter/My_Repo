import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useDashboardWarehouseStock } from "@/api/dashboard";
import { useRegions } from "@/api/sites";
import { ApiError } from "@/api/client";
import { tripoliToday } from "@/lib/today";
import { Card, num } from "./dashboardBits";

const PERIODS = [7, 30, 90] as const;
const addDays = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Warehouse stock (contract 0.15.593): per item group what was received, issued and returned in the period, and what is on hand and available today.
 * The numbers are the posted movements of Warehouse; on hand and available are the figures of Warehouse > Stock. Read only. A caller without warehouse
 * rights sees nothing (the card hides itself).
 */
export function WarehouseStockCard() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === "ar";
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const [open, setOpen] = useState<string | null>(null);
  const to = tripoliToday();
  const from = addDays(to, -(days - 1));
  const q = useDashboardWarehouseStock(from, to);
  const regions = useRegions();
  if (q.error instanceof ApiError && q.error.status === 403) return null;
  const regionName = (id: number) => {
    const r = regions.data?.find((x) => x.id === id);
    return (ar && r?.name_ar ? r.name_ar : r?.name_en) ?? `#${id}`;
  };
  return (
    <Card title={t("dash.stock.title")} testid="dash-stock" className="print:break-inside-avoid">
      <p className="mb-3 text-sm text-mute">{t("dash.stock.hint")}</p>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-mute" title={t("dash.stock.period_hint")}>{t("dash.stock.period")}</span>
        {PERIODS.map((d) => (
          <button key={d} type="button" className={`btn ${days === d ? "btn-primary" : ""}`} aria-pressed={days === d} data-testid={`dash-stock-period-${d}`} onClick={() => setDays(d)}>
            {t("dash.stock.days", { n: d })}
          </button>
        ))}
        <Link to="/warehouse?tab=stock" className="btn ms-auto" data-testid="dash-stock-link" title={t("dash.stock.open_hint")}>
          {t("dash.stock.open")}
        </Link>
      </div>
      {!q.data ? (
        <p className="text-mute" role="status" data-testid="dash-stock-loading">{q.isError ? t("dash.stock.error") : t("common.loading")}</p>
      ) : q.data.groups.length === 0 ? (
        <p className="text-mute" data-testid="dash-stock-empty">{t("dash.stock.empty")}</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2 text-sm" data-testid="dash-stock-totals">
            {(["received", "issued", "returned", "on_hand", "available"] as const).map((k) => (
              <span key={k} className="chip border border-line" title={t(`dash.stock.hint_${k}`)} data-testid={`dash-stock-total-${k}`}>
                {t(`dash.stock.col_${k}`)} <b className="ms-1 tnum">{num(q.data.totals[k])}</b>
              </span>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="dash-stock-table">
              <thead>
                <tr className="text-xs text-mute">
                  <th className="py-1 pe-2 text-start font-medium">{t("dash.stock.col_group")}</th>
                  {(["received", "issued", "returned", "on_hand", "available"] as const).map((k) => (
                    <th key={k} className="px-2 text-end font-medium" title={t(`dash.stock.hint_${k}`)}>{t(`dash.stock.col_${k}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {q.data.groups.map((g, i) => (
                  <Fragment key={g.group}>
                    <tr className="cursor-pointer border-t border-line" data-testid={`dash-stock-row-${i}`} onClick={() => setOpen(open === g.group ? null : g.group)}>
                      <td className="py-1 pe-2">
                        {g.group}
                        {g.mixed_units && <span className="ms-1 text-xs text-mute" title={t("dash.stock.mixed_hint")} data-testid={`dash-stock-mixed-${i}`}>({t("dash.stock.mixed")})</span>}
                      </td>
                      <td className="px-2 text-end tnum">{num(g.received)}</td>
                      <td className="px-2 text-end tnum">{num(g.issued)}</td>
                      <td className="px-2 text-end tnum">{num(g.returned)}</td>
                      <td className="px-2 text-end tnum">{num(g.on_hand)}</td>
                      <td className="px-2 text-end tnum">{num(g.available)}</td>
                    </tr>
                    {open === g.group && (
                      <tr data-testid={`dash-stock-regions-${i}`}>
                        <td colSpan={6} className="pb-2 ps-4 text-xs text-mute">
                          {g.by_region.length === 0
                            ? t("dash.stock.no_regions")
                            : g.by_region.map((r) => `${regionName(r.region_id)}: ${t("dash.stock.col_issued")} ${num(r.issued)}, ${t("dash.stock.col_returned")} ${num(r.returned)}`).join(" · ")}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-mute" data-testid="dash-stock-basis">{t("dash.stock.basis", { from: q.data.from, to: q.data.to })}</p>
        </>
      )}
    </Card>
  );
}
