import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMe } from "@/api/hooks";
import {
  useColumnImpact,
  useDeleteColumn,
  useRegisterColumns,
  useReorderColumns,
} from "@/api/registerColumns";
import type { RegisterColumn } from "@/api/types";
import { ColumnDialog, type Place } from "@/components/ColumnDialog";
import { errText, FormDialog } from "@/components/FormDialog";
import type { HeaderMenuItem, TableApi } from "@/components/TableKit";
import { useToast } from "@/components/Toast";

/** Add, delete, rename and the global order are for the System Admin or a delegate of fields.edit; hiding and a personal order are for everyone. */
export const canEditColumns = (me: ReturnType<typeof useMe>["data"]) =>
  !!me &&
  (!!me.is_system_admin ||
    me.effective.grants.some(
      (g) => g.module_key === "fields" && (g.action as string) === "edit",
    ));

type Dlg =
  | { k: "add"; place: Place }
  | { k: "edit"; c: RegisterColumn }
  | { k: "delete"; c: RegisterColumn };

/**
 * The menu of a column header in a register grid (contract 0.15.13). Everyone: hide the column for themselves and move it earlier or later in their own order
 * (both stay in the browser, per user). The admin also adds a column before or after, renames, deletes (a column that held values is deactivated) and
 * turns their own order into the order of everyone, which the templates follow.
 */
export function useGridColumnMenu(registerKey: string, tbl: TableApi) {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useMe(true);
  const admin = canEditColumns(me.data);
  const scr = useRegisterColumns(registerKey, admin);
  const reorder = useReorderColumns(registerKey);
  const del = useDeleteColumn(registerKey);
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fields = scr.data?.fields ?? [],
    sections = scr.data?.sections ?? [];
  const byCode = (id: string) =>
    id.startsWith("f:")
      ? fields.find((f) => f.code === id.slice(2))
      : undefined;
  const impact = useColumnImpact(
    registerKey,
    dlg?.k === "delete" ? dlg.c.code : null,
  );

  const colMenu = (id: string): HeaderMenuItem[] => {
    if (!id.startsWith("f:")) return [];
    const c = byCode(id);
    const mine: HeaderMenuItem[] = [
      {
        id: "hide",
        label: t("regcols.grid_hide"),
        testid: `col-hide-${id}`,
        onSelect: () => tbl.toggle(id),
      },
      {
        id: "left",
        label: t("regcols.grid_left"),
        testid: `col-left-${id}`,
        onSelect: () => tbl.move(id, -1),
      },
      {
        id: "right",
        label: t("regcols.grid_right"),
        testid: `col-right-${id}`,
        onSelect: () => tbl.move(id, 1),
      },
    ];
    if (!admin || !c) return mine;
    const code = c.code;
    return [
      {
        id: "before",
        label: t("regcols.grid_add_before"),
        testid: `col-add-before-${id}`,
        onSelect: () => setDlg({ k: "add", place: { code, side: "before" } }),
      },
      {
        id: "after",
        label: t("regcols.grid_add_after"),
        testid: `col-add-after-${id}`,
        onSelect: () => setDlg({ k: "add", place: { code, side: "after" } }),
      },
      {
        id: "rename",
        label: t("regcols.grid_rename"),
        testid: `col-rename-${id}`,
        onSelect: () => setDlg({ k: "edit", c }),
      },
      ...mine,
      {
        id: "global",
        label: t("regcols.grid_global_order"),
        testid: `col-global-order-${id}`,
        onSelect: () => makeGlobal(),
      },
      {
        id: "delete",
        label: t("regcols.grid_delete"),
        testid: `col-delete-${id}`,
        disabled: c.is_system,
        onSelect: () => {
          setErr(null);
          setDlg({ k: "delete", c });
        },
      },
    ];
  };

  /** The caller's own order of the field columns becomes the order of the register; the columns they do not show keep their place after them. */
  const makeGlobal = () => {
    const mineOrder = tbl.menuCols
      .map((d) => d.id)
      .filter((x) => x.startsWith("f:"))
      .map((x) => x.slice(2));
    const known = new Set(fields.map((f) => f.code));
    const first = mineOrder.filter((x) => known.has(x));
    const codes = [
      ...first,
      ...fields.map((f) => f.code).filter((x) => !first.includes(x)),
    ];
    reorder.mutate(
      { codes, reason: t("regcols.reorder_reason") },
      {
        onSuccess: () => toast(t("regcols.grid_global_done")),
        onError: (e) => toast(errText(e, t), "err"),
      },
    );
  };

  const dialogs = admin ? (
    <>
      <ColumnDialog
        open={dlg?.k === "add" || dlg?.k === "edit"}
        onClose={() => setDlg(null)}
        registerKey={registerKey}
        column={dlg?.k === "edit" ? dlg.c : undefined}
        place={dlg?.k === "add" ? dlg.place : null}
        columns={fields}
        sections={sections}
      />
      <FormDialog
        open={dlg?.k === "delete"}
        onClose={() => setDlg(null)}
        testid="grid-column-delete"
        error={err}
        busy={del.isPending}
        title={
          dlg?.k === "delete"
            ? t("regcols.delete_title", { code: dlg.c.code })
            : ""
        }
        submitLabel={
          impact.data?.delete_mode === "hard"
            ? t("regcols.delete")
            : t("regcols.deactivate")
        }
        onSubmit={(reason) => {
          if (dlg?.k !== "delete") return;
          setErr(null);
          del.mutate(
            { code: dlg.c.code, reason },
            {
              onSuccess: (r) => {
                toast(
                  r.mode === "deleted"
                    ? t("regcols.deleted")
                    : t("regcols.deactivated"),
                );
                setDlg(null);
              },
              onError: (e) => setErr(errText(e, t)),
            },
          );
        }}
      >
        {impact.data && (
          <p data-testid="grid-column-delete-mode">
            {impact.data.delete_mode === "hard"
              ? t("regcols.delete_hard")
              : t("regcols.delete_deactivate", {
                  count: impact.data.usage.records_with_value ?? 0,
                })}
          </p>
        )}
      </FormDialog>
    </>
  ) : null;

  return {
    colMenu,
    dialogs,
    admin,
    openAdd: () => setDlg({ k: "add", place: null }),
  };
}
