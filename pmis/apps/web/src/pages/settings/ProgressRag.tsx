import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useProgressRag, useSetProgressRag } from "@/api/dashboardSettings";
import { errText, FormDialog } from "@/components/FormDialog";
import { QueryFallback } from "@/components/States";
import { useToast } from "@/components/Toast";
import { UnsavedGuard } from "@/lib/unsavedGuard";

interface Row {
  enabled: boolean;
  green: string;
  amber: string;
}
type Draft = Record<string, Row>;

/**
 * Settings, Dashboard, colours of the progress figures (contract 0.15.432, settings review gap 5): green and amber for the SPI, the progress against plan (points) and the
 * weekly velocity of the progress curve (points per week). Higher is better. Nothing is coloured until a row is turned on and saved, so nothing changes on deploy; the
 * suggested numbers are shown for each row and are not stored until saved. Own save, reason and audit row.
 */
export function ProgressRag() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useProgressRag();
  const set = useSetProgressRag();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data)
    return (
      <fieldset className="rounded-md border border-line p-3">
        <QueryFallback queries={[q]} testid="progress-rag-loading" />
      </fieldset>
    );
  const items = q.data.items;
  const base: Draft = Object.fromEntries(
    items.map((i) => [i.code, { enabled: i.enabled, green: String(i.green), amber: String(i.amber) }]),
  );
  const cur = draft ?? base;
  const num = (s: string) => (s.trim() === "" ? NaN : Number(s));
  const errorOf = (code: string): string | null => {
    const it = items.find((i) => i.code === code)!;
    const r = cur[code]!;
    const g = num(r.green);
    const a = num(r.amber);
    if (Number.isNaN(g) || Number.isNaN(a) || g < it.min || g > it.max || a < it.min || a > it.max)
      return t("progressRag.range", { min: it.min, max: it.max });
    if (g < a) return t("progressRag.order");
    return null;
  };
  const invalid = items.some((i) => errorOf(i.code) !== null);
  const changed = items.some((i) => {
    const r = cur[i.code]!;
    return r.enabled !== i.enabled || num(r.green) !== i.green || num(r.amber) !== i.amber;
  });
  const body = (reason: string) => ({
    reason,
    items: Object.fromEntries(
      items.map((i) => [i.code, { enabled: cur[i.code]!.enabled, green: num(cur[i.code]!.green), amber: num(cur[i.code]!.amber) }]),
    ) as never,
  });
  const patch = (code: string, p: Partial<Row>) => setDraft({ ...cur, [code]: { ...cur[code]!, ...p } });
  const label = (i: { label_en: string; label_ar: string }) => (i18n.language.startsWith("ar") ? i.label_ar : i.label_en);
  return (
    <fieldset className="space-y-2 rounded-md border border-line p-3" data-testid="progress-rag">
      <legend className="px-1 text-sm font-semibold">{t("progressRag.title")}</legend>
      <p className="text-xs text-mute">{t("progressRag.note")}</p>
      <p className="mono text-xs text-mute" data-testid="progress-rag-version">
        {t("scopeMatch.version", { version: q.data.version })}
      </p>
      <ul className="space-y-2">
        {items.map((i) => {
          const r = cur[i.code]!;
          const err = errorOf(i.code);
          return (
            <li key={i.code} className="flex flex-wrap items-center gap-3" data-testid={`progress-rag-row-${i.code}`}>
              <label className="flex min-w-60 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  aria-label={`${t("progressRag.enabled")}: ${label(i)}`}
                  data-testid={`progress-rag-on-${i.code}`}
                  onChange={(e) => patch(i.code, { enabled: e.target.checked })}
                />
                {label(i)}
              </label>
              <label className="text-sm">
                {t("progressRag.green")}
                <input
                  className="input ms-1 w-24"
                  inputMode="decimal"
                  data-testid={`progress-rag-green-${i.code}`}
                  value={r.green}
                  onChange={(e) => patch(i.code, { green: e.target.value })}
                />
              </label>
              <label className="text-sm">
                {t("progressRag.amber")}
                <input
                  className="input ms-1 w-24"
                  inputMode="decimal"
                  data-testid={`progress-rag-amber-${i.code}`}
                  value={r.amber}
                  onChange={(e) => patch(i.code, { amber: e.target.value })}
                />
              </label>
              <button
                type="button"
                className="btn"
                data-testid={`progress-rag-suggest-${i.code}`}
                onClick={() => patch(i.code, { green: String(i.default_green), amber: String(i.default_amber) })}
              >
                {t("progressRag.suggest", { green: i.default_green, amber: i.default_amber })}
              </button>
              {err && (
                <span className="text-xs text-lateInk" role="alert" data-testid={`progress-rag-error-${i.code}`}>
                  {err}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <UnsavedGuard
        scope="settings"
        dirty={draft !== null && changed && !invalid}
        needsReason
        label={t("ui.guard_settings")}
        onSave={(reason) =>
          new Promise<boolean>((res) =>
            set.mutate(
              { version: q.data!.version, body: body(reason) },
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
        data-testid="progress-rag-save"
        disabled={draft === null || !changed || invalid}
        onClick={() => setOpen(true)}
      >
        {t("scopeMatch.save")}
      </button>
      {open && (
        <FormDialog
          open
          onClose={() => setOpen(false)}
          testid="progress-rag-dialog"
          title={t("progressRag.title")}
          busy={set.isPending}
          error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) =>
            set.mutate(
              { version: q.data!.version, body: body(reason) },
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
