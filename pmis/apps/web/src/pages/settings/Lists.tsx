import { ArrowDown, ArrowUp, Download, GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAddListValue,
  useCreateList,
  useDeleteListValue,
  useImportListValues,
  useListCatalogues,
  useUpdateList,
  useUpdateListValue,
} from "@/api/lists";
import { useRegisterColumns, useUpdateColumn } from "@/api/registerColumns";
import { useRegisterDefs } from "@/api/registers";
import { downloadFile } from "@/api/client";
import type { ListCatalogue, ListCatalogueInput, ListValue, RegisterColumnPatch } from "@/api/types";
import { errText, FormDialog } from "@/components/FormDialog";
import { useToast } from "@/components/Toast";
import { fieldErrors } from "@/lib/fields";

const split = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const nameOf = (c: ListCatalogue, lang: string) =>
  (lang === "ar" && c.name_ar) || c.name_en;
/** 0.13.2 (Q260): the Severity list mirrors the snag severities; its values are changed in Settings, QC snag severities, never here. */
const mirrored = (c: ListCatalogue) => c.code === "Severity";
const VALUE_TYPES = [
  "text",
  "number",
  "date",
  "person",
  "site",
  "vendor",
] as const;
type ValueType = (typeof VALUE_TYPES)[number];

type Dlg =
  | { kind: "new-list" }
  | { kind: "edit-list"; list: ListCatalogue }
  | { kind: "new-value"; list: ListCatalogue }
  | { kind: "edit-value"; list: ListCatalogue; value: ListValue }
  | { kind: "delete-value"; list: ListCatalogue; value: ListValue };

/**
 * Settings, lists (contract 0.12.5, Q104; F17 extends this tab, owner rule 2026-11-15): every list of a register is data. A value keeps its code for
 * ever (the code is what the records store); its labels, aliases, groups, colour and order can change, and it is deactivated with a reason, never
 * deleted in use. F17 adds the value type, multi-select, dependent lists (a parent list and its value), the default value, and a hard delete of an
 * unused value (with a reason). `pending` lists are drafts for the owner's review; a critical list accepts only its own values.
 */
