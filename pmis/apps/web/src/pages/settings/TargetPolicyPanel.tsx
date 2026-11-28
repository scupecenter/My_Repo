import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDashboardTargetPolicy, useSetDashboardTargetPolicy } from "@/api/settings";
import { errText, FormDialog } from "@/components/FormDialog";
import { useToast } from "@/components/Toast";

/**
 * Dashboard settings (contract 0.15.367, migration 0524): the targets are derived from the scope and nobody types them. The typed numbers below are an
 * exception: off by default, turned on here with a reason (audited). While off, the typed numbers are kept but not used and not shown.
 */
export function TargetPolicyPanel() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useDashboardTargetPolicy();
  const set = useSetDashboardTargetPolicy();
  const [open, setOpen] = useState(false);
  if (!q.data) return null;
  const cur = q.data;
  return (
    <fieldset className="rounded-md border border-line p-3" data-testid="dsettings-policy">
      <legend className="px-1 text-sm font-semibold">{t("dashSettings.tp_title")}</legend>
      <p className="mb-2 text-sm text-mute">{t("dashSettings.tp_note")}</p>
      <p className="mb-2 text-sm" data-testid="dsettings-policy-state">
        {t(cur.manual_override ? "dashSettings.tp_on" : "dashSettings.tp_off")}
      </p>
      {cur.can_edit ? (
        <button className="btn" data-testid="dsettings-policy-toggle" onClick={() => setOpen(true)}>
          {t(cur.manual_override ? "dashSettings.tp_turn_off" : "dashSettings.tp_turn_on")}
        </button>
      ) : (
        <p className="text-sm text-mute" data-testid="dsettings-policy-readonly">{t("dashSettings.tp_readonly")}</p>
      )}
      {open && (
        <FormDialog
          open
          onClose={() => setOpen(false)}
          testid="dsettings-policy-dialog"
          title={t("dashSettings.tp_title")}
          busy={set.isPending}
          error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) =>
            set.mutate(
              { version: cur.version, manual_override: !cur.manual_override, reason },
              { onSuccess: () => { toast(t("settings.audited")); setOpen(false); } },
            )
          }
        >
          <p className="text-sm text-mute">{t(cur.manual_override ? "dashSettings.tp_confirm_off" : "dashSettings.tp_confirm_on")}</p>
        </FormDialog>
      )}
    </fieldset>
  );
}
