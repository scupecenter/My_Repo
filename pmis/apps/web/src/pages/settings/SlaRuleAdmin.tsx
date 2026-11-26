import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useWorkflowVersions } from "@/api/workflowEditor";
import type { WorkflowVersion } from "@/api/types";
import { errText } from "@/components/FormDialog";
import { InlineCell } from "@/components/InlineCell";

/** F14: bulk SLA admin, a section of the Settings > SLA rules tab (owner rule: no setting twice). Lists the SLA rules of the current rule set, filters them, and bulk-edits the selected tasks.
 *  Writes go to the DRAFT workflow version through the editor door (one PUT per task, each with the version ETag in If-Match). */
type RuleRow = {
  id: string;
  task_code: string;
  min_working_days: number;
  max_working_days: number;
  start_event: string;
  calendar_code: string;
  region_id: number | null;
  scenario: string | null;
  unit?: "working" | "calendar";
  warning_pct?: number | null;
  breach_owner_role?: string | null;
  escalation_role?: string | null;
  pause_on_client_wait?: boolean;
  is_active?: boolean;
  open_task_count: number;
};

export function SlaBulkAdmin() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const rules = useQuery({
    queryKey: ["sla-admin-rules"],
    retry: false,
    queryFn: () =>
      api.get<{ items: RuleRow[] }>("/settings/sla-rules", {
        query: { limit: 200 },
      }),
  });
  const versions = useWorkflowVersions();
  const draft = (versions.data?.items ?? []).find((v) => v.status === "draft");

  // The list holds one row per task and scope; the editor rule is the base row (no region, no scenario) when present.
  const perTask = useMemo(() => {
    const byTask = new Map<string, RuleRow>();
    for (const r of rules.data?.items ?? []) {
      const cur = byTask.get(r.task_code);
      const base = r.region_id === null && r.scenario === null;
      if (!cur || (base && !(cur.region_id === null && cur.scenario === null)))
        byTask.set(r.task_code, r);
    }
    return [...byTask.values()];
  }, [rules.data]);

  const [text, setText] = useState("");
  const [unitFilter, setUnitFilter] = useState<"" | "working" | "calendar">("");
  const [pauseFilter, setPauseFilter] = useState<"" | "yes" | "no">("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkUnit, setBulkUnit] = useState<"" | "working" | "calendar">("");
  const [bulkWarn, setBulkWarn] = useState("");
  const [bulkPause, setBulkPause] = useState<"" | "yes" | "no">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      perTask.filter(
        (r) =>
          (!text ||
            r.task_code.toLowerCase().includes(text.trim().toLowerCase())) &&
          (!unitFilter || (r.unit ?? "working") === unitFilter) &&
          (!pauseFilter ||
            (pauseFilter === "yes") === (r.pause_on_client_wait ?? false)),
      ),
    [perTask, text, unitFilter, pauseFilter],
  );

  const toggle = (code: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(code)) n.delete(code);
      else n.add(code);
      return n;
    });

  const applyBulk = async () => {
    if (!draft) return;
    const chosen = perTask.filter((r) => picked.has(r.task_code));
    setBusy(true);
    setMsg(null);
    let done = 0;
    try {
      let etag =
        (await api.get<WorkflowVersion>(`/workflow/versions/${draft.version}`))
          .version_etag ?? 0;
      for (const r of chosen) {
        const warn =
          bulkWarn.trim() === "" ? (r.warning_pct ?? null) : Number(bulkWarn);
        const next = await api.put<WorkflowVersion>(
          `/workflow/versions/${draft.version}/tasks/${r.task_code}/sla-rule`,
          {
            version: etag,
            body: {
              min_working_days: r.min_working_days,
              max_working_days: r.max_working_days,
              start_event: r.start_event,
              unit: bulkUnit || (r.unit ?? "working"),
              calendar_code: r.calendar_code,
              warning_pct: warn,
              breach_owner_role: r.breach_owner_role ?? null,
              escalation_role: r.escalation_role ?? null,
              pause_on_client_wait:
                bulkPause === ""
                  ? (r.pause_on_client_wait ?? false)
                  : bulkPause === "yes",
              reason: reason.trim(),
            },
          },
        );
        // Each save bumps the version ETag, so the next row needs the new one.
        etag =
          typeof next.version_etag === "number"
            ? next.version_etag
            : ((
                await api.get<WorkflowVersion>(
                  `/workflow/versions/${draft.version}`,
                )
              ).version_etag ?? etag);
        done += 1;
      }
      setMsg(t("sla_admin.bulk_done", { n: done }));
      setPicked(new Set());
      await qc.invalidateQueries({ queryKey: ["sla-admin-rules"] });
      await qc.invalidateQueries({ queryKey: ["wf-version"] });
    } catch (e) {
      setMsg(
        t("sla_admin.bulk_failed", { n: done, total: chosen.length }) +
          " " +
          errText(e, t),
      );
    } finally {
      setBusy(false);
    }
  };

  // Edit in place: one cell saves one rule to the DRAFT version (same door as the bulk apply); nothing is live before Publish.
  const saveCell = async (r: RuleRow, patch: Partial<RuleRow>) => {
    if (!draft) throw new Error(t("sla_admin.no_draft"));
    if (reason.trim().length < 3) throw new Error(t("sla_admin.inline_need_reason"));
    const etag = (await api.get<WorkflowVersion>(`/workflow/versions/${draft.version}`)).version_etag ?? 0;
    const m = { ...r, ...patch };
    try {
      await api.put<WorkflowVersion>(`/workflow/versions/${draft.version}/tasks/${r.task_code}/sla-rule`, {
        version: etag,
        body: {
          min_working_days: m.min_working_days,
          max_working_days: m.max_working_days,
          start_event: m.start_event,
          unit: m.unit ?? "working",
          calendar_code: m.calendar_code,
          warning_pct: m.warning_pct ?? null,
          breach_owner_role: m.breach_owner_role ?? null,
          escalation_role: m.escalation_role ?? null,
          pause_on_client_wait: m.pause_on_client_wait ?? false,
          reason: reason.trim(),
        },
      });
    } catch (e) {
      throw new Error(errText(e, t));
    }
    setMsg(t("sla_admin.inline_saved", { task: r.task_code }));
    await qc.invalidateQueries({ queryKey: ["sla-admin-rules"] });
    await qc.invalidateQueries({ queryKey: ["wf-version"] });
  };
  const num = (v: string) => Number(v);

  const canBulk =
    !!draft && picked.size > 0 && reason.trim().length >= 3 && !busy;

  return (
    <section className="space-y-3" data-testid="sla-admin">
      <h2 className="text-lg font-semibold">{t("sla_admin.title")}</h2>
      {rules.isError && (
        <p role="alert" className="text-lateInk">
          {errText(rules.error, t)}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          {t("sla_admin.filter_task")}
          <input
            className="input"
            data-testid="sla-admin-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <label className="text-sm">
          {t("sla_admin.col_unit")}
          <select
            className="input"
            data-testid="sla-admin-unit"
            value={unitFilter}
            onChange={(e) =>
              setUnitFilter(e.target.value as "" | "working" | "calendar")
            }
          >
            <option value="">{t("sla_admin.all")}</option>
            <option value="working">{t("wfe.sla_section.unit_working")}</option>
            <option value="calendar">
              {t("wfe.sla_section.unit_calendar")}
            </option>
          </select>
        </label>
        <label className="text-sm">
          {t("sla_admin.col_pause")}
          <select
            className="input"
            data-testid="sla-admin-pause"
            value={pauseFilter}
            onChange={(e) =>
              setPauseFilter(e.target.value as "" | "yes" | "no")
            }
          >
            <option value="">{t("sla_admin.all")}</option>
            <option value="yes">{t("common.yes")}</option>
            <option value="no">{t("common.no")}</option>
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-2 text-sm" data-testid="sla-inline-bar">
        <label className="flex-1">
          {t("sla_admin.inline_reason")}
          <input className="input w-full" data-testid="sla-inline-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <p className="text-xs text-mute">{t(draft ? "sla_admin.inline_hint" : "sla_admin.no_draft")}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="sla-admin-table">
          <thead>
            <tr>
              <th className="p-2">
                <span className="sr-only">{t("sla_admin.select")}</span>
              </th>
              {[
                "col_task",
                "col_min",
                "col_max",
                "col_unit",
                "col_start",
                "col_calendar",
                "col_warning",
                "col_owner",
                "col_escalation",
                "col_pause",
                "col_open",
              ].map((k) => (
                <th key={k} className="p-2 text-start">
                  {t(`sla_admin.${k}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.task_code}
                data-testid="sla-admin-row"
                className="border-t"
              >
                <td className="p-2">
                  <input
                    type="checkbox"
                    aria-label={r.task_code}
                    checked={picked.has(r.task_code)}
                    onChange={() => toggle(r.task_code)}
                  />
                </td>
                <td className="mono p-2 text-xs">{r.task_code}</td>
                <td className="p-2"><InlineCell kind="number" min={0} max={365} value={r.min_working_days} label={t("sla_admin.col_min")} testid={`sla-cell-min-${r.task_code}`} disabled={!draft} onCommit={(v) => saveCell(r, { min_working_days: num(v) })} /></td>
                <td className="p-2"><InlineCell kind="number" min={0} max={365} value={r.max_working_days} label={t("sla_admin.col_max")} testid={`sla-cell-max-${r.task_code}`} disabled={!draft} onCommit={(v) => saveCell(r, { max_working_days: num(v) })} /></td>
                <td className="p-2"><InlineCell kind="select" value={r.unit ?? "working"} options={[{ value: "working", label: t("wfe.sla_section.unit_working") }, { value: "calendar", label: t("wfe.sla_section.unit_calendar") }]} label={t("sla_admin.col_unit")} testid={`sla-cell-unit-${r.task_code}`} disabled={!draft} onCommit={(v) => saveCell(r, { unit: v as "working" | "calendar" })} /></td>
                <td className="mono p-2 text-xs">{r.start_event}</td>
                <td className="p-2">{r.calendar_code}</td>
                <td className="p-2"><InlineCell kind="number" min={0} max={100} value={r.warning_pct} label={t("sla_admin.col_warning")} testid={`sla-cell-warn-${r.task_code}`} disabled={!draft} onCommit={(v) => saveCell(r, { warning_pct: v === "" ? null : num(v) })} /></td>
                <td className="p-2">{r.breach_owner_role ?? "-"}</td>
                <td className="p-2">{r.escalation_role ?? "-"}</td>
                <td className="p-2"><InlineCell kind="select" value={(r.pause_on_client_wait ?? false) ? "yes" : "no"} options={[{ value: "no", label: t("common.no") }, { value: "yes", label: t("common.yes") }]} display={(r.pause_on_client_wait ?? false) ? t("common.yes") : t("common.no")} label={t("sla_admin.col_pause")} testid={`sla-cell-pause-${r.task_code}`} disabled={!draft} onCommit={(v) => saveCell(r, { pause_on_client_wait: v === "yes" })} /></td>
                <td className="p-2">{r.open_task_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <fieldset
        className="space-y-2 rounded border p-2"
        data-testid="sla-admin-bulk"
      >
        <legend className="text-sm font-semibold">
          {t("sla_admin.bulk_title", { n: picked.size })}
        </legend>
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label>
            {t("sla_admin.col_unit")}
            <select
              className="input"
              data-testid="sla-bulk-unit"
              value={bulkUnit}
              onChange={(e) =>
                setBulkUnit(e.target.value as "" | "working" | "calendar")
              }
            >
              <option value="">{t("sla_admin.keep")}</option>
              <option value="working">
                {t("wfe.sla_section.unit_working")}
              </option>
              <option value="calendar">
                {t("wfe.sla_section.unit_calendar")}
              </option>
            </select>
          </label>
          <label>
            {t("sla_admin.col_warning")}
            <input
              className="input w-20"
              type="number"
              min={0}
              max={100}
              data-testid="sla-bulk-warn"
              value={bulkWarn}
              onChange={(e) => setBulkWarn(e.target.value)}
            />
          </label>
          <label>
            {t("sla_admin.col_pause")}
            <select
              className="input"
              data-testid="sla-bulk-pause"
              value={bulkPause}
              onChange={(e) =>
                setBulkPause(e.target.value as "" | "yes" | "no")
              }
            >
              <option value="">{t("sla_admin.keep")}</option>
              <option value="yes">{t("common.yes")}</option>
              <option value="no">{t("common.no")}</option>
            </select>
          </label>
          <label className="flex-1">
            {t("sla_admin.reason")}
            <input
              className="input w-full"
              data-testid="sla-bulk-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn"
            data-testid="sla-bulk-apply"
            disabled={!canBulk}
            onClick={() => void applyBulk()}
          >
            {t("sla_admin.apply")}
          </button>
        </div>
        {!draft && (
          <p className="text-xs text-mute" data-testid="sla-admin-no-draft">
            {t("sla_admin.no_draft")}
          </p>
        )}
        {msg && (
          <p role="status" className="text-xs" data-testid="sla-bulk-msg">
            {msg}
          </p>
        )}
      </fieldset>
    </section>
  );
}