export function Lists() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const toast = useToast();
  const q = useListCatalogues(true);
  const [filter, setFilter] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const reorderValue = useUpdateListValue();
  const all = q.data ?? [];
  const items = all.filter(
    (c) =>
      !filter.trim() ||
      `${c.code} ${c.name_en} ${c.name_ar ?? ""}`
        .toLowerCase()
        .includes(filter.trim().toLowerCase()),
  );
  const cur = all.find((c) => c.code === sel) ?? null;
  /** Moves a value to the place of another (drag and drop) or one step (the arrows). Only the values whose position changes are written, each with its own version and reason, so the audit shows every change. */
  const placeValue = async (id: string, targetIndex: number) => {
    if (!cur) return;
    const arr = [...cur.values];
    const from = arr.findIndex((v) => v.id === id);
    if (from < 0 || targetIndex < 0 || targetIndex >= arr.length || from === targetIndex) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(targetIndex, 0, moved!);
    try {
      for (const [i, v] of arr.entries()) {
        const want = (i + 1) * 10;
        if (v.sort_order !== want) await reorderValue.mutateAsync({ code: cur.code, id: v.id, version: v.version, body: { sort_order: want, reason: t("lists.reorder_reason") } });
      }
      toast(t("settings.audited"));
    } catch (e) { toast(errText(e, t), "err"); }
  };
  const parentOf = (c: ListCatalogue) =>
    c.parent_catalogue
      ? (all.find((x) => x.code === c.parent_catalogue) ?? null)
      : null;

  return (
    <section className="space-y-3" data-testid="page-lists">
      <div className="card space-y-3 p-4">
        <h2 className="font-bold">{t("lists.title")}</h2>
        <p className="text-sm text-mute">{t("lists.note")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input max-w-64"
            data-testid="lists-filter"
            aria-label={t("lists.filter")}
            placeholder={t("lists.filter")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-accent ms-auto"
            data-testid="lists-new"
            onClick={() => setDlg({ kind: "new-list" })}
          >
            <Plus size={14} />
            {t("lists.new")}
          </button>
        </div>
        {q.isLoading && <p className="text-mute">{t("common.loading")}</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="lists-table">
            <thead className="text-mute">
              <tr>
                <th className="p-2 text-start">{t("lists.code")}</th>
                <th className="p-2 text-start">{t("lists.name")}</th>
                <th className="p-2 text-start">{t("lists.status")}</th>
                <th className="p-2 text-end">{t("lists.values")}</th>
                <th className="p-2 text-start">{t("lists.used_by")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr
                  key={c.code}
                  className={`cursor-pointer border-t border-line hover:bg-hover ${sel === c.code ? "bg-accentSoft" : ""} ${c.is_active ? "" : "opacity-60"}`}
                  data-testid={`lists-row-${c.code}`}
                  onClick={() => setSel(c.code)}
                >
                  <td className="p-2 mono">{c.code}</td>
                  <td className="p-2">{nameOf(c, lang)}</td>
                  <td className="p-2">
                    <span
                      className={`chip ${c.status === "confirmed" ? "bg-doneBg text-doneInk" : "bg-waitBg text-waitInk"}`}
                      data-testid={`lists-status-${c.code}`}
                    >
                      {t(`lists.status_${c.status}`)}
                    </span>
                    {c.critical && (
                      <span
                        className="chip ms-1 bg-lateBg text-lateInk"
                        data-testid={`lists-critical-${c.code}`}
                      >
                        {t("lists.critical")}
                      </span>
                    )}
                    {c.allow_other && (
                      <span className="chip ms-1 bg-card2">
                        {t("lists.allow_other")}
                      </span>
                    )}
                    {(c.value_type ?? "text") !== "text" && (
                      <span
                        className="chip ms-1 bg-card2"
                        data-testid={`lists-type-${c.code}`}
                      >
                        {t(`lists.type_${c.value_type}`)}
                      </span>
                    )}
                    {c.multi_select && (
                      <span className="chip ms-1 bg-card2">
                        {t("lists.multi_select")}
                      </span>
                    )}
                    {c.parent_catalogue && (
                      <span
                        className="chip ms-1 bg-card2"
                        data-testid={`lists-parent-${c.code}`}
                      >
                        {t("lists.depends_on", { code: c.parent_catalogue })}
                      </span>
                    )}
                    {!c.is_active && (
                      <span className="chip ms-1 bg-lockBg text-lockInk">
                        {t("lists.inactive")}
                      </span>
                    )}
                  </td>
                  <td className="p-2 text-end mono">
                    {c.values.filter((v) => v.is_active).length}
                  </td>
                  <td className="p-2 text-mute">
                    {c.used_by
                      .map(
                        (u) =>
                          `${u.register_key}.${u.field_code}${u.column ? `.${u.column}` : ""}`,
                      )
                      .join(", ") || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {cur && (
        <div className="card space-y-3 p-4" data-testid="lists-detail">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-bold">
              {nameOf(cur, lang)}{" "}
              <span className="mono text-sm text-mute">{cur.code}</span>
            </h3>
            {cur.critical && cur.values.every((v) => !v.is_active) && (
              <span
                role="alert"
                className="chip bg-lateBg text-lateInk"
                data-testid="lists-blocking"
              >
                {t("lists.blocking")}
              </span>
            )}
            <button
              type="button"
              className="btn ms-auto"
              data-testid="lists-edit"
              onClick={() => setDlg({ kind: "edit-list", list: cur })}
            >
              <Pencil size={14} />
              {t("lists.edit")}
            </button>
            {!mirrored(cur) && (
              <button
                type="button"
                className="btn btn-accent"
                data-testid="lists-add-value"
                onClick={() => setDlg({ kind: "new-value", list: cur })}
              >
                <Plus size={14} />
                {t("lists.add_value")}
              </button>
            )}
          </div>
          {cur.description && (
            <p className="text-sm text-mute">{cur.description}</p>
          )}
          <p className="text-sm text-mute" data-testid="lists-type-line">
            {t("lists.value_type")}:{" "}
            {t(`lists.type_${cur.value_type ?? "text"}`)}
            {cur.multi_select ? ` · ${t("lists.multi_select")}` : ""}
          </p>
          {cur.parent_catalogue && (
            <p className="text-sm text-mute" data-testid="lists-parent-line">
              {t("lists.depends_on", { code: cur.parent_catalogue })}
              {parentOf(cur) ? "" : ` · ${t("lists.parent_missing")}`}
            </p>
          )}
          {(cur.dependent_lists ?? []).length > 0 && (
            <p className="text-sm text-mute" data-testid="lists-dependents">
              {t("lists.dependent_lists")}:{" "}
              {(cur.dependent_lists ?? []).join(", ")}
            </p>
          )}
          {mirrored(cur) && (
            <p
              className="rounded-md bg-card2 p-3 text-sm"
              data-testid="lists-mirrored"
            >
              {t("lists.mirrored")}
            </p>
          )}
          <table className="w-full text-sm" data-testid="lists-values">
            <thead className="text-mute">
              <tr>
                <th className="p-2 text-start">{t("lists.code")}</th>
                <th className="p-2 text-start">{t("lists.label_en")}</th>
                <th className="p-2 text-start">{t("lists.label_ar")}</th>
                <th className="p-2 text-start">{t("lists.aliases")}</th>
                <th className="p-2 text-start">{t("lists.groups")}</th>
                <th className="p-2 text-start">{t("lists.colour")}</th>
                <th className="p-2 text-start">{t("lists.parent_value")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cur.values.map((v) => (
                <tr
                  key={v.id}
                  className={`border-t border-line ${v.is_active ? "" : "opacity-60"} ${drag === v.id ? "bg-hover" : ""}`}
                  data-testid={`lists-value-${v.code}`}
                  draggable={!mirrored(cur)}
                  onDragStart={() => setDrag(v.id)}
                  onDragOver={(e) => { if (drag) e.preventDefault(); }}
                  onDrop={() => { const d = drag; setDrag(null); if (d) void placeValue(d, cur.values.findIndex((x) => x.id === v.id)); }}
                  onDragEnd={() => setDrag(null)}
                >
                  <td className="p-2 mono">
                    {!mirrored(cur) && <GripVertical size={14} className="me-1 inline cursor-grab text-mute" aria-hidden />}
                    {v.code}
                    {!v.is_active && (
                      <span className="chip ms-1 bg-lockBg text-lockInk">
                        {t("lists.inactive")}
                      </span>
                    )}
                    {v.is_default && (
                      <span
                        className="chip ms-1 bg-card2"
                        data-testid={`lists-default-${v.code}`}
                      >
                        {t("lists.default")}
                      </span>
                    )}
                  </td>
                  <td className="p-2">{v.label_en}</td>
                  <td className="p-2" dir="rtl">
                    {v.label_ar ?? "-"}
                  </td>
                  <td className="p-2 text-mute">
                    {v.aliases.join(", ") || "-"}
                  </td>
                  <td className="p-2 text-mute">
                    {v.groups.join(", ") || "-"}
                  </td>
                  <td className="p-2">
                    {v.colour ? (
                      <span className="inline-flex items-center gap-1 mono">
                        <span
                          className="inline-block h-3 w-3 rounded-full border border-line"
                          style={{ background: v.colour }}
                          aria-hidden="true"
                        />
                        {v.colour}
                      </span>
                    ) : (
                      ", "
                    )}
                  </td>
                  <td className="p-2 mono text-mute">
                    {v.parent_code ?? "-"}
                  </td>
                  <td className="p-2 text-end whitespace-nowrap">
                    {!mirrored(cur) && (
                      <>
                        <button type="button" className="btn btn-ghost p-1" data-testid={`lists-value-up-${v.code}`} aria-label={t("lists.move_up", { code: v.code })} disabled={cur.values[0]?.id === v.id} onClick={() => void placeValue(v.id, cur.values.findIndex((x) => x.id === v.id) - 1)}><ArrowUp size={14} /></button>
                        <button type="button" className="btn btn-ghost p-1" data-testid={`lists-value-down-${v.code}`} aria-label={t("lists.move_down", { code: v.code })} disabled={cur.values[cur.values.length - 1]?.id === v.id} onClick={() => void placeValue(v.id, cur.values.findIndex((x) => x.id === v.id) + 1)}><ArrowDown size={14} /></button>
                        <button
                          type="button"
                          className="btn btn-ghost p-1"
                          data-testid={`lists-value-edit-${v.code}`}
                          aria-label={t("lists.edit_value", { code: v.code })}
                          onClick={() =>
                            setDlg({ kind: "edit-value", list: cur, value: v })
                          }
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost p-1"
                          data-testid={`lists-value-delete-${v.code}`}
                          aria-label={t("lists.delete_value", { code: v.code })}
                          onClick={() =>
                            setDlg({
                              kind: "delete-value",
                              list: cur,
                              value: v,
                            })
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {!cur.values.length && (
                <tr>
                  <td colSpan={8} className="p-2 text-mute">
                    {t("lists.no_values")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {cur && !mirrored(cur) && <ImportValues list={cur} />}
      {cur && !mirrored(cur) && <BindColumn list={cur} />}
      {dlg && (
        <ListDialog
          dlg={dlg}
          all={all}
          onClose={() => setDlg(null)}
          onDone={(code) => {
            toast(t("settings.audited"));
            setDlg(null);
            if (code) setSel(code);
          }}
        />
      )}
    </section>
  );
}

/** F17 follow-up: the approved template of the values (TPL-LISTVALUES) is downloaded, filled, and uploaded again; every row applies or none does. */
function ImportValues({ list }: { list: ListCatalogue }) {
  const { t } = useTranslation();
  const toast = useToast();
  const imp = useImportListValues();
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState("");
  const [dlErr, setDlErr] = useState<string | null>(null);
  const template = async () => {
    setDlErr(null);
    try {
      await downloadFile("/templates/TPL-LISTVALUES/download");
    } catch (e) {
      setDlErr(errText(e, t));
    }
  };
  const submit = () => {
    if (!file) return;
    imp.mutate(
      { code: list.code, file, reason: reason.trim() },
      {
        onSuccess: (r) => {
          toast(t("lists.import_done", { count: r.imported ?? 0 }));
          setFile(null);
          setReason("");
        },
      },
    );
  };
  return (
    <div className="card space-y-2 p-4" data-testid="lists-import">
      <h4 className="font-semibold">{t("lists.import_title")}</h4>
      <p className="text-xs text-mute">{t("lists.import_hint")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn" data-testid="lists-template" onClick={() => void template()}>
          <Download size={14} />
          {t("lists.template_download")}
        </button>
        <input type="file" accept=".xlsx" data-testid="lists-import-file" aria-label={t("lists.import_file")} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <input className="input max-w-64" data-testid="lists-import-reason" aria-label={t("lists.reason_short")} placeholder={t("lists.reason_short")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <button type="button" className="btn btn-accent" data-testid="lists-import-submit" disabled={!file || reason.trim().length < 3 || imp.isPending} onClick={submit}>
          {t("lists.import_submit")}
        </button>
      </div>
      {dlErr && <p role="alert" className="text-xs text-lateInk" data-testid="lists-template-error">{dlErr}</p>}
      {imp.isError && <p role="alert" className="text-xs text-lateInk" data-testid="lists-import-error">{errText(imp.error, t)}</p>}
    </div>
  );
}

/** F17 follow-up: binds this list to a list column of a register, from the list page (the same PATCH as the column dialog). */
function BindColumn({ list }: { list: ListCatalogue }) {
  const { t } = useTranslation();
  const toast = useToast();
  const defs = useRegisterDefs();
  const [reg, setReg] = useState("");
  const [field, setField] = useState("");
  const [reason, setReason] = useState("");
  const cols = useRegisterColumns(reg, !!reg);
  const bind = useUpdateColumn(reg);
  const listCols = (cols.data?.fields ?? []).filter((c) => c.type === "list" || c.type === "multi_list");
  const submit = () => {
    bind.mutate(
      { code: field, patch: { list_catalogue: list.code, reason: reason.trim() } as RegisterColumnPatch },
      {
        onSuccess: () => {
          toast(t("lists.bind_done"));
          setField("");
          setReason("");
        },
      },
    );
  };
  return (
    <div className="card space-y-2 p-4" data-testid="lists-bind">
      <h4 className="font-semibold">{t("lists.bind_title")}</h4>
      <div className="flex flex-wrap items-center gap-2">
        <select className="input max-w-64" data-testid="lists-bind-register" aria-label={t("lists.bind_pick_register")} value={reg} onChange={(e) => { setReg(e.target.value); setField(""); }}>
          <option value="">{t("lists.bind_pick_register")}</option>
          {(defs.data ?? []).map((d) => (
            <option key={d.register_key} value={d.register_key}>{d.name_en}</option>
          ))}
        </select>
        <select className="input max-w-64" data-testid="lists-bind-field" aria-label={t("lists.bind_pick_field")} value={field} disabled={!reg} onChange={(e) => setField(e.target.value)}>
          <option value="">{t("lists.bind_pick_field")}</option>
          {listCols.map((c) => (
            <option key={c.code} value={c.code}>{c.label_en}</option>
          ))}
        </select>
        <input className="input max-w-64" data-testid="lists-bind-reason" aria-label={t("lists.reason_short")} placeholder={t("lists.reason_short")} value={reason} onChange={(e) => setReason(e.target.value)} />
        <button type="button" className="btn btn-accent" data-testid="lists-bind-submit" disabled={!field || reason.trim().length < 3 || bind.isPending} onClick={submit}>
          {t("lists.bind_submit")}
        </button>
      </div>
      {bind.isError && <p role="alert" className="text-xs text-lateInk" data-testid="lists-bind-error">{errText(bind.error, t)}</p>}
    </div>
  );
}

function ListDialog({
  dlg,
  all,
  onClose,
  onDone,
}: {
  dlg: Dlg;
  all: ListCatalogue[];
  onClose: () => void;
  onDone: (code?: string) => void;
}) {
  const { t } = useTranslation();
  const create = useCreateList(),
    update = useUpdateList(),
    addV = useAddListValue(),
    updV = useUpdateListValue(),
    delV = useDeleteListValue();
  const list = dlg.kind === "new-list" ? null : dlg.list;
  const value = dlg.kind === "edit-value" ? dlg.value : null;
  const parentValues = list?.parent_catalogue
    ? (all.find((c) => c.code === list.parent_catalogue)?.values ?? []).filter(
        (v) => v.is_active,
      )
    : [];
  const [f, setF] = useState({
    code: "",
    name_en: list?.name_en ?? "",
    name_ar: list?.name_ar ?? "",
    critical: list?.critical ?? false,
    allow_other: list?.allow_other ?? false,
    status: list?.status ?? "pending",
    is_active: (value ?? list)?.is_active ?? true,
    label_en: value?.label_en ?? "",
    label_ar: value?.label_ar ?? "",
    aliases: value?.aliases.join(", ") ?? "",
    groups: value?.groups.join(", ") ?? "",
    sort_order: value?.sort_order ?? 0,
    value_type: (list?.value_type ?? "text") as ValueType,
    multi_select: list?.multi_select ?? false,
    parent_catalogue: list?.parent_catalogue ?? "",
    colour: value?.colour ?? "",
    is_default: value?.is_default ?? false,
    parent_code: value?.parent_code ?? "",
  });
  const m = {
    "new-list": create,
    "edit-list": update,
    "new-value": addV,
    "edit-value": updV,
    "delete-value": delV,
  }[dlg.kind];
  const errs = fieldErrors(m.error);
  const set = (k: keyof typeof f) => (v: unknown) =>
    setF((x) => ({ ...x, [k]: v }));
  const err = (p: string) =>
    errs[p] && (
      <p
        role="alert"
        className="text-xs text-lateInk"
        data-testid={`lists-err-${p.slice(1)}`}
      >
        {t(`listErrors.${errs[p]}`, {
          defaultValue: t(`fieldError.${errs[p]}`, { defaultValue: errs[p] }),
        })}
      </p>
    );
  const isList = dlg.kind === "new-list" || dlg.kind === "edit-list";
  const parentChoices = all.filter((c) => c.code !== list?.code);
  const submit = (reason: string) => {
    const done = { onSuccess: (r: ListCatalogue) => onDone(r.code) };
    const parentCat = f.parent_catalogue || null;
    const listFields = {
      value_type: f.value_type as ListCatalogueInput["value_type"],
      multi_select: f.multi_select,
      parent_catalogue: parentCat,
    };
    if (dlg.kind === "new-list")
      create.mutate(
        {
          code: f.code.trim(),
          name_en: f.name_en.trim(),
          name_ar: f.name_ar.trim() || null,
          critical: f.critical,
          allow_other: f.allow_other,
          reason,
          ...listFields,
        },
        done,
      );
    else if (dlg.kind === "edit-list")
      update.mutate(
        {
          code: dlg.list.code,
          version: dlg.list.version,
          body: {
            name_en: f.name_en.trim(),
            name_ar: f.name_ar.trim() || null,
            critical: f.critical,
            allow_other: f.allow_other,
            status: f.status as "pending" | "confirmed",
            is_active: f.is_active,
            ...listFields,
            reason,
          },
        },
        done,
      );
    else if (dlg.kind === "new-value")
      addV.mutate(
        {
          code: dlg.list.code,
          body: {
            code: f.code.trim(),
            ...(f.label_en.trim() ? { label_en: f.label_en.trim() } : {}),
            label_ar: f.label_ar.trim() || null,
            aliases: split(f.aliases),
            groups: split(f.groups),
            colour: f.colour.trim() || null,
            is_default: f.is_default,
            parent_code: dlg.list.parent_catalogue
              ? f.parent_code || null
              : null,
            reason,
          },
        },
        done,
      );
    else if (dlg.kind === "delete-value")
      delV.mutate({ code: dlg.list.code, id: dlg.value.id, reason }, done);
    else
      updV.mutate(
        {
          code: dlg.list.code,
          id: dlg.value.id,
          version: dlg.value.version,
          body: {
            label_en: f.label_en.trim(),
            label_ar: f.label_ar.trim() || null,
            aliases: split(f.aliases),
            groups: split(f.groups),
            sort_order: Number(f.sort_order),
            is_active: f.is_active,
            colour: f.colour.trim() || null,
            is_default: f.is_default,
            parent_code: dlg.list?.parent_catalogue
              ? f.parent_code || null
              : null,
            reason,
          },
        },
        done,
      );
  };
  const title = {
    "new-list": t("lists.new"),
    "edit-list": t("lists.edit"),
    "new-value": t("lists.add_value"),
    "edit-value": t("lists.edit_value", { code: value?.code ?? "" }),
    "delete-value": t("lists.delete_value", {
      code: dlg.kind === "delete-value" ? dlg.value.code : "",
    }),
  }[dlg.kind];
  const input = (
    k: keyof typeof f,
    label: string,
    extra: Record<string, unknown> = {},
  ) => (
    <label className="block text-sm font-semibold">
      {label}
      <input
        className="input mt-1 font-normal"
        data-testid={`lists-in-${k}`}
        value={String(f[k])}
        onChange={(e) => set(k)(e.target.value)}
        {...extra}
      />
    </label>
  );
  const check = (k: keyof typeof f, label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        data-testid={`lists-in-${k}`}
        checked={f[k] === true}
        onChange={(e) => set(k)(e.target.checked)}
      />
      {label}
    </label>
  );
  return (
    <FormDialog
      open
      testid="lists-dialog"
      title={title}
      busy={m.isPending}
      error={
        m.isError && !Object.keys(errs).length ? errText(m.error, t) : null
      }
      onClose={onClose}
      onSubmit={submit}
    >
      <div className="space-y-2">
        {dlg.kind === "delete-value" && (
          <p className="text-sm" data-testid="lists-delete-note">
            {t("lists.delete_hint")}
          </p>
        )}
        {(dlg.kind === "new-list" || dlg.kind === "new-value") && (
          <>
            {input("code", t("lists.code"), {
              maxLength: dlg.kind === "new-list" ? 41 : 80,
            })}
            {err("/code")}
            <p className="text-xs text-mute">
              {t(
                dlg.kind === "new-list"
                  ? "lists.code_hint_list"
                  : "lists.code_hint_value",
              )}
            </p>
          </>
        )}
        {isList ? (
          <>
            {input("name_en", t("lists.name_en"))}
            {err("/name_en")}
            {input("name_ar", t("lists.name_ar"), { dir: "rtl" })}
            {check("critical", t("lists.critical_hint"))}
            {err("/critical")}
            {check("allow_other", t("lists.allow_other_hint"))}
            {err("/allow_other")}
            <label className="block text-sm font-semibold">
              {t("lists.value_type")}
              <select
                className="input mt-1 font-normal"
                data-testid="lists-in-value_type"
                value={f.value_type}
                onChange={(e) => set("value_type")(e.target.value)}
              >
                {VALUE_TYPES.map((vt) => (
                  <option key={vt} value={vt}>
                    {t(`lists.type_${vt}`)}
                  </option>
                ))}
              </select>
            </label>
            {err("/value_type")}
            {check("multi_select", t("lists.multi_select_hint"))}
            {err("/multi_select")}
            <label className="block text-sm font-semibold">
              {t("lists.parent_list")}
              <select
                className="input mt-1 font-normal"
                data-testid="lists-in-parent_catalogue"
                value={f.parent_catalogue}
                onChange={(e) => set("parent_catalogue")(e.target.value)}
              >
                <option value="">{t("lists.parent_none")}</option>
                {parentChoices.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                  </option>
                ))}
              </select>
            </label>
            {err("/parent_catalogue")}
            {dlg.kind === "edit-list" && (
              <>
                <label className="block text-sm font-semibold">
                  {t("lists.status")}
                  <select
                    className="input mt-1 font-normal"
                    data-testid="lists-in-status"
                    value={f.status}
                    onChange={(e) => set("status")(e.target.value)}
                  >
                    <option value="pending">{t("lists.status_pending")}</option>
                    <option value="confirmed">
                      {t("lists.status_confirmed")}
                    </option>
                  </select>
                </label>
                {err("/status")}
                {check("is_active", t("lists.active"))}
                {err("/is_active")}
              </>
            )}
          </>
        ) : dlg.kind === "delete-value" ? null : (
          <>
            {input("label_en", t("lists.label_en"))}
            {err("/label_en")}
            {input("label_ar", t("lists.label_ar"), { dir: "rtl" })}
            {input("aliases", t("lists.aliases_hint"))}
            {err("/aliases")}
            {input("groups", t("lists.groups_hint"))}
            {err("/groups")}
            {input("colour", t("lists.colour_hint"), {
              placeholder: "#RRGGBB",
              maxLength: 7,
            })}
            {err("/colour")}
            {check("is_default", t("lists.is_default_hint"))}
            {err("/is_default")}
            {list?.parent_catalogue && (
              <label className="block text-sm font-semibold">
                {t("lists.parent_value")}
                <select
                  className="input mt-1 font-normal"
                  data-testid="lists-in-parent_code"
                  value={f.parent_code}
                  onChange={(e) => set("parent_code")(e.target.value)}
                >
                  <option value="">{t("lists.parent_none")}</option>
                  {parentValues.map((v) => (
                    <option key={v.code} value={v.code}>
                      {v.code}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {err("/parent_code")}
            {dlg.kind === "edit-value" && (
              <>
                {input("sort_order", t("lists.sort_order"), {
                  type: "number",
                  min: 0,
                })}
                {check("is_active", t("lists.active"))}
                {err("/is_active")}
              </>
            )}
          </>
        )}
      </div>
    </FormDialog>
  );
}
