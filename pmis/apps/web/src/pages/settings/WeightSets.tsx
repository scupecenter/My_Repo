import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import {
  useCreateWeightDraft,
  usePreviewWeights,
  usePublishWeights,
  useSaveWeightDraft,
  useWeightSet,
  useWeightSetList,
} from "@/api/settings";
import type { WeightSet, WeightSetCode, WeightSetInput } from "@/api/types";
import { errText, FormDialog } from "@/components/FormDialog";
import { useToast } from "@/components/Toast";
import { fieldErrors } from "@/lib/fields";
import { tripoliToday } from "@/lib/today";
import { sumOf, weightIssues } from "@/lib/weights";
import { FieldErr } from "./Calendar";

const CODES: WeightSetCode[] = [
  "project_status",
  "health_index",
  "delay_attribution",
];
type Act = WeightSet["activities"][number];
type Problems = { path: string; code: string; message?: string }[];
const problems = (e: unknown): Problems =>
  e instanceof ApiError
    ? ((e.problem as { errors?: Problems }).errors ?? [])
    : [];
/** A weight the contract accepts: 0 to 100 with at most 3 decimals. */
const okWeight = (n: number) =>
  Number.isFinite(n) &&
  n >= 0 &&
  n <= 100 &&
  Math.abs(Math.round(n * 1000) - n * 1000) < 1e-6;

const Sum = ({ sum, testid }: { sum: number; testid: string }) => (
  <span
    className={`chip ${sum === 100 ? "bg-doneBg text-doneInk" : "bg-lateBg text-lateInk"}`}
    data-testid={testid}
    data-ok={sum === 100}
  >
    {sum}%
  </span>
);

