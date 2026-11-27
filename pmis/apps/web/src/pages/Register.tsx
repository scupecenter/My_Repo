import {
  ArrowRightLeft,
  CalendarDays,
  Columns3,
  Download,
  Grid3x3,
  Lock,
  Map as MapIcon,
  Plus,
  RotateCcw,
  Table2,
  TableProperties,
  Unlock,
  Warehouse as WarehouseIcon,
  Ruler,
} from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Link,
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useMe } from "@/api/hooks";
import {
  downloadTemplate,
  useColumnLock,
  useRecordLock,
  useRecordOp,
  useRegisterDefs,
  useRegisterRecords,
  useTemplates,
  useUpdateRecord,
  type RecordFilters,
} from "@/api/registers";
import { decodeFilter, encodeFilter, type FilterTree } from "@/api/views";
import { useRegions } from "@/api/sites";
import type { ExtraField } from "@/components/UnifiedFilter";
import type { RegisterDefinition, RegisterRecord } from "@/api/types";
import { TemplateExportMenu } from "@/components/TemplateExportMenu";
import { PmDuePanel } from "@/components/PmDuePanel";
import { ViewAnalytics } from "@/components/ViewAnalytics";
import { LayoutPanel, type ViewOption } from "@/components/LayoutPanel";
import { useRememberedView } from "@/lib/viewPreference";
import { GridCellEditor, INLINE_TYPES } from "@/components/GridCellEditor";
import { FieldValue } from "@/components/FieldValue";
import { RegisterGrid } from "@/components/RegisterGrid";
import { RejectDialog } from "@/components/RejectDialog";
import { TemplateUploadDialog } from "@/components/TemplateUploadDialog";
import { Holders } from "@/components/HolderChip";
import {
  canEditColumns,
  useGridColumnMenu,
} from "@/components/GridColumnAdmin";
import { HlcLegacyDialog } from "@/components/P4cPanels";
import { fieldLabel, showValue } from "@/components/RegisterFields";
import { RegisterDrawer, STATE_TONE } from "@/components/RegisterDrawer";
import {
  ALL_CAP,
  BY_STATE,
  defaultBoardBy,
  dateFields,
  layoutsOf,
  RegisterBoard,
  RegisterCalendar,
  RegisterMap,
  RegisterWide,
  statusFields,
  type RegisterLane,
  type RegisterLayout,
} from "@/components/RegisterViews";
import { useToast } from "@/components/Toast";
import { BatchEditBar } from "@/components/BatchEditBar";
import { useBatchEdit } from "@/lib/useBatchEdit";
import { MoreMenu, PageHeader } from "@/components/PageHeader";
import { displayAttrs, PastedChip, ROWNO_COL, RowNo, SearchBox, ShownFooter, TableCount, TableToolbar } from "@/components/TableStandard";
import type { CountedPage } from "@/api/types";
import {
  ActiveChips,
  BulkBar,
  ColumnMenu,
  Empty,
  gxRow,
  HeaderRow,
  pin,
  rowPad,
  SelectBox,
  StatusChip,
  totalWidth,
  tracks,
  Trunc,
  useAutoFit,
  useTablePrefs,
} from "@/components/TableKit";
import type { ColDef, FitSample } from "@/lib/tablePrefs";
import {
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  NoResults,
} from "@/components/States";
import { registerErrorMessage } from "@/lib/registerErrors";
import { isLive, OWNER_NOTE } from "@/lib/registerForms";

const RF_KEYS = ["q", "region_id", "state", "record_type"] as const;
// W2: a saved view also keeps the layout (list, wide, board, map) and the board's grouping and swimlane, as #185 does for Site Master
const LAYOUT_KEYS = ["layout", "board_by", "lane", "calf"] as const;
type RegisterView = RecordFilters & {
  advanced?: FilterTree;
  layout?: string;
  board_by?: string;
  lane?: string;
  calf?: string;
};
const VIEW_EMPTY: RegisterView = {
  q: "",
  region_id: "",
  state: "",
  record_type: "",
  layout: "",
  board_by: "",
  lane: "",
  calf: "",
};
// P10: the saved-views control (and its share dialog, people picker and role/group queries) loads on its own, after the records, so it never
// delays the first paint of the list.
const SavedViews = lazy(() =>
  import("@/components/SavedViews").then((m) => ({
    default: m.SavedViews<RegisterView>,
  })),
);
// F3 (0.15.31): the AND/OR filter builder loads with the saved views.
const UnifiedFilter = lazy(() =>
  import("@/components/UnifiedFilter").then((m) => ({ default: m.UnifiedFilter })),
);

export function RegisterSoon({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <div data-testid="page-register-soon">
      <h1 className="text-2xl font-bold">{name}</h1>
      <p className="card mt-3 p-6 text-mute">{t("registers.soon_body")}</p>
    </div>
  );
}

