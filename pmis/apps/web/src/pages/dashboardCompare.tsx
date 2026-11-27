import { useTranslation } from "react-i18next";
import type { Dashboard, DashboardOps } from "@/api/dashboard";
import { Card } from "./dashboardBits";

type Ops = DashboardOps | undefined;
type Region = Dashboard["regions"]["items"][number];
type Level = "ok" | "amber" | "red" | "insufficient";

const TONE: Record<Level, string> = {
  ok: "bg-card2",
  amber: "bg-lateBg text-lateInk",
  red: "bg-lateBg text-lateInk font-bold",
  insufficient: "bg-card2 text-mute",
};

/**
 * Item 10 (contract 0.15.207; owner approval 2026-11-26, dashboard proposals): regions and contractors side by side.
 * The regions come from the dashboard regions the page already holds (so the filters and the caller's regions apply),
 * ranked by progress with the late tasks beside them; the contractors are the performance report parties, worst first.
 * No amounts anywhere. Without the contractors view right the contractors half is left out.
 */
export function OpsCompareCard({ ops, regions }: { ops: Ops; regions: Region[] }) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === "ar";
  const parties = ops?.compare?.available ? (ops.compare.contractors ?? []) : null;
  if (regions.length === 0 && parties === null) return null;
  const ranked = [...regions].sort((a, b) => b.progress_pct - a.progress_pct);
  const best = ranked[0]?.region_id;
  const worst = ranked.length > 1 ? ranked[ranked.length - 1].region_id : undefined;
  return (
    <Card title={t("dash.ops.compare_title")} testid="dash-ops-compare" className="print:break-inside-avoid">
      <p className="mb-3 text-sm text-mute">{t("dash.ops.compare_hint")}</p>
      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-label={t("dash.ops.compare_regions")}>
          <h4 className="mb-2 text-sm font-semibold">{t("dash.ops.compare_regions")}</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="dash-compare-regions">
              <thead>
                <tr className="text-start text-mute">
                  <th className="py-1 text-start font-semibold">{t("dash.ops.compare_region")}</th>
                  <th className="py-1 text-start font-semibold">{t("dash.ops.compare_sites")}</th>
                  <th className="py-1 text-start font-semibold">{t("dash.ops.compare_progress")}</th>
                  <th className="py-1 text-start font-semibold">{t("dash.ops.compare_late")}</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((r) => (
                  <tr key={r.region_id} className="border-t border-line" data-testid={`dash-compare-region-${r.region_id}`}>
                    <td className="py-1.5">
                      {ar && r.region_name_ar ? r.region_name_ar : r.region_name}
                      {r.region_id === best && (
                        <span className="chip ms-2 border border-line" data-testid="dash-compare-best">{t("dash.ops.compare_best")}</span>
                      )}
                      {r.region_id === worst && (
                        <span className={`chip ms-2 ${TONE.amber}`} data-testid="dash-compare-worst">{t("dash.ops.compare_worst")}</span>
                      )}
                    </td>
                    <td className="py-1.5 tnum">{r.sites_total}</td>
                    <td className="py-1.5">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 rounded bg-card2" aria-hidden="true">
                          <div className="h-2 rounded bg-teal-700" style={{ width: `${Math.min(100, Math.max(0, r.progress_pct))}%` }} />
                        </div>
                        <span className="tnum">{r.progress_pct}%</span>
                      </div>
                    </td>
                    <td className="py-1.5 tnum">{r.late ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        {parties !== null && (
          <section aria-label={t("dash.ops.compare_contractors")}>
            <h4 className="mb-2 text-sm font-semibold">{t("dash.ops.compare_contractors")}</h4>
            {parties.length === 0 ? (
              <p className="text-sm text-mute" data-testid="dash-compare-none">{t("dash.ops.compare_none")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="dash-compare-contractors">
                  <thead>
                    <tr className="text-mute">
                      <th className="py-1 text-start font-semibold">{t("dash.ops.compare_party")}</th>
                      <th className="py-1 text-start font-semibold">{t("dash.ops.compare_level")}</th>
                      <th className="py-1 text-start font-semibold">{t("dash.ops.compare_delay")}</th>
                      <th className="py-1 text-start font-semibold">{t("dash.ops.compare_snags")}</th>
                      <th className="py-1 text-start font-semibold">{t("dash.ops.compare_quality")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parties.map((p) => (
                      <tr key={p.party_id} className="border-t border-line" data-testid={`dash-compare-party-${p.party_id}`}>
                        <td className="py-1.5">{p.name}</td>
                        <td className="py-1.5">
                          <span className={`chip ${TONE[p.level as Level]}`}>{t(`dash.ops.compare_level_${p.level}`)}</span>
                        </td>
                        <td className="py-1.5 tnum">{p.delay_days}</td>
                        <td className="py-1.5 tnum">{p.snags_open} / {p.snags_overdue}</td>
                        <td className="py-1.5 tnum">{p.quality_failed}{p.quality_fail_pct !== null ? ` (${p.quality_fail_pct}%)` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </Card>
  );
}