function Preview({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const prev = usePreviewWeights(id);
  const run = prev.mutate;
  useEffect(() => {
    run();
  }, [run]);
  const p = prev.data;
  return (
    <FormDialog
      open
      onClose={onClose}
      testid="weights-preview-dialog"
      wide
      withReason={false}
      title={t("wtSet.preview")}
      submitLabel={t("common.close")}
      onSubmit={onClose}
      error={prev.isError ? errText(prev.error, t) : null}
    >
      {prev.isPending && (
        <p className="text-sm text-mute">{t("common.loading")}</p>
      )}
      {p && (
        <div className="space-y-2 text-sm">
          <p>
            <span
              className={`chip ${p.valid ? "bg-doneBg text-doneInk" : "bg-lateBg text-lateInk"}`}
              data-testid="weights-preview-valid"
              data-valid={p.valid}
            >
              {p.valid ? t("rules.valid") : t("rules.invalid")}
            </span>
          </p>
          {p.errors.length > 0 && (
            <ul role="alert" className="text-lateInk">
              {p.errors.map((e) => (
                <li
                  key={e.path}
                  data-testid={`weights-preview-error-${e.path.replace(/\//g, "-")}`}
                  data-code={e.code}
                >
                  {t(`fieldError.${e.code}`, { defaultValue: e.code })}{" "}
                  <span className="mono" dir="ltr">
                    {e.path}
                  </span>{" "}
                  {e.message}
                </li>
              ))}
            </ul>
          )}
          {p.progress_current_pct !== null && (
            <p data-testid="weights-preview-progress">
              {t("wtSet.progress", {
                cur: p.progress_current_pct,
                next: p.progress_new_pct ?? "-",
              })}
            </p>
          )}
        </div>
      )}
    </FormDialog>
  );
}

function Publish({
  id,
  etag,
  onClose,
}: {
  id: string;
  etag: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const pub = usePublishWeights(id);
  const [date, setDate] = useState(tripoliToday());
  const list = problems(pub.error),
    errs = fieldErrors(pub.error);
  return (
    <FormDialog
      open
      onClose={onClose}
      testid="weights-publish-dialog"
      title={t("wtSet.publish")}
      busy={pub.isPending}
      error={pub.isError && !list.length ? errText(pub.error, t) : null}
      onSubmit={(reason) =>
        pub.mutate(
          { etag, effective_date: date, reason },
          {
            onSuccess: () => {
              toast(`${t("settings.audited")} ${t("wtSet.recalc")}`);
              onClose();
            },
          },
        )
      }
    >
      <label className="block text-sm font-semibold">
        {t("slaSet.effective_date")}
        <input
          type="date"
          min={tripoliToday()}
          className="input mt-1 font-normal"
          data-testid="weights-publish-date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <span className="text-xs text-mute">{t("slaSet.tz_note")}</span>
      <FieldErr errs={errs} path="/effective_date" />
      <p className="text-xs text-mute">{t("wtSet.snapshots")}</p>
      {list.filter((e) => e.path !== "/effective_date").length > 0 && (
        <ul
          role="alert"
          className="text-xs text-lateInk"
          data-testid="weights-publish-errors"
        >
          {list
            .filter((e) => e.path !== "/effective_date")
            .map((e) => (
              <li
                key={`${e.path}${e.code}`}
                data-testid={`weights-publish-error-${e.path.replace(/\//g, "-")}`}
                data-code={e.code}
              >
                {t(`fieldError.${e.code}`, { defaultValue: e.code })}{" "}
                <span className="mono" dir="ltr">
                  {e.path}
                </span>{" "}
                {e.message}
              </li>
            ))}
        </ul>
      )}
    </FormDialog>
  );
}

function Editor({ id, pin }: { id: string; pin: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useWeightSet(id),
    save = useSaveWeightDraft(id);
  const [acts, setActs] = useState<Act[] | null>(null);
  const [dlg, setDlg] = useState<null | "save" | "preview" | "publish">(null);
  const set = q.data?.data,
    etag = q.data?.etag ?? 0;
  if (!set)
    return (
      <section className="card p-4 text-mute">{t("common.loading")}</section>
    );
  const draft = set.status === "draft",
    view = acts ?? set.activities,
    dirty = acts !== null;
  const issues = weightIssues({ activities: view }),
    top = issues.find((i) => i.level === "activities");
  const invalid = view.some(
    (a) =>
      !okWeight(a.weight) ||
      !a.name_en.trim() ||
      a.items.some((i) => !okWeight(i.weight) || !i.name_en.trim()),
  );
  const setAct = (ai: number, patch: Partial<Act>) =>
    setActs(view.map((a, k) => (k === ai ? { ...a, ...patch } : a)));
  const setItem = (
    ai: number,
    ii: number,
    patch: Partial<Act["items"][number]>,
  ) =>
    setAct(ai, {
      items: view[ai].items.map((x, k) => (k === ii ? { ...x, ...patch } : x)),
    });
  const addItem = (ai: number) => {
    const a = view[ai];
    let n = a.items.length + 1;
    while (a.items.some((x) => x.code === `${a.code}_${n}`)) n++;
    setAct(ai, {
      items: [
        ...a.items,
        {
          code: `${a.code}_${n}`,
          name_en: "",
          name_ar: null,
          weight: 0,
          unit: null,
          measure_rule: null,
        },
      ],
    });
  };
  const ar = i18n.language === "ar";
  const body = (reason: string): WeightSetInput => ({
    reason,
    activities: view.map((a) => ({
      code: a.code,
      name_en: a.name_en.trim(),
      name_ar: a.name_ar || null,
      weight: a.weight,
      items: a.items.map((i) => ({
        code: i.code,
        name_en: i.name_en.trim(),
        name_ar: i.name_ar || null,
        weight: i.weight,
        unit: i.unit || null,
        measure_rule: i.measure_rule || null,
        source: i.source ?? null,
      })),
    })),
  });
  const serverErrs = fieldErrors(save.error);
  const num = (v: string) => (v === "" ? NaN : Number(v));

  return (
    <section className="card space-y-3 p-4" data-testid={`weights-${set.code}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="me-auto font-bold">
          {t(`rules.set_${set.code}`)}{" "}
          <span className="mono text-xs text-mute">v{set.version}</span>
        </h2>
        <span
          className={`chip ${set.status === "published" ? "bg-doneBg text-doneInk" : "bg-waitBg text-waitInk"}`}
          data-testid="weights-status"
        >
          {t(`rules.status_${set.status}`)}
        </span>
        <span
          className={`chip ${issues.length ? "bg-lateBg text-lateInk" : "bg-doneBg text-doneInk"}`}
          data-testid={`weights-valid-${set.code}`}
        >
          {issues.length ? t("rules.invalid") : t("rules.valid")}
        </span>
        {draft && (
          <>
            <button
              className="btn"
              data-testid="weights-save"
              disabled={!dirty || invalid || save.isPending}
              onClick={() => setDlg("save")}
            >
              {t("common.save")}
            </button>
            <button
              className="btn"
              data-testid="weights-preview"
              disabled={dirty}
              title={dirty ? t("slaSet.save_first") : undefined}
              onClick={() => setDlg("preview")}
            >
              {t("wtSet.preview")}
            </button>
            <button
              className="btn btn-accent"
              data-testid={`weights-publish-${set.code}`}
              disabled={dirty}
              title={dirty ? t("slaSet.save_first") : undefined}
              onClick={() => setDlg("publish")}
            >
              {t("wtSet.publish")}
            </button>
          </>
        )}
      </div>
      {draft && dirty && (
        <p className="text-xs text-mute">{t("slaSet.save_first")}</p>
      )}
      <div className="flex items-center gap-2 text-sm font-semibold">
        {t("wtSet.sum_activities")}
        <Sum
          sum={sumOf(view.map((a) => a.weight))}
          testid="weights-sum-activities"
        />
      </div>
      {top && (
        <p
          role="alert"
          className="text-sm font-semibold text-lateInk"
          data-testid={`weights-error-${set.code}`}
        >
          {t("rules.sum_activities", { sum: top.sum })}
        </p>
      )}
      <ul className="space-y-3 text-sm">
        {view.map((a, ai) => {
          const bad = issues.find((i) => i.activity === a.code);
          return (
            <li
              key={a.code}
              className="rounded-md border border-line p-2"
              data-testid={`weights-activity-${set.code}-${a.code}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="mono w-10 text-xs text-mute">{a.code}</span>
                {draft ? (
                  <>
                    <input
                      className="input min-w-40 flex-1"
                      aria-label={t("wtSet.name_en")}
                      data-testid={`weights-name-${a.code}`}
                      value={a.name_en}
                      onChange={(e) => setAct(ai, { name_en: e.target.value })}
                    />
                    <input
                      className="input min-w-40 flex-1"
                      dir="rtl"
                      aria-label={t("wtSet.name_ar")}
                      data-testid={`weights-name-ar-${a.code}`}
                      value={a.name_ar ?? ""}
                      onChange={(e) => setAct(ai, { name_ar: e.target.value })}
                    />
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.001}
                      className="input w-24"
                      aria-label={t("wtSet.weight")}
                      aria-invalid={!okWeight(a.weight)}
                      data-testid={`weights-weight-${a.code}`}
                      value={Number.isNaN(a.weight) ? "" : a.weight}
                      onChange={(e) =>
                        setAct(ai, { weight: num(e.target.value) })
                      }
                    />
                  </>
                ) : (
                  <>
                    <span className="flex-1">
                      {(ar && a.name_ar) || a.name_en}
                    </span>
                    <span className="mono">{a.weight}%</span>
                  </>
                )}
              </div>
              {(a.items.length > 0 || draft) && (
                <div className="ms-4 mt-2 space-y-1">
                  {a.items.map((it, ii) => (
                    <div
                      key={it.code}
                      className="flex flex-wrap items-center gap-2"
                      data-testid={`weights-item-${set.code}-${it.code}`}
                    >
                      {draft ? (
                        <>
                          <input
                            className="input min-w-32 flex-1"
                            aria-label={t("wtSet.name_en")}
                            data-testid={`weights-item-name-${it.code}`}
                            value={it.name_en}
                            onChange={(e) =>
                              setItem(ai, ii, { name_en: e.target.value })
                            }
                          />
                          <input
                            className="input min-w-32 flex-1"
                            dir="rtl"
                            aria-label={t("wtSet.name_ar")}
                            data-testid={`weights-item-name-ar-${it.code}`}
                            value={it.name_ar ?? ""}
                            onChange={(e) =>
                              setItem(ai, ii, { name_ar: e.target.value })
                            }
                          />
                          <input
                            className="input w-24"
                            aria-label={t("wtSet.unit")}
                            placeholder={t("wtSet.unit")}
                            data-testid={`weights-item-unit-${it.code}`}
                            value={it.unit ?? ""}
                            onChange={(e) =>
                              setItem(ai, ii, { unit: e.target.value })
                            }
                          />
                          <input
                            className="input min-w-40 flex-1"
                            aria-label={t("wtSet.measure")}
                            placeholder={t("wtSet.measure")}
                            data-testid={`weights-item-measure-${it.code}`}
                            value={it.measure_rule ?? ""}
                            onChange={(e) =>
                              setItem(ai, ii, { measure_rule: e.target.value })
                            }
                          />
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={0.001}
                            className="input w-24"
                            aria-label={t("wtSet.weight")}
                            aria-invalid={!okWeight(it.weight)}
                            data-testid={`weights-item-weight-${it.code}`}
                            value={Number.isNaN(it.weight) ? "" : it.weight}
                            onChange={(e) =>
                              setItem(ai, ii, { weight: num(e.target.value) })
                            }
                          />
                          <button
                            className="btn"
                            aria-label={t("common.remove")}
                            data-testid={`weights-item-remove-${it.code}`}
                            onClick={() =>
                              setAct(ai, {
                                items: a.items.filter((_, k) => k !== ii),
                              })
                            }
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="flex-1 text-mute">
                            {(ar && it.name_ar) || it.name_en}
                          </span>
                          <span className="text-xs text-mute">{it.unit}</span>
                          <span className="mono">{it.weight}%</span>
                        </>
                      )}
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    {a.items.length > 0 && (
                      <>
                        <span className="text-xs text-mute">
                          {t("wtSet.sum_items")}
                        </span>
                        <Sum
                          sum={sumOf(a.items.map((i) => i.weight))}
                          testid={`weights-sum-items-${a.code}`}
                        />
                      </>
                    )}
                    {draft && (
                      <button
                        className="btn"
                        data-testid={`weights-item-add-${a.code}`}
                        onClick={() => addItem(ai)}
                      >
                        <Plus size={14} />
                        {t("wtSet.add_item")}
                      </button>
                    )}
                  </div>
                  {bad && (
                    <p
                      role="alert"
                      className="text-xs text-lateInk"
                      data-testid={`weights-error-${set.code}-${a.code}`}
                    >
                      {t("rules.sum_items", { sum: bad.sum })}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {dlg === "save" && (
        <FormDialog
          open
          onClose={() => setDlg(null)}
          testid="weights-save-dialog"
          title={t("wtSet.save_title")}
          busy={save.isPending}
          error={
            save.isError
              ? Object.keys(serverErrs).length
                ? t("errors.validation_failed")
                : errText(save.error, t)
              : null
          }
          onSubmit={(reason) =>
            save.mutate(
              { etag, body: body(reason) },
              {
                onSuccess: () => {
                  toast(t("settings.audited"));
                  setActs(null);
                  setDlg(null);
                },
              },
            )
          }
        >
          <p className="text-xs text-mute">{t("wtSet.save_note")}</p>
        </FormDialog>
      )}
      {dlg === "preview" && <Preview id={id} onClose={() => setDlg(null)} />}
      {dlg === "publish" && (
        <Publish id={id} etag={etag} onClose={() => { pin(); setDlg(null); }} />
      )}
    </section>
  );
}

export function WeightSets() {
  const { t } = useTranslation();
  const toast = useToast();
  const [code, setCode] = useState<WeightSetCode>("project_status");
  const [sel, setSel] = useState<string>();
  const [open, setOpen] = useState(false);
  const [base, setBase] = useState("");
  const all = useWeightSetList(),
    create = useCreateWeightDraft();
  const sets = (all.data ?? []).filter((w) => w.code === code);
  const draft = sets.find((w) => w.status === "draft"),
    active = sets.find((w) => w.is_active);
  const id =
    (sel && sets.some((w) => w.id === sel) ? sel : undefined) ??
    draft?.id ??
    active?.id;
  const openDraft = (d?: WeightSet) => {
    if (d) setSel(d.id);
  };
  return (
    <div className="space-y-4" data-testid="page-weights">
      <section className="card space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input w-auto"
            aria-label={t("wtSet.set")}
            data-testid="weights-code"
            value={code}
            onChange={(e) => {
              setCode(e.target.value as WeightSetCode);
              setSel(undefined);
            }}
          >
            {CODES.map((c) => (
              <option key={c} value={c}>
                {t(`rules.set_${c}`)}
              </option>
            ))}
          </select>
          <span className="me-auto" />
          {draft ? (
            <button
              className="btn"
              data-testid="weights-open-draft"
              onClick={() => openDraft(draft)}
            >
              {t("slaSet.open_draft")}
            </button>
          ) : (
            <button
              className="btn btn-accent"
              data-testid="weights-create-draft"
              onClick={() => {
                setBase("");
                setOpen(true);
              }}
            >
              {t("slaSet.create_draft")}
            </button>
          )}
        </div>
        <p className="text-sm text-mute">{t("wtSet.note")}</p>
      </section>
      {id && <Editor key={id} id={id} pin={() => setSel(id)} />}
      <section className="card overflow-x-auto p-4">
        <h2 className="mb-2 font-bold">{t("rules.versions")}</h2>
        <table className="w-full text-sm">
          <thead className="text-mute">
            <tr>
              {["version", "effective", "who", "when", "why"].map((k) => (
                <th key={k} className="p-2 text-start">
                  {t(`slaSet.vcol_${k}`)}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody data-testid="weights-versions">
            {sets.map((w) => (
              <tr
                key={w.id}
                className="border-t border-line"
                data-testid={`weights-version-${w.code}-${w.version}`}
              >
                <td className="p-2">
                  v{w.version}{" "}
                  <span
                    className={`chip ms-1 ${w.status === "published" ? "bg-doneBg text-doneInk" : "bg-waitBg text-waitInk"}`}
                  >
                    {t(`rules.status_${w.status}`)}
                  </span>
                  {w.is_active && (
                    <span className="chip ms-1 bg-doneBg text-doneInk">
                      {t("rules.current")}
                    </span>
                  )}
                </td>
                <td className="mono p-2 text-xs">
                  {w.effective_from}
                  {w.effective_to ? ` → ${w.effective_to}` : ""}
                </td>
                <td className="p-2">{w.changed_by?.display_name}</td>
                <td className="mono p-2 text-xs">
                  {(w.published_at ?? w.created_at ?? "").slice(0, 10)}
                </td>
                <td className="p-2 text-mute">{w.reason}</td>
                <td className="p-2 text-end">
                  <button
                    className="btn"
                    data-testid={`weights-view-${w.code}-${w.version}`}
                    onClick={() => setSel(w.id)}
                  >
                    {t("slaSet.view")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {open && (
        <FormDialog
          open
          onClose={() => setOpen(false)}
          testid="weights-create-dialog"
          title={t("slaSet.create_draft")}
          busy={create.isPending}
          error={
            create.isError && create.error.status !== 409
              ? errText(create.error, t)
              : null
          }
          onSubmit={(reason) =>
            create.mutate(
              { code, reason, ...(base ? { base_set_id: base } : {}) },
              {
                onSuccess: (d) => {
                  toast(t("slaSet.draft_created"));
                  setSel(d.id);
                  setOpen(false);
                },
                // One draft per set: a 409 means it exists, so open it.
                onError: (e) => {
                  if (e.status === 409) {
                    toast(t("slaSet.draft_exists"));
                    setOpen(false);
                    void all
                      .refetch()
                      .then((r) =>
                        openDraft(
                          r.data?.find(
                            (w) => w.code === code && w.status === "draft",
                          ),
                        ),
                      );
                  }
                },
              },
            )
          }
        >
          <label className="block text-sm font-semibold">
            {t("wtSet.base")}
            <select
              className="input mt-1 font-normal"
              data-testid="weights-base"
              value={base}
              onChange={(e) => setBase(e.target.value)}
            >
              <option value="">{t("wtSet.base_current")}</option>
              {sets
                .filter((w) => w.status === "published" && !w.is_active)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    v{w.version} · {w.effective_from}
                  </option>
                ))}
            </select>
          </label>
        </FormDialog>
      )}
    </div>
  );
}
