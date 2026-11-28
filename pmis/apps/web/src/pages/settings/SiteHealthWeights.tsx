import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSetSiteHealthWeights, useSiteHealthWeights } from "@/api/siteHealth";
import { errText, FormDialog } from "@/components/FormDialog";
import { QueryFallback } from "@/components/States";
import { useToast } from "@/components/Toast";

const KEYS = ["tasks", "docs", "snags", "delay"] as const;
type K = (typeof KEYS)[number];

/** The weights are whole numbers 0 to 100 and at least one counts. */
export function weightsInvalid(w: Record<K, number>): boolean {
  return KEYS.some((k) => !Number.isInteger(w[k]) || w[k] < 0 || w[k] > 100) || KEYS.every((k) => w[k] === 0);
}

/** Settings, Dashboard, site health weights (contract 0.15.591): how much tasks, documents, snags and delay count in a site's score. Own save, reason and audit row. */
export function SiteHealthWeights() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useSiteHealthWeights();
  const set = useSetSiteHealthWeights();
  const [draft, setDraft] = useState<Record<K, string> | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data)
    return (
      <fieldset className="rounded-md border border-line p-3">
        <QueryFallback queries={[q]} testid="site-health-weights-loading" />
      </fieldset>
    );
  const s = q.data;
  const cur: Record<K, string> = draft ?? { tasks: String(s.tasks), docs: String(s.docs), snags: String(s.snags), delay: String(s.delay) };
  const nums = Object.fromEntries(KEYS.map((k) => [k, cur[k] === "" ? NaN : Number(cur[k])])) as Record<K, number>;
  const invalid = weightsInvalid(nums);
  const changed = KEYS.some((k) => nums[k] !== s[k]);
  const body = { ...nums, reason: "" };
  return (
    <fieldset className="space-y-2 rounded-md border border-line p-3" data-testid="site-health-weights">
      <legend className="px-1 text-sm font-semibold">{t("siteHealthWeights.title")}</legend>
      <p className="text-xs text-mute">{t("siteHealthWeights.note")}</p>
      <p className="mono text-xs text-mute" data-testid="site-health-weights-version">{t("scopeMatch.version", { version: s.version })}</p>
      <div className="flex flex-wrap items-end gap-4">
        {KEYS.map((k) => (
          <label key={k} className="block text-sm" title={t(`dash.siteHealth.factor_hint.${k}`)}>
            {t(`dash.siteHealth.factor.${k}`)}
            <input
              type="number"
              min={0}
              max={100}
              className="input mt-1 w-24"
              data-testid={`site-health-weights-${k}`}
              value={cur[k]}
              onChange={(e) => setDraft({ ...cur, [k]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {invalid && <p className="text-sm text-lateInk" data-testid="site-health-weights-invalid">{t("siteHealthWeights.invalid")}</p>}
      <button className="btn btn-accent" data-testid="site-health-weights-save" disabled={!draft || !changed || invalid} onClick={() => setOpen(true)}>
        {t("scopeMatch.save")}
      </button>
      {open && (
        <FormDialog
          open
          onClose={() => setOpen(false)}
          testid="site-health-weights-dialog"
          title={t("siteHealthWeights.title")}
          busy={set.isPending}
          error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) =>
            set.mutate(
              { version: s.version, body: { ...body, reason } },
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
