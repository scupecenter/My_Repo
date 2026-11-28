import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useHealthBands, useSetHealthBands } from "@/api/dashboardSettings";
import { errText, FormDialog } from "@/components/FormDialog";
import { QueryFallback } from "@/components/States";
import { useToast } from "@/components/Toast";
import { UnsavedGuard } from "@/lib/unsavedGuard";

/** The edge values of the health index bands. A band edge is a whole number; green is above amber, red is everything below amber. */
export function bandsInvalid(green: number, amber: number): boolean {
  return (
    !Number.isInteger(green) ||
    !Number.isInteger(amber) ||
    green < 1 ||
    green > 100 ||
    amber < 0 ||
    amber > 99 ||
    green <= amber
  );
}

/**
 * Settings, Dashboard, health index bands (contract 0.15.435, settings review gap 8): the score from which the health index is green and the score
 * from which it is amber (red below). The setting is `dashboard.health_bands`; this card has its own save, reason and audit row. A change colours the live
 * index from the save on and never rewrites a stored snapshot.
 */
export function HealthBands() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useHealthBands();
  const set = useSetHealthBands();
  const [draft, setDraft] = useState<{ green: string; amber: string } | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  if (!q.data)
    return (
      <fieldset className="rounded-md border border-line p-3">
        <QueryFallback queries={[q]} testid="health-bands-loading" />
      </fieldset>
    );
  const s = q.data;
  const cur = draft ?? { green: String(s.green), amber: String(s.amber) };
  const g = cur.green === "" ? NaN : Number(cur.green);
  const a = cur.amber === "" ? NaN : Number(cur.amber);
  const invalid = bandsInvalid(g, a);
  const changed = g !== s.green || a !== s.amber;
  return (
    <fieldset
      className="space-y-2 rounded-md border border-line p-3"
      data-testid="health-bands"
    >
      <legend className="px-1 text-sm font-semibold">
        {t("healthBands.title")}
      </legend>
      <p className="text-xs text-mute">{t("healthBands.note")}</p>
      <p className="mono text-xs text-mute" data-testid="health-bands-version">
        {t("scopeMatch.version", { version: s.version })}
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <label className="block text-sm">
          {t("healthBands.green")}
          <input
            type="number"
            min={1}
            max={100}
            className="input mt-1 w-28"
            data-testid="health-bands-green"
            value={cur.green}
            onChange={(e) => setDraft({ ...cur, green: e.target.value })}
          />
        </label>
        <label className="block text-sm">
          {t("healthBands.amber")}
          <input
            type="number"
            min={0}
            max={99}
            className="input mt-1 w-28"
            data-testid="health-bands-amber"
            value={cur.amber}
            onChange={(e) => setDraft({ ...cur, amber: e.target.value })}
          />
        </label>
        <p className="text-sm text-mute" data-testid="health-bands-red">
          {t("healthBands.red", { amber: Number.isFinite(a) ? a : "" })}
        </p>
      </div>
      {invalid && (
        <p className="text-sm text-lateInk" data-testid="health-bands-invalid">
          {t("healthBands.invalid")}
        </p>
      )}
      <UnsavedGuard
        scope="settings"
        dirty={!!draft && changed && !invalid}
        needsReason
        label={t("ui.guard_settings")}
        onSave={(reason) =>
          new Promise<boolean>((res) =>
            set.mutate(
              { version: s.version, body: { green: g, amber: a, reason } },
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
        data-testid="health-bands-save"
        disabled={!draft || !changed || invalid}
        onClick={() => setOpen(true)}
      >
        {t("scopeMatch.save")}
      </button>
      {open && (
        <FormDialog
          open
          onClose={() => setOpen(false)}
          testid="health-bands-dialog"
          title={t("healthBands.title")}
          busy={set.isPending}
          error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) =>
            set.mutate(
              { version: s.version, body: { green: g, amber: a, reason } },
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
