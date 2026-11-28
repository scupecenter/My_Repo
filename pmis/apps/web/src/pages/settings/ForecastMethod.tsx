import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useSetForecastMethod,
  useForecastMethod,
} from "@/api/dashboardSettings";
import { errText, FormDialog } from "@/components/FormDialog";
import { QueryFallback } from "@/components/States";
import { useToast } from "@/components/Toast";
import { UnsavedGuard } from "@/lib/unsavedGuard";

const METHODS = ["mean", "linear"] as const;

/**
 * Settings, Dashboard, forecast method (contract 0.15.474, phase 5): how the progress curve forecast takes the weekly pace from the saved snapshots, the mean weekly gain (default,
 * the former fixed behaviour) or a straight line fitted through the actual points (setting `dashboard.forecast_method`). Own save, reason and audit row. The forecast is drawn
 * from the saved snapshots when the card opens, so nothing stored is recomputed or rewritten.
 */
export function ForecastMethod() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useForecastMethod();
  const set = useSetForecastMethod();
  const [draft, setDraft] = useState<"mean" | "linear" | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data)
    return (
      <fieldset className="rounded-md border border-line p-3">
        <QueryFallback queries={[q]} testid="forecast-method-loading" />
      </fieldset>
    );
  const s = q.data;
  const cur = draft ?? (s.method === "linear" ? "linear" : "mean");
  const changed = cur !== s.method;
  return (
    <fieldset
      className="space-y-2 rounded-md border border-line p-3"
      data-testid="forecast-method"
    >
      <legend className="px-1 text-sm font-semibold">
        {t("forecastMethod.title")}
      </legend>
      <p className="text-xs text-mute">{t("forecastMethod.note")}</p>
      <p className="mono text-xs text-mute" data-testid="forecast-method-version">
        {t("scopeMatch.version", { version: s.version })}
      </p>
      <label className="block text-sm">
        {t("forecastMethod.method")}
        <select
          className="input mt-1 w-48"
          data-testid="forecast-method-method"
          value={cur}
          onChange={(e) => setDraft(e.target.value === "linear" ? "linear" : "mean")}
        >
          {METHODS.map((d) => (
            <option key={d} value={d}>
              {t(`forecastMethod.${d}`)}
            </option>
          ))}
        </select>
      </label>
      <UnsavedGuard
        scope="settings"
        dirty={draft !== null && changed}
        needsReason
        label={t("ui.guard_settings")}
        onSave={(reason) =>
          new Promise<boolean>((res) =>
            set.mutate(
              { version: s.version, body: { method: cur, reason } },
              {
                onSuccess: () => {
                  setDraft(null);
                  res(true);
                },
                onError: () => res(false),
              },
            ),
          )
        }
      />
      <button
        className="btn btn-accent"
        data-testid="forecast-method-save"
        disabled={draft === null || !changed}
        onClick={() => setOpen(true)}
      >
        {t("scopeMatch.save")}
      </button>
      {open && (
        <FormDialog
          open
          onClose={() => setOpen(false)}
          testid="forecast-method-dialog"
          title={t("forecastMethod.title")}
          busy={set.isPending}
          error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) =>
            set.mutate(
              { version: s.version, body: { method: cur, reason } },
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
    </fieldset>
  );
}
