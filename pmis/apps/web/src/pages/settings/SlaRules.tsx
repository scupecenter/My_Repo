import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import { useRegions } from "@/api/sites";
import {
  useCreateSlaDraft,
  usePreviewSla,
  usePublishSla,
  useSaveSlaDraft,
  useSlaSet,
  useSlaSets,
  useStartEvents,
} from "@/api/settings";
import type {
  DeliveryScenario,
  SlaRuleOverride,
  SlaRuleSetSummary,
  SlaTaskRule,
} from "@/api/types";
import { errText, FormDialog } from "@/components/FormDialog";
import { useToast } from "@/components/Toast";
import { fieldErrors } from "@/lib/fields";
import { tripoliToday } from "@/lib/today";
import { FieldErr } from "./Calendar";

const SCENARIOS: DeliveryScenario[] = [
  "new_build",
  "expansion",
  "hot_swap",
  "cold_swap",
  "relocation",
];
const who = (s: SlaRuleSetSummary) =>
  (s.published_by ?? s.created_by)?.display_name ?? "";

/** Live check of one min/max pair, the same rule as the server (`min_exceeds_max`). */
const bad = (r: { min_working_days: number; max_working_days: number }) =>
  !Number.isInteger(r.min_working_days) ||
  !Number.isInteger(r.max_working_days) ||
  r.min_working_days < 0 ||
  r.max_working_days > 365 ||
  r.min_working_days > r.max_working_days;

function PreviewDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const prev = usePreviewSla(id);
  const [date, setDate] = useState(tripoliToday());
  const run = prev.mutate;
  useEffect(() => {
    if (date) run({ effective_date: date });
  }, [date, run]);
  const p = prev.data,
    errs = fieldErrors(prev.error);
  return (
    <FormDialog
      open
      onClose={onClose}
      testid="sla-preview-dialog"
      wide
      withReason={false}
      title={t("slaSet.preview")}
      submitLabel={t("common.close")}
      onSubmit={onClose}
    >
      <label className="block text-sm font-semibold">
        {t("slaSet.effective_date")}
        <input
          type="date"
          min={tripoliToday()}
          className="input mt-1 font-normal"
          data-testid="sla-preview-date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <FieldErr errs={errs} path="/effective_date" />
      {prev.isPending && (
        <p className="text-sm text-mute">{t("common.loading")}</p>
      )}
      {p && (
        <div data-testid="sla-preview-result" className="space-y-2 text-sm">
          <p>
            <strong data-testid="sla-preview-changed">
              {p.changed_due_date_count}
            </strong>{" "}
            {t("slaSet.preview_changed", { total: p.open_tasks_total })}
          </p>
          <p className="text-mute">
            {t("slaSet.preview_late", {
              late: p.became_late_count,
              ok: p.no_longer_late_count,
            })}
          </p>
          <ul className="max-h-40 overflow-y-auto">
            {p.by_task.map((b) => (
              <li
                key={b.task_code}
                className="flex gap-2"
                data-testid={`sla-preview-task-${b.task_code}`}
              >
                <span className="mono w-16">{b.task_code}</span>
                <span className="flex-1 text-mute">
                  {t("slaSet.preview_task", { open: b.open_tasks })}
                </span>
                <span className="mono">{b.changed}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-mute">
            {t("slaSet.preview_samples", { count: p.samples.length })}
          </p>
        </div>
      )}
      {prev.isError && !Object.keys(errs).length && (
        <p role="alert" className="text-lateInk">
          {errText(prev.error, t)}
        </p>
      )}
    </FormDialog>
  );
}

function PublishDialog({
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
  const pub = usePublishSla(id);
  const [date, setDate] = useState(tripoliToday());
  const [apply, setApply] = useState(false);
  const errs = fieldErrors(pub.error);
  const others = Object.entries(errs).filter(([p]) => p !== "/effective_date");
  return (
    <FormDialog
      open
      onClose={onClose}
      testid="sla-publish-dialog"
      title={t("slaSet.publish")}
      busy={pub.isPending}
      error={
        pub.isError && !Object.keys(errs).length ? errText(pub.error, t) : null
      }
      onSubmit={(reason) =>
        pub.mutate(
          { etag, effective_date: date, reason, apply_to_open_tasks: apply },
          {
            onSuccess: (r) => {
              toast(
                `${t("settings.audited")} ${t("slaSet.published", { count: r.affected_open_tasks })}`,
              );
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
          data-testid="sla-publish-date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <span className="text-xs text-mute">{t("slaSet.tz_note")}</span>
      <FieldErr errs={errs} path="/effective_date" />
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input
          type="checkbox"
          data-testid="sla-publish-apply"
          checked={apply}
          onChange={(e) => setApply(e.target.checked)}
        />
        {t("slaSet.apply")}
      </label>
      <p
        className="rounded-md bg-waitBg p-2 text-xs text-waitInk"
        data-testid="sla-publish-warning"
      >
        {t("slaSet.apply_warning")}
      </p>
      {others.length > 0 && (
        <ul
          role="alert"
          className="text-xs text-lateInk"
          data-testid="sla-publish-errors"
        >
          {others.map(([p, c]) => (
            <li key={p} data-testid={`sla-publish-error-${c}`}>
              {t(`fieldError.${c}`, { defaultValue: c })}
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
  const q = useSlaSet(id),
    ev = useStartEvents(),
    regions = useRegions(),
    save = useSaveSlaDraft(id);
  const [edits, setEdits] = useState<Record<string, SlaTaskRule>>({});
  const [dlg, setDlg] = useState<null | "save" | "preview" | "publish">(null);
  const [sent, setSent] = useState<string[]>([]);
  const set = q.data?.data,
    etag = q.data?.etag ?? 0;
  if (!set)
    return (
      <section className="card p-4 text-mute">{t("common.loading")}</section>
    );
  const ar = i18n.language === "ar",
    name = (n: string, a?: string | null) => (ar && a) || n;
  const draft = set.status === "draft",
    dirty = Object.keys(edits).length > 0;
  const rows = set.rules.map((r) => edits[r.task_code] ?? r);
  const upd = (r: SlaTaskRule, patch: Partial<SlaTaskRule>) =>
    setEdits({ ...edits, [r.task_code]: { ...r, ...patch } });
  const updOv = (r: SlaTaskRule, j: number, patch: Partial<SlaRuleOverride>) =>
    upd(r, {
      overrides: (r.overrides ?? []).map((o, k) =>
        k === j ? { ...o, ...patch } : o,
      ),
    });
  const serverErrs = fieldErrors(save.error);
  const serverFor = (code: string, j: number | null, f: string) => {
    const i = sent.indexOf(code);
    return serverErrs[`/rules/${i}${j === null ? "" : `/overrides/${j}`}/${f}`];
  };
  const localBad = rows.some((r) => bad(r) || (r.overrides ?? []).some(bad));
  const startOpts = ev.data
    ? ([
        [
          t("slaSet.grp_tasks"),
          ev.data.tasks.map((x) => [
            x.code,
            `${x.code} · ${name(x.name_en, x.name_ar)}`,
          ]),
        ],
        [
          t("slaSet.grp_milestones"),
          ev.data.milestones.map((x) => [x.code, name(x.name_en, x.name_ar)]),
        ],
        [
          t("slaSet.grp_gates"),
          ev.data.gates.map((x) => [x.code, name(x.name_en, x.name_ar)]),
        ],
      ] as [string, string[][]][])
    : [];
  const known = new Set(startOpts.flatMap(([, o]) => o.map((x) => x[0])));
  const rname = (rid: number) => {
    const r = regions.data?.find((x) => x.id === rid);
    return (ar && r?.name_ar) || r?.name_en || String(rid);
  };

  return (
    <section className="card space-y-3 p-4" data-testid="sla-editor">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="me-auto font-bold">
          v{set.version}{" "}
          <span
            className={`chip ${set.status === "published" ? "bg-doneBg text-doneInk" : "bg-waitBg text-waitInk"}`}
            data-testid="sla-editor-status"
          >
            {t(`rules.status_${set.status}`)}
          </span>
        </h2>
        {draft && (
          <>
            <button
              className="btn"
              data-testid="sla-save"
              disabled={!dirty || localBad || save.isPending}
              onClick={() => setDlg("save")}
            >
              {t("common.save")}
            </button>
            <button
              className="btn"
              data-testid="sla-preview"
              disabled={dirty}
              title={dirty ? t("slaSet.save_first") : undefined}
              onClick={() => setDlg("preview")}
            >
              {t("slaSet.preview")}
            </button>
            <button
              className="btn btn-accent"
              data-testid="sla-publish"
              disabled={dirty}
              title={dirty ? t("slaSet.save_first") : undefined}
              onClick={() => setDlg("publish")}
            >
              {t("slaSet.publish")}
            </button>
          </>
        )}
      </div>
      {draft && dirty && (
        <p className="text-xs text-mute" data-testid="sla-dirty">
          {t("slaSet.save_first")}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-mute">
            <tr>
              {["task", "min", "max", "start", "calendar"].map((k) => (
                <th key={k} className="p-2 text-start">
                  {t(`slaSet.col_${k}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody data-testid="sla-list">
            {rows.map((r) => {
              const rowBad =
                bad(r) ||
                serverFor(r.task_code, null, "max_working_days") ===
                  "min_exceeds_max";
              const startErr = serverFor(r.task_code, null, "start_event");
              return [
                <tr
                  key={r.task_code}
                  className="border-t border-line align-top"
                  data-testid={`sla-${r.task_code}`}
                >
                  <td className="mono p-2">{r.task_code}</td>
                  <td className="p-2">
                    <input
                      type="number"
                      min={0}
                      max={365}
                      className="input w-20"
                      aria-invalid={rowBad}
                      aria-label={`${r.task_code} ${t("slaSet.col_min")}`}
                      data-testid={`sla-min-${r.task_code}`}
                      disabled={!draft}
                      value={r.min_working_days}
                      onChange={(e) =>
                        upd(r, { min_working_days: Number(e.target.value) })
                      }
                    />
                  </td>
                  <td className="p-2">
                    <input
                      type="number"
                      min={0}
                      max={365}
                      className="input w-20"
                      aria-invalid={rowBad}
                      aria-label={`${r.task_code} ${t("slaSet.col_max")}`}
                      data-testid={`sla-max-${r.task_code}`}
                      disabled={!draft}
                      value={r.max_working_days}
                      onChange={(e) =>
                        upd(r, { max_working_days: Number(e.target.value) })
                      }
                    />
                    {rowBad && (
                      <p
                        role="alert"
                        className="mt-1 text-xs text-lateInk"
                        data-testid={`sla-err-${r.task_code}`}
                      >
                        {t("fieldError.min_exceeds_max")}
                      </p>
                    )}
                  </td>
                  <td className="p-2">
                    <select
                      className="input w-56"
                      aria-label={`${r.task_code} ${t("slaSet.col_start")}`}
                      data-testid={`sla-start-${r.task_code}`}
                      disabled={!draft}
                      value={r.start_event}
                      onChange={(e) => upd(r, { start_event: e.target.value })}
                    >
                      {!known.has(r.start_event) && (
                        <option value={r.start_event}>{r.start_event}</option>
                      )}
                      {startOpts.map(([g, o]) => (
                        <optgroup key={g} label={g}>
                          {o.map(([c, l]) => (
                            <option key={c} value={c}>
                              {l}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    {startErr && (
                      <p
                        role="alert"
                        className="mt-1 text-xs text-lateInk"
                        data-testid={`sla-err-start-${r.task_code}`}
                      >
                        {t(`fieldError.${startErr}`, {
                          defaultValue: startErr,
                        })}
                      </p>
                    )}
                  </td>
                  <td className="p-2">
                    <select
                      className="input w-24"
                      aria-label={`${r.task_code} ${t("slaSet.col_calendar")}`}
                      data-testid={`sla-cal-${r.task_code}`}
                      disabled={!draft}
                      value={r.calendar_code}
                      onChange={(e) =>
                        upd(r, { calendar_code: e.target.value })
                      }
                    >
                      <option value="LY">LY</option>
                    </select>
                  </td>
                </tr>,
                (draft || (r.overrides ?? []).length > 0) && (
                  <tr
                    key={`${r.task_code}-o`}
                    data-testid={`sla-ovr-${r.task_code}`}
                  >
                    <td />
                    <td colSpan={4} className="pb-2 ps-2">
                      <ul className="space-y-1">
                        {(r.overrides ?? []).map((o, j) => {
                          const oBad =
                              bad(o) ||
                              serverFor(r.task_code, j, "max_working_days") ===
                                "min_exceeds_max",
                            dup = serverFor(r.task_code, j, "scenario");
                          return (
                            <li
                              key={j}
                              className="flex flex-wrap items-center gap-2"
                              data-testid={`sla-ovr-${r.task_code}-${j}`}
                            >
                              <select
                                className="input w-40"
                                aria-label={t("slaSet.ovr_scenario")}
                                data-testid={`sla-ovr-scenario-${r.task_code}-${j}`}
                                disabled={!draft}
                                value={o.scenario ?? ""}
                                onChange={(e) =>
                                  updOv(r, j, {
                                    scenario: (e.target.value || undefined) as
                                      | DeliveryScenario
                                      | undefined,
                                  })
                                }
                              >
                                <option value="">
                                  {t("slaSet.any_scenario")}
                                </option>
                                {SCENARIOS.map((s) => (
                                  <option key={s} value={s}>
                                    {t(`scenario.${s}`)}
                                  </option>
                                ))}
                              </select>
                              <select
                                className="input w-40"
                                aria-label={t("slaSet.ovr_region")}
                                data-testid={`sla-ovr-region-${r.task_code}-${j}`}
                                disabled={!draft}
                                value={o.region_id ?? ""}
                                onChange={(e) =>
                                  updOv(r, j, {
                                    region_id: e.target.value
                                      ? Number(e.target.value)
                                      : undefined,
                                  })
                                }
                              >
                                <option value="">
                                  {t("slaSet.any_region")}
                                </option>
                                {(regions.data ?? []).map((g) => (
                                  <option key={g.id} value={g.id}>
                                    {rname(g.id)}
                                  </option>
                                ))}
                              </select>
                              <input
                                type="number"
                                min={0}
                                max={365}
                                className="input w-20"
                                aria-label={t("slaSet.col_min")}
                                data-testid={`sla-ovr-min-${r.task_code}-${j}`}
                                disabled={!draft}
                                value={o.min_working_days}
                                onChange={(e) =>
                                  updOv(r, j, {
                                    min_working_days: Number(e.target.value),
                                  })
                                }
                              />
                              <input
                                type="number"
                                min={0}
                                max={365}
                                className="input w-20"
                                aria-label={t("slaSet.col_max")}
                                aria-invalid={oBad}
                                data-testid={`sla-ovr-max-${r.task_code}-${j}`}
                                disabled={!draft}
                                value={o.max_working_days}
                                onChange={(e) =>
                                  updOv(r, j, {
                                    max_working_days: Number(e.target.value),
                                  })
                                }
                              />
                              {draft && (
                                <button
                                  className="btn"
                                  aria-label={t("common.remove")}
                                  data-testid={`sla-ovr-remove-${r.task_code}-${j}`}
                                  onClick={() =>
                                    upd(r, {
                                      overrides: (r.overrides ?? []).filter(
                                        (_, k) => k !== j,
                                      ),
                                    })
                                  }
                                >
                                  <Trash2 size={14} />
                                </button>
                              )}
                              {oBad && (
                                <span
                                  role="alert"
                                  className="text-xs text-lateInk"
                                  data-testid={`sla-err-${r.task_code}-o${j}`}
                                >
                                  {t("fieldError.min_exceeds_max")}
                                </span>
                              )}
                              {dup && (
                                <span
                                  role="alert"
                                  className="text-xs text-lateInk"
                                >
                                  {t(`fieldError.${dup}`, {
                                    defaultValue: dup,
                                  })}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                      {draft && (
                        <button
                          className="btn mt-1"
                          data-testid={`sla-ovr-add-${r.task_code}`}
                          onClick={() =>
                            upd(r, {
                              overrides: [
                                ...(r.overrides ?? []),
                                {
                                  scenario: "new_build",
                                  min_working_days: r.min_working_days,
                                  max_working_days: r.max_working_days,
                                },
                              ],
                            })
                          }
                        >
                          <Plus size={14} />
                          {t("slaSet.add_override")}
                        </button>
                      )}
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
      {dlg === "save" && (
        <FormDialog
          open
          onClose={() => setDlg(null)}
          testid="sla-save-dialog"
          title={t("slaSet.save_title")}
          busy={save.isPending}
          error={
            save.isError && !Object.keys(serverErrs).length
              ? errText(save.error, t)
              : null
          }
          onSubmit={(reason) => {
            const changed = Object.values(edits);
            setSent(changed.map((r) => r.task_code));
            save.mutate(
              { etag, reason, rules: changed },
              {
                onSuccess: () => {
                  toast(t("settings.audited"));
                  setEdits({});
                  setDlg(null);
                },
                onError: (e) => {
                  if (e instanceof ApiError && e.status === 422) setDlg(null);
                },
              },
            );
          }}
        />
      )}
      {dlg === "preview" && (
        <PreviewDialog id={id} onClose={() => setDlg(null)} />
      )}
      {dlg === "publish" && (
        <PublishDialog id={id} etag={etag} onClose={() => { pin(); setDlg(null); }} />
      )}
    </section>
  );
}

export function SlaRules() {
  const { t } = useTranslation();
  const toast = useToast();
  const list = useSlaSets(),
    create = useCreateSlaDraft();
  const [sel, setSel] = useState<string>();
  const [open, setOpen] = useState(false);
  const sets = list.data ?? [];
  const draft = sets.find((s) => s.status === "draft"),
    active = sets.find((s) => s.is_active);
  const id = sel ?? draft?.id ?? active?.id;
  return (
    <div className="space-y-4" data-testid="page-sla">
      <section className="card space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="me-auto font-bold">{t("slaSet.title")}</h2>
          {draft ? (
            <button
              className="btn"
              data-testid="sla-open-draft"
              onClick={() => setSel(draft.id)}
            >
              {t("slaSet.open_draft")}
            </button>
          ) : (
            <button
              className="btn btn-accent"
              data-testid="sla-create-draft"
              disabled={!active}
              onClick={() => setOpen(true)}
            >
              {t("slaSet.create_draft")}
            </button>
          )}
        </div>
        <p className="text-sm text-mute">{t("slaSet.note")}</p>
      </section>
      {id && <Editor key={id} id={id} pin={() => setSel(id)} />}
      <section className="card overflow-x-auto p-4">
        <h2 className="mb-2 font-bold">{t("rules.versions")}</h2>
        <table className="w-full text-sm">
          <thead className="text-mute">
            <tr>
              {["version", "effective", "who", "when", "why", "applied"].map(
                (k) => (
                  <th key={k} className="p-2 text-start">
                    {t(`slaSet.vcol_${k}`)}
                  </th>
                ),
              )}
              <th />
            </tr>
          </thead>
          <tbody data-testid="sla-versions">
            {sets.map((s) => (
              <tr
                key={s.id}
                className="border-t border-line"
                data-testid={`sla-version-${s.version}`}
              >
                <td className="p-2">
                  v{s.version}{" "}
                  <span
                    className={`chip ms-1 ${s.status === "published" ? "bg-doneBg text-doneInk" : "bg-waitBg text-waitInk"}`}
                  >
                    {t(`rules.status_${s.status}`)}
                  </span>
                  {s.is_active && (
                    <span className="chip ms-1 bg-doneBg text-doneInk">
                      {t("rules.current")}
                    </span>
                  )}
                </td>
                <td className="mono p-2 text-xs">{s.effective_from ?? "-"}</td>
                <td className="p-2">{who(s)}</td>
                <td className="mono p-2 text-xs">
                  {(s.published_at ?? s.created_at).slice(0, 10)}
                </td>
                <td className="p-2 text-mute">{s.reason}</td>
                <td className="p-2">
                  {s.apply_to_open_tasks === null
                    ? "-"
                    : s.apply_to_open_tasks
                      ? t("slaSet.applied", {
                          count: s.affected_open_tasks ?? 0,
                        })
                      : t("slaSet.not_applied")}
                </td>
                <td className="p-2 text-end">
                  <button
                    className="btn"
                    data-testid={`sla-view-${s.version}`}
                    onClick={() => setSel(s.id)}
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
          testid="sla-create-dialog"
          title={t("slaSet.create_draft")}
          busy={create.isPending}
          error={
            create.isError && create.error.status !== 409
              ? errText(create.error, t)
              : null
          }
          onSubmit={(reason) =>
            create.mutate(
              { reason },
              {
                onSuccess: (d) => {
                  toast(t("slaSet.draft_created"));
                  setSel(d.id);
                  setOpen(false);
                },
                // One draft at a time: a 409 means somebody already made it, so open that one.
                onError: (e) => {
                  if (e.status === 409) {
                    toast(t("slaSet.draft_exists"));
                    setOpen(false);
                    void list
                      .refetch()
                      .then((r) =>
                        setSel(r.data?.find((s) => s.status === "draft")?.id),
                      );
                  }
                },
              },
            )
          }
        >
          <p className="text-sm text-mute">
            {t("slaSet.create_note", { version: active?.version })}
          </p>
        </FormDialog>
      )}
    </div>
  );
}
