import { ArrowDown, ArrowUp } from "lucide-react";
import { TargetPolicyPanel } from "./TargetPolicyPanel";
import { useDashboardTargetPolicy } from "@/api/settings";
import { UnsavedGuard } from '@/lib/unsavedGuard';
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useDashboardSettings,
  useSetDashboardSettings,
  type DashboardSettings as Settings,
  type DashboardSettingsInput,
  type DashboardTab,
} from "@/api/dashboardSettings";
import { usePartialCredit, useSetPartialCredit } from "@/api/partialCredit";
import { errText, FormDialog } from "@/components/FormDialog";
import { useToast } from "@/components/Toast";
import { moveRow, tabRows, toLayout, type CardRow } from "../dashboardLayout";
import { QueryFallback } from '@/components/States';
import { FinanceReadersPanel } from "./FinanceReadersPanel";
import { ProgressRag } from "./ProgressRag";
import { ForecastWindow } from "./ForecastWindow";
import { SnapshotSchedule } from "./SnapshotSchedule";
import { HealthBands } from "./HealthBands";
import { ShareLinksCard } from '@/components/DashboardShare';

const TABS: DashboardTab[] = ["pmo", "cw", "te"];
type Thresholds = DashboardSettingsInput["thresholds"];

/** The editable copy of the setting: the rows of each tab are kept in display order, so every card is listed once. */
function fromSettings(s: Settings) {
  const cards = s.catalogue.cards.map((c) => c.code);
  const rows = Object.fromEntries(
    TABS.map((tab) => [tab, tabRows(s.tabs[tab], cards)]),
  ) as Record<DashboardTab, CardRow[]>;
  return { targets: s.targets, thresholds: s.thresholds as Thresholds, rows };
}

function toInput(d: ReturnType<typeof fromSettings>): DashboardSettingsInput {
  return {
    targets: d.targets,
    thresholds: d.thresholds,
    tabs: {
      pmo: toLayout(d.rows.pmo),
      cw: toLayout(d.rows.cw),
      te: toLayout(d.rows.te),
    },
  };
}

/**
 * Settings, Dashboard (contract 0.15.24, F20): the targets (sites per batch, monthly On-Air), the green and amber thresholds of each KPI, and the cards of each
 * dashboard tab with their order. Global only: the per-user layout stays in the browser. The save needs admin.settings edit for all regions and a reason.
 */
