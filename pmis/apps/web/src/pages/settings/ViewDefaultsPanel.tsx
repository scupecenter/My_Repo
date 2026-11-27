import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDashboardViewDefaults, useSetDashboardViewDefaults } from "@/api/settings";
import { errText, FormDialog } from "@/components/FormDialog";
import { useToast } from "@/components/Toast";

/**
 * Dashboard settings (contract 0.15.208, migration 0510): the server-wide defaults of the dashboard view, the export format of the Share / Export
 * menu and whether the sections start open or collapsed. A user's own remembered choice overrides them. Saved on its own (its own audited setting).
 */
export function ViewDefaultsPanel() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useDashboardViewDefaults();
  const set = useSetDashboardViewDefaults();
  const [draft, setDraft] = useState<{ fmt: "xlsx" | "csv"; collapse: "open" | "closed" } | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return null;
  const cur = q.data;
  const v = draft ?? { fmt: cur.export_format, collapse: cur.collapse };
  const same = v.fmt === cur.export_format && v.collapse === cur.collapse;
  const ro = !cur.can_edit;
  return (
    <fieldset className="rounded-md border border-line p-3" data-testid="dsettings-view">
      <legend className="px-1 text-sm font-semibold">{t("dashSettings.vd_title")}</legend>
      <p className="mb-2 text-sm text-mute">{t("dashSettings.vd_note")}</p>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          {t("dashSettings.vd_format")}
          <select
            className="input w-auto"
            data-testid="dsettings-view-format"
            value={v.fmt}
            disabled={ro}
            onChange={(e) => setDraft({ ...v, fmt: e.target.value as "xlsx" | "csv" })}
          >
            {(["xlsx", "csv"] as const).map((f) => (
              <option key={f} value={f}>{t(`dash.format.${f}`)}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          {t("dashSettings.vd_collapse")}
          <select
            className="input w-auto"
            data-testid="dsettings-view-collapse"
            value={v.collapse}
            disabled={ro}
            onChange={(e) => setDraft({ ...v, collapse: e.target.value as "open" | "closed" })}
          >
            {(["open", "closed"] as const).map((c) => (
              <option key={c} value={c}>{t(`dashSettings.vd_collapse_${c}`)}</option>
            ))}
          </select>
        </label>
      </div>
      {ro ? (
        <p className="text-sm text-mute" data-testid="dsettings-view-readonly">{t("dashSettings.vd_readonly")}</p>
      ) : (
        <button className="btn" data-testid="dsettings-view-save" disabled={same} onClick={() => setOpen(true)}>
          {t("dashSettings.vd_save")}
        </button>
      )}
      {open && (
        <FormDialog
          open
          onClose={() => setOpen(false)}
          testid="dsettings-view-dialog"
          title={t("dashSettings.vd_title")}
          busy={set.isPending}
          error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) =>
            set.mutate(
              { version: cur.version, export_format: v.fmt, collapse: v.collapse, reason },
              {
                onSuccess: () => {
                  toast(t("settings.audited"));
                  setOpen(false);
                  setDraft(null);
                },
              },
            )
          }
        >
          <p className="text-sm text-mute">{t("dashSettings.vd_confirm")}</p>
        </FormDialog>
      )}
    </fieldset>
  );
}
