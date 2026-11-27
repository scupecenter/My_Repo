import { useTranslation } from "react-i18next";
import type { DashboardOps } from "@/api/dashboard";
import { Bar, Card, pct } from "./dashboardBits";

type Ops = DashboardOps | undefined;

/**
 * Phase scope (contract 0.15.367; approved by Ahmed 2026-11-27): the registered, not cancelled sites per project phase, how many are on air, and the
 * target derived from the scope (all its sites; the monthly On-Air target from the planned dates). Read only; nothing here is typed by anyone.
 */
export function OpsPhaseCard({ ops }: { ops: Ops }) {
  const { t } = useTranslation();
  if (!ops)
    return (
      <p className="text-mute" role="status" data-testid="dash-phase-loading">
        {t("common.loading")}
      </p>
    );
  const p = ops.phase_scope;
  const label = (phase: string | null) => phase ?? t("dash.phase.none");
  return (
    <Card title={t("dash.phase.title")} testid="dash-ops-phase" className="print:break-inside-avoid">
      <p className="mb-3 text-sm text-mute">{t("dash.phase.hint")}</p>
      {!p.available || !p.total || !p.phases ? (
        <p className="text-mute" data-testid="dash-phase-unavailable">{t("dash.phase.unavailable")}</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            <span className="chip border border-line" data-testid="dash-phase-total" title={t("dash.phase.total_hint")}>
              {t("dash.phase.total")} <b className="ms-1 tnum">{p.total.sites}</b>
            </span>
            <span className="chip border border-line" data-testid="dash-phase-onair" title={t("dash.phase.onair_hint")}>
              {t("dash.phase.on_air")} <b className="ms-1 tnum">{p.total.on_air}</b> ({pct(p.total.progress_pct)})
            </span>
            <span className="chip border border-line" data-testid="dash-phase-monthly" title={t("dash.phase.monthly_hint")}>
              {t("dash.phase.monthly")}{" "}
              <b className="ms-1 tnum">{p.monthly_on_air_auto?.value ?? t("dash.phase.no_target")}</b>
              {p.monthly_on_air_auto?.planned_end && (
                <span className="ms-1 text-xs text-mute">
                  {t("dash.phase.monthly_basis", { n: p.monthly_on_air_auto.remaining, m: p.monthly_on_air_auto.months_left, d: p.monthly_on_air_auto.planned_end })}
                </span>
              )}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="dash-phase-table">
              <thead>
                <tr className="text-xs text-mute">
                  <th className="py-1 pe-2 text-start font-medium">{t("dash.phase.col_phase")}</th>
                  <th className="px-2 text-end font-medium" title={t("dash.phase.total_hint")}>{t("dash.phase.col_sites")}</th>
                  <th className="px-2 text-end font-medium" title={t("dash.phase.onair_hint")}>{t("dash.phase.col_on_air")}</th>
                  <th className="px-2 text-end font-medium">{t("dash.phase.col_progress")}</th>
                  <th className="ps-2 text-end font-medium" title={t("dash.phase.target_hint")}>{t("dash.phase.col_target")}</th>
                </tr>
              </thead>
              <tbody>
                {p.phases.map((r, i) => (
                  <tr key={r.phase ?? "none"} className="border-t border-line" data-testid={`dash-phase-row-${i}`}>
                    <td className="py-1 pe-2 font-semibold">{label(r.phase)}</td>
                    <td className="px-2 text-end tnum">{r.sites}</td>
                    <td className="px-2 text-end tnum">{r.on_air}</td>
                    <td className="w-40 px-2">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1"><Bar value={r.progress_pct ?? 0} tone="bg-open" /></span>
                        <b className="tnum w-14 text-end">{pct(r.progress_pct)}</b>
                      </div>
                    </td>
                    <td className="ps-2 text-end tnum">{r.target_sites}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
