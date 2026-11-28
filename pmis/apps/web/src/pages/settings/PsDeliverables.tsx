import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type PsDeliverablesItemInput,
  usePsDeliverables,
  useSetPsDeliverables,
} from "@/api/dashboardSettings";
import { useListCatalogues } from "@/api/lists";
import { errText, FormDialog } from "@/components/FormDialog";
import { QueryFallback } from "@/components/States";
import { useToast } from "@/components/Toast";
import { UnsavedGuard } from "@/lib/unsavedGuard";

/**
 * Settings, Dashboard, Project Status from the Deliverables register (contract 0.15.470, F4 follow-up 1): per central Project Status item the deliverable kind it
 * reads and a switch auto / manual only. In auto the figure is accepted / non-cancelled deliverables of the kind while at least one exists; otherwise, and in
 * manual, the manual value (kept with its history) shows. Own save, reason and audit row.
 */
export function PsDeliverables() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = usePsDeliverables();
  const cat = useListCatalogues(false);
  const set = useSetPsDeliverables();
  const [draft, setDraft] = useState<Record<string, PsDeliverablesItemInput> | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data)
    return (
      <fieldset className="rounded-md border border-line p-3">
        <QueryFallback queries={[q]} testid="ps-deliv-loading" />
      </fieldset>
    );
  const s = q.data;
  const base: Record<string, PsDeliverablesItemInput> = {};
  for (const i of s.items)
    base[i.item_code] = { item_code: i.item_code, kind: i.kind ?? null, mode: i.mode };
  const cur = draft ?? base;
  const changed = s.items.some((i) => {
    const c = cur[i.item_code]!;
    return c.mode !== i.mode || (c.kind ?? null) !== (i.kind ?? null);
  });
  const kinds = (cat.data?.find((c) => c.code === "DeliverableKind")?.values ?? [])
    .filter((v) => v.is_active)
    .map((v) => v.code);
  const body = () => ({ items: s.items.map((i) => cur[i.item_code]!) });
  const edit = (code: string, patch: Partial<PsDeliverablesItemInput>) =>
    setDraft({ ...cur, [code]: { ...cur[code]!, ...patch } });
  const invalid = s.items.some((i) => cur[i.item_code]!.mode === "auto" && !cur[i.item_code]!.kind);
  return (
    <fieldset className="space-y-2 rounded-md border border-line p-3" data-testid="ps-deliv">
      <legend className="px-1 text-sm font-semibold">{t("psDeliv.title")}</legend>
      <p className="text-xs text-mute">{t("psDeliv.note")}</p>
      <p className="mono text-xs text-mute" data-testid="ps-deliv-version">
        {t("scopeMatch.version", { version: s.version })}
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-start text-xs text-mute">
            <th className="text-start">{t("psDeliv.item")}</th>
            <th className="text-start">{t("psDeliv.kind")}</th>
            <th className="text-start">{t("psDeliv.mode")}</th>
            <th className="text-start">{t("psDeliv.count")}</th>
          </tr>
        </thead>
        <tbody>
          {s.items.map((i) => {
            const c = cur[i.item_code]!;
            const opts = Array.from(new Set([...kinds, ...(c.kind ? [c.kind] : [])]));
            return (
              <tr key={i.item_code} data-testid={`ps-deliv-row-${i.item_code}`}>
                <td>
                  <span className="mono">{i.item_code}</span>{" "}
                  {i18n.language === "ar" && i.name_ar ? i.name_ar : i.name_en}
                </td>
                <td>
                  <select
                    className="input w-32"
                    data-testid={`ps-deliv-kind-${i.item_code}`}
                    value={c.kind ?? ""}
                    onChange={(e) => edit(i.item_code, { kind: e.target.value || null })}
                  >
                    <option value="">{t("psDeliv.none")}</option>
                    {opts.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    className="input w-40"
                    data-testid={`ps-deliv-mode-${i.item_code}`}
                    value={c.mode}
                    onChange={(e) => edit(i.item_code, { mode: e.target.value as "auto" | "manual" })}
                  >
                    <option value="auto">{t("psDeliv.auto")}</option>
                    <option value="manual">{t("psDeliv.manual")}</option>
                  </select>
                </td>
                <td className="text-xs text-mute" data-testid={`ps-deliv-count-${i.item_code}`}>
                  {i.total == null
                    ? "-"
                    : t("psDeliv.counts", { accepted: i.accepted ?? 0, total: i.total })}
                  {" · "}
                  {t(i.source === "deliverables" ? "psDeliv.src_deliverables" : "psDeliv.src_manual")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {invalid && <p className="text-xs text-bad" data-testid="ps-deliv-invalid">{t("psDeliv.kind_required")}</p>}
      <UnsavedGuard
        scope="settings"
        dirty={draft !== null && changed}
        needsReason
        label={t("ui.guard_settings")}
        onSave={(reason) =>
          new Promise<boolean>((res) =>
            set.mutate(
              { version: s.version, body: { ...body(), reason } },
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
        data-testid="ps-deliv-save"
        disabled={draft === null || !changed || invalid}
        onClick={() => setOpen(true)}
      >
        {t("scopeMatch.save")}
      </button>
      {open && (
        <FormDialog
          open
          onClose={() => setOpen(false)}
          testid="ps-deliv-dialog"
          title={t("psDeliv.title")}
          busy={set.isPending}
          error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) =>
            set.mutate(
              { version: s.version, body: { ...body(), reason } },
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