function RegisterList({ def }: { def: RegisterDefinition }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const key = def.register_key;
  const recordId = sp.get("record");
  // Filters live in the URL beside `record`, so Back and shared links restore the view (plan F9).
  const f: RecordFilters = {
    q: sp.get("q") ?? "",
    region_id: sp.get("region_id") ?? "",
    state: sp.get("state") ?? "",
    record_type: sp.get("record_type") ?? "",
  };
  // F3 (0.15.31): the AND/OR filter tree lives in the URL as JSON (adv) and goes to the server as `filter`, which compiles it
  const adv = sp.get("adv") ?? "";
  const advTree = decodeFilter(adv);
  const activeFilters =
    Object.values(f).filter(Boolean).length + (advTree ? 1 : 0);
  const setParams = (kv: Record<string, string>) =>
    setSp(
      (p) => {
        const n = new URLSearchParams(p);
        for (const [k, v] of Object.entries(kv)) {
          if (v) n.set(k, v);
          else n.delete(k);
        }
        return n;
      },
      { replace: true },
    );
  const set = (k: keyof RecordFilters) => (v: string) => setParams({ [k]: v });
  const clearAll = () =>
    setParams({ ...Object.fromEntries(RF_KEYS.map((k) => [k, ""])), adv: "" });
  // The list ("vertical") is the only visible view (owner request 2026-11-22): the Excel-like Grid has no button any more and opens only when
  // `?view=grid` is in the URL (hidden).
  const view: "vertical" | "grid" = sp.get("view") === "grid" ? "grid" : "vertical";
  // W2 (plan 2026-11-23-next-ui-cleanup): the same view switcher as Site Master. The list is the default; the wide table and the board on every
  // register, the map only where the records carry a site. The layout lives in the URL (layout=wide|board|map) and in saved views.
  const layouts = layoutsOf(def);
  const layoutParam = sp.get("layout") ?? "";
  const layout: RegisterLayout = (layouts as string[]).includes(layoutParam)
    ? (layoutParam as RegisterLayout)
    : "list";
  const boardBy = sp.get("board_by") || defaultBoardBy(def);
  const lane: RegisterLane =
    sp.get("lane") === "region" ||
    (sp.get("lane") === "type" && !!def.record_types?.length)
      ? (sp.get("lane") as RegisterLane)
      : "none";
  // V2: the calendar's date field (`calf` in the URL and the saved views); the register's first date field is the default
  const calDates = dateFields(def);
  const calParam = sp.get("calf") ?? "";
  const calField = calDates.find((x) => x.code === calParam) ?? calDates[0];
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const regions = useRegions();
  // F16: As-Built splits CW BOQ / TE BOQ and Dismantle splits CW / TE by record_type (the server filter); the first tab is the default.
  // The first tab (All, value '') is the default: every row of the register, as the Excel master shows it.
  const tabDefs =
    key === "as_built"
      ? [
          { value: "", label: t("registers.tab_all") },
          { value: "cw_part", label: t("registers.tab_asb_cw") },
          { value: "te_part", label: t("registers.tab_asb_te") },
        ]
      : key === "dismantle"
        ? [
            { value: "", label: t("registers.tab_all") },
            { value: "cw", label: t("registers.tab_dis_cw") },
            { value: "te", label: t("registers.tab_dis_te") },
          ]
        : [];
  const tab = f.record_type;
  const list = useRegisterRecords(key, {
    ...f,
    record_type: tab,
    ...(adv ? { filter: adv } : {}),
  });
  const save = useUpdateRecord(key);
  const batch = useBatchEdit<RegisterRecord>(key, true, () => toast(t("batchedit.resumed")));
  // 0.15.22: a System Admin edits a locked row or column (the database exempts admins too); everyone else sees it read-only.
  const me = useMe(true).data;
  const admin = !!me?.is_system_admin;
  const [editing, setEditing] = useState<{ id: string; col: string } | null>(
    null,
  );
  const templates = useTemplates();
  const [uploading, setUploading] = useState(false);
  const [legacy, setLegacy] = useState(false); // 0063 (Q139): the one-time migration of the legacy HLC requests
  // The saved-views control mounts once the first page has settled; the list keeps its previous data, so a filter change does not unmount it.
  const viewsReady = !list.isPending;
  // The unified filter (owner request 2026-11-22): region and state are fields of the register list; the older URL parameters stay as chips so links and saved views keep working.
  const regionName = (id: string) => { const r = regions.data?.find((x) => x.id === Number(id)); return (i18n.language === "ar" && r?.name_ar) || r?.name_en || id; };
  const filterExtras: ExtraField[] = [
    { key: "region_id", label: t("sites.all_regions"), kind: "text", hidden: true, value: f.region_id, set: set("region_id"), chip: `${t("sites.region")}: ${f.region_id ? regionName(f.region_id) : ""}` },
    { key: "state", label: t("registers.all_states"), kind: "text", hidden: true, value: f.state, set: set("state"), chip: `${t("registers.state")}: ${f.state ? t(`regState.${f.state}`) : ""}` },
    ...(def.record_types?.length && !tabDefs.length
      ? [{ key: "record_type", label: t("registers.record_type"), group: "fields", kind: "enum" as const, options: def.record_types.map((x) => ({ value: x, label: x.toUpperCase() })), value: f.record_type, set: set("record_type") }]
      : []),
  ];
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  // the board and the map show every record of the filters (their column counts and sites must not depend on paging), up to ALL_CAP records
  const needAll = view === "vertical" && (layout === "board" || layout === "map");
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    if (needAll && hasNextPage && !isFetchingNextPage && items.length < ALL_CAP)
      void fetchNextPage();
  }, [needAll, hasNextPage, isFetchingNextPage, items.length, fetchNextPage]);
  // W8 item 6 (0.15.68): the counts come from the server: every record of the register the caller may see, and those matching the filters and the search
  const first = list.data?.pages[0] as CountedPage<(typeof items)[number]> | undefined;
  const total = first?.counts?.filtered ?? first?.page.total ?? items.length;
  const screenTotal = first?.counts?.total ?? total;
  const noun = key === "issues" ? "issues" : "records";
  const real0 = items.filter((r) => !r.id.startsWith("tmp-"));
  const partial =
    needAll && !list.isFetchingNextPage && real0.length < total
      ? { shown: real0.length, total }
      : null;
  // The catalogue only lists fields the caller may see, so a permission-hidden field never becomes a column (plan G1).
  const fieldCols = def.fields.filter((x) => x.in_list);
  const defs: ColDef[] = [
    ROWNO_COL,
    { id: "site", w: 100, min: 70, pinned: true },
    { id: "region", w: 110, min: 70, max: 240 },
    { id: "type", w: 80, min: 60 },
    ...fieldCols.map((c, i) => ({
      id: `f:${c.code}`,
      w: 150,
      min: 70,
      max: 320,
      off: i >= 4,
    })),
    { id: "state", w: 130, min: 90 },
    { id: "ball", w: 180, min: 90, max: 320 },
  ];
  const tbl = useTablePrefs(`register-${key}`, defs);
  const grid = useGridColumnMenu(key, tbl); // header menu: hide and personal order for all, add, rename, delete and global order for the admin

  // contract 0.7.0: every register has its own approved template (Template.register_key)
  const tpl = templates.data?.find((x) => x.register_key === key);
  const setRecord = (id: string | null) =>
    setSp(
      (p) => {
        const n = new URLSearchParams(p);
        if (id) n.set("record", id);
        else n.delete("record");
        return n;
      },
      { replace: true },
    );
  // One View menu replaces the row of layout buttons: list, wide table, grid, board and (where the records carry a site) map. The choice is kept per
  // user and register on the server (lib/viewPreference).
  const viewOptions: ViewOption[] = [
    { id: "list", label: t("view.list"), hint: t("view.list_hint"), icon: <Table2 size={14} />, testid: "register-layout-list" },
    { id: "wide", label: t("sites.wide"), hint: t("view.wide_hint"), icon: <TableProperties size={14} />, testid: "register-layout-wide" },
    { id: "grid", label: t("view.grid"), hint: t("view.grid_hint"), icon: <Grid3x3 size={14} />, testid: "register-layout-grid" },
    { id: "board", label: t("board.board"), hint: t("view.board_hint"), icon: <Columns3 size={14} />, testid: "register-layout-board" },
    ...(layouts.includes("map") ? [{ id: "map", label: t("sites.map"), hint: t("view.map_hint"), icon: <MapIcon size={14} />, testid: "register-layout-map" }] : []),
    ...(layouts.includes("calendar") ? [{ id: "calendar", label: t("calview.title"), hint: t("view.calendar_hint"), icon: <CalendarDays size={14} />, testid: "register-layout-calendar" }] : []),
  ];
  const applyView = (id: string) => setParams({ view: id === "grid" ? "grid" : "", layout: id === "grid" || id === "list" ? "" : id });
  const remember = useRememberedView(
    `register-${key}`,
    sp.has("layout") || sp.has("view"),
    (l) => viewOptions.some((o) => o.id === l),
    applyView,
  );
  const pickView = (id: string) => { applyView(id); remember(id); };
  const rname = (id?: number | null) => {
    const r = regions.data?.find((x) => x.id === id);
    return (i18n.language === "ar" && r?.name_ar) || r?.name_en || "-";
  };
  const name = (i18n.language === "ar" && def.name_ar) || def.name_en;

  const down = (prefill: boolean) =>
    tpl &&
    downloadTemplate(tpl.template_id, {
      prefill,
      regionId: f.region_id || undefined,
    }).then(
      (n) => toast(t("grid.downloaded", { name: n })),
      (e) => toast(registerErrorMessage(t, e), "err"),
    );
  const inlineField = (cid: string) =>
    cid.startsWith("f:")
      ? fieldCols.find((x) => `f:${x.code}` === cid)
      : undefined;
  const label = (id: string) => {
    const fc = fieldCols.find((c) => `f:${c.code}` === id);
    return fc
      ? fieldLabel(fc, i18n.language)
      : t(
          {
            rowno: "tstd.rowno",
            site: "sites.code",
            region: "sites.region",
            type: "registers.record_type",
            state: "registers.state",
            ball: "grid.ball",
          }[id] ?? id,
        );
  };
  const W = totalWidth(tbl.cols, true);
  const real = items.filter((r) => !r.id.startsWith("tmp-"));
  const flip = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allPicked = real.length > 0 && real.every((r) => picked.has(r.id));
  // 0103 (0.15.22): lock, unlock and void. Lock and void take a reason; the database decides every row. A row that is not eligible or is refused is named, never skipped silently.
  const lockRec = useRecordLock(key);
  const lockCol = useColumnLock(key);
  const voidRec = useRecordOp(key);
  const [bulk, setBulk] = useState<null | "lock" | "unlock" | "void">(null);
  const [colDlg, setColDlg] = useState<null | {
    code: string;
    locked: boolean;
  }>(null);
  const [colPick, setColPick] = useState("");
  const colLabel = (code: string) => {
    const x = def.fields.find((c) => c.code === code);
    return x ? fieldLabel(x, i18n.language) : code;
  };
  const runBulk = async (kind: "lock" | "unlock" | "void", reason: string) => {
    const rows = real.filter((r) => picked.has(r.id));
    const eligible = (r: RegisterRecord) =>
      kind === "void"
        ? !!r.allowed_actions?.includes("void")
        : (kind === "lock") !== !!r.locked;
    let done = 0;
    const notDone: string[] = [];
    for (const r of rows) {
      if (!eligible(r)) {
        notDone.push(r.site_code ?? r.id.slice(0, 8));
        continue;
      }
      try {
        if (kind === "void")
          await voidRec.mutateAsync({ record: r, op: "void", note: reason });
        else
          await lockRec.mutateAsync({
            record: r,
            locked: kind === "lock",
            reason,
          });
        done += 1;
      } catch {
        notDone.push(r.site_code ?? r.id.slice(0, 8));
      }
    }
    toast(t("registers.bulk_result", { done, refused: notDone.length }));
    if (notDone.length)
      toast(t("registers.bulk_refused", { list: notDone.join(", ") }), "err");
    setBulk(null);
  };
  const colLock = (code: string, locked: boolean, reason: string) =>
    lockCol.mutate(
      { code, locked, reason },
      {
        onSuccess: () =>
          toast(
            t(
              locked
                ? "registers.column_locked_ok"
                : "registers.column_unlocked_ok",
            ),
          ),
        onError: (e) => toast(registerErrorMessage(t, e), "err"),
      },
    );
  const chips = [
    ...(f.q
      ? [
          {
            key: "q",
            label: t("table.filter_q", { v: f.q }),
            onRemove: () => set("q")(""),
          },
        ]
      : []),
    ...(f.region_id
      ? [
          {
            key: "region_id",
            label: t("table.filter_region", { v: rname(Number(f.region_id)) }),
            onRemove: () => set("region_id")(""),
          },
        ]
      : []),
    ...(f.state
      ? [
          {
            key: "state",
            label: t("table.filter_state", { v: t(`regState.${f.state}`) }),
            onRemove: () => set("state")(""),
          },
        ]
      : []),
    ...(f.record_type
      ? [
          {
            key: "record_type",
            label: t("table.filter_type", { v: f.record_type.toUpperCase() }),
            onRemove: () => set("record_type")(""),
          },
        ]
      : []),
  ];
  // The text each cell shows, for sizing the columns to their content (null = not measurable here, e.g. the people chips of the ball column).
  const fitText = (id: string, r: (typeof items)[number]): FitSample | null => {
    if (id.startsWith("f:")) {
      const c = fieldCols.find((x) => `f:${x.code}` === id);
      const txt = c ? showValue(c, r.data[c.code], i18n.language, t) : "";
      return txt === ", " ? null : txt;
    }
    switch (id) {
      case "rowno":
        return null;
      case "site":
        return r.site_code ?? null;
      case "region":
        return rname(r.region_id as number | null);
      case "type":
        return r.record_type ? r.record_type.toUpperCase() : null;
      case "state":
        return [t(`regState.${r.state}`), 24];
      default:
        return null;
    }
  };
  useAutoFit(tbl, label, items, fitText, i18n.language);
  const cell = (id: string, r: (typeof items)[number]) => {
    if (id.startsWith("f:")) {
      const c = fieldCols.find((x) => `f:${x.code}` === id);
      if (!c) return <Empty />;
      const txt = showValue(c, r.data[c.code], i18n.language, t);
      return txt === "-" ? <Empty /> : <FieldValue f={c} v={r.data[c.code]} testid={`reg-cell-${r.id}-${c.code}`} />;
    }
    switch (id) {
      case "site":
        return (
          <>
            <b className="mono">{r.site_code ?? "-"}</b>
            {r.locked && (
              <span
                data-testid="reg-locked-badge"
                className="ms-2 rounded bg-hover px-1.5 text-xs text-mute"
              >
                {t("registers.locked_badge")}
              </span>
            )}
          </>
        );
      case "region":
        return <Trunc text={rname(r.region_id as number | null)} />;
      case "type":
        return r.record_type ? (
          <span>{r.record_type.toUpperCase()}</span>
        ) : (
          <Empty />
        );
      case "state":
        return (
          <StatusChip
            tone={STATE_TONE[r.state]}
            testid={`reg-state-${r.id}`}
            text={t(`regState.${r.state}`)}
          >
            {t(`regState.${r.state}`)}
          </StatusChip>
        );
      default:
        return r.ball_in_court &&
          (r.state === "in_review" || r.state === "in_approval") ? (
          <Holders holders={r.ball_in_court.holders} />
        ) : (
          <Empty />
        );
    }
  };

  return (
    <div data-testid={`page-register-${key}`}>
      <PageHeader title={name} />
      {OWNER_NOTE[key] && (
        <p className="mb-3 text-mute" data-testid="register-owner-note">
          {t(OWNER_NOTE[key])}
        </p>
      )}
      <div
        className="mb-3 flex flex-wrap items-center gap-2"
        data-testid="register-column-locks"
      >
        <select
          className="input w-auto"
          aria-label={t("registers.column_lock_select")}
          data-testid="register-column-lock-select"
          value={colPick}
          onChange={(e) => setColPick(e.target.value)}
        >
          <option value="">{t("registers.column_lock_select")}</option>
          {def.fields
            .filter((x) => !x.read_only && !x.locked)
            .map((x) => (
              <option key={x.code} value={x.code}>
                {fieldLabel(x, i18n.language)}
              </option>
            ))}
        </select>
        {canEditColumns(me) && (
          <Link
            className="btn"
            to="/admin/settings/registers/columns"
            data-testid="register-columns-settings"
          >
            {t("settings.tab_register-columns")}
          </Link>
        )}
        <button
          type="button"
          className="btn"
          disabled={!colPick}
          data-testid="register-column-lock"
          onClick={() => setColDlg({ code: colPick, locked: true })}
        >
          <Lock size={16} />
          {t("registers.column_lock")}
        </button>
        {def.fields
          .filter((x) => x.locked)
          .map((x) => (
            <button
              key={x.code}
              type="button"
              className="btn"
              data-testid={`register-column-unlock-${x.code}`}
              onClick={() => setColDlg({ code: x.code, locked: false })}
            >
              <Unlock size={16} />
              {t("registers.column_unlock", {
                field: fieldLabel(x, i18n.language),
              })}
            </button>
          ))}
      </div>
      <RejectDialog
        open={colDlg !== null}
        title={
          colDlg
            ? t(
                colDlg.locked
                  ? "registers.column_title_lock"
                  : "registers.column_title_unlock",
                { field: colLabel(colDlg.code) },
              )
            : ""
        }
        onClose={() => setColDlg(null)}
        onSend={(reason) => {
          if (colDlg) colLock(colDlg.code, colDlg.locked, reason);
          setColDlg(null);
          setColPick("");
        }}
      />
      {tabDefs.length > 0 && (
        <div
          className="mb-3 flex gap-1"
          role="group"
          aria-label={name}
          data-testid="register-tabs"
        >
          {tabDefs.map((x) => (
            <button
              key={x.value}
              type="button"
              className={`btn ${tab === x.value ? "btn-accent" : ""}`}
              aria-pressed={tab === x.value}
              data-testid={`register-tab-${x.value || "all"}`}
              onClick={() => set("record_type")(x.value)}
            >
              {x.label}
            </button>
          ))}
        </div>
      )}
      <PmDuePanel registerKey={key} />
      {/* W8: the shared table toolbar of the site-data screens (registers that list sites) */}
      <TableToolbar
        testid="register-toolbar"
        views={viewsReady ? (
          <Suspense fallback={null}>
            <SavedViews
              screen={`register-${key}`}
              value={{
                ...f,
                layout: layout === "list" ? "" : layout,
                board_by: layout === "board" ? (sp.get("board_by") ?? "") : "",
                lane: layout === "board" ? (sp.get("lane") ?? "") : "",
                calf: layout === "calendar" ? (sp.get("calf") ?? "") : "",
                ...(advTree ? { advanced: advTree } : {}),
              }}
              empty={VIEW_EMPTY}
              table={tbl}
              onApply={(v) =>
                setParams({
                  ...Object.fromEntries(
                    [...RF_KEYS, ...LAYOUT_KEYS].map((k) => [
                      k,
                      String((v as Record<string, unknown>)[k] ?? ""),
                    ]),
                  ),
                  adv: encodeFilter(v.advanced),
                })
              }
            />
          </Suspense>
        ) : undefined}
        search={<SearchBox testid="register-search" value={f.q} onChange={set("q")} placeholder={t("registers.search")} />}
        filter={viewsReady ? (
          <Suspense fallback={null}>
            <UnifiedFilter
              screen={`register-${key}`}
              value={advTree}
              onChange={(tree) => setParams({ adv: encodeFilter(tree) })}
              onClearAll={clearAll}
              extras={filterExtras}
            />
          </Suspense>
        ) : <span data-testid="register-filter-pending" />}
        extra={<PastedChip search={first?.search} />}
        count={
          <span className="flex items-center gap-2">
            {activeFilters > 0 && <span className="chip bg-accentSoft text-accentText" data-testid="toolbar-active-filters">{t("states.filters")} {activeFilters}</span>}
            <TableCount testid="register-count" noun={noun} total={screenTotal} filtered={total} active={activeFilters > 0} selected={picked.size} onClear={clearAll} />
            <ViewAnalytics def={def} records={real} total={total} />
          </span>
        }
        layout={
          /* V1: one Layout panel — the view switcher, the board's grouping and swimlanes while the board is on, and the Display options of the
             table layouts (list and wide table) */
          <LayoutPanel
            testid="register-view"
            views={{ value: view === "grid" ? "grid" : layout, options: viewOptions, onChange: pickView }}
            options={view === "vertical" && layout === "calendar" ? (
              <label className="flex items-center gap-2 text-sm"><span className="text-mute">{t("calview.field")}</span>
                <select className="input w-auto py-1" data-testid="register-calendar-field" value={calField?.code ?? ""} onChange={(e) => setParams({ calf: e.target.value === calDates[0]?.code ? "" : e.target.value })}>
                  {calDates.map((x) => <option key={x.code} value={x.code}>{fieldLabel(x, i18n.language)}</option>)}
                </select>
              </label>
            ) : view === "vertical" && layout === "board" ? (
              <>
                <label className="flex items-center gap-2 text-sm"><span className="text-mute">{t("regviews.board_by")}</span>
                  <select className="input w-auto py-1" data-testid="register-board-by" value={boardBy} onChange={(e) => setParams({ board_by: e.target.value === defaultBoardBy(def) ? "" : e.target.value })}>
                    {statusFields(def).map((f) => <option key={f.code} value={f.code}>{fieldLabel(f, i18n.language)}</option>)}
                    <option value={BY_STATE}>{t("regviews.by_state")}</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm"><span className="text-mute">{t("board.swimlane")}</span>
                  <select className="input w-auto py-1" data-testid="register-board-lane" value={lane} onChange={(e) => setParams({ lane: e.target.value === "none" ? "" : e.target.value })}>
                    {(def.record_types?.length ? ["none", "region", "type"] : ["none", "region"]).map((l) => <option key={l} value={l}>{l === "type" ? t("regviews.lane_type") : t(`board.lane_${l}`)}</option>)}
                  </select>
                </label>
              </>
            ) : undefined}
            table={view === "vertical" && (layout === "list" || layout === "wide") ? tbl : undefined}
          />
        }
        primary={
          <button
            className="btn btn-primary"
            data-testid="register-new"
            onClick={() => setRecord("new")}
          >
            <Plus size={16} />
            {t("registers.new")}
          </button>
        }
        columns={view === "vertical" ? <ColumnMenu api={tbl} label={label} /> : undefined}
        exporter={
            <TemplateExportMenu
              testid="register-tools"
              exportTestid="register-export"
              source={key}
              hasTemplate={!!tpl}
              onBlank={() => void down(false)}
              onFilled={() => void down(true)}
              onUpload={() => setUploading(true)}
              onBatches={() => nav(`/templates?register=${key}`)}
              filters={Object.fromEntries(
                Object.entries({ ...f, ...(adv ? { filter: adv } : {}) }).filter(([, x]) => x),
              )}
              columns={[
                "site_code",
                "region",
                "record_type",
                "state",
                ...tbl.cols
                  .filter((c) => c.id.startsWith("f:"))
                  .map((c) => c.id.slice(2)),
              ]}
            />
        }
        more={
            <MoreMenu
              items={[
                ...(key === "as_built"
                  ? [
                      {
                        id: "items",
                        label: t("asb.items_link"),
                        icon: <Ruler size={16} />,
                        testid: "register-asbuilt-items",
                        onSelect: () => nav("/as-built/items"),
                      },
                    ]
                  : []),
                ...(key === "hlc"
                  ? [
                      {
                        id: "hlc-legacy",
                        label: t("p4c.legacy_menu"),
                        icon: <ArrowRightLeft size={16} />,
                        testid: "register-hlc-legacy",
                        onSelect: () => setLegacy(true),
                      },
                    ]
                  : []),
                ...(key === "warehouse"
                  ? [
                      {
                        id: "wh",
                        label: t("wh.title"),
                        icon: <WarehouseIcon size={16} />,
                        testid: "register-warehouse-screen",
                        onSelect: () => nav("/warehouse"),
                      },
                    ]
                  : []),
                ...(grid.admin
                  ? [
                      {
                        id: "col-add",
                        label: t("regcols.add"),
                        icon: <Plus size={16} />,
                        testid: "register-column-add",
                        onSelect: grid.openAdd,
                      },
                      {
                        id: "col-manage",
                        label: t("regcols.manage"),
                        icon: <Columns3 size={16} />,
                        testid: "register-columns-manage",
                        onSelect: () =>
                          nav(
                            `/admin/settings/registers/columns?register=${key}`,
                          ),
                      },
                    ]
                  : []),
                {
                  id: "reset",
                  label: t("table.reset"),
                  icon: <RotateCcw size={16} />,
                  testid: "register-reset-cols",
                  onSelect: tbl.reset,
                },
              ]}
            />
        }
      />
      {tpl && (
        <TemplateUploadDialog
          open={uploading}
          onClose={() => setUploading(false)}
          templateId={tpl.template_id}
          templateName={`${name} · v${tpl.current_version}`}
          onDone={(b) => {
            setUploading(false);
            toast(t("grid.uploaded"));
            nav(`/registers/${key}/batches/${b.id}`);
          }}
        />
      )}
      {grid.dialogs}
      {key === "hlc" && (
        <HlcLegacyDialog open={legacy} onClose={() => setLegacy(false)} />
      )}
      <ActiveChips chips={chips} onClear={clearAll} />
      {view === "grid" && (
        <RegisterGrid
          testid="register-grid"
          rows={real}
          columns={[
            { id: "site", label: label("site") },
            { id: "region", label: label("region") },
            { id: "type", label: label("type") },
            ...fieldCols.map((c) => ({
              id: `f:${c.code}`,
              label: label(`f:${c.code}`),
            })),
            { id: "state", label: label("state") },
            { id: "ball", label: label("ball") },
          ]}
          cell={cell}
          onOpen={setRecord}
          canEdit={(cid, r) => {
            const fc = inlineField(cid);
            return (
              !!fc &&
              INLINE_TYPES.includes(fc.type) &&
              !fc.read_only &&
              (admin || (!fc.locked && !r.locked)) &&
              !!r.allowed_actions?.includes("edit")
            );
          }}
          editing={editing}
          onStartEdit={(id, col) => setEditing({ id, col })}
          renderEditor={(cid, r) => {
            const fc = inlineField(cid);
            if (!fc) return null;
            return (
              <GridCellEditor
                key={`${r.id}-${cid}`}
                field={fc}
                value={r.data[fc.code]}
                onClose={() => setEditing(null)}
                onSave={(v) => {
                  const before = r.data[fc.code];
                  save.mutate(
                    { record: r, patch: { data: { [fc.code]: v } } },
                    {
                      onError: (e) => toast(registerErrorMessage(t, e), "err"),
                      // undo for 8 seconds: the same edit path puts the old value back (same permissions and rules; the server may refuse it)
                      onSuccess: (saved) =>
                        toast(t("registers.inline_saved"), "ok", {
                          ms: 8000,
                          action: {
                            label: t("common.undo"),
                            onClick: () =>
                              save.mutate(
                                { record: saved, patch: { data: { [fc.code]: before ?? null } } },
                                {
                                  onSuccess: () => toast(t("registers.inline_undone")),
                                  onError: (e) => toast(registerErrorMessage(t, e), "err"),
                                },
                              ),
                          },
                        }),
                    },
                  );
                }}
              />
            );
          }}
        />
      )}
      {view === "vertical" && (
        <>
          {layout === "wide" && (
            <div className="mb-2 space-y-2">
              {!batch.on ? (
                <button type="button" className="btn" data-testid="batch-start" onClick={() => batch.setOn(true)}>{t("batchedit.start")}</button>
              ) : (
                <BatchEditBar
                  draft={batch.draft}
                  results={batch.results}
                  busy={batch.busy}
                  fieldLabel={(c) => { const f = def.fields.find((x) => x.code === c); return f ? fieldLabel(f, i18n.language) : c; }}
                  valueText={(_c, v) => (v === null || v === undefined ? "" : String(v))}
                  onSave={() => void batch.saveAll((id) => real.find((x) => x.id === id), (r, data) => save.mutateAsync({ record: r, patch: { data } }), (e) => registerErrorMessage(t, e)).then((out) => { const ok = out.filter((o) => o.status === "saved").length; if (ok) toast(t("batchedit.saved_n", { count: ok })); })}
                  onDiscard={batch.discard}
                  onExit={() => batch.setOn(false)}
                />
              )}
            </div>
          )}
          {layout === "wide" && (
            <RegisterWide
              def={def}
              records={real}
              admin={admin}
              regionName={(id) => rname(id as number | null)}
              onOpen={setRecord}
              pending={batch.on ? Object.fromEntries(Object.entries(batch.draft.changes).map(([id, r]) => [id, r.set])) : undefined}
              onSave={async (r, code, value) => {
                const before = r.data[code];
                if (batch.on) {
                  // batch mode: the edit waits in the draft; nothing is saved until Save all
                  batch.edit(r, r.site_code ?? r.id.slice(0, 8), code, before, value);
                  return null;
                }
                const saved = await save.mutateAsync({ record: r, patch: { data: { [code]: value } } });
                // undo for 8 seconds: the same edit path puts the old value back (the server may refuse it)
                toast(t("registers.inline_saved"), "ok", {
                  ms: 8000,
                  action: {
                    label: t("common.undo"),
                    onClick: () =>
                      save.mutate(
                        { record: saved, patch: { data: { [code]: before ?? null } } },
                        {
                          onSuccess: () => toast(t("registers.inline_undone")),
                          onError: (e) => toast(registerErrorMessage(t, e), "err"),
                        },
                      ),
                  },
                });
                return saved;
              }}
              errorText={(e) => registerErrorMessage(t, e)}
              display={tbl.display}
              height={Math.max(320, (typeof window === "undefined" ? 800 : window.innerHeight) - 260)}
              current={recordId}
              picked={picked}
              onPick={flip}
              onPickAll={() =>
                setPicked(allPicked ? new Set() : new Set(real.map((r) => r.id)))
              }
              hasMore={false /* the "Load more" of the page below serves every layout */}
              loadingMore={list.isFetchingNextPage}
              onMore={() => void list.fetchNextPage()}
              loaded={list.isSuccess}
              filtered={activeFilters > 0}
              onClear={clearAll}
            />
          )}
          {layout === "board" && (
            <RegisterBoard
              def={def}
              records={real}
              by={boardBy}
              lane={lane}
              regionName={(id) => rname(id as number | null)}
              onOpen={setRecord}
              partial={partial}
            />
          )}
          {layout === "map" && (
            <RegisterMap records={real} regionId={f.region_id} partial={partial} />
          )}
          {layout === "calendar" && (
            <RegisterCalendar def={def} records={real} field={calField} onOpen={setRecord} partial={partial} />
          )}
          {layout === "list" && (
          <div className="card gx overflow-hidden" {...displayAttrs(tbl.display)} data-testid="register-list-card">
            <div
              className="relative max-h-[calc(100vh-18rem)] min-h-40 overflow-auto"
              data-testid="register-scroll"
            >
              <HeaderRow
                api={tbl}
                label={label}
                colMenu={grid.colMenu}
                select={{
                  checked: allPicked,
                  indeterminate: picked.size > 0,
                  onChange: () =>
                    setPicked(
                      allPicked ? new Set() : new Set(real.map((r) => r.id)),
                    ),
                  label: t("table.select_all"),
                  testid: "register-select-all",
                }}
              />
              <div
                data-testid="register-list"
                role="list"
                style={{ minWidth: W }}
              >
                {items.map((r, i) => {
                  const tmp = r.id.startsWith("tmp-"),
                    on = picked.has(r.id),
                    cur = recordId === r.id;
                  const g = gxRow(i, { picked: on, current: cur, muted: tmp });
                  return (
                    <div
                      key={r.id}
                      role="listitem"
                      tabIndex={0}
                      aria-selected={on || cur}
                      onKeyDown={(e) => {
                        if (
                          (e.key === "Enter" || e.key === " ") &&
                          e.target === e.currentTarget
                        ) {
                          e.preventDefault();
                          if (!tmp) setRecord(r.id);
                        }
                      }}
                      data-testid={`reg-row-${r.id}`}
                      data-state={r.state}
                      data-locked={r.locked || undefined}
                      data-current={cur || undefined}
                      data-zebra={g["data-zebra"]}
                      data-picked={g["data-picked"]}
                      onClick={() => !tmp && setRecord(r.id)}
                      style={{ gridTemplateColumns: tracks(tbl.cols, true) }}
                      className={`grid w-full cursor-pointer items-center border-b border-line text-start text-sm ${rowPad(tbl.density)} ${g.className}`}
                    >
                      <div className="sticky start-0 z-10 flex items-center justify-center gap-1 bg-inherit">
                        {!tmp && (
                          <SelectBox
                            checked={on}
                            onChange={() => flip(r.id)}
                            label={t("table.select_row", {
                              code: r.site_code ?? r.id,
                            })}
                            testid={`reg-select-${r.id}`}
                          />
                        )}
                      </div>
                      {tbl.cols.map((c) => {
                        const p = pin(c, true, tbl.cols);
                        return (
                          <div
                            key={c.id}
                            data-col={c.id}
                            className={`min-w-0 px-2 ${p.className}`}
                            style={p.style}
                          >
                            {c.id === "rowno" ? <span data-testid="reg-row-no"><RowNo n={i + 1} /></span> : cell(c.id, r)}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
                {list.isLoading && <LoadingSkeleton />}
                {list.isSuccess &&
                  !items.length &&
                  (activeFilters ? (
                    <NoResults testid="register-empty" onClear={clearAll} />
                  ) : (
                    <EmptyState
                      testid="register-empty"
                      title={t("registers.empty")}
                    />
                  ))}
                {list.isError && (
                  <ErrorState onRetry={() => void list.refetch()} />
                )}
              </div>
            </div>
          </div>
          )}
          {layout !== "list" && list.isError && (
            <ErrorState onRetry={() => void list.refetch()} />
          )}
          <BulkBar
            testid="register-bulk"
            count={picked.size}
            loaded={real.length}
            total={total}
            onClear={() => setPicked(new Set())}
          >
            <button
              type="button"
              className="btn"
              data-testid="register-bulk-lock"
              onClick={() => setBulk("lock")}
            >
              <Lock size={16} />
              {t("registers.lock_selected")}
            </button>
            <button
              type="button"
              className="btn"
              data-testid="register-bulk-unlock"
              onClick={() => setBulk("unlock")}
            >
              <Unlock size={16} />
              {t("registers.unlock_selected")}
            </button>
            <button
              type="button"
              className="btn"
              data-testid="register-bulk-void"
              onClick={() => setBulk("void")}
            >
              {t("registers.void_selected")}
            </button>
            {picked.size === 1 && (
              <button
                type="button"
                className="btn"
                data-testid="register-bulk-open"
                onClick={() => setRecord([...picked][0])}
              >
                {t("table.open_selected")}
              </button>
            )}
            <button
              type="button"
              className="btn"
              data-testid="register-bulk-copy"
              onClick={() => {
                void navigator.clipboard?.writeText(
                  real
                    .filter((r) => picked.has(r.id))
                    .map((r) => r.site_code ?? r.id)
                    .join("\n"),
                );
                toast(t("table.copied", { count: picked.size }));
              }}
            >
              {t("table.copy_codes")}
            </button>
          </BulkBar>
          <RejectDialog
            open={bulk !== null}
            title={
              bulk
                ? t(`registers.bulk_title_${bulk}`, { count: picked.size })
                : ""
            }
            onClose={() => setBulk(null)}
            onSend={(reason) => {
              if (bulk) void runBulk(bulk, reason);
            }}
          />
        </>
      )}
      <ShownFooter shown={real.length} filtered={total} />
      {list.hasNextPage && (
        <button
          className="btn mt-3"
          data-testid="register-more"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          <Download size={16} />
          {t("registers.more")}
        </button>
      )}
      <RegisterDrawer
        def={def}
        recordId={recordId}
        nav={real.map((r) => r.id)}
        onClose={() => setRecord(null)}
        onOpen={setRecord}
      />
    </div>
  );
}

export function RegisterPage() {
  const { t } = useTranslation();
  const { key = "" } = useParams();
  const defs = useRegisterDefs();
  if (!isLive(key)) return <RegisterSoon name={key} />;
  if (defs.isLoading) return <p className="text-mute">{t("common.loading")}</p>;
  const def = defs.data?.find((d) => d.register_key === key);
  if (!def)
    return defs.isError ? (
      <p role="alert" className="text-lateInk">
        {t("errors.generic")}
      </p>
    ) : (
      <Navigate to="/my-work" replace />
    );
  return <RegisterList key={key} def={def} />;
}
