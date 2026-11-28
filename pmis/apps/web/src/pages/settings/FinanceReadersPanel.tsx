import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useFinanceReaders, useSetFinanceReaders } from "@/api/settings";
import { errText, FormDialog } from "@/components/FormDialog";
import { useToast } from "@/components/Toast";

/**
 * Dashboard settings, item 9 (contract 0.15.206, migration 0307): who sees the restricted financial summary card. Off by
 * default; a System Admin (or an all-regions delegate of settings edit) switches it on and chooses the roles, with a
 * reason and a step-up. Saved on its own (its own audited setting), apart from the card layout and thresholds above.
 */
export function FinanceReadersPanel() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useFinanceReaders();
  const set = useSetFinanceReaders();
  const [draft, setDraft] = useState<{ enabled: boolean; roles: string[] } | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return null;
  const cur = q.data;
  const v = draft ?? { enabled: cur.enabled, roles: cur.role_codes };
  const same = v.enabled === cur.enabled && [...v.roles].sort().join(",") === [...cur.role_codes].sort().join(",");
  const ro = !cur.can_edit;
  const toggle = (code: string) =>
    setDraft({ ...v, roles: v.roles.includes(code) ? v.roles.filter((c) => c !== code) : [...v.roles, code] });
  return (
    <fieldset className="rounded-md border border-line p-3" data-testid="dsettings-finance">
      <legend className="px-1 text-sm font-semibold">{t("dashSettings.fr_title")}</legend>
      <p className="mb-2 text-sm text-mute">{t("dashSettings.fr_note")}</p>
      <label className="mb-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="dsettings-finance-enabled"
          checked={v.enabled}
          disabled={ro}
          onChange={(e) => setDraft({ ...v, enabled: e.target.checked })}
        />
        {t("dashSettings.fr_enabled")}
      </label>
      <p className="mb-1 text-sm font-semibold">{t("dashSettings.fr_roles")}</p>
      <ul className="mb-3 flex flex-wrap gap-3 text-sm">
        {cur.roles.map((r) => (
          <li key={r.code}>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                data-testid={`dsettings-finance-role-${r.code}`}
                checked={v.roles.includes(r.code)}
                disabled={ro}
                onChange={() => toggle(r.code)}
              />
              {i18n.language === "ar" && r.name_ar ? r.name_ar : r.name_en}
            </label>
          </li>
        ))}
      </ul>
      {ro ? (
        <p className="text-sm text-mute" data-testid="dsettings-finance-readonly">
          {t("dashSettings.fr_readonly")}
        </p>
      ) : (
        <button className="btn" data-testid="dsettings-finance-save" disabled={same} onClick={() => setOpen(true)}>
          {t("dashSettings.fr_save")}
        </button>
      )}
      {open && (
        <FormDialog
          open
          onClose={() => setOpen(false)}
          testid="dsettings-finance-dialog"
          title={t("dashSettings.fr_title")}
          busy={set.isPending}
          error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) =>
            set.mutate(
              { version: cur.version, enabled: v.enabled, role_codes: v.roles, reason },
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
          <p className="text-sm text-mute">{t(v.enabled ? "dashSettings.fr_confirm_on" : "dashSettings.fr_confirm_off")}</p>
        </FormDialog>
      )}
    </fieldset>
  );
}
