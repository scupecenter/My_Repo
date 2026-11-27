import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { DashboardOps } from "@/api/dashboard";
import { Card } from "./dashboardBits";
import { AgingRow } from "./dashboardOps";

type Ops = DashboardOps | undefined;
type Part = NonNullable<NonNullable<Ops>["gecol_hlc"]["gecol"]>;

/**
 * Item 4 (contract 0.15.201; owner approval 2026-11-26, dashboard proposals): GECOL power and HLC fiber readiness.
 * Per utility: the scoped sites, how many are done (powered / in service), the waiting ones aged since the request,
 * the in-scope sites with no record, and the headline waits (civilly ready but not electrified; installed but not in
 * service). Read only; each part links to its register and answers unavailable without its view right.
 */
function UtilityPart({
  part,
  kind,
  testid,
}: {
  part: Part;
  kind: "gecol" | "hlc";
  testid: string;
}) {
  const { t } = useTranslation();
  if (!part.available) {
    return (
      <p className="text-mute" data-testid={`${testid}-unavailable`}>
        {t(`dash.ops.unavailable_${kind}`)}
      </p>
    );
  }
  return (
    <div data-testid={testid}>
      <div className="mb-3 flex flex-wrap gap-2 text-sm">
        <span className="chip border border-line" data-testid={`${testid}-in-scope`}>
          {t("dash.ops.in_scope")} <b className="ms-1 tnum">{part.in_scope ?? 0}</b>
        </span>
        <span className="chip border border-line" data-testid={`${testid}-done`}>
          {t(kind === "gecol" ? "dash.ops.powered" : "dash.ops.in_service")}{" "}
          <b className="ms-1 tnum">
            {(kind === "gecol" ? part.powered : part.in_service) ?? 0}
          </b>
        </span>
        <span className="chip border border-line" data-testid={`${testid}-no-record`}>
          {t("dash.ops.no_record")}{" "}
          <b className={`ms-1 tnum ${(part.no_record ?? 0) > 0 ? "text-waitInk" : ""}`}>
            {part.no_record ?? 0}
          </b>
        </span>
        <span className="chip border border-line" data-testid={`${testid}-headline`}>
          {t(kind === "gecol" ? "dash.ops.civil_ready_no_power" : "dash.ops.installed_not_in_service")}{" "}
          <b
            className={`ms-1 tnum ${
              ((kind === "gecol" ? part.civil_ready_no_power : part.installed_not_in_service) ?? 0) > 0
                ? "text-lateInk"
                : ""
            }`}
          >
            {(kind === "gecol" ? part.civil_ready_no_power : part.installed_not_in_service) ?? 0}
          </b>
        </span>
      </div>
      {part.waiting && (
        <AgingRow
          label={t(kind === "gecol" ? "dash.ops.waiting_power" : "dash.ops.waiting_fiber")}
          aging={part.waiting}
          testid={`${testid}-aging`}
        />
      )}
    </div>
  );
}

export function OpsReadinessCard({ ops }: { ops: Ops }) {
  const { t } = useTranslation();
  if (!ops)
    return (
      <p className="text-mute" role="status" data-testid="dash-readiness-loading">
        {t("common.loading")}
      </p>
    );
  const g = ops.gecol_hlc;
  return (
    <Card
      title={t("dash.ops.readiness_title")}
      testid="dash-ops-readiness"
      className="xl:col-span-2 print:break-inside-avoid"
      aside={
        <span className="flex gap-3">
          <Link to="/registers/gecol" className="text-sm text-accent underline">
            {t("dash.ops.open_gecol")}
          </Link>
          <Link to="/registers/hlc" className="text-sm text-accent underline">
            {t("dash.ops.open_hlc")}
          </Link>
        </span>
      }
    >
      <p className="mb-3 text-sm text-mute">{t("dash.ops.readiness_hint")}</p>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold">{t("dash.ops.gecol_title")}</h3>
          <UtilityPart part={g.gecol} kind="gecol" testid="dash-gecol" />
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold">{t("dash.ops.hlc_title")}</h3>
          <UtilityPart part={g.hlc} kind="hlc" testid="dash-hlc" />
        </div>
      </div>
    </Card>
  );
}
