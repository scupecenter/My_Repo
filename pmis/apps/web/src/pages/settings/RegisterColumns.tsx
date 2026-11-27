import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, Pencil, Plus, TextCursorInput, Trash2, Undo2 } from 'lucide-react';
import { InlineCell } from '@/components/InlineCell';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useColumnImpact, useDeleteColumn, useDeleteSection, useRegisterColumns, useRenameRegister, useReorderColumns, useSaveSection, useSetColumnDefault, useUpdateColumn } from '@/api/registerColumns';
import { useRegisterDefs } from '@/api/registers';
import type { RegisterColumn, RegisterColumnPatch, RegisterColumnType, RegisterSection } from '@/api/types';
import { FieldInput, showValue } from '@/components/RegisterFields';
import { ColumnDialog, type Place } from '@/components/ColumnDialog';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { ItemColumns } from './ItemColumns';
import { RegisterStatePanel } from './RegisterStatePanel';
import { isStreamKey, STREAM_MENUS, STREAM_PREFIX, StreamColumns, type StreamMenu } from './StreamColumns';

type Dlg =
  | { k: 'add'; place?: Place } | { k: 'edit'; c: RegisterColumn } | { k: 'delete'; c: RegisterColumn } | { k: 'react'; c: RegisterColumn }
  | { k: 'section'; s?: RegisterSection } | { k: 'section-del'; s: RegisterSection } | { k: 'rename' } | { k: 'default'; c: RegisterColumn };

/** 0.15.103: the column types that can carry a default value (the database refuses the others). */
const DEFAULTABLE = ['text', 'long_text', 'email', 'phone', 'link', 'number', 'currency', 'percentage', 'date', 'yes_no', 'list', 'multi_list'];

/** Settings, register columns (contract 0.15.13): the admin adds, edits, orders, hides and removes the columns, sections and name of a register. */
export function RegisterColumns() {
  const [sp] = useSearchParams();
  const k = sp.get('register') || 'gecol';
  if (k === ITEMS_KEY) return <ItemsPage />;
  return isStreamKey(k) ? <StreamPage menu={k.slice(STREAM_PREFIX.length) as StreamMenu} /> : <RegisterColumnsOf />;
}

const ITEMS_KEY = 'wh:items';

/** The one dropdown of the Columns page: the Site Master streams, then every register and log. */
function ColumnsPicker({ value, onChange }: { value: string; onChange: (k: string) => void }) {
  const { t, i18n } = useTranslation();
  const defs = useRegisterDefs();
  const lang = i18n.language;
  return (
    <select className="input w-auto" aria-label={t('regcols.register')} data-testid="regcols-register" value={value} onChange={(e) => onChange(e.target.value)}>
      <optgroup label={t('regcols.group_streams')}>
        {STREAM_MENUS.map((m) => <option key={m} value={STREAM_PREFIX + m}>{t(`studio.columns.menu_${m}`)}</option>)}
      </optgroup>
      <optgroup label={t('itemcols.group')}>
        <option value={ITEMS_KEY}>{t('itemcols.title')}</option>
      </optgroup>
      <optgroup label={t('regcols.group_registers')}>
        {(defs.data ?? []).map((d) => <option key={d.register_key} value={d.register_key}>{(lang === 'ar' && d.name_ar) || d.name_en}</option>)}
      </optgroup>
    </select>
  );
}

function ItemsPage() {
  const { t } = useTranslation();
  const [, setSp] = useSearchParams();
  return (
    <section className="space-y-3" data-testid="page-register-columns">
      <RegisterStatePanel />
      <div className="card space-y-3 p-4">
        <h2 className="font-bold">{t('regcols.title')}</h2>
        <ColumnsPicker value={ITEMS_KEY} onChange={(k) => setSp({ register: k }, { replace: true })} />
        <ItemColumns />
      </div>
    </section>
  );
}

