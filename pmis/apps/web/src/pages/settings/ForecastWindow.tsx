import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useSetForecastWindow,
  useForecastWindow,
} from "@/api/dashboardSettings";
import { errText, FormDialog } from "@/components/FormDialog";
import { QueryFallback } from "@/components/States";
import { useToast } from "@/components/Toast";
import { UnsavedGuard } from "@/lib/unsavedGuard";

const WEEKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/**
 * Settings, Dashboard, forecast window (contract 0.15.431, settings review gap 4): how many of the last real weeks the progress curve forecast averages the weekly gain over
 * (setting `dashboard.forecast_window_weeks`, 2 to 12, default 4, the value that was fixed in the web code). Own save, reason and audit row. The forecast is drawn from the
 * saved snapshots when the card opens, so nothing stored is recomputed or rewritten.
 */
export function ForecastWindow() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useForecastWindow();
  const set = useSetForecastWindow();
  const [draft, setDraft] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data)
    return (
      <fieldset className="rounded-md border border-line p-3">
        <QueryFallback queries={[q]} testid="forecast-window-loading" />
      </fieldset>
    );
  const s = q.data;
  const cur = draft ?? s.weeks;
  const changed = cur !== s.weeks;
  return (
    <fieldset
      className="space-y-2 rounded-md border border-line p-3"
      data-testid="forecast-window"
    >
      <legend className="px-1 text-sm font-semibold">
        {t("forecastWindow.title")}
      </legend>
      <p className="text-xs text-mute">{t("forecastWindow.note")}</p>
      <p className="mono text-xs text-mute" data-testid="forecast-window-version">
        {t("scopeMatch.version", { version: s.version })}
      </p>
      <label className="block text-sm">
        {t("forecastWindow.weeks")}
        <select
          className="input mt-1 w-48"
          data-testid="forecast-window-weeks"
          value={cur}
          onChange={(e) => setDraft(Number(e.target.value))}
        >
          {WEEKS.map((d) => (
            <option key={d} value={d}>
              {d}
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
              { version: s.version, body: { weeks: cur, reason } },
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
        data-testid="forecast-window-save"
        disabled={draft === null || !changed}
        onClick={() => setOpen(true)}
      >
        {t("scopeMatch.save")}
      </button>
      {open && (
        <FormDialog
          open
          onClose={() => setOpen(false)}
          testid="forecast-window-dialog"
          title={t("forecastWindow.title")}
          busy={set.isPending}
          error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) =>
            set.mutate(
              { version: s.version, body: { weeks: cur, reason } },
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
