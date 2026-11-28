import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useSetSnapshotSchedule,
  useSnapshotSchedule,
} from "@/api/dashboardSettings";
import { errText, FormDialog } from "@/components/FormDialog";
import { QueryFallback } from "@/components/States";
import { useToast } from "@/components/Toast";
import { UnsavedGuard } from "@/lib/unsavedGuard";

const DAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Settings, Dashboard, weekly snapshot day (contract 0.15.430, settings review gap 3): the weekday on which the nightly job takes the weekly dashboard snapshot
 * (setting `dashboard.snapshot_weekday`; 0 = Sunday ... 6 = Saturday, Tripoli dates). The month-end snapshot has no setting. `dashboard.snapshot_every_days` is
 * not shown: it has been unused since migration 0046, so a field for it would change nothing. Own save, reason and audit row. A change applies from the next
 * snapshot and never moves a stored one.
 */
export function SnapshotSchedule() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useSnapshotSchedule();
  const set = useSetSnapshotSchedule();
  const [draft, setDraft] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data)
    return (
      <fieldset className="rounded-md border border-line p-3">
        <QueryFallback queries={[q]} testid="snapshot-schedule-loading" />
      </fieldset>
    );
  const s = q.data;
  const cur = draft ?? s.weekday;
  const changed = cur !== s.weekday;
  return (
    <fieldset
      className="space-y-2 rounded-md border border-line p-3"
      data-testid="snapshot-schedule"
    >
      <legend className="px-1 text-sm font-semibold">
        {t("snapshotSchedule.title")}
      </legend>
      <p className="text-xs text-mute">{t("snapshotSchedule.note")}</p>
      <p className="mono text-xs text-mute" data-testid="snapshot-schedule-version">
        {t("scopeMatch.version", { version: s.version })}
      </p>
      <label className="block text-sm">
        {t("snapshotSchedule.weekday")}
        <select
          className="input mt-1 w-48"
          data-testid="snapshot-schedule-weekday"
          value={cur}
          onChange={(e) => setDraft(Number(e.target.value))}
        >
          {DAYS.map((d) => (
            <option key={d} value={d}>
              {t(`weekday.${d}`)}
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
              { version: s.version, body: { weekday: cur, reason } },
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
        data-testid="snapshot-schedule-save"
        disabled={draft === null || !changed}
        onClick={() => setOpen(true)}
      >
        {t("scopeMatch.save")}
      </button>
      {open && (
        <FormDialog
          open
          onClose={() => setOpen(false)}
          testid="snapshot-schedule-dialog"
          title={t("snapshotSchedule.title")}
          busy={set.isPending}
          error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) =>
            set.mutate(
              { version: s.version, body: { weekday: cur, reason } },
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