export function DashboardSettings() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useDashboardSettings();
  const set = useSetDashboardSettings();
  const policy = useDashboardTargetPolicy();
  const [draft, setDraft] = useState<ReturnType<typeof fromSettings> | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  const label = (x: { label_en: string; label_ar: string }) =>
    (i18n.language === "ar" && x.label_ar) || x.label_en;

  if (!q.data)
    return (
      <section className="card p-4" data-testid="page-dashboard-settings">
        <QueryFallback queries={[q]} testid="dash-settings-loading" />
      </section>
    );
  const s = q.data;
  const cur = draft ?? fromSettings(s);
  const cardsOf = Object.fromEntries(
    s.catalogue.cards.map((c) => [c.code, c]),
  ) as Record<string, (typeof s.catalogue.cards)[number]>;
  const setTab = (tab: DashboardTab, rows: CardRow[]) =>
    setDraft({ ...cur, rows: { ...cur.rows, [tab]: rows } });
  const setThreshold = (
    code: string,
    edge: "green" | "amber",
    value: string,
  ) => {
    const prev = cur.thresholds[code] ?? { green: 0, amber: 0 };
    const n = value === "" ? NaN : Number(value);
    setDraft({
      ...cur,
      thresholds: { ...cur.thresholds, [code]: { ...prev, [edge]: n } },
    });
  };
  const setTarget = (
    key: "sites_per_batch" | "monthly_on_air",
    value: string,
  ) =>
    setDraft({
      ...cur,
      targets: { ...cur.targets, [key]: value === "" ? null : Number(value) },
    });
  const invalid = s.catalogue.kpis.some((k) => {
    const th = cur.thresholds[k.code];
    if (!th || !Number.isFinite(th.green) || !Number.isFinite(th.amber))
      return true;
    return k.direction === "higher" ? th.green < th.amber : th.green > th.amber;
  });

  return (
    <>
    <section
      className="card space-y-4 p-4"
      data-testid="page-dashboard-settings"
    >
      <h2 className="font-bold">{t("dashSettings.title")}</h2>
      <p className="text-sm text-mute">{t("dashSettings.note")}</p>
      <p className="mono text-xs text-mute" data-testid="dsettings-version">
        {t("scopeMatch.version", { version: s.version })}
        {draft && <span className="chip ms-2">{t("scopeMatch.unsaved")}</span>}
      </p>

      <TargetPolicyPanel />

      {policy.data?.manual_override ? (
        <fieldset
          className="space-y-2 rounded-md border border-line p-3"
          data-testid="dsettings-targets"
        >
          <legend className="px-1 text-sm font-semibold">
            {t("dashSettings.targets")}
          </legend>
          <label className="block text-sm">
            {t("dashSettings.sites_per_batch")}
            <input
              type="number"
              min={0}
              className="input mt-1 w-32"
              data-testid="dsettings-sites-per-batch"
              value={cur.targets.sites_per_batch ?? ""}
              onChange={(e) => setTarget("sites_per_batch", e.target.value)}
            />
          </label>
          <label className="block text-sm">
            {t("dashSettings.monthly_on_air")}
            <input
              type="number"
              min={0}
              className="input mt-1 w-32"
              data-testid="dsettings-monthly-on-air"
              value={cur.targets.monthly_on_air ?? ""}
              onChange={(e) => setTarget("monthly_on_air", e.target.value)}
            />
          </label>
        </fieldset>
      ) : (
        <p className="rounded-md border border-line p-3 text-sm text-mute" data-testid="dsettings-targets-derived">
          {t("dashSettings.targets_derived")}
        </p>
      )}

      <SnapshotSchedule />
      <ProgressRag />
      <ForecastWindow />
      <HealthBands />

      <fieldset
        className="space-y-2 rounded-md border border-line p-3"
        data-testid="dsettings-thresholds"
      >
        <legend className="px-1 text-sm font-semibold">
          {t("dashSettings.thresholds")}
        </legend>
        <p className="text-xs text-mute">{t("dashSettings.thresholds_note")}</p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-start text-mute">
              <th className="text-start font-semibold">
                {t("dashSettings.kpi")}
              </th>
              <th className="text-start font-semibold">
                {t("dashSettings.direction")}
              </th>
              <th className="text-start font-semibold">
                {t("dashSettings.green")}
              </th>
              <th className="text-start font-semibold">
                {t("dashSettings.amber")}
              </th>
            </tr>
          </thead>
          <tbody>
            {s.catalogue.kpis.map((k) => (
              <tr key={k.code} data-testid={`dsettings-kpi-${k.code}`}>
                <td className="py-1 pe-2">
                  {label(k)}{" "}
                  <span className="text-xs text-mute">
                    ({t(`dashSettings.unit_${k.unit}`)})
                  </span>
                </td>
                <td className="py-1 pe-2 text-mute">
                  {t(`dashSettings.dir_${k.direction}`)}
                </td>
                <td className="py-1 pe-2">
                  <input
                    type="number"
                    aria-label={`${label(k)} ${t("dashSettings.green")}`}
                    className="input w-24"
                    data-testid={`dsettings-green-${k.code}`}
                    value={
                      Number.isFinite(cur.thresholds[k.code]?.green)
                        ? cur.thresholds[k.code]!.green
                        : ""
                    }
                    onChange={(e) =>
                      setThreshold(k.code, "green", e.target.value)
                    }
                  />
                </td>
                <td className="py-1">
                  <input
                    type="number"
                    aria-label={`${label(k)} ${t("dashSettings.amber")}`}
                    className="input w-24"
                    data-testid={`dsettings-amber-${k.code}`}
                    value={
                      Number.isFinite(cur.thresholds[k.code]?.amber)
                        ? cur.thresholds[k.code]!.amber
                        : ""
                    }
                    onChange={(e) =>
                      setThreshold(k.code, "amber", e.target.value)
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </fieldset>

      {TABS.map((tab) => {
        const rows = cur.rows[tab];
        return (
          <fieldset
            key={tab}
            className="space-y-2 rounded-md border border-line p-3"
            data-testid={`dsettings-tab-${tab}`}
          >
            <legend className="px-1 text-sm font-semibold">
              {t(`dashSettings.tab_${tab}`)}
            </legend>
            <ol className="space-y-1 text-sm">
              {rows.map((r, i) => (
                <li
                  key={r.code}
                  className="flex flex-wrap items-center gap-2"
                  data-testid={`dsettings-row-${tab}-${r.code}`}
                >
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      data-testid={`dsettings-shown-${tab}-${r.code}`}
                      checked={r.shown}
                      onChange={(e) =>
                        setTab(
                          tab,
                          rows.map((x) =>
                            x.code === r.code
                              ? { ...x, shown: e.target.checked }
                              : x,
                          ),
                        )
                      }
                    />
                    {label(cardsOf[r.code]!)}
                  </label>
                  <button
                    type="button"
                    className="btn btn-ghost p-1"
                    aria-label={t("dashSettings.move_up", {
                      name: label(cardsOf[r.code]!),
                    })}
                    data-testid={`dsettings-up-${tab}-${r.code}`}
                    disabled={i === 0}
                    onClick={() => setTab(tab, moveRow(rows, i, -1))}
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost p-1"
                    aria-label={t("dashSettings.move_down", {
                      name: label(cardsOf[r.code]!),
                    })}
                    data-testid={`dsettings-down-${tab}-${r.code}`}
                    disabled={i === rows.length - 1}
                    onClick={() => setTab(tab, moveRow(rows, i, 1))}
                  >
                    <ArrowDown size={14} />
                  </button>
                </li>
              ))}
            </ol>
          </fieldset>
        );
      })}

      <FinanceReadersPanel />
      {invalid && (
        <p
          role="alert"
          className="text-sm text-lateInk"
          data-testid="dsettings-invalid"
        >
          {t("dashSettings.invalid")}
        </p>
      )}
      <UnsavedGuard scope="settings" dirty={!!draft && !invalid} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => set.mutate({ version: s.version, body: { ...toInput(cur), reason } }, { onSuccess: () => { setDraft(null); res(true); }, onError: () => res(false) }))} />
      <button
        className="btn btn-accent"
        data-testid="dsettings-save"
        disabled={!draft || invalid}
        onClick={() => setOpen(true)}
      >
        {t("scopeMatch.save")}
      </button>
      {open && (
        <FormDialog
          open
          onClose={() => setOpen(false)}
          testid="dsettings-dialog"
          title={t("dashSettings.title")}
          busy={set.isPending}
          error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) =>
            set.mutate(
              { version: s.version, body: { ...toInput(cur), reason } },
              {
                onSuccess: () => {
                  toast(t("settings.audited"));
                  setOpen(false);
                  setDraft(null);
                },
              },
            )
          }
        />
      )}
    </section>
    <PartialCreditCard />
      <ShareLinksCard />
    </>
  );
}

