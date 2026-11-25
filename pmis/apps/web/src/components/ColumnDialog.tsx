import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useColumnImpact, useCreateColumn, useReorderColumns, useUpdateColumn } from '@/api/registerColumns';
import { useListCatalogues } from '@/api/lists';
import { ApiError } from '@/api/client';
import type { RegisterColumn, RegisterColumnCreate, RegisterColumnPatch, RegisterColumnType, RegisterSection } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';

/** The types the admin picks, in the order of the picker. `child_list` and `multi_site` are kept for the existing columns only. */
export const COLUMN_TYPES: RegisterColumnType[] = ['text', 'long_text', 'number', 'currency', 'percentage', 'date', 'datetime', 'yes_no', 'list', 'multi_list', 'user', 'multi_user', 'site', 'external_party', 'warehouse_item', 'email', 'phone', 'link', 'document', 'computed'];
const FORMULA_OPS = ['sum', 'diff', 'product', 'ratio', 'days_between'] as const;
const NUMERIC: RegisterColumnType[] = ['number', 'currency', 'percentage'];
const DATES: RegisterColumnType[] = ['date', 'datetime'];

/** A code from the English label: lower case, digits and underscores, starting with a letter (the contract's pattern). */
export const codeFrom = (s: string) => {
  const c = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return /^[a-z]/.test(c) ? c : c ? `c_${c}`.slice(0, 40) : '';
};

export type Place = { code: string; side: 'before' | 'after' } | null;

/**
 * Add or edit a register column (contract 0.15.13). Protected columns (`is_system`) accept only the names, the section and the visibility: the rest is shown
 * locked with the reason. A change of type shows the conversion preview first: it is allowed when every value converts, and the failing values are listed
 * otherwise. The list type picks a catalogue or creates one with its values in the same dialog.
 */
type Props = { open: boolean; onClose: () => void; registerKey: string; column?: RegisterColumn; columns: RegisterColumn[]; sections: RegisterSection[]; place?: Place };
export function ColumnDialog(p: Props) {
  // the form state starts from the column each time the dialog opens: a fresh instance, not an effect that resets it
  return p.open ? <ColumnForm key={p.column?.code ?? `new-${p.place?.code ?? ''}-${p.place?.side ?? ''}`} {...p} /> : null;
}

