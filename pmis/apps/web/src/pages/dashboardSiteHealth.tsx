import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useSiteHealth, useSiteHealthDetail, type SiteHealthBand } from "@/api/siteHealth";
import { QueryFallback } from "@/components/States";
import { Card } from "./dashboardBits";

const TONE: Record<string, string> = {
  green: "bg-doneBg text-doneInk",
  amber: "bg-waitBg text-waitInk",
  red: "bg-lateBg text-lateInk",
};
const BANDS: SiteHealthBand[] = ["red", "amber", "green"];
const FACTORS = ["tasks", "docs", "snags", "delay"] as const;

/**
 * Site health score (contract 0.15.591): one number and colour per site, worst first, from tasks on time, documents, open snags and delay periods.
 * The bands are Settings > Dashboard > health bands, the weights are Settings > Dashboard > site health weights. Read only. Click a site to see the
 * factors behind its score.
 */
export function SiteHealthCard() {
  const { t } = useTranslation();
  const [band, setBand] = useState<SiteHealthBand | "">("");
  const [q, setQ] = useState("");
  const [site, setSite] = useState<string | null>(null);
  const list = useSiteHealth(band, q);
  const detail = useSiteHealthDetail(site);
  return (
    <Card title={t("dash.siteHealth.title")} testid="dash-site-health" className="print:break-inside-avoid">
      <p className="mb-3 text-sm text-mute">{t("dash.siteHealth.hint")}</p>
      {!list.data ? (
        <QueryFallback queries={[list]} testid="dash-site-health-loading" />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            {BANDS.map((b) => (
              <button
                key={b}
                type="button"
                className={`chip border border-line ${band === b ? "ring-2 ring-accent" : ""}`}
                aria-pressed={band === b}
                title={t("dash.siteHealth.filter_hint", { band: t(`dash.health.band.${b}`) })}
                data-testid={`dash-site-health-count-${b}`}
                onClick={() => setBand(band === b ? "" : b)}
              >
                <span className={`chip me-1 ${TONE[b]}`}>{t(`dash.health.band.${b}`)}</span>
                <b className="tnum">{list.data.counts[b]}</b>
              </button>
            ))}
            <span className="text-xs text-mute" title={t("dash.siteHealth.unscored_hint")} data-testid="dash-site-health-unscored">
              {t("dash.siteHealth.unscored", { n: list.data.counts.unscored })}
            </span>
            <input
              className="input ms-auto w-44"
              aria-label={t("dash.siteHealth.search")}
              placeholder={t("dash.siteHealth.search")}
              data-testid="dash-site-health-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {list.data.items.length === 0 ? (
            <p className="text-mute" data-testid="dash-site-health-empty">{t("dash.siteHealth.empty")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="dash-site-health-table">
                <thead>
                  <tr className="text-xs text-mute">
                    <th className="py-1 pe-2 text-start font-medium">{t("dash.siteHealth.col_site")}</th>
                    <th className="px-2 text-end font-medium">{t("dash.siteHealth.col_score")}</th>
                    {FACTORS.map((f) => (
                      <th key={f} className="px-2 text-end font-medium" title={t(`dash.siteHealth.factor_hint.${f}`)}>
                        {t(`dash.siteHealth.factor.${f}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((r, i) => (
                    <tr
                      key={r.site_id}
                      className={`cursor-pointer border-t border-line ${site === r.site_id ? "bg-soft" : ""}`}
                      data-testid={`dash-site-health-row-${i}`}
                      onClick={() => setSite(site === r.site_id ? null : r.site_id)}
                    >
                      <td className="py-1 pe-2">
                        <Link to={`/sites/${r.site_id}`} className="mono text-accent" onClick={(e) => e.stopPropagation()}>
                          {r.site_code}
                        </Link>{" "}
                        <span className="text-mute">{r.site_name}</span>
                      </td>
                      <td className="px-2 text-end">
                        {r.band ? <span className={`chip ${TONE[r.band]}`} data-band={r.band}><b className="tnum">{r.score}</b></span> : <span className="text-mute">-</span>}
                      </td>
                      {FACTORS.map((f) => (
                        <td key={f} className="px-2 text-end tnum">{r[f] ?? "-"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs text-mute" data-testid="dash-site-health-total">
            {t("dash.siteHealth.shown", { n: list.data.items.length, total: list.data.total })}
          </p>
          {site && detail.data && (
            <div className="mt-3 rounded-md border border-line p-3" data-testid="dash-site-health-detail">
              <p className="mb-2 text-sm font-semibold">{detail.data.site_code} {detail.data.site_name}</p>
              <ul className="space-y-1 text-sm">
                {detail.data.factors.map((f) => (
                  <li key={f.code} data-testid={`dash-site-health-factor-${f.code}`} title={t(`dash.siteHealth.factor_hint.${f.code}`)}>
                    {t(`dash.siteHealth.factor.${f.code}`)}: <b className="tnum">{f.value ?? "-"}</b>{" "}
                    <span className="text-xs text-mute">
                      {f.excluded ? t("dash.siteHealth.excluded") : t("dash.siteHealth.weight_count", { w: f.weight, n: f.count })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
