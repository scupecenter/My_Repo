import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useColumnImpact, useDeleteColumn, useDeleteSection, useRegisterColumns, useRenameRegister, useReorderColumns, useSaveSection, useUpdateColumn } from '@/api/registerColumns';
import { useRegisterDefs } from '@/api/registers';
import type { RegisterColumn, RegisterSection } from '@/api/types';
import { ColumnDialog } from '@/components/ColumnDialog';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';

type Dlg =
  | { k: 'add' } | { k: 'edit'; c: RegisterColumn } | { k: 'delete'; c: RegisterColumn } | { k: 'react'; c: RegisterColumn }
  | { k: 'section'; s?: RegisterSection } | { k: 'section-del'; s: RegisterSection } | { k: 'rename' };

/** Settings, register columns (contract 0.15.13): the admin adds, edits, orders, hides and removes the columns, sections and name of a register. */
export function RegisterColumns() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const toast = useToast();
  const defs = useRegisterDefs();
  const [sp, setSp] = useSearchParams();
  const key = sp.get('register') || 'gecol';
  const setKey = (k: string) => setSp({ register: k }, { replace: true });
  const scr = useRegisterColumns(key);
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
          <select className="input w-auto" aria-label={t('regcols.register')} data-testid="regcols-register" value={key} onChange={(e) => setKey(e.target.value)}>
            {(defs.data ?? []).map((d) => <option key={d.register_key} value={d.register_key}>{(lang === 'ar' && d.name_ar) || d.name_en}</option>)}
          </select>
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
          <table className="w-full text-sm" data-testid="regcols-table">
            <thead className="text-mute"><tr>
              <th className="p-2 text-start">{t('regcols.code')}</th><th className="p-2 text-start">{t('regcols.label_en')}</th><th className="p-2 text-start">{t('regcols.type')}</th>
              <th className="p-2 text-start">{t('regcols.section')}</th><th className="p-2 text-start">{t('regcols.usage')}</th><th className="p-2 text-start">{t('lists.status')}</th><th className="p-2" />
            </tr></thead>
            <tbody>
              {fields.map((c, i) => (
                <tr key={c.code} className={`border-t border-line ${c.is_active ? '' : 'opacity-60'}`} data-testid={`regcols-row-${c.code}`}>
                  <td className="mono p-2">{c.code}</td>
                  <td className="p-2">{(lang === 'ar' && c.label_ar) || c.label_en}{c.is_system && <span className="chip ms-2" data-testid={`regcols-protected-${c.code}`} title={c.system_reason ?? ''}>{t('regcols.protected')}</span>}</td>
                  <td className="p-2">{t(`regcols.type_${c.type}`)}</td>
                  <td className="p-2">{secName(c.section)}</td>
                  <td className="p-2">{c.usage?.records_with_value ?? 0}</td>
                  <td className="p-2">{c.is_active ? t('regcols.active') : t('regcols.inactive')}</td>
                  <td className="whitespace-nowrap p-2 text-end">
                    <button type="button" className="btn btn-ghost p-1" aria-label={t('regcols.move_up', { code: c.code })} disabled={i === 0} onClick={() => move(c, -1)}><ArrowUp size={14} /></button>
                    <button type="button" className="btn btn-ghost p-1" aria-label={t('regcols.move_down', { code: c.code })} disabled={i === fields.length - 1} onClick={() => move(c, 1)}><ArrowDown size={14} /></button>
                    <button type="button" className="btn btn-ghost p-1" data-testid={`regcols-edit-${c.code}`} aria-label={t('regcols.edit_title', { code: c.code })} onClick={() => setDlg({ k: 'edit', c })}><Pencil size={14} /></button>
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

      <ColumnDialog open={dlg?.k === 'add' || dlg?.k === 'edit'} onClose={close} registerKey={key} column={dlg?.k === 'edit' ? dlg.c : undefined} columns={fields} sections={sections} />

      <FormDialog open={dlg?.k === 'delete'} onClose={close} testid="column-delete" title={dlg?.k === 'delete' ? t('regcols.delete_title', { code: dlg.c.code }) : ''} error={err} busy={del.isPending}
        submitLabel={impact.data?.delete_mode === 'hard' ? t('regcols.delete') : t('regcols.deactivate')}
        onSubmit={(reason) => dlg?.k === 'delete' && void run(async () => { const r = await del.mutateAsync({ code: dlg.c.code, reason }); toast(r.mode === 'deleted' ? t('regcols.deleted') : t('regcols.deactivated')); }, '')}>
        {impact.isLoading && <p className="text-mute">{t('common.loading')}</p>}
        {impact.data && <p data-testid="column-delete-mode">{impact.data.delete_mode === 'hard' ? t('regcols.delete_hard') : t('regcols.delete_deactivate', { count: impact.data.usage.records_with_value ?? 0 })}</p>}
      </FormDialog>

      <FormDialog open={dlg?.k === 'react'} onClose={close} testid="column-react" title={dlg?.k === 'react' ? t('regcols.reactivate', { code: dlg.c.code }) : ''} error={err} busy={upd.isPending}
        onSubmit={(reason) => dlg?.k === 'react' && void run(() => upd.mutateAsync({ code: dlg.c.code, version: dlg.c.version, patch: { is_active: true, reason } }), t('regcols.saved'))} />

      <FormDialog open={dlg?.k === 'section'} onClose={close} testid="section-dialog" title={dlg?.k === 'section' && dlg.s ? t('regcols.rename_section', { name: dlg.s.name_en }) : t('regcols.add_section')} error={err} busy={saveSec.isPending} disabled={!sec.en.trim()}
        onSubmit={(reason) => dlg?.k === 'section' && void run(() => saveSec.mutateAsync({ id: dlg.s?.id, version: dlg.s?.version, name_en: sec.en.trim(), name_ar: sec.ar.trim() || null, reason }), t('regcols.saved'))}>
        <input className="input" data-testid="section-name-en" aria-label={t('regcols.label_en')} placeholder={t('regcols.label_en')} value={sec.en} onChange={(e) => setSec({ ...sec, en: e.target.value })} />
        <input className="input" dir="rtl" data-testid="section-name-ar" aria-label={t('regcols.label_ar')} placeholder={t('regcols.label_ar')} value={sec.ar} onChange={(e) => setSec({ ...sec, ar: e.target.value })} />
      </FormDialog>

      <FormDialog open={dlg?.k === 'section-del'} onClose={close} testid="section-delete" title={dlg?.k === 'section-del' ? t('regcols.delete_section', { name: dlg.s.name_en }) : ''} error={err} busy={delSec.isPending}
        onSubmit={(reason) => dlg?.k === 'section-del' && void run(() => delSec.mutateAsync({ id: dlg.s.id, reason }), t('regcols.deleted'))} />

      <FormDialog open={dlg?.k === 'rename'} onClose={close} testid="register-rename" title={t('regcols.rename_register')} error={err} busy={ren.isPending} disabled={!name.en.trim()}
        onSubmit={(reason) => void run(() => ren.mutateAsync({ version: scr.data?.register.version, name_en: name.en.trim(), name_ar: name.ar.trim() || null, reason }), t('regcols.saved'))}>
        <input className="input" data-testid="register-name-en" aria-label={t('regcols.label_en')} value={name.en} onChange={(e) => setName({ ...name, en: e.target.value })} />
        <input className="input" dir="rtl" data-testid="register-name-ar" aria-label={t('regcols.label_ar')} value={name.ar} onChange={(e) => setName({ ...name, ar: e.target.value })} />
      </FormDialog>
    </section>
  );
}