function StreamPage({ menu }: { menu: StreamMenu }) {
  const { t } = useTranslation();
  const [, setSp] = useSearchParams();
  return (
    <section className="space-y-3" data-testid="page-register-columns">
      <div className="card space-y-3 p-4">
        <h2 className="font-bold">{t('regcols.title')}</h2>
        <ColumnsPicker value={STREAM_PREFIX + menu} onChange={(k) => setSp({ register: k }, { replace: true })} />
        <StreamColumns menu={menu} />
      </div>
    </section>
  );
}

function RegisterColumnsOf() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const key = sp.get('register') || 'gecol';
  const setKey = (k: string) => setSp({ register: k }, { replace: true });
  const scr = useRegisterColumns(key);
  const regDefs = useRegisterDefs();
  const setDefault = useSetColumnDefault(key);
  const [dval, setDval] = useState<unknown>('');
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState({ en: '', ar: '' });
  const [sec, setSec] = useState({ en: '', ar: '' });
  const del = useDeleteColumn(key), upd = useUpdateColumn(key), order = useReorderColumns(key), saveSec = useSaveSection(key), delSec = useDeleteSection(key), ren = useRenameRegister(key);
  const impact = useColumnImpact(key, dlg?.k === 'delete' ? dlg.c.code : null);
  const fields = scr.data?.fields ?? [], sections = scr.data?.sections ?? [];
  const close = () => { setDlg(null); setErr(null); };
  const run = async (fn: () => Promise<unknown>, ok: string) => { setErr(null); try { await fn(); toast(ok); close(); } catch (e) { setErr(errText(e, t)); } };
  const secName = (s: string | null | undefined) => { const x = sections.find((y) => y.name_en === s); return x ? (lang === 'ar' && x.name_ar) || x.name_en : s ?? '—'; };
  const [drag, setDrag] = useState<string | null>(null);
  // Edit in place next to the pencil form: a cell saves ONE column through the same update call (audited, a new template version), with the reason typed above the table.
  const [inReason, setInReason] = useState('');
  const SIMPLE = ['text', 'long_text', 'number', 'currency', 'percentage', 'date', 'datetime', 'yes_no', 'email', 'phone', 'link'];
  const saveCol = async (c: RegisterColumn, patch: Partial<RegisterColumnPatch>) => {
    if (inReason.trim().length < 3) throw new Error(t('regcols.inline_need_reason'));
    try { await upd.mutateAsync({ code: c.code, version: c.version, patch: { ...patch, reason: inReason.trim() } as RegisterColumnPatch }); toast(t('regcols.saved')); }
    catch (e) { throw new Error(errText(e, t)); }
  };
  /** Drag and drop: the dragged column takes the place of the one it is dropped on (the arrows are the keyboard way). */
  const dropOn = (onto: string) => {
    if (!drag || drag === onto) { setDrag(null); return; }
    const codes = fields.map((f) => f.code).filter((x) => x !== drag);
    codes.splice(codes.indexOf(onto) + (fields.findIndex((f) => f.code === drag) < fields.findIndex((f) => f.code === onto) ? 1 : 0), 0, drag);
    setDrag(null);
    order.mutate({ codes, reason: t('regcols.reorder_reason') }, { onError: (e) => toast(errText(e, t), 'err') });
  };
  /** The four visibility switches (list, filters, template, export) together. A template natural key stays in the template (the database says so); the other three still go. Nothing is deleted. */
  const isHidden = (c: RegisterColumn) => !c.in_list && !c.in_filter && !c.in_export;
  const setHidden = async (c: RegisterColumn, hide: boolean) => {
    const on = !hide;
    const base = { in_list: on, in_filter: on, in_export: on, reason: t(hide ? 'regcols.hide_reason' : 'regcols.show_reason') };
    try {
      await upd.mutateAsync({ code: c.code, version: c.version, patch: { ...base, in_template: on } });
      toast(t(hide ? 'regcols.hidden_done' : 'regcols.shown_done'));
    } catch (e) {
      if (!hide) { toast(errText(e, t), 'err'); return; }
      try { await upd.mutateAsync({ code: c.code, version: c.version, patch: base }); toast(t('regcols.hidden_kept_template')); } catch (e2) { toast(errText(e2, t), 'err'); }
    }
  };
  const move = (c: RegisterColumn, d: -1 | 1) => {
    const codes = fields.map((f) => f.code), i = codes.indexOf(c.code), j = i + d;
    if (j < 0 || j >= codes.length) return;
    [codes[i], codes[j]] = [codes[j]!, codes[i]!];
    order.mutate({ codes, reason: t('regcols.reorder_reason') }, { onError: (e) => toast(errText(e, t), 'err') });
  };

  return (
    <section className="space-y-3" data-testid="page-register-columns">
      <div className="card space-y-3 p-4">
        <h2 className="font-bold">{t('regcols.title')}</h2>
        <p className="text-sm text-mute">{t('regcols.note')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <ColumnsPicker value={key} onChange={setKey} />
          <button type="button" className="btn" data-testid="regcols-rename" onClick={() => { setName({ en: scr.data?.register.name_en ?? '', ar: scr.data?.register.name_ar ?? '' }); setDlg({ k: 'rename' }); }}><Pencil size={14} />{t('regcols.rename_register')}</button>
          <button type="button" className="btn" data-testid="regcols-section-new" onClick={() => { setSec({ en: '', ar: '' }); setDlg({ k: 'section' }); }}><Plus size={14} />{t('regcols.add_section')}</button>
          <button type="button" className="btn btn-accent ms-auto" data-testid="regcols-add" onClick={() => setDlg({ k: 'add' })}><Plus size={14} />{t('regcols.add')}</button>
        </div>
        {scr.isLoading && <p className="text-mute">{t('common.loading')}</p>}
        {scr.isError && <p role="alert" className="text-lateInk">{t('errors.generic')}</p>}

        {sections.length > 0 && <ul className="flex flex-wrap gap-2" data-testid="regcols-sections">
          {sections.map((s) => (
            <li key={s.id} className="chip flex items-center gap-1" data-testid={`regcols-section-${s.id}`}>
              {(lang === 'ar' && s.name_ar) || s.name_en} <span className="text-mute">({s.field_count})</span>
              <button type="button" className="btn btn-ghost p-1" aria-label={t('regcols.rename_section', { name: s.name_en })} onClick={() => { setSec({ en: s.name_en, ar: s.name_ar ?? '' }); setDlg({ k: 'section', s }); }}><Pencil size={12} /></button>
              <button type="button" className="btn btn-ghost p-1" aria-label={t('regcols.delete_section', { name: s.name_en })} disabled={s.field_count > 0} title={s.field_count > 0 ? t('regcols.section_not_empty') : undefined} onClick={() => setDlg({ k: 'section-del', s })}><Trash2 size={12} /></button>
            </li>
          ))}
        </ul>}

        <div className="overflow-x-auto">
          <div className="mb-2 flex flex-wrap items-end gap-2 text-sm" data-testid="regcols-inline-bar">
            <label className="flex-1">{t('regcols.inline_reason')}<input className="input w-full" data-testid="regcols-inline-reason" value={inReason} onChange={(e) => setInReason(e.target.value)} /></label>
            <p className="text-xs text-mute">{t('regcols.inline_hint')}</p>
          </div>
          <table className="w-full text-sm" data-testid="regcols-table">
            <thead className="text-mute"><tr>
              <th className="p-2 text-start">{t('regcols.code')}</th><th className="p-2 text-start">{t('regcols.label_en')}</th><th className="p-2 text-start">{t('regcols.type')}</th>
              <th className="p-2 text-start">{t('regcols.section')}</th><th className="p-2 text-start">{t('regcols.default_value')}</th><th className="p-2 text-start">{t('regcols.usage')}</th><th className="p-2 text-start">{t('lists.status')}</th><th className="p-2" />
            </tr></thead>
            <tbody>
              {fields.map((c, i) => (
                <tr key={c.code} className={`border-t border-line ${c.is_active ? '' : 'opacity-60'} ${drag === c.code ? 'bg-hover' : ''}`} data-testid={`regcols-row-${c.code}`}
                  onDragOver={(e) => { if (drag) e.preventDefault(); }} onDrop={() => dropOn(c.code)} onDragEnd={() => setDrag(null)}>
                  <td className="mono p-2"><span draggable className="me-1 inline-block cursor-grab text-mute" data-testid={`regcols-grip-${c.code}`} title={t('regcols.drag')} onDragStart={(e) => { setDrag(c.code); const tr = e.currentTarget.closest('tr'); if (tr) e.dataTransfer.setDragImage?.(tr, 0, 0); }}><GripVertical size={14} aria-hidden /></span>{c.code}</td>
                  <td className="p-2"><span className="inline-block min-w-32">{lang === 'ar' && c.label_ar
                    ? <InlineCell value={c.label_ar} dir="rtl" label={t('regcols.label_ar')} testid={`regcols-cell-name-${c.code}`} onCommit={(v) => saveCol(c, { label_ar: v.trim() || null })} />
                    : <InlineCell value={c.label_en} label={t('regcols.label_en')} testid={`regcols-cell-name-${c.code}`} onCommit={(v) => v.trim() ? saveCol(c, { label_en: v.trim() }) : Promise.reject(new Error(t('regcols.inline_need_name')))} />}</span>{c.is_active && isHidden(c) && <span className="chip ms-2" data-testid={`regcols-hidden-${c.code}`}>{t('regcols.hidden')}</span>}{c.is_system && <span className="chip ms-2" data-testid={`regcols-protected-${c.code}`} title={c.system_reason ?? ''}>{t('regcols.protected')}</span>}</td>
                  <td className="p-2">{!c.is_system && c.is_active && SIMPLE.includes(c.type) && (c.usage?.records_with_value ?? 0) === 0
                    ? <InlineCell kind="select" value={c.type} display={t(`regcols.type_${c.type}`)} options={SIMPLE.map((x) => ({ value: x, label: t(`regcols.type_${x}`) }))} label={t('regcols.type')} testid={`regcols-cell-type-${c.code}`} onCommit={(v) => saveCol(c, { field_type: v as RegisterColumnType })} />
                    : t(`regcols.type_${c.type}`)}</td>
                  <td className="p-2"><InlineCell kind="select" value={c.section ?? ''} display={secName(c.section)} options={[{ value: '', label: '—' }, ...sections.map((x) => ({ value: x.name_en, label: (lang === 'ar' && x.name_ar) || x.name_en }))]} label={t('regcols.section')} testid={`regcols-cell-section-${c.code}`} onCommit={(v) => saveCol(c, { section: v || null })} /></td>
                  <td className="p-2" data-testid={`regcols-default-${c.code}`}>
                    {(() => { const rf = regDefs.data?.find((d) => d.register_key === key)?.fields.find((x) => x.code === c.code);
                      const dv = (c as { default_value?: unknown }).default_value;
                      return (
                        <span className="inline-flex items-center gap-1">
                          <span className={dv == null ? 'text-mute' : ''}>{dv == null || !rf ? '—' : showValue(rf, dv, lang, t)}</span>
                          {c.is_active && DEFAULTABLE.includes(c.type) && rf && !rf.read_only
                            ? <button type="button" className="btn btn-ghost p-1" data-testid={`regcols-default-edit-${c.code}`} aria-label={t('regcols.default_edit', { code: c.code })} title={t('regcols.default_edit', { code: c.code })}
                                onClick={() => { setDval(dv ?? ''); setDlg({ k: 'default', c }); }}><TextCursorInput size={14} /></button>
                            : null}
                        </span>
                      ); })()}
                  </td>
                  <td className="p-2">{c.usage?.records_with_value ?? 0}</td>
                  <td className="p-2">{c.is_active ? t('regcols.active') : t('regcols.inactive')}</td>
                  <td className="whitespace-nowrap p-2 text-end">
                    <button type="button" className="btn btn-ghost p-1" aria-label={t('regcols.move_up', { code: c.code })} disabled={i === 0} onClick={() => move(c, -1)}><ArrowUp size={14} /></button>
                    <button type="button" className="btn btn-ghost p-1" aria-label={t('regcols.move_down', { code: c.code })} disabled={i === fields.length - 1} onClick={() => move(c, 1)}><ArrowDown size={14} /></button>
                    <button type="button" className="btn btn-ghost p-1" data-testid={`regcols-before-${c.code}`} aria-label={t('regcols.add_before', { code: c.code })} title={t('regcols.add_before', { code: c.code })} onClick={() => setDlg({ k: 'add', place: { code: c.code, side: 'before' } })}><Plus size={14} /><ArrowUp size={10} /></button>
                    <button type="button" className="btn btn-ghost p-1" data-testid={`regcols-after-${c.code}`} aria-label={t('regcols.add_after', { code: c.code })} title={t('regcols.add_after', { code: c.code })} onClick={() => setDlg({ k: 'add', place: { code: c.code, side: 'after' } })}><Plus size={14} /><ArrowDown size={10} /></button>
                    <button type="button" className="btn btn-ghost p-1" data-testid={`regcols-edit-${c.code}`} aria-label={t('regcols.edit_title', { code: c.code })} onClick={() => setDlg({ k: 'edit', c })}><Pencil size={14} /></button>
                    {c.is_active && <button type="button" className="btn me-1 px-2 py-0.5 text-xs" data-testid={`regcols-hide-${c.code}`} aria-pressed={isHidden(c)} aria-label={t(isHidden(c) ? 'regcols.show' : 'regcols.hide', { code: c.code })} title={t(isHidden(c) ? 'regcols.show' : 'regcols.hide', { code: c.code })} disabled={upd.isPending} onClick={() => void setHidden(c, !isHidden(c))}>{isHidden(c) ? <EyeOff size={14} /> : <Eye size={14} />}<span className="ms-1">{t(isHidden(c) ? 'regcols.show_btn' : 'regcols.hide_btn')}</span></button>}
                    {c.is_active
                      ? <button type="button" className="btn btn-ghost p-1" data-testid={`regcols-delete-${c.code}`} aria-label={t('regcols.delete_title', { code: c.code })} disabled={c.is_system} title={c.is_system ? t('regcols.protected_note', { reason: c.system_reason ?? '' }) : undefined} onClick={() => setDlg({ k: 'delete', c })}><Trash2 size={14} /></button>
                      : <button type="button" className="btn btn-ghost p-1" data-testid={`regcols-reactivate-${c.code}`} aria-label={t('regcols.reactivate', { code: c.code })} onClick={() => setDlg({ k: 'react', c })}><Undo2 size={14} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ColumnDialog open={dlg?.k === 'add' || dlg?.k === 'edit'} onClose={close} registerKey={key} column={dlg?.k === 'edit' ? dlg.c : undefined} columns={fields} sections={sections} place={dlg?.k === 'add' ? dlg.place : null} />

      <FormDialog inline open={dlg?.k === 'delete'} onClose={close} testid="column-delete" title={dlg?.k === 'delete' ? t('regcols.delete_title', { code: dlg.c.code }) : ''} error={err} busy={del.isPending}
        submitLabel={impact.data?.delete_mode === 'hard' ? t('regcols.delete') : t('regcols.deactivate')}
        onSubmit={(reason) => dlg?.k === 'delete' && void run(async () => { const r = await del.mutateAsync({ code: dlg.c.code, reason }); toast(r.mode === 'deleted' ? t('regcols.deleted') : t('regcols.deactivated')); }, '')}>
        {impact.isLoading && <p className="text-mute">{t('common.loading')}</p>}
        {impact.data && <p data-testid="column-delete-mode">{impact.data.delete_mode === 'hard' ? t('regcols.delete_hard') : t('regcols.delete_deactivate', { count: impact.data.usage.records_with_value ?? 0 })}</p>}
      </FormDialog>

      <FormDialog inline open={dlg?.k === 'default'} onClose={close} testid="column-default" title={dlg?.k === 'default' ? t('regcols.default_title', { code: dlg.c.code }) : ''} error={err} busy={setDefault.isPending}
        onSubmit={(reason) => dlg?.k === 'default' && void run(() => setDefault.mutateAsync({ code: dlg.c.code, version: dlg.c.version, value: dval === '' || dval === undefined ? null : dval, reason }), t('regcols.saved'))}>
        {(() => {
          const rf = dlg?.k === 'default' ? regDefs.data?.find((d) => d.register_key === key)?.fields.find((x) => x.code === dlg.c.code) : undefined;
          return (
            <div className="space-y-2">
              <p className="text-sm text-mute">{t('regcols.default_note')}</p>
              {rf ? <FieldInput field={{ ...rf, read_only: false }} value={dval} onChange={setDval} /> : null}
              <button type="button" className="btn btn-ghost text-sm" data-testid="column-default-clear" onClick={() => setDval('')}>{t('regcols.default_clear')}</button>
            </div>
          );
        })()}
      </FormDialog>

      <FormDialog inline open={dlg?.k === 'react'} onClose={close} testid="column-react" title={dlg?.k === 'react' ? t('regcols.reactivate', { code: dlg.c.code }) : ''} error={err} busy={upd.isPending}
        onSubmit={(reason) => dlg?.k === 'react' && void run(() => upd.mutateAsync({ code: dlg.c.code, version: dlg.c.version, patch: { is_active: true, reason } }), t('regcols.saved'))} />

      <FormDialog inline open={dlg?.k === 'section'} onClose={close} testid="section-dialog" title={dlg?.k === 'section' && dlg.s ? t('regcols.rename_section', { name: dlg.s.name_en }) : t('regcols.add_section')} error={err} busy={saveSec.isPending} disabled={!sec.en.trim()}
        onSubmit={(reason) => dlg?.k === 'section' && void run(() => saveSec.mutateAsync({ id: dlg.s?.id, version: dlg.s?.version, name_en: sec.en.trim(), name_ar: sec.ar.trim() || null, reason }), t('regcols.saved'))}>
        <input className="input" data-testid="section-name-en" aria-label={t('regcols.label_en')} placeholder={t('regcols.label_en')} value={sec.en} onChange={(e) => setSec({ ...sec, en: e.target.value })} />
        <input className="input" dir="rtl" data-testid="section-name-ar" aria-label={t('regcols.label_ar')} placeholder={t('regcols.label_ar')} value={sec.ar} onChange={(e) => setSec({ ...sec, ar: e.target.value })} />
      </FormDialog>

      <FormDialog inline open={dlg?.k === 'section-del'} onClose={close} testid="section-delete" title={dlg?.k === 'section-del' ? t('regcols.delete_section', { name: dlg.s.name_en }) : ''} error={err} busy={delSec.isPending}
        onSubmit={(reason) => dlg?.k === 'section-del' && void run(() => delSec.mutateAsync({ id: dlg.s.id, reason }), t('regcols.deleted'))} />

      <FormDialog inline open={dlg?.k === 'rename'} onClose={close} testid="register-rename" title={t('regcols.rename_register')} error={err} busy={ren.isPending} disabled={!name.en.trim()}
        onSubmit={(reason) => void run(() => ren.mutateAsync({ version: scr.data?.register.version, name_en: name.en.trim(), name_ar: name.ar.trim() || null, reason }), t('regcols.saved'))}>
        <input className="input" data-testid="register-name-en" aria-label={t('regcols.label_en')} value={name.en} onChange={(e) => setName({ ...name, en: e.target.value })} />
        <input className="input" dir="rtl" data-testid="register-name-ar" aria-label={t('regcols.label_ar')} value={name.ar} onChange={(e) => setName({ ...name, ar: e.target.value })} />
      </FormDialog>
    </section>
  );
}
