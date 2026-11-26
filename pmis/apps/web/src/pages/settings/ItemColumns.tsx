import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/client';
import { InlineCell } from '@/components/InlineCell';
import { type ItemColumn, useItemColumns, useSaveItemColumn } from '@/api/warehouseColumns';
import { useAsk } from './studio/studioCtx';

const TYPES = ['text', 'number', 'date', 'bool'] as const;
const EMPTY = { code: '', label_en: '', label_ar: '', data_type: 'text' as (typeof TYPES)[number] };

/** Settings, Columns, "Warehouse items" (P6): add, rename, order and hide the extra columns of the item master. Every change needs a reason; hiding keeps the values. */
export function ItemColumns() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const q = useItemColumns(true);
  const save = useSaveItemColumn();
  const { askReason, node } = useAsk();
  const [f, setF] = useState(EMPTY);
  // Edit in place next to the buttons: a name cell saves that column (same call as the form, audited) with the reason typed above the table.
  const [inReason, setInReason] = useState('');
  const saveName = async (c: ItemColumn, body: Record<string, unknown>) => {
    if (inReason.trim().length < 3) throw new Error(t('itemcols.inline_need_reason'));
    try { await save.mutateAsync({ col: c, body: { ...body, reason: inReason.trim() } as never }); }
    catch (e) { throw new Error(e instanceof Error ? e.message : t('errors.generic')); }
  };
  const forbidden = q.error instanceof ApiError && q.error.status === 403;
  const cols = q.data ?? [];
  const run = (col: ItemColumn | undefined, body: Record<string, unknown>, title: string) =>
    askReason({ title, run: (reason, cb) => save.mutate({ col, body: { ...body, reason } as never }, { onError: cb.onError, onSuccess: () => { if (!col) setF(EMPTY); cb.onSuccess(); } }) });
  const ok = /^[a-z][a-z0-9_]{1,40}$/.test(f.code) && f.label_en.trim() !== '';
  return (
    <div className="space-y-2" data-testid="item-columns">
      <p className="text-sm text-mute">{t('itemcols.note')}</p>
      {q.isLoading && <p className="text-mute">{t('common.loading')}</p>}
      {q.isError && <p role="alert" className="text-lateInk">{forbidden ? t('studio.columns.no_access') : t('errors.generic')}</p>}
      {q.data && (
        <div className="overflow-x-auto">
          <div className="mb-2 flex flex-wrap items-end gap-2 text-sm" data-testid="item-col-inline-bar">
            <label className="flex-1">{t('itemcols.inline_reason')}<input className="input w-full" data-testid="item-col-inline-reason" value={inReason} onChange={(e) => setInReason(e.target.value)} /></label>
            <p className="text-xs text-mute">{t('itemcols.inline_hint')}</p>
          </div>
          <table className="w-full text-sm" data-testid="item-columns-table" aria-label={t('itemcols.title')}>
            <thead className="text-mute"><tr>{(['code', 'name', 'type', 'state'] as const).map((k) => <th key={k} scope="col" className="p-2 text-start">{t(`itemcols.${k}`)}</th>)}<th className="p-2" /></tr></thead>
            <tbody>
              {cols.map((c, i) => (
                <tr key={c.code} className={`border-t border-line ${c.is_active ? '' : 'opacity-60'}`} data-testid={`item-col-${c.code}`}>
                  <td className="mono p-2" dir="ltr">{c.code}</td>
                  <td className="p-2">{ar && c.label_ar
                    ? <InlineCell value={c.label_ar} dir="rtl" label={t('itemcols.name_ar')} testid={`item-col-cell-name-${c.code}`} onCommit={(v) => saveName(c, { label_ar: v.trim() || null })} />
                    : <InlineCell value={c.label_en} label={t('itemcols.name_en')} testid={`item-col-cell-name-${c.code}`} onCommit={(v) => v.trim() ? saveName(c, { label_en: v.trim() }) : Promise.reject(new Error(t('itemcols.inline_need_name')))} />}</td>
                  <td className="p-2">{t(`itemcols.type_${c.data_type}`)}</td>
                  <td className="p-2">{t(c.is_active ? 'regcols.active' : 'regcols.inactive')}</td>
                  <td className="p-2 text-end whitespace-nowrap">
                    <button className="btn" disabled={i === 0} aria-label={t('itemcols.up')} data-testid={`item-col-up-${c.code}`}
                      onClick={() => run(c, { sort_order: Math.max(0, cols[i - 1]!.sort_order - 1) }, t('itemcols.move'))}>↑</button>{' '}
                    <button className="btn" disabled={i === cols.length - 1} aria-label={t('itemcols.down')} data-testid={`item-col-down-${c.code}`}
                      onClick={() => run(c, { sort_order: cols[i + 1]!.sort_order + 1 }, t('itemcols.move'))}>↓</button>{' '}
                    <button className="btn" data-testid={`item-col-toggle-${c.code}`}
                      onClick={() => run(c, { is_active: !c.is_active }, t(c.is_active ? 'itemcols.hide' : 'itemcols.show'))}>{t(c.is_active ? 'itemcols.hide' : 'itemcols.show')}</button>
                  </td>
                </tr>
              ))}
              {!cols.length && <tr><td colSpan={5} className="p-3 text-mute" data-testid="item-columns-empty">{t('itemcols.empty')}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {q.data && (
        <fieldset className="flex flex-wrap items-end gap-2" data-testid="item-col-add">
          <legend className="text-sm font-semibold">{t('itemcols.add')}</legend>
          <input className="input w-36" dir="ltr" placeholder={t('itemcols.code')} aria-label={t('itemcols.code')} data-testid="item-col-f-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
          <input className="input w-44" placeholder={t('itemcols.name_en')} aria-label={t('itemcols.name_en')} data-testid="item-col-f-en" value={f.label_en} onChange={(e) => setF({ ...f, label_en: e.target.value })} />
          <input className="input w-44" dir="rtl" placeholder={t('itemcols.name_ar')} aria-label={t('itemcols.name_ar')} data-testid="item-col-f-ar" value={f.label_ar} onChange={(e) => setF({ ...f, label_ar: e.target.value })} />
          <select className="input w-auto" aria-label={t('itemcols.type')} data-testid="item-col-f-type" value={f.data_type} onChange={(e) => setF({ ...f, data_type: e.target.value as typeof f.data_type })}>
            {TYPES.map((x) => <option key={x} value={x}>{t(`itemcols.type_${x}`)}</option>)}
          </select>
          <button className="btn btn-primary" disabled={!ok} data-testid="item-col-add-go"
            onClick={() => run(undefined, { code: f.code, label_en: f.label_en.trim(), label_ar: f.label_ar.trim() || null, data_type: f.data_type }, t('itemcols.add'))}>{t('itemcols.add')}</button>
        </fieldset>
      )}
      {node}
    </div>
  );
}
