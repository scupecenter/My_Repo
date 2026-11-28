import { useTranslation } from "react-i18next";
import { useSettingsChangeLog } from "@/api/dashboardSettings";
import { QueryFallback } from "@/components/States";

const show = (v: unknown) =>
  v === undefined || v === null ? "-" : typeof v === "object" ? JSON.stringify(v) : String(v);

/**
 * Settings, Dashboard and Goals, change log (contract 0.15.433, settings review gap 6): who changed the settings, when, why and what, read only. It lists the audit rows
 * the saves already write; nothing is written here. Same right as the screens (admin.settings view).
 */
export function SettingsChangeLog({ scope }: { scope: "dashboard" | "goals" }) {
  const { t } = useTranslation();
  const q = useSettingsChangeLog(scope);
  if (!q.data)
    return (
      <fieldset className="rounded-md border border-line p-3">
        <QueryFallback queries={[q]} testid={`change-log-${scope}-loading`} />
      </fieldset>
    );
  const items = q.data.items;
  return (
    <fieldset
      className="space-y-2 rounded-md border border-line p-3"
      data-testid={`change-log-${scope}`}
    >
      <legend className="px-1 text-sm font-semibold">{t("changeLog.title")}</legend>
      <p className="text-xs text-mute">{t("changeLog.note")}</p>
      {items.length === 0 ? (
        <p className="text-sm text-mute" data-testid={`change-log-${scope}-empty`}>
          {t("changeLog.empty")}
        </p>
      ) : (
        <ul className="space-y-2" aria-label={t("changeLog.title")}>
          {items.map((it) => (
            <li key={it.id} className="rounded border border-line p-2 text-sm" data-testid="change-log-row">
              <div className="flex flex-wrap gap-x-3 text-xs text-mute">
                <span className="mono">{new Date(it.at).toLocaleString()}</span>
                <span>{it.actor ? `${it.actor.display_name}${it.actor.employee_id ? ` (${it.actor.employee_id})` : ""}` : "-"}</span>
                <span className="mono">{it.setting}</span>
              </div>
              <div>
                {t("changeLog.reason")}: {it.reason ?? "-"}
              </div>
              <ul className="mono text-xs">
                {it.changes.map((c) => (
                  <li key={c.field}>
                    {c.field}: {show(c.before)} → {show(c.after)}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