function ColumnForm({ open, onClose, registerKey, column, columns, sections, place }: Props) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const edit = !!column;
  const locked = !!column?.is_system;
  const create = useCreateColumn(registerKey), update = useUpdateColumn(registerKey), reorder = useReorderColumns(registerKey);
  const lists = useListCatalogues(false);
  const [label_en, setEn] = useState(column?.label_en ?? ''), [label_ar, setAr] = useState(column?.label_ar ?? ''), [code, setCode] = useState(''), [codeTouched, setCodeTouched] = useState(false);
  const [type, setType] = useState<RegisterColumnType>(column?.type ?? 'text');
  const [required, setRequired] = useState(!!column?.required), [section, setSection] = useState(column?.section ?? '');
  const [catalogue, setCatalogue] = useState(column?.list_catalogue ?? ''), [newList, setNewList] = useState(false), [listName, setListName] = useState(''), [listValues, setListValues] = useState('');
  const [op, setOp] = useState<(typeof FORMULA_OPS)[number]>('sum'), [fa, setFa] = useState(''), [fb, setFb] = useState('');
  const [vis, setVis] = useState({ in_list: column?.in_list ?? true, in_filter: column?.in_filter ?? true, in_template: column?.in_template ?? true, in_export: column?.in_export ?? true });
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ record_id?: string; value?: unknown; message?: string }[] | null>(null);

  const typeChanged = edit && !locked && type !== column!.type;
  const impact = useColumnImpact(registerKey, typeChanged ? column!.code : null, typeChanged ? type : undefined);
  const conv = typeChanged ? impact.data?.conversion : null;
  const isList = type === 'list' || type === 'multi_list';
  const secName = (s: RegisterSection) => (i18n.language === 'ar' && s.name_ar) || s.name_en;
  const sameKind = (c: RegisterColumn, kinds: RegisterColumnType[]) => c.is_active && c.code !== column?.code && kinds.includes(c.type);
  const pickA = useMemo(() => columns.filter((c) => sameKind(c, op === 'days_between' ? DATES : NUMERIC)), [columns, op, column]); // eslint-disable-line react-hooks/exhaustive-deps
  const valueList = listValues.split(/[\n,;]/).map((x) => x.trim()).filter(Boolean);
  const finalCode = edit ? column!.code : (codeTouched ? code : codeFrom(label_en));
  const codeTaken = !edit && columns.some((c) => c.code === finalCode);
  const listOk = !isList || (newList ? !!listName.trim() && valueList.length > 0 : !!catalogue);
  const formulaOk = type !== 'computed' || (!!fa && !!fb && fa !== fb);
  const convOk = !typeChanged || (!!conv && conv.failed === 0 && (conv.convertible ?? 0) >= 0 && (!(conv.rewritten ?? 0) || confirm));
  const ready = !!label_en.trim() && (edit || (!!finalCode && !codeTaken)) && listOk && formulaOk && convOk && !(typeChanged && (impact.isLoading || !conv));
  const busy = create.isPending || update.isPending || reorder.isPending;

  const newListBody = newList && isList ? { name_en: listName.trim(), values: valueList.map((v) => ({ label_en: v })) } : undefined;
  const submit = async (reason: string) => {
    setErr(null); setBlocked(null);
    try {
      const names = { label_en: label_en.trim(), label_ar: label_ar.trim() || null };
      const where = { section: section || null };
      const f = type === 'computed' ? { formula: { op, a: fa, b: fb } } : {};
      const lst = isList ? (newListBody ? { new_list: newListBody } : { list_catalogue: catalogue }) : {};
      if (!edit) {
        const body: RegisterColumnCreate = { code: finalCode, field_type: type, required, ...names, ...where, ...f, ...lst, ...vis, reason };
        const r = await create.mutateAsync(body);
        if (place) {
          const codes = columns.map((c) => c.code).filter((c) => c !== r.code);
          const i = codes.indexOf(place.code);
          codes.splice(i < 0 ? codes.length : place.side === 'before' ? i : i + 1, 0, r.code);
          await reorder.mutateAsync({ codes, reason });
        }
        toast(t('regcols.added', { name: label_en.trim() }));
      } else {
        const patch: RegisterColumnPatch = { ...names, ...where, ...vis, reason };
        if (!locked) {
          if (required !== !!column!.required) patch.required = required;
          if (typeChanged) { patch.field_type = type; Object.assign(patch, f, lst); if (conv && (conv.rewritten ?? 0) > 0) patch.confirm_conversion = true; }
          else if (isList && (newListBody || catalogue !== (column!.list_catalogue ?? ''))) Object.assign(patch, lst);
        }
        const r = await update.mutateAsync({ code: column!.code, version: column!.version, patch });
        toast(r.converted ? t('regcols.saved_converted', { count: r.converted }) : t('regcols.saved'));
        if (r.records_missing_value) toast(t('regcols.required_missing', { count: r.records_missing_value }));
      }
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conversion_blocked') setBlocked(((e.problem as unknown as { failures?: { record_id?: string; value?: unknown; message?: string }[] }).failures) ?? []);
      setErr(errText(e, t));
    }
  };

  const typeLabel = (x: RegisterColumnType) => t(`regcols.type_${x}`);
  const flip = (k: keyof typeof vis) => setVis((v) => ({ ...v, [k]: !v[k] }));
  return (
    <FormDialog inline open={open} onClose={onClose} testid="column-dialog" wide title={edit ? t('regcols.edit_title', { code: column!.code }) : t('regcols.add_title')} onSubmit={(r) => void submit(r)} busy={busy} disabled={!ready} error={err}>
      {!edit && <p className="rounded border border-line bg-card2 p-2 text-sm" data-testid="column-add-impact">{t(vis.in_template ? 'regcols.add_impact_tpl' : 'regcols.add_impact')}</p>}
      {locked && <p className="rounded border border-line bg-card2 p-2 text-sm" data-testid="column-protected">{t('regcols.protected_note', { reason: column!.system_reason ?? '' })}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label className="text-sm font-semibold" htmlFor="col-en">{t('regcols.label_en')}</label>
          <input id="col-en" data-testid="col-label-en" className="input mt-1" value={label_en} maxLength={200} onChange={(e) => setEn(e.target.value)} /></div>
        <div><label className="text-sm font-semibold" htmlFor="col-ar">{t('regcols.label_ar')}</label>
          <input id="col-ar" data-testid="col-label-ar" dir="rtl" className="input mt-1" value={label_ar} maxLength={200} onChange={(e) => setAr(e.target.value)} /></div>
        {!edit && <details data-testid="col-code-details" className="text-sm"><summary className="cursor-pointer text-mute">{t('regcols.code_generated', { code: finalCode || '-' })}</summary>
          <label className="font-semibold" htmlFor="col-code">{t('regcols.code')}</label>

          <input id="col-code" data-testid="col-code" dir="ltr" className="input mono mt-1" value={finalCode} onChange={(e) => { setCodeTouched(true); setCode(e.target.value.toLowerCase()); }} aria-invalid={codeTaken} />
          <p className="mt-1 text-mute">{t('regcols.code_hint')}</p></details>}
        {edit && <p data-testid="col-code-fixed" className="text-sm"><span className="font-semibold">{t('regcols.code')}: </span><span dir="ltr" className="mono">{column!.code}</span> <span className="text-mute">{t('regcols.code_fixed')}</span></p>}
        <div><label className="text-sm font-semibold" htmlFor="col-type">{t('regcols.type')}</label>
          <select id="col-type" data-testid="col-type" className="input mt-1" value={type} disabled={locked} onChange={(e) => { setType(e.target.value as RegisterColumnType); setConfirm(false); }}>
            {[...new Set([...(edit && !COLUMN_TYPES.includes(column!.type) ? [column!.type] : []), ...COLUMN_TYPES])].map((x) => <option key={x} value={x}>{typeLabel(x)}</option>)}
          </select></div>
        <div><label className="text-sm font-semibold" htmlFor="col-section">{t('regcols.section')}</label>
          <select id="col-section" data-testid="col-section" className="input mt-1" value={section} onChange={(e) => setSection(e.target.value)}>
            <option value="">{t('regcols.no_section')}</option>{sections.map((s) => <option key={s.id} value={s.name_en}>{secName(s)}</option>)}
          </select></div>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="col-required" checked={required} disabled={locked || type === 'computed' || type === 'document'} onChange={(e) => setRequired(e.target.checked)} />{t('regcols.required')}</label>
      <p className="-mt-2 text-xs text-mute">{t('regcols.required_note')}</p>

      {isList && (
        <fieldset className="space-y-2 rounded border border-line p-3" data-testid="col-list-box">
          <legend className="px-1 text-sm font-semibold">{t('regcols.list_legend')}</legend>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1"><input type="radio" name="col-list-mode" data-testid="col-list-existing" checked={!newList} onChange={() => setNewList(false)} />{t('regcols.list_existing')}</label>
            <label className="flex items-center gap-1"><input type="radio" name="col-list-mode" data-testid="col-list-new" checked={newList} onChange={() => setNewList(true)} />{t('regcols.list_new')}</label>
          </div>
          {!newList
            ? <select className="input" aria-label={t('regcols.list_existing')} data-testid="col-list-pick" value={catalogue} onChange={(e) => setCatalogue(e.target.value)}>
                <option value="">{t('regcols.list_pick')}</option>{(lists.data ?? []).map((c) => <option key={c.code} value={c.code}>{(i18n.language === 'ar' && c.name_ar) || c.name_en}</option>)}
              </select>
            : <>
                <input className="input" data-testid="col-list-name" aria-label={t('regcols.list_name')} placeholder={t('regcols.list_name')} value={listName} onChange={(e) => setListName(e.target.value)} />
                <textarea className="input min-h-20" data-testid="col-list-values" aria-label={t('regcols.list_values')} placeholder={t('regcols.list_values')} value={listValues} onChange={(e) => setListValues(e.target.value)} />
                <p className="text-xs text-mute">{t('regcols.list_values_note', { count: valueList.length })}</p>
              </>}
        </fieldset>
      )}

      {type === 'computed' && (
        <fieldset className="grid gap-2 rounded border border-line p-3 sm:grid-cols-3" data-testid="col-formula-box">
          <legend className="px-1 text-sm font-semibold">{t('regcols.formula')}</legend>
          <select className="input" aria-label={t('regcols.formula_op')} data-testid="col-formula-op" value={op} onChange={(e) => { setOp(e.target.value as typeof op); setFa(''); setFb(''); }}>
            {FORMULA_OPS.map((o) => <option key={o} value={o}>{t(`regcols.op_${o}`)}</option>)}
          </select>
          <select className="input" aria-label={t('regcols.formula_a')} data-testid="col-formula-a" value={fa} onChange={(e) => setFa(e.target.value)}>
            <option value="">{t('regcols.formula_a')}</option>{pickA.map((c) => <option key={c.code} value={c.code}>{c.label_en}</option>)}
          </select>
          <select className="input" aria-label={t('regcols.formula_b')} data-testid="col-formula-b" value={fb} onChange={(e) => setFb(e.target.value)}>
            <option value="">{t('regcols.formula_b')}</option>{pickA.map((c) => <option key={c.code} value={c.code}>{c.label_en}</option>)}
          </select>
          <p className="text-xs text-mute sm:col-span-3">{t('regcols.computed_note')}</p>
        </fieldset>
      )}
      {type === 'document' && <p className="text-sm text-mute" data-testid="col-document-note">{t('regcols.document_note')}</p>}

      <fieldset className="rounded border border-line p-3">
        <legend className="px-1 text-sm font-semibold">{t('regcols.visibility')}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {(['in_list', 'in_filter', 'in_template', 'in_export'] as const).map((k) => <label key={k} className="flex items-center gap-1"><input type="checkbox" data-testid={`col-${k}`} checked={vis[k]} onChange={() => flip(k)} />{t(`regcols.${k}`)}</label>)}
        </div>
      </fieldset>

      {typeChanged && (
        <div className="space-y-2 rounded border border-line bg-card2 p-3" data-testid="col-conversion" aria-live="polite">
          <p className="font-semibold">{t('regcols.conv_title', { from: typeLabel(column!.type), to: typeLabel(type) })}</p>
          {impact.isLoading && <p className="text-mute">{t('common.loading')}</p>}
          {conv && (conv.failed ?? 0) === 0 && <>
            <p data-testid="col-conv-ok">{t('regcols.conv_ok', { count: conv.convertible ?? 0 })}</p>
            {(conv.rewritten ?? 0) > 0 && <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="col-conv-confirm" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />{t('regcols.conv_confirm', { count: conv.rewritten ?? 0 })}</label>}
          </>}
          {conv && (conv.failed ?? 0) > 0 && <>
            <p role="alert" className="text-lateInk" data-testid="col-conv-failed">{t('regcols.conv_failed', { count: conv.failed ?? 0 })}</p>
            <ul className="max-h-32 overflow-auto text-sm" data-testid="col-conv-failures">{(conv.failures ?? []).slice(0, 20).map((x, i) => <li key={i}><span className="mono">{String(x.value ?? '')}</span> <span className="text-mute">{x.message}</span></li>)}</ul>
          </>}
        </div>
      )}
      {blocked && blocked.length > 0 && <ul className="max-h-32 overflow-auto text-sm" data-testid="col-blocked">{blocked.slice(0, 20).map((x, i) => <li key={i}><span className="mono">{String(x.value ?? '')}</span> <span className="text-mute">{x.message}</span></li>)}</ul>}
    </FormDialog>
  );
}