/** Migration 0543: the partial-credit switch of the progress calculation (off by default). A separate setting with its own audited save. */
function PartialCreditCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = usePartialCredit();
  const set = useSetPartialCredit();
  const [open, setOpen] = useState(false);
  if (!q.data)
    return (
      <section className="card p-4" data-testid="partial-credit-card">
        <QueryFallback queries={[q]} testid="partial-credit-loading" />
      </section>
    );
  const s = q.data;
  return (
    <section className="card space-y-2 p-4" data-testid="partial-credit-card">
      <h2 className="font-bold">{t("dashSettings.partial_credit_title")}</h2>
      <p className="text-sm text-mute">{t("dashSettings.partial_credit_note")}</p>
      <p className="text-sm" data-testid="partial-credit-state">
        {s.enabled ? t("dashSettings.partial_credit_on") : t("dashSettings.partial_credit_off")}
      </p>
      <button className="btn" data-testid="partial-credit-change" onClick={() => setOpen(true)}>
        {s.enabled ? t("dashSettings.partial_credit_turn_off") : t("dashSettings.partial_credit_turn_on")}
      </button>
      {open && (
        <FormDialog
          open
          onClose={() => setOpen(false)}
          testid="partial-credit-dialog"
          title={t("dashSettings.partial_credit_title")}
          busy={set.isPending}
          error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) =>
            set.mutate(
              { version: s.version, body: { enabled: !s.enabled, reason } },
              {
                onSuccess: () => {
                  toast(t("settings.audited"));
                  setOpen(false);
                },
              },
            )
          }
        />
      )}
    </section>
  );
}
