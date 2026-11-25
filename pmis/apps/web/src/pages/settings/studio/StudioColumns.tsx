import * as Popover from '@radix-ui/react-popover';
import { MoreHorizontal, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { useColumnDetails, useColumnAdmin, usePreviewColumnType, type ColumnAdmin, type ColumnType, type MenuKey } from '@/api/site360Columns';
import { SITE360_MOVABLE_MENUS } from '@/api/site360';
import { useListCatalogues } from '@/api/lists';
import { FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { colCb, useColErr } from './colErr';
import type { ColCtx, Ctx } from './studioCtx';
import { StudioCard } from './StudioForms';

const lbl = 'block text-sm font-semibold';
const field = 'input mt-1 min-h-11 font-normal';
export const COLUMN_TYPE_LIST: ColumnType[] = ['text', 'number', 'date', 'list', 'yes_no'];

/** The column as people name it: the letter and the name of the language in use. */
export const colName = (c: Pick<ColumnAdmin, 'name_en' | 'name_ar' | 'header'>, ar: boolean) => (ar && c.name_ar ? c.name_ar : c.name_en ?? c.header);

export function Dialogs({ c, dlg, onClose }: { c: ColCtx; dlg: Dlg; onClose: () => void }) {
  if (!dlg) return null;
  if (dlg.kind === 'rename') return <RenameDialog c={c} col={dlg.col} onClose={onClose} />;
  if (dlg.kind === 'menus') return <MenusDialog c={c} col={dlg.col} onClose={onClose} />;
  return <TypeDialog c={c} col={dlg.col} mode={dlg.kind} onClose={onClose} />;
}
export type Dlg = null | { kind: 'rename' | 'type' | 'list' | 'menus'; col: ColumnAdmin };

/** The card of a task form: the Site Master columns whose source is this task, with the row actions of the Studio. */
export function TaskColumnsCard({ c, code }: { c: Ctx; code: string }) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const q = useColumnAdmin();
  const lists = useListCatalogues().data ?? [];
  const mine = (q.data?.items ?? []).filter((x) => x.source.kind === 'task' && x.source.task_code === code);
  const details = useColumnDetails(mine.filter((x) => x.is_added && !x.is_protected).map((x) => x.ord)).data;
  const [dlg, setDlg] = useState<Dlg>(null);
  const listName = (codeOf: string | null) => { const l = lists.find((x) => x.code === codeOf); return l ? (ar && l.name_ar ? l.name_ar : l.name_en) : codeOf; };
  const forbidden = q.error instanceof ApiError && q.error.status === 403;

  return (
    <StudioCard title={t('studio.master_cols')} testid="studio-card-master" aside={
      <button type="button" className="btn min-h-11" data-testid="studio-col-add" disabled={!c.canCols} title={!c.canCols ? t('studio.columns.readonly') : undefined} onClick={() => c.addColumn(code)}>
        <Plus size={14} aria-hidden />{t('studio.columns.add')}
      </button>}>
      {q.isLoading && <p className="text-sm text-mute" data-testid="studio-col-loading">{t('studio.columns.loading')}</p>}
      {q.isError && <p role="alert" className="text-sm text-lateInk" data-testid="studio-col-error">{forbidden ? t('studio.columns.no_access') : t('errors.generic')}</p>}
      {q.data && mine.length === 0 && <div className="rounded-lg border border-dashed border-line p-4 text-center text-sm text-mute" data-testid="studio-master-empty">{t('studio.columns.empty')}</div>}
      {mine.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm" aria-label={t('studio.columns.table_aria', { code })} data-testid="studio-col-table">
            <thead><tr className="text-start text-xs text-mute">
              {(['col', 'name', 'type', 'list', 'menus', 'state'] as const).map((k) => <th key={k} scope="col" className="p-2 text-start font-semibold">{t(`studio.columns.${k}`)}</th>)}
              <th scope="col" className="p-2"><span className="sr-only">{t('studio.columns.actions')}</span></th>
            </tr></thead>
            <tbody>
              {mine.map((col) => {
                const letter = col.letter;
                return (
                  <tr key={col.ord} className={`border-t border-line align-top ${col.is_active ? '' : 'opacity-70'}`} data-testid={`studio-col-row-${letter}`} data-ord={col.ord} data-active={col.is_active}>
                    <td className="p-2 font-mono" dir="ltr" data-testid={`studio-col-letter-${letter}`}>{letter}</td>
                    <td className="p-2">
                      <span data-testid={`studio-col-name-${letter}`}>{colName(col, ar)}</span>
                      <span className="ms-2 inline-flex flex-wrap gap-1 align-middle">
                        {col.is_protected && <span className="chip bg-lockBg text-lockInk" title={col.protected_reason ?? undefined} data-testid={`studio-col-protected-${letter}`}>{t('studio.columns.protected')}</span>}
                        {col.is_added && <span className="chip bg-hover text-ink">{t('studio.columns.added')}</span>}
                      </span>
                      <div className="text-xs text-mute" dir="ltr">{col.source.input_label ?? col.source.field_key}</div>
                    </td>
                    <td className="p-2" data-testid={`studio-col-type-${letter}`}>{t(`studio.columns.type_${col.value_type}`)}</td>
                    <td className="p-2" data-testid={`studio-col-list-${letter}`}>{col.value_type === 'list' ? <>{listName(col.list_catalogue)} <span className="mono text-xs text-mute" dir="ltr">{col.list_catalogue}</span></> : <span className="text-mute">{t('studio.columns.no_list')}</span>}</td>
                    <td className="p-2" data-testid={`studio-col-menus-${letter}`}>
                      <span className="flex flex-wrap gap-1">
                        {col.sections.includes('status') ? <span className="chip bg-hover text-ink">{t('studio.columns.protected')}</span>
                          : col.sections.length === 0 ? <span className="text-mute">{t('studio.columns.no_menus')}</span>
                            : col.sections.map((s) => <span key={s} className="chip bg-accentSoft text-accentText" data-testid={`studio-col-menu-${letter}-${s}`}>{t(`studio.columns.menu_${s}`)}</span>)}
                      </span>
                    </td>
                    <td className="p-2"><span className={`chip ${col.is_active ? 'bg-accentSoft text-accentText' : 'bg-waitBg text-waitInk'}`} data-testid={`studio-col-state-${letter}`}>{t(col.is_active ? 'studio.columns.active' : 'studio.columns.inactive')}</span></td>
                    <td className="p-2 text-end"><RowActions c={c} col={col} del={details?.[col.ord]?.delete_mode === 'hard'} onDialog={(kind) => setDlg({ kind, col })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Dialogs c={c} dlg={dlg} onClose={() => setDlg(null)} />
    </StudioCard>
  );
}

const item = 'flex min-h-11 w-full items-center rounded-md px-3 text-start text-sm hover:bg-hover disabled:pointer-events-none disabled:opacity-50';

const Item = ({ ord, id, label, why, onClick }: { ord: number; id: string; label: string; why: string | null; onClick: () => void }) => (
  <button type="button" role="menuitem" className={item} data-testid={`studio-col-${id}-${ord}`} disabled={!!why} aria-disabled={!!why} title={why ?? undefined} onClick={onClick}>{label}</button>
);

/** The actions of one column. A protected column keeps only the rename and the menus; the others are disabled with the reason. Delete shows only when the API allows it. */
export function RowActions({ c, col, del, onDialog }: { c: ColCtx; col: ColumnAdmin; del: boolean; onDialog: (k: 'rename' | 'type' | 'list' | 'menus') => void }) {
  const { t } = useTranslation();
  const fmt = useColErr();
  const [open, setOpen] = useState(false);
  const ord = col.ord;
  const off = !c.canCols ? t('studio.columns.readonly') : null;
  const prot = off ?? (col.is_protected ? col.protected_reason ?? t('studio.columns.protected_why') : null);
  const notList = prot ?? (col.value_type !== 'list' ? t('studio.columns.list_only') : null);
  const noMenus = off ?? (col.sections.includes('status') ? t('studio.columns.status_menus') : null);
  const done = (k: 'rename' | 'type' | 'list' | 'menus') => () => { setOpen(false); onDialog(k); };
  const toggle = (on: boolean) => {
    setOpen(false);
    const mut = on ? c.W.colReactivate : c.W.colDeactivate;
    c.askReason({ title: t(on ? 'studio.columns.reactivate_title' : 'studio.columns.deactivate_title', { col: col.letter }), hint: t(on ? 'studio.columns.reactivate_hint' : 'studio.columns.deactivate_hint'),
      run: (reason, cb) => mut.mutate({ ord, version: col.version, reason }, colCb(cb, fmt)) });
  };
  const remove = () => {
    setOpen(false);
    c.askReason({ title: t('studio.columns.delete_title', { col: col.letter }), hint: t('studio.columns.delete_hint'), run: (reason, cb) => c.W.colDelete.mutate({ ord, version: col.version, reason }, colCb(cb, fmt)) });
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="btn min-h-11 min-w-11" aria-haspopup="menu" aria-label={t('studio.columns.row_actions', { col: col.letter })} data-testid={`studio-col-actions-${ord}`}><MoreHorizontal size={16} aria-hidden /></button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} role="menu" aria-label={t('studio.columns.row_actions', { col: col.letter })} className="card z-[60] w-60 p-1 shadow-lg" data-testid={`studio-col-menu-${ord}`}>
          <Item ord={ord} id="rename" label={t('studio.columns.act_rename')} why={off} onClick={done('rename')} />
          <Item ord={ord} id="type" label={t('studio.columns.act_type')} why={prot} onClick={done('type')} />
          <Item ord={ord} id="list" label={t('studio.columns.act_list')} why={notList} onClick={done('list')} />
          <Item ord={ord} id="menus" label={t('studio.columns.act_menus')} why={noMenus} onClick={done('menus')} />
          {col.is_active
            ? <Item ord={ord} id="deactivate" label={t('studio.columns.act_deactivate')} why={prot} onClick={() => toggle(false)} />
            : <Item ord={ord} id="reactivate" label={t('studio.columns.act_reactivate')} why={off} onClick={() => toggle(true)} />}
          {del && !col.is_protected && <Item ord={ord} id="delete" label={t('studio.columns.act_delete')} why={off} onClick={remove} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function RenameDialog({ c, col, onClose }: { c: ColCtx; col: ColumnAdmin; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const err = useColErr();
  const [en, setEn] = useState(col.name_en ?? '');
  const [ar, setAr] = useState(col.name_ar ?? '');
  const [error, setError] = useState<string | null>(null);
  const dirty = en.trim() !== (col.name_en ?? '') || ar.trim() !== (col.name_ar ?? '');
  return (
    <FormDialog open onClose={onClose} testid="studio-col-rename-dialog" title={t('studio.columns.rename_title', { col: col.letter })} busy={c.W.colUpdate.isPending} error={error} disabled={!en.trim() || !dirty}
      onSubmit={(reason) => { setError(null); c.W.colUpdate.mutate({ ord: col.ord, version: col.version, body: { name_en: en.trim(), name_ar: ar.trim() || null, reason } }, { onSuccess: () => { toast(t('wfe.saved')); onClose(); }, onError: (e) => setError(err(e)) }); }}>
      <label className={lbl}>{t('wfe.name_en')}<input className={field} dir="ltr" data-testid="studio-col-name-en" value={en} onChange={(e) => setEn(e.target.value)} /></label>
      <label className={lbl}>{t('wfe.name_ar')}<input className={field} dir="rtl" data-testid="studio-col-name-ar" value={ar} onChange={(e) => setAr(e.target.value)} /></label>
    </FormDialog>
  );
}

function MenusDialog({ c, col, onClose }: { c: ColCtx; col: ColumnAdmin; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const err = useColErr();
  const [pick, setPick] = useState<MenuKey[]>(col.sections.filter((s): s is MenuKey => (SITE360_MOVABLE_MENUS as readonly string[]).includes(s)));
  const [error, setError] = useState<string | null>(null);
  const same = pick.length === col.sections.length && pick.every((s) => (col.sections as string[]).includes(s));
  return (
    <FormDialog open onClose={onClose} testid="studio-col-menus-dialog" title={t('studio.columns.menus_title', { col: col.letter })} busy={c.W.colSections.isPending} error={error} disabled={pick.length === 0 || same}
      onSubmit={(reason) => { setError(null); c.W.colSections.mutate({ ord: col.ord, sections: pick, reason }, { onSuccess: () => { toast(t('wfe.saved')); onClose(); }, onError: (e) => setError(err(e)) }); }}>
      <p className="text-sm text-mute">{t('studio.columns.menus_hint')}</p>
      <MenuPicker value={pick} onChange={setPick} prefix="studio-col-menu-pick" />
    </FormDialog>
  );
}

/** The seven SITE 360 menus a column may be in, as checkboxes of 44px. */
export function MenuPicker({ value, onChange, prefix }: { value: MenuKey[]; onChange: (v: MenuKey[]) => void; prefix: string }) {
  const { t } = useTranslation();
  return (
    <fieldset className="grid gap-1 sm:grid-cols-2" data-testid={prefix}>
      <legend className="sr-only">{t('studio.columns.menus')}</legend>
      {SITE360_MOVABLE_MENUS.map((m) => (
        <label key={m} className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" className="h-5 w-5" data-testid={`${prefix}-${m}`} checked={value.includes(m)} onChange={(e) => onChange(e.target.checked ? [...value, m] : value.filter((x) => x !== m))} />{t(`studio.columns.menu_${m}`)}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Change the type or the dropdown list of a column. The stored values are never rewritten, so before the change the Studio asks the API how many of them would
 * not fit (type-preview) and shows the count; with unconvertible values the admin must accept that they stay as they are (`confirm_unconvertible`).
 */
function TypeDialog({ c, col, mode, onClose }: { c: ColCtx; col: ColumnAdmin; mode: 'type' | 'list'; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const err = useColErr();
  const lists = (useListCatalogues().data ?? []).filter((l) => l.is_active);
  const prev = usePreviewColumnType();
  const [type, setType] = useState<ColumnType>(mode === 'list' ? 'list' : col.value_type);
  const [list, setList] = useState(col.list_catalogue ?? '');
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listOf = type === 'list' ? list : null;
  const key = `${type}|${listOf ?? ''}`;
  const [checked, setChecked] = useState<string | null>(null);
  const p = checked === key ? prev.data : undefined;
  const changed = type !== col.value_type || (listOf ?? '') !== (col.list_catalogue ?? '');
  const bad = p?.not_convertible ?? 0;
  const ready = changed && !!p && (type !== 'list' || !!list) && (bad === 0 || accept);
  const nm = (l: { name_en: string; name_ar?: string | null }) => (i18n.language === 'ar' && l.name_ar ? l.name_ar : l.name_en);
  const reset = () => { setChecked(null); setAccept(false); prev.reset(); setError(null); };
  const check = () => { setError(null); prev.mutate({ ord: col.ord, value_type: type, list_catalogue: listOf }, { onSuccess: () => setChecked(key), onError: (e) => setError(err(e)) }); };
  return (
    <FormDialog open wide onClose={onClose} testid="studio-col-type-dialog" title={t(mode === 'list' ? 'studio.columns.list_title' : 'studio.columns.type_title', { col: col.letter })} busy={c.W.colUpdate.isPending} error={error} disabled={!ready} submitLabel={t('studio.columns.confirm')}
      onSubmit={(reason) => { setError(null); c.W.colUpdate.mutate({ ord: col.ord, version: col.version, body: { value_type: type, ...(type === 'list' ? { list_catalogue: list } : col.value_type === 'list' ? { list_catalogue: null } : {}), ...(bad > 0 ? { confirm_unconvertible: true } : {}), reason } },
        { onSuccess: () => { toast(t('wfe.saved')); onClose(); }, onError: (e) => setError(err(e)) }); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        {mode === 'type' && (
          <label className={lbl}>{t('studio.columns.new_type')}
            <select className={field} data-testid="studio-col-type-select" value={type} onChange={(e) => { setType(e.target.value as ColumnType); reset(); }}>
              {COLUMN_TYPE_LIST.map((x) => <option key={x} value={x}>{t(`studio.columns.type_${x}`)}</option>)}</select></label>
        )}
        {type === 'list' && (
          <label className={lbl}>{t('studio.columns.new_list')}
            <select className={field} data-testid="studio-col-list-select" value={list} onChange={(e) => { setList(e.target.value); reset(); }}>
              <option value="">{t('studio.columns.pick_list')}</option>{lists.map((l) => <option key={l.code} value={l.code}>{nm(l)} ({l.code})</option>)}</select></label>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn min-h-11" data-testid="studio-col-preview" disabled={!changed || prev.isPending || (type === 'list' && !list)} onClick={check}>{prev.isPending ? t('studio.columns.checking') : t('studio.columns.check')}</button>
        {!p && <span className="text-sm text-mute">{t('studio.columns.check_first')}</span>}
      </div>
      {p && (
        <div className="space-y-2 rounded-lg border border-line p-3 text-sm" role="status" data-testid="studio-col-preview-result" data-bad={bad} data-total={p.total_values}>
          <p className="font-semibold">{p.total_values === 0 ? t('studio.columns.preview_none') : bad === 0 ? t('studio.columns.preview_ok', { total: p.total_values }) : t('studio.columns.preview_bad', { bad, total: p.total_values })}</p>
          {bad > 0 && <>
            <p className="text-mute">{t('studio.columns.preview_note')}</p>
            <ul className="list-disc ps-5" data-testid="studio-col-preview-samples">{p.samples.slice(0, 5).map((s) => <li key={`${s.site_code}-${s.value}`} dir="ltr">{t('studio.columns.sample', { site: s.site_code, value: s.value })}</li>)}</ul>
            <label className="flex min-h-11 items-center gap-2"><input type="checkbox" className="h-5 w-5" data-testid="studio-col-accept" checked={accept} onChange={(e) => setAccept(e.target.checked)} />{t('studio.columns.accept')}</label>
          </>}
        </div>
      )}
    </FormDialog>
  );
}
