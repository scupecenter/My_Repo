import { useTranslation } from "react-i18next";
import type { DashboardOps } from "@/api/dashboard";
import { Card } from "./dashboardBits";
import { AgingRow } from "./dashboardOps";

type Ops = DashboardOps | undefined;

const lyd = (n: number | null | undefined, lang: string): string =>
  new Intl.NumberFormat(lang === "ar" ? "ar-LY-u-nu-latn" : "en-US", { maximumFractionDigits: 0 }).format(n ?? 0);

/**
 * Item 9 (contract 0.15.206; owner approval 2026-11-26, dashboard proposals): the restricted financial summary. The
 * server sends figures only to a configured reader (setting dashboard.finance_readers), so for everyone else this card
 * renders nothing at all. Read only; never part of an export or a share link. No invoice ages: no invoice data exists.
 */
export function OpsFinanceCard({ ops }: { ops: Ops }) {
  const { t, i18n } = useTranslation();
  const f = ops?.finance;
  if (!f || !f.available || !f.advances || !f.amounts || !f.achievement) return null;
  const lang = i18n.language;
  const stat = (label: string, value: string, testid: string) => (
    <span className="chip border border-line" data-testid={testid}>
      {label} <b className="ms-1 tnum">{value}</b>
    </span>
  );
  return (
    <Card title={t("dash.ops.finance_title")} testid="dash-ops-finance" className="print:break-inside-avoid">
      <p className="mb-3 text-sm text-mute">{t("dash.ops.finance_hint")}</p>
      <div className="grid gap-6 md:grid-cols-2">
        <section aria-label={t("dash.ops.finance_advances")}>
          <h4 className="mb-2 text-sm font-semibold">{t("dash.ops.finance_advances")}</h4>
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            {stat(t("dash.ops.finance_advances"), String(f.advances.total), "dash-finance-total")}
            {stat(t("dash.ops.finance_open"), String(f.advances.open), "dash-finance-open")}
            {f.advances.hidden_amounts > 0 && (
              <span className="chip border border-line" data-testid="dash-finance-hidden">
                {t("dash.ops.finance_hidden", { n: f.advances.hidden_amounts })}
              </span>
            )}
          </div>
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            {stat(t("dash.ops.finance_approved"), lyd(f.amounts.approved, lang), "dash-finance-approved")}
            {stat(t("dash.ops.finance_disbursed"), lyd(f.amounts.disbursed, lang), "dash-finance-disbursed")}
            {stat(t("dash.ops.finance_returned"), lyd(f.amounts.returned, lang), "dash-finance-returned")}
            {stat(t("dash.ops.finance_open_disbursed"), lyd(f.amounts.open_disbursed, lang), "dash-finance-open-disbursed")}
          </div>
          {f.open_aging && (
            <AgingRow label={t("dash.ops.finance_open_age")} aging={f.open_aging} testid="dash-finance-aging" />
          )}
          {f.invoices && (
            <div className="mt-4" data-testid="dash-finance-invoices">
              <h4 className="mb-2 text-sm font-semibold">{t("dash.ops.finance_invoices")}</h4>
              <div className="mb-3 flex flex-wrap gap-2 text-sm">
                {stat(t("dash.ops.finance_invoices_open"), String(f.invoices.open), "dash-finance-invoices-open")}
                {stat(t("dash.ops.finance_invoices_overdue"), String(f.invoices.overdue), "dash-finance-invoices-overdue")}
              </div>
              <AgingRow label={t("dash.ops.finance_invoices_age")} aging={f.invoices.aging} testid="dash-finance-invoices-aging" />
            </div>
          )}
        </section>
        <section aria-label={t("dash.ops.finance_achievement")}>
          <h4 className="mb-2 text-sm font-semibold">{t("dash.ops.finance_achievement")}</h4>
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            {stat(t("dash.ops.finance_assignments"), String(f.achievement.assignments), "dash-finance-assignments")}
            {stat(
              t("dash.ops.finance_completed"),
              `${f.achievement.completed}${f.achievement.completion_pct !== null ? ` (${f.achievement.completion_pct}%)` : ""}`,
              "dash-finance-completed",
            )}
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            {stat(t("dash.ops.finance_on_done"), lyd(f.achievement.disbursed_on_completed, lang), "dash-finance-on-done")}
            {stat(t("dash.ops.finance_on_open"), lyd(f.achievement.disbursed_on_open_work, lang), "dash-finance-on-open")}
          </div>
        </section>
      </div>
    </Card>
  );
}
