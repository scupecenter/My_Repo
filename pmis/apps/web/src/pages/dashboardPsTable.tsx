import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dashboard } from "@/api/dashboard";
import { Card, pct } from "./dashboardBits";

type Activity = NonNullable<Dashboard["headline"]["project_status"]>["activities"][number];

/**
 * Compact detail table under the progress and weight cards (contract 0.15.366): the main weight headings (A1..A8) with progress,
 * weight and counts; the items of each heading are hidden until its button opens them (or expand all). Read only; the data is the
 * activities[].items[] that GET /dashboard and GET /project-status already return. Ordered and hidden from Settings > Dashboard.
 */
export function PsDetailTable({ activities }: { activities: Activity[] | undefined }) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === "ar";
  const rows = activities ?? [];
  const [open, setOpen] = useState<Set<string>>(new Set());
  const name = (x: { name_en: string; name_ar?: string | null }) => (ar && x.name_ar ? x.name_ar : x.name_en);
  const withItems = rows.filter((a) => (a.items ?? []).length > 0).map((a) => a.code);
  const toggle = (code: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(code)) n.delete(code);
      else n.add(code);
      return n;
    });
  const itemTotal = rows.reduce((n, a) => n + (a.items ?? []).length, 0);
  return (
    <Card
      title={t("dash.pst.title")}
      testid="dash-ps-table"
      className="print:break-inside-avoid"
      aside={
        <span className="flex gap-2 print:hidden">
          <button type="button" className="btn !px-2 !py-0.5 text-xs" data-testid="dash-pst-expand" title={t("dash.pst.expand_hint")}
            onClick={() => setOpen(new Set(withItems))}>{t("dash.pst.expand")}</button>
          <button type="button" className="btn !px-2 !py-0.5 text-xs" data-testid="dash-pst-collapse" title={t("dash.pst.collapse_hint")}
            onClick={() => setOpen(new Set())}>{t("dash.pst.collapse")}</button>
        </span>
      }
    >
      <p className="-mt-2 mb-2 text-xs text-mute">{t("dash.pst.hint", { a: rows.length, n: itemTotal })}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="dash-pst-table">
          <thead>
            <tr className="text-start text-xs text-mute">
              <th className="py-1 pe-2 text-start font-medium">{t("dash.pst.col_name")}</th>
              <th className="px-2 text-end font-medium" title={t("dash.pst.progress_hint")}>{t("dash.pst.col_progress")}</th>
              <th className="px-2 text-end font-medium" title={t("dash.pst.weight_hint")}>{t("dash.pst.col_weight")}</th>
              <th className="ps-2 text-end font-medium" title={t("dash.pst.sites_hint")}>{t("dash.pst.col_sites")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const items = a.items ?? [];
              const isOpen = open.has(a.code);
              const sum = (k: "done" | "applicable") => items.reduce((n, i) => n + (i[k] ?? 0), 0);
              return (
                <RowGroup key={a.code}>
                  <tr className="border-t border-line font-semibold" data-testid={`dash-pst-row-${a.code}`}>
                    <td className="py-1 pe-2">
                      {items.length > 0 ? (
                        <button type="button" className="inline-flex items-start gap-1 text-start" aria-expanded={isOpen}
                          data-testid={`dash-pst-toggle-${a.code}`}
                          title={t(isOpen ? "dash.pst.close_row" : "dash.pst.open_row", { n: items.length })}
                          onClick={() => toggle(a.code)}>
                          <span aria-hidden="true" className={`inline-block transition-transform rtl:-scale-x-100 ${isOpen ? "rotate-90 rtl:-rotate-90" : ""}`}>▸</span>
                          <span><span className="tnum text-mute">{a.code}</span> {name(a)}{" "}
                          <span className="text-xs font-normal text-mute">({items.length})</span></span>
                        </button>
                      ) : (
                        <span className="inline-flex items-start gap-1"><span aria-hidden="true" className="invisible">▸</span><span><span className="tnum text-mute">{a.code}</span> {name(a)}</span></span>
                      )}
                    </td>
                    <td className="px-2 text-end tnum">
                      {a.measured ? pct(a.progress_pct) : <span className="text-xs font-normal text-mute">{t("dash.ps.no_data")}</span>}
                    </td>
                    <td className="px-2 text-end tnum">{a.weight}%</td>
                    <td className="ps-2 text-end tnum">{items.length > 0 ? <bdi dir="ltr">{`${sum("done")} / ${sum("applicable")}`}</bdi> : "–"}</td>
                  </tr>
                  {isOpen &&
                    items.map((i) => (
                      <tr key={i.code} className="text-mute" data-testid={`dash-pst-item-${i.code}`}
                        title={i.reason ? t(`dash.pst.reason_${i.reason}`) : undefined}>
                        <td className="py-0.5 ps-5 pe-2"><span className="tnum">{i.code}</span> {name(i)}</td>
                        <td className="px-2 text-end tnum">{i.measured ? pct(i.progress_pct) : "–"}</td>
                        <td className="px-2 text-end tnum">{i.weight}%</td>
                        <td className="ps-2 text-end tnum">{i.applicable !== undefined ? <bdi dir="ltr">{`${i.done ?? 0} / ${i.applicable}`}</bdi> : "–"}</td>
                      </tr>
                    ))}
                </RowGroup>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
