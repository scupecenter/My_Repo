import { Lock, Pencil, Plus } from 'lucide-react';
import { ScreenSettingsLink } from '@/components/ScreenSettingsLink';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useMe } from '@/api/hooks';
import { useRegisterRecord, useUpdateRecord } from '@/api/registers';
import { useRegions } from '@/api/sites';
import type { StockLevel, StockMovement, WarehouseItem } from '@/api/types';
import { useItemColumns, type ItemColumn } from '@/api/warehouseColumns';
import { HistoryDialog } from '@/components/HistoryDialog';
import { useItemHistory } from '@/api/history';
import { useConfigGaps, useRegionVendors, useSaveRegionVendor, type RegionVendor, useDeleteItem, useDispatchList, useMovements, useQuarantineExit, useReverseMovement, useSaveItem, useStock, useWhItems, type QuarantineExitBody } from '@/api/warehouse';
import { NEED_TONE } from '@/components/SiteDispatch';
import { errText, FormDialog } from '@/components/FormDialog';
import { InlinePanel } from '@/components/InlinePanel';
import { SavedViews } from '@/components/SavedViews';
import { StandardTable, type StdCol } from '@/components/StandardTable';
import { UnifiedFilter } from '@/components/UnifiedFilter';
import { decodeFilter, encodeFilter, type FilterTree } from '@/api/views';
import { useToast } from '@/components/Toast';
import { hasGrant, isAdmin } from '@/lib/perm';
import { registerErrorMessage } from '@/lib/registerErrors';
import { DateInput } from '@/components/DateInput';
import { ReorderLimits, SupplierReturns } from './WarehouseLogistics';

type Tab = 'items' | 'movements' | 'stock' | 'reorder' | 'rma' | 'dispatch' | 'gaps';
type Dlg = { mode: 'new' } | { mode: 'edit' | 'off' | 'del'; item: WarehouseItem } | null;
type Rule = NonNullable<WarehouseItem['need_rules']>[number];
type Form = { code: string; name_en: string; name_ar: string; uom: string; category: string; serial_tracked: boolean; code_source: string; rules: Rule[] };
const EMPTY: Form = { code: '', name_en: '', name_ar: '', uom: '', category: '', serial_tracked: false, code_source: 'internal_provisional', rules: [] };
/** A need rule as the API takes it back (no id; Q107 status kept). */
const ruleBody = (r: Rule) => ({ need_unit: r.need_unit, quantity: r.quantity ?? null, status: r.status ?? 'pending_configuration', quantity_rule: r.quantity_rule ?? null, applies_when: r.applies_when ?? null });
const TONE: Record<string, string> = { pending: 'bg-lateBg text-lateInk', posted: 'bg-doneBg text-doneInk', cancelled: 'bg-lockBg text-lockInk' };
const useName = () => { const { i18n } = useTranslation(); return (x: { name_en?: string; name_ar?: string | null }) => (i18n.language === 'ar' && x.name_ar) || x.name_en || ''; };

function Items() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const name = useName();
  const admin = isAdmin(useMe(true).data);
  const [q, setQ] = useState('');
  const [inactive, setInactive] = useState(false);
  const list = useWhItems({ q, include_inactive: inactive });
  const save = useSaveItem<WarehouseItem>('/warehouse/items', 'wh-items');
  const del = useDeleteItem();
  const [hist, setHist] = useState<WarehouseItem | null>(null);
  const histQ = useItemHistory(hist?.id ?? null);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [f, setF] = useState<Form>(EMPTY);
  const cols = useItemColumns().data ?? [];
  /** P6: the values of the extra columns in the form, as text ('true'/'false' for yes/no); empty = no value. */
  const [cv, setCv] = useState<Record<string, string>>({});
  const [fe, setFe] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  const close = () => { setDlg(null); setFe({}); setErr(null); };
  const open = (d: Dlg) => {
    setF(d && d.mode === 'edit' ? { code: d.item.code, name_en: d.item.name_en ?? '', name_ar: d.item.name_ar ?? '', uom: d.item.uom ?? '', category: d.item.category ?? '', serial_tracked: !!d.item.serial_tracked, code_source: d.item.code_source ?? 'internal_provisional', rules: d.item.need_rules ?? [] } : EMPTY);
    setCv(d && d.mode === 'edit' ? Object.fromEntries(Object.entries(d.item.custom ?? {}).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])) : {});
    setFe({}); setErr(null); setDlg(d);
  };
  const colLabel = (c: ItemColumn) => (i18n.language === 'ar' && c.label_ar) || c.label_en;
  const showVal = (c: ItemColumn, v: unknown) => (v === null || v === undefined || v === '' ? '—' : c.data_type === 'bool' ? t(v ? 'wh.yes' : 'wh.no') : String(v));
  const set = (k: keyof Form) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const setRule = (i: number, patch: Partial<Rule>) => setF((x) => ({ ...x, rules: x.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  const submit = (reason: string) => {
    if (!dlg) return;
    const item = dlg.mode === 'new' ? undefined : dlg.item;
    let body: Record<string, unknown>;
    if (dlg.mode === 'del') {
      del.mutate({ item: dlg.item, reason }, { onSuccess: close, onError: (e) => { close(); toast(registerErrorMessage(t, e), 'err'); } });
      return;
    }
    if (dlg.mode === 'off') body = { is_active: false, reason };
    else {
      const all: Record<string, unknown> = { name_en: f.name_en.trim(), name_ar: f.name_ar.trim() || null, uom: f.uom.trim(), category: f.category.trim() || null, serial_tracked: f.serial_tracked, code_source: f.code_source };
      const cur = dlg.mode === 'edit' ? dlg.item : null;
      body = { ...(cur ? Object.fromEntries(Object.entries(all).filter(([k, v]) => v !== ((cur as Record<string, unknown>)[k] ?? null))) : { code: f.code.trim(), ...all }), reason };
      // need rules (Q107): sent only when the quantity or the status of one changed
      if (cur && JSON.stringify(f.rules.map(ruleBody)) !== JSON.stringify((cur.need_rules ?? []).map(ruleBody))) body.need_rules = f.rules.map(ruleBody);
      // P6: only the extra columns whose value changed
      const was = (cur?.custom ?? {}) as Record<string, unknown>;
      const custom: Record<string, string | number | boolean | null> = {};
      cols.forEach((c) => {
        const v = (cv[c.code] ?? '').trim();
        if (v === (was[c.code] === null || was[c.code] === undefined ? '' : String(was[c.code]))) return;
        custom[c.code] = v === '' ? null : c.data_type === 'number' ? Number(v) : c.data_type === 'bool' ? v === 'true' : v;
      });
      if (Object.keys(custom).length) body.custom = custom;
      if (cur && Object.keys(body).length === 1) return close();
    }
    save.mutate({ item, body }, {
      onSuccess: close,
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'item_in_use' && dlg.mode === 'edit') {
          const bad = ['uom', 'serial_tracked'].filter((k) => k in body);
          if (bad.length) return setFe(Object.fromEntries(bad.map((k) => [k, registerErrorMessage(t, e)])));
        }
        if (dlg.mode === 'off') { close(); return toast(registerErrorMessage(t, e), 'err'); }
        if (e instanceof ApiError && e.status === 409 && dlg.mode === 'new') return setFe({ code: t('wh.code_taken') });
        setErr(e instanceof ApiError && ['item_in_use', 'insufficient_stock'].includes(e.code) ? registerErrorMessage(t, e) : errText(e, t));
      },
    });
  };
  const Fld = ({ k, label, dir, disabled }: { k: 'code' | 'name_en' | 'name_ar' | 'uom' | 'category'; label: string; dir?: string; disabled?: boolean }) => (
    <label className="block text-sm font-semibold">{label}
      <input className="input mt-1 font-normal" dir={dir} data-testid={`wh-f-${k}`} disabled={disabled} value={f[k]} onChange={(e) => set(k)(e.target.value)} />
      {fe[k] && <span role="alert" data-testid={`wh-error-${k}`} className="mt-1 block font-normal text-lateInk">{fe[k]}</span>}
    </label>
  );

  const stdCols: StdCol<WarehouseItem>[] = [
    { id: 'code', label: t('wh.code'), w: 170, pinned: true, text: (x) => x.code,
      cell: (x) => <span className="mono font-bold">{x.code}{x.code_source === 'internal_provisional' && <span className="chip ms-2 bg-waitBg font-normal text-waitInk" data-testid={`wh-provisional-${x.code}`} title={t('wh.code_source')}>{t('wh.cs_internal_provisional')}</span>}</span> },
    { id: 'name', label: t('wh.name'), w: 260, multi: true, text: (x) => name(x),
      cell: (x) => <>{name(x)}{(() => { const pend = (x.need_rules ?? []).filter((r) => r.status !== 'confirmed').length; return pend > 0 ? <span className="chip ms-2 bg-waitBg text-waitInk" data-testid={`wh-need-pending-${x.code}`}>{t('wh.need_pending_n', { count: pend })}</span> : null; })()}</> },
    { id: 'uom', label: t('wh.uom'), w: 90, text: (x) => x.uom ?? '', cell: (x) => x.uom },
    { id: 'category', label: t('wh.category'), w: 140, text: (x) => x.category ?? '', cell: (x) => x.category ?? '—' },
    { id: 'serial', label: t('wh.serial'), w: 90, text: (x) => (x.serial_tracked ? t('wh.yes') : t('wh.no')), cell: (x) => (x.serial_tracked ? t('wh.yes') : t('wh.no')) },
    ...cols.map((c): StdCol<WarehouseItem> => ({ id: `cv_${c.code}`, label: colLabel(c), w: 140, text: (x) => showVal(c, (x.custom ?? {})[c.code]), cell: (x) => <span data-testid={`wh-cv-${x.code}-${c.code}`}>{showVal(c, (x.custom ?? {})[c.code])}</span> })),
    { id: 'status', label: t('wh.status'), w: 110, text: (x) => t(x.is_active ? 'wh.active' : 'wh.inactive'), cell: (x) => <span className={`chip ${x.is_active ? 'bg-doneBg text-doneInk' : 'bg-lockBg text-lockInk'}`}>{t(x.is_active ? 'wh.active' : 'wh.inactive')}</span> },
    { id: 'actions', label: '', w: 260, action: true, multi: true, text: () => '', cell: (x) => admin ? <span className="flex flex-wrap justify-end gap-1">
      <button className="btn" data-testid={`wh-history-${x.code}`} onClick={() => setHist(x)}>{t('history.open')}</button>
      {x.is_active && <>
      <button className="btn" data-testid={`wh-edit-${x.code}`} onClick={() => open({ mode: 'edit', item: x })}>{t('wh.edit')}</button>
      <button className="btn" data-testid={`wh-off-${x.code}`} onClick={() => open({ mode: 'off', item: x })}>{t('wh.deactivate')}</button>
      {x.deletable && <button className="btn" data-testid={`wh-del-${x.code}`} onClick={() => open({ mode: 'del', item: x })}>{t('wh.delete')}</button>}</>}</span> : null },
  ];
  return (
    <div data-testid="wh-items">
      <StandardTable<WarehouseItem> headTestId={(id) => (id.startsWith('cv_') ? `wh-colh-${id.slice(3)}` : undefined)} screen="warehouse-items" testid="wh-item-table" cols={stdCols} rows={items} rowId={(x) => x.id} rowTestId={(x) => `wh-item-${x.code}`}
        loading={list.isLoading} error={list.isError} onRetry={() => void list.refetch()} empty={t('wh.empty')} exportName="warehouse-items" noun="items"
        query={q} onQuery={setQ} searchTestId="wh-search"
        views={<SavedViews<Record<string, unknown>> screen="warehouse-items" value={{ q, inactive }} empty={{ q: '', inactive: false }} onApply={(v) => { setQ(String(v.q ?? '')); setInactive(v.inactive === true); }} />}
        extra={<label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="wh-show-inactive" checked={inactive} onChange={(e) => setInactive(e.target.checked)} />{t('wh.show_inactive')}</label>}
        primary={admin ? <button className="btn btn-primary" data-testid="wh-new" onClick={() => open({ mode: 'new' })}><Plus size={16} />{t('wh.new_item')}</button> : undefined} />
      {hist && <HistoryDialog testid="wh-history-dialog" title={t('history.title_item', { code: hist.code })} entries={histQ.data} loading={histQ.isLoading} onClose={() => setHist(null)}
        onRestore={(e) => {
          // Restore = the old values through the normal writer (PATCH items/:id): rights, locks, reason and audit as for any edit
          // every field the item writer accepts; the code (identity), version and timestamps are not restorable
          const EDITABLE = ['name_en', 'name_ar', 'uom', 'category', 'serial_tracked', 'manufacturer', 'contract_qty', 'planned_delivery_date', 'progress_item_code', 'code_source', 'is_active'];
          const body: Record<string, unknown> = Object.fromEntries(e.changes.filter((c) => EDITABLE.includes(c.field)).map((c) => [c.field, c.from ?? null]));
          const cc = e.changes.find((c) => c.field === 'custom');
          if (cc) {
            // extra columns: the old values, and null for a column that had no value before
            const was = (cc.from ?? {}) as Record<string, unknown>; const now = (cc.to ?? {}) as Record<string, unknown>;
            const custom: Record<string, unknown> = {};
            Object.keys({ ...was, ...now }).forEach((k) => { if (JSON.stringify(was[k] ?? null) !== JSON.stringify(now[k] ?? null)) custom[k] = was[k] ?? null; });
            if (Object.keys(custom).length) body.custom = custom;
          }
          const nr = e.changes.find((c) => c.field === 'need_rules');
          if (nr && Array.isArray(nr.from)) body.need_rules = nr.from;
          if (!Object.keys(body).length) return;
          save.mutate({ item: hist, body: { ...body, reason: `Restore ${e.action} ${e.at.slice(0, 10)}` } }, { onSuccess: () => { setHist(null); toast(t('history.restored')); }, onError: (er) => toast(registerErrorMessage(t, er), 'err') });
        }} />}
      {dlg && (
        <FormDialog open onClose={close} testid="wh-dialog" busy={save.isPending || del.isPending} error={err} onSubmit={submit}
          title={t(dlg.mode === 'new' ? 'wh.new_title' : dlg.mode === 'edit' ? 'wh.edit_title' : dlg.mode === 'del' ? 'wh.delete_title' : 'wh.deactivate_title')}
          disabled={dlg.mode !== 'off' && dlg.mode !== 'del' && (!f.code.trim() || !f.name_en.trim() || !f.uom.trim())}>
          {dlg.mode === 'off' || dlg.mode === 'del' ? <p>{name(dlg.item)} ({dlg.item.code}){dlg.mode === 'del' && <span className="block text-mute" data-testid="wh-del-note">{t('wh.delete_note')}</span>}</p> : <>
            {Fld({ k: 'code', label: t('wh.code'), disabled: dlg.mode === 'edit' })}
            {Fld({ k: 'name_en', label: t('wh.name_en') })}
            {Fld({ k: 'name_ar', label: t('wh.name_ar'), dir: 'rtl' })}
            {Fld({ k: 'uom', label: t('wh.uom') })}
            {Fld({ k: 'category', label: t('wh.category') })}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="wh-f-serial" checked={f.serial_tracked} onChange={(e) => set('serial_tracked')(e.target.checked)} />{t('wh.serial')}</label>
            {fe.serial_tracked && <p role="alert" data-testid="wh-error-serial_tracked" className="text-lateInk">{fe.serial_tracked}</p>}
            <label className="block text-sm font-semibold">{t('wh.code_source')}
              <select className="input mt-1 font-normal" data-testid="wh-f-code_source" value={f.code_source} onChange={(e) => set('code_source')(e.target.value)}>
                {['master', 'internal_provisional'].map((c) => <option key={c} value={c}>{t(`wh.cs_${c}`)}</option>)}
              </select>
            </label>
            {cols.map((c) => (
              <label key={c.code} className="block text-sm font-semibold">{colLabel(c)}
                {c.data_type === 'bool' ? (
                  <select className="input mt-1 font-normal" data-testid={`wh-f-cv-${c.code}`} value={cv[c.code] ?? ''} onChange={(e) => setCv((x) => ({ ...x, [c.code]: e.target.value }))}>
                    <option value="" />{['true', 'false'].map((b) => <option key={b} value={b}>{t(b === 'true' ? 'wh.yes' : 'wh.no')}</option>)}
                  </select>
                ) : (
                  c.data_type === 'date'
                    ? <DateInput className="input mt-1 font-normal" data-testid={`wh-f-cv-${c.code}`} value={cv[c.code] ?? ''} onChange={(e) => setCv((x) => ({ ...x, [c.code]: e.target.value }))} />
                    : <input className="input mt-1 font-normal" type={c.data_type === 'number' ? 'number' : 'text'} step="any" data-testid={`wh-f-cv-${c.code}`} value={cv[c.code] ?? ''} onChange={(e) => setCv((x) => ({ ...x, [c.code]: e.target.value }))} />
                )}
              </label>
            ))}
            {dlg.mode === 'edit' && f.rules.length > 0 && (
              <fieldset className="space-y-2" data-testid="wh-f-rules"><legend className="text-sm font-semibold">{t('wh.need')}</legend>
                {f.rules.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 text-sm" data-testid={`wh-f-rule-${i}`}>
                    <span className="min-w-28">{r.need_unit}</span>
                    <input type="number" min={0} step="any" className="input w-24" aria-label={`${t('wh.need')} ${r.need_unit}`} data-testid={`wh-f-rule-qty-${i}`} value={r.quantity ?? ''}
                      onChange={(e) => setRule(i, { quantity: e.target.value === '' ? null : Number(e.target.value) })} />
                    <select className="input w-auto" aria-label={t('wh.status')} data-testid={`wh-f-rule-status-${i}`} value={r.status ?? 'pending_configuration'}
                      onChange={(e) => setRule(i, { status: e.target.value as Rule['status'] })}>
                      {['confirmed', 'pending_configuration'].map((c) => <option key={c} value={c}>{t(`wh.rs_${c}`)}</option>)}
                    </select>
                  </div>
                ))}
                {fe.need_rules && <p role="alert" data-testid="wh-error-need_rules" className="text-lateInk">{fe.need_rules}</p>}
              </fieldset>
            )}
          </>}
        </FormDialog>
      )}
    </div>
  );
}

function Movements() {
  const { t } = useTranslation();
  const [status, setStatus] = useState('');
  const [adv, setAdv] = useState('');
  const list = useMovements(status, adv);
  const [editing, setEditing] = useState<string | null>(null);
  const [reversing, setReversing] = useState<string | null>(null);
  // DN and RN, and the quarantine exits (Q270); the other documents (PL, OPEN, ADJ) have no site and are kept in the register.
  const items = (list.data?.items ?? []).filter((m) => m.kind === 'issue' || m.kind === 'return' || m.kind === 'quarantine_exit');
  const stdCols: StdCol<StockMovement>[] = [
    { id: 'doc_no', label: t('wh.doc_no'), w: 150, pinned: true, text: (m) => m.doc_no ?? '', cell: (m) => <span className="mono font-bold">{m.register_record_id ? <Link className="underline" to={`/registers/warehouse?record=${m.register_record_id}`}>{m.doc_no ?? '—'}</Link> : (m.doc_no ?? '—')}</span> },
    { id: 'type', label: t('wh.type'), w: 220, multi: true, text: (m) => (m.record_type ?? m.kind).toUpperCase(),
      cell: (m) => <>{(m.record_type ?? m.kind).toUpperCase()}{m.exit_kind && <span className="chip ms-2 bg-waitBg font-normal text-waitInk" data-testid={`wh-mv-exit-${m.doc_no ?? m.id}`} title={m.exit_reason ?? undefined}>{t(`wh.qx_${m.exit_kind}`)}</span>}{m.doc_no_locked && <Lock size={12} className="ms-1 inline text-mute" aria-label={t('wh.locked_hint')} data-testid={`wh-mv-locked-${m.doc_no ?? m.id}`} />}</> },
    { id: 'site', label: t('wh.site'), w: 120, text: (m) => m.site_code ?? '', cell: (m) => m.site_code ?? '—' },
    { id: 'qty', label: t('wh.qty'), w: 90, text: (m) => String(m.lines.reduce((a, l) => a + l.qty, 0)), cell: (m) => m.lines.reduce((a, l) => a + l.qty, 0) },
    { id: 'status', label: t('wh.status'), w: 120, multi: true, text: (m) => t(`wh.st_${m.status}`), cell: (m) => <span className={`chip ${TONE[m.status]}`} data-testid={`wh-mv-status-${m.doc_no ?? m.id}`}>{t(`wh.st_${m.status}`)}</span> },
    { id: 'actions', label: '', w: 280, action: true, multi: true, text: () => '', cell: (m) => <span className="flex flex-wrap justify-end gap-1">{m.register_record_id && (m.status === 'pending'
        ? <button className="btn" data-testid={`wh-mv-edit-open-${m.doc_no ?? m.id}`} onClick={() => setEditing(m.id)}><Pencil size={14} />{t('wh.mv_edit')}</button>
        : <span className="inline-flex items-center gap-1 text-xs text-mute" data-testid={`wh-mv-lock-${m.doc_no ?? m.id}`} title={t(`wh.mv_locked_${m.status}`, { defaultValue: '' })}><Lock size={12} />{t(m.status === 'posted' ? 'wh.mv_locked_posted' : 'wh.mv_locked_cancelled')}</span>)}
        {m.status === 'posted' && m.site_id && COUNTERPART[m.record_type ?? ''] && <button className="btn" data-testid={`wh-mv-reverse-open-${m.doc_no ?? m.id}`} onClick={() => setReversing(m.id)}>{t('wh.mv_reverse')}</button>}</span> },
  ];
  return (
    <div data-testid="wh-movements">
      <StandardTable<StockMovement> screen="warehouse-movements" testid="wh-movement-table" cols={stdCols} rows={items} rowId={(m) => m.id} rowTestId={(m) => `wh-mv-${m.doc_no ?? m.id}`} rowAttrs={(m) => ({ 'data-status': m.status })}
        loading={list.isLoading} error={list.isError} onRetry={() => void list.refetch()} empty={t('wh.empty')} exportName="warehouse-movements" noun="documents"
        views={<SavedViews<Record<string, unknown>> screen="warehouse-movements" value={{ status, ...(decodeFilter(adv) ? { advanced: decodeFilter(adv) } : {}) }} empty={{ status: '' }}
          onApply={(v) => { setStatus(String(v.status ?? '')); setAdv(encodeFilter((v as { advanced?: FilterTree }).advanced)); }} />}
        filter={<UnifiedFilter screen="warehouse-movements" value={decodeFilter(adv)} onChange={(tree) => setAdv(encodeFilter(tree))} onClearAll={() => setAdv('')} />}
        extra={<select className="input w-auto" aria-label={t('wh.status')} data-testid="wh-filter-status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('wh.all_statuses')}</option>{['pending', 'posted', 'cancelled'].map((x) => <option key={x} value={x}>{t(`wh.st_${x}`)}</option>)}
        </select>}
        rowExpand={(m) => editing === m.id && m.register_record_id ? <div role="row" className="border-b border-line p-2"><MovementEdit recordId={m.register_record_id} doc={m.doc_no ?? ''} onClose={() => setEditing(null)} /></div>
          : reversing === m.id ? <div role="row" className="border-b border-line p-2"><ReverseMovement m={m} onClose={() => setReversing(null)} /></div> : null} />
    </div>
  );
}

/**
 * Pending document: edit in place through the existing register record edit path (PATCH /registers/warehouse/records/:id, same permissions, If-Match
 * version and audit, no new write path; the register edit has no reason field, so none is asked; the server decides who may edit and when). Lines are not edited: stock is computed from the movements only.
 */
function MovementEdit({ recordId, doc, onClose }: { recordId: string; doc: string; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const rec = useRegisterRecord('warehouse', recordId);
  const upd = useUpdateRecord('warehouse');
  const cur = rec.data;
  const [f, setF] = useState<{ doc_date?: string; remark?: string }>({});
  const val = (k: 'doc_date' | 'remark') => f[k] ?? (typeof cur?.data?.[k] === 'string' ? (cur.data[k] as string) : '');
  return (
    <InlinePanel onClose={onClose} testid="wh-mv-edit" title={t('wh.mv_edit_title', { doc })} busy={upd.isPending || !cur} disabled={!cur || !Object.keys(f).length}
      error={upd.isError ? registerErrorMessage(t, upd.error) : null}
      withReason={false} onSubmit={() => cur && upd.mutate({ record: cur, patch: { data: f } }, { onSuccess: () => { toast(t('wh.mv_saved'), 'ok'); onClose(); } })}>
      <label className="block text-sm font-semibold">{t('wh.mv_doc_date')}
        <DateInput className="input mt-1 font-normal" data-testid="wh-mv-edit-date" value={val('doc_date')} onChange={(e) => setF({ ...f, doc_date: e.target.value })} /></label>
      <label className="block text-sm font-semibold">{t('wh.mv_remark')}
        <input className="input mt-1 font-normal" data-testid="wh-mv-edit-remark" value={val('remark')} onChange={(e) => setF({ ...f, remark: e.target.value })} /></label>
      <p className="text-xs text-mute">{t('wh.mv_lines_note')}</p>
    </InlinePanel>
  );
}

const COUNTERPART: Record<string, 'te_dn' | 'cw_dn' | 'te_rn' | 'cw_rn'> = { te_dn: 'te_rn', cw_dn: 'cw_rn', te_rn: 'te_dn', cw_rn: 'cw_dn' };

/**
 * Posted document: no direct edit. The correction is a reversal movement (the counterpart document with the same lines) that goes through the normal
 * creation and approval. Serial numbers are not copied: a serial-tracked item is refused by the server with its own message and is corrected by a new document.
 */
function ReverseMovement({ m, onClose }: { m: StockMovement; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const rev = useReverseMovement();
  const rt = COUNTERPART[m.record_type ?? ''];
  return (
    <InlinePanel onClose={onClose} testid="wh-mv-reverse" title={t('wh.mv_reverse_title', { doc: m.doc_no ?? '' })} busy={rev.isPending} disabled={!rt || !m.site_id}
      error={rev.isError ? registerErrorMessage(t, rev.error) : null}
      onSubmit={(reason) => rt && m.site_id && rev.mutate({ record_type: rt, site_id: m.site_id, reason, remark: t('wh.mv_reverse_remark', { doc: m.doc_no ?? '' }), lines: m.lines.map((l) => ({ item_id: l.item_id, qty: l.qty })) }, { onSuccess: (r) => { toast(t('wh.mv_reverse_done', { doc: r.doc_no ?? '' }), 'ok'); onClose(); } })}>
      <p className="text-sm text-mute">{t('wh.mv_reverse_note', { type: (rt ?? '').toUpperCase() })}</p>
      <ul className="list-disc ps-5 text-sm" data-testid="wh-mv-reverse-lines">{m.lines.map((l) => <li key={l.item_id}><b className="mono">{l.item_code}</b> {l.qty}</li>)}</ul>
    </InlinePanel>
  );
}

type ExitKind = QuarantineExitBody['exit_kind'];
const EXIT_KINDS: ExitKind[] = ['repaired', 'written_off', 'returned_to_supplier'];

/** Q270 (contract 0.13.1): one Warehouse document that takes quarantined stock out again, with a reason; L2 approves it in the register. */
function ExitDialog({ row, onClose }: { row: StockLevel; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const save = useQuarantineExit();
  const free = (row.quarantine ?? 0) - (row.quarantine_pending ?? 0);
  const [kind, setKind] = useState<ExitKind>('repaired');
  const [qty, setQty] = useState(String(free));
  const [serials, setSerials] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const n = Number(qty);
  const submit = (reason: string) => {
    const list = serials.split('\n').map((x) => x.trim()).filter(Boolean);
    save.mutate({ exit_kind: kind, reason, lines: [{ item_id: row.item_id, qty: n, ...(list.length ? { serials: list } : {}) }] }, {
      onSuccess: (m) => { toast(t('wh.qx_done', { doc_no: m.doc_no ?? '' }), 'ok'); onClose(); },
      onError: (e) => {
        if (e instanceof ApiError) {
          if (e.code === 'insufficient_stock') return setErr(t('wh.qx_err_too_many'));
          const code = (e.problem.errors ?? []).map((x) => x.code).find((c) => t(`wh.qx_err_${c}`) !== `wh.qx_err_${c}`);
          if (code) return setErr(t(`wh.qx_err_${code}`));
        }
        setErr(errText(e, t));
      },
    });
  };
  return (
    <FormDialog open onClose={onClose} testid="wh-qx" busy={save.isPending} error={err} onSubmit={submit} title={t('wh.qx_title')} submitLabel={t('wh.qx_submit')} disabled={!(n > 0) || n > free}>
      <p className="text-sm"><b className="mono">{row.item_code}</b> {row.item_name}</p>
      <p className="text-sm text-mute" data-testid="wh-qx-free">{t('wh.qx_available', { count: free })}</p>
      <label className="block text-sm font-semibold">{t('wh.qx_kind')}
        <select className="input mt-1 font-normal" data-testid="wh-qx-kind" value={kind} onChange={(e) => setKind(e.target.value as ExitKind)}>
          {EXIT_KINDS.map((k) => <option key={k} value={k}>{t(`wh.qx_${k}`)}</option>)}
        </select>
      </label>
      <label className="block text-sm font-semibold">{t('wh.qx_qty')}
        <input type="number" min={0} step="any" className="input mt-1 font-normal" data-testid="wh-qx-qty" value={qty} onChange={(e) => setQty(e.target.value)} />
      </label>
      <label className="block text-sm font-semibold">{t('wh.qx_serials')}
        <textarea className="input mt-1 min-h-16 font-normal" dir="ltr" data-testid="wh-qx-serials" value={serials} onChange={(e) => setSerials(e.target.value)} />
      </label>
    </FormDialog>
  );
}

function Stock() {
  const { t, i18n } = useTranslation();
  const me = useMe(true).data;
  const canExit = isAdmin(me) || hasGrant(me, 'create');
  const [q, setQ] = useState('');
  const [exit, setExit] = useState<StockLevel | null>(null);
  const list = useStock(q);
  const items = list.data?.items ?? [];
  const cols = ['on_hand', 'reserved', 'pending_issue', 'pending_return', 'available', 'quarantine'] as const;
  const stdCols: StdCol<StockLevel>[] = [
    { id: 'code', label: t('wh.code'), w: 260, pinned: true, text: (s) => `${s.item_code} ${s.item_name}`, cell: (s) => <><b className="mono">{s.item_code}</b> {s.item_name}</> },
    { id: 'uom', label: t('wh.uom'), w: 90, text: (s) => s.uom ?? '', cell: (s) => s.uom },
    ...cols.map((c): StdCol<StockLevel> => ({ id: c, label: t(`wh.${c}`), w: 120, multi: c === 'quarantine', text: (s) => String(s[c] ?? 0),
      cell: (s) => <span data-testid={`wh-stock-${s.item_code}-${c}`} className={c === 'quarantine' && (s[c] ?? 0) > 0 ? 'text-lateInk' : ''} title={c === 'quarantine' ? t('wh.quarantine_hint') : undefined}>
        {(s[c] ?? 0).toLocaleString(i18n.language)}
        {c === 'quarantine' && (s.quarantine_pending ?? 0) > 0 && <span className="chip ms-2 bg-waitBg font-normal text-waitInk" data-testid={`wh-stock-${s.item_code}-qx-pending`}>{t('wh.qx_pending_n', { count: s.quarantine_pending })}</span>}
      </span> })),
    { id: 'actions', label: '', w: 150, action: true, multi: true, text: () => '', cell: (s) => canExit && (s.quarantine ?? 0) - (s.quarantine_pending ?? 0) > 0 ? <button className="btn" data-testid={`wh-qx-open-${s.item_code}`} onClick={() => setExit(s)}>{t('wh.qx_action')}</button> : null },
  ];
  return (
    <div data-testid="wh-stock">
      <StandardTable<StockLevel> screen="warehouse-stock" testid="wh-stock-table" cols={stdCols} rows={items} rowId={(s) => s.item_id} rowTestId={(s) => `wh-stock-${s.item_code}`}
        loading={list.isLoading} error={list.isError} onRetry={() => void list.refetch()} empty={t('wh.empty')} exportName="warehouse-stock" noun="items"
        query={q} onQuery={setQ} searchTestId="wh-stock-search"
        views={<SavedViews<Record<string, unknown>> screen="warehouse-stock" value={{ q }} empty={{ q: '' }} onApply={(v) => setQ(String(v.q ?? ''))} />} />
      {exit && <ExitDialog row={exit} onClose={() => setExit(null)} />}
    </div>
  );
}

/** D6: per TE site, the Q65 date (latest approved TE DN) and GSDN Workspace need status, side by side. */
function Dispatch() {
  const { t } = useTranslation();
  const [status, setStatus] = useState('');
  const list = useDispatchList(status);
  const items = list.data?.items ?? [];
  const stdCols: StdCol<(typeof items)[number]>[] = [
    { id: 'site', label: t('wh.site'), w: 220, pinned: true, multi: true, text: (d) => d.site_code, cell: (d) => <span className="mono font-bold"><Link className="underline" to={`/sites/${d.site_id}?tab=warehouse`}>{d.site_code}</Link>{d.router_only && <span className="chip ms-2 bg-lockBg font-normal text-lockInk">{t('wh.router_only')}</span>}</span> },
    { id: 'dispatch_date', label: t('wh.dispatch_date'), w: 160, text: (d) => d.te_dispatch_complete_date ?? '', cell: (d) => <span className="mono" data-testid={`wh-dispatch-date-${d.site_code}`}>{d.te_dispatch_complete_date ?? '—'}</span> },
    { id: 'need_status', label: t('wh.need_status'), w: 180, multi: true, text: (d) => t(`wh.ns_${d.need_status}`), cell: (d) => <span className={`chip ${NEED_TONE[d.need_status]}`} data-testid={`wh-dispatch-status-${d.site_code}`}>{t(`wh.ns_${d.need_status}`)}</span> },
  ];
  return (
    <div data-testid="wh-dispatch">
      <StandardTable<(typeof items)[number]> screen="warehouse-dispatch" testid="wh-dispatch-table" cols={stdCols} rows={items} rowId={(d) => d.site_id} rowTestId={(d) => `wh-dispatch-${d.site_code}`}
        loading={list.isLoading} error={list.isError} onRetry={() => void list.refetch()} empty={t('wh.empty')} exportName="warehouse-dispatch" noun="items"
        views={<SavedViews<Record<string, unknown>> screen="warehouse-dispatch" value={{ status }} empty={{ status: '' }} onApply={(v) => setStatus(String(v.status ?? ''))} />}
        extra={<select className="input w-auto" aria-label={t('wh.need_status')} data-testid="wh-dispatch-filter" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('wh.all_statuses')}</option>{['complete', 'short', 'pending_configuration'].map((x) => <option key={x} value={x}>{t(`wh.ns_${x}`)}</option>)}
        </select>} />
    </div>
  );
}

function GapBox({ k, rows }: { k: string; rows: string[] }) {
  const { t } = useTranslation();
  return (
    <section className="card p-3" data-testid={`wh-gaps-${k}`}>
      <h2 className="mb-2 font-semibold">{t(`wh.gaps_${k}`)} <span className="text-mute">({rows.length})</span></h2>
      {rows.length ? <ul className="list-disc ps-5 text-sm">{rows.map((r) => <li key={r}>{r}</li>)}</ul> : <p className="text-sm text-mute">{t('wh.gaps_none')}</p>}
    </section>
  );
}

/** D58: the WL vendor of each region (Cambium or Intracom), set here by the System Admin or a delegate: the server decides who may (admin right on the item master), with a reason, version and audit. */
function RegionVendors({ rn }: { rn: (id: number) => string }) {
  const { t } = useTranslation();
  const q = useRegionVendors();
  const save = useSaveRegionVendor();
  const [edit, setEdit] = useState<RegionVendor | null>(null);
  const [v, setV] = useState('');
  const rows = q.data?.items ?? [];
  const missing = rows.filter((r) => !r.wl_vendor).length;
  return (
    <section className="card p-3 md:col-span-2" data-testid="wh-gaps-vendor">
      <h2 className="mb-2 font-semibold">{t('wh.gaps_vendor')} <span className="text-mute">({missing})</span></h2>
      <table className="w-full text-sm"><tbody>
        {rows.map((r) => (
          <tr key={r.region_id} className="border-b border-line last:border-0" data-testid={`wh-vendor-row-${r.region_id}`}>
            <td className="px-2 py-1">{rn(r.region_id)}</td>
            <td className="px-2 py-1">{r.wl_vendor ?? <span className="text-mute">{t('wh.vendor_unset')}</span>}</td>
            <td className="px-2 py-1 text-end"><button className="btn" data-testid={`wh-vendor-edit-${r.region_id}`} onClick={() => { setEdit(r); setV(r.wl_vendor ?? ''); }}>{t('common.edit')}</button></td>
          </tr>
        ))}
      </tbody></table>
      {edit && (
        <div className="mt-3">
          <InlinePanel testid="wh-vendor-panel" title={t('wh.vendor_edit', { region: rn(edit.region_id) })} onClose={() => setEdit(null)} busy={save.isPending}
            error={save.isError ? registerErrorMessage(t, save.error) : null}
            onSubmit={(reason) => save.mutate({ region_id: edit.region_id, version: edit.version, wl_vendor: v === '' ? null : (v as 'Cambium' | 'Intracom'), reason }, { onSuccess: () => setEdit(null) })}>
            <select className="input w-auto" aria-label={t('wh.vendor_pick')} data-testid="wh-vendor-select" value={v} onChange={(e) => setV(e.target.value)}>
              <option value="">{t('wh.vendor_unset')}</option><option value="Cambium">Cambium</option><option value="Intracom">Intracom</option>
            </select>
          </InlinePanel>
        </div>
      )}
    </section>
  );
}

/** Q107: the owner data that is still missing (need quantities, manufacturer codes, region WL vendor, numbering of the other regions). */
function Gaps() {
  const { t, i18n } = useTranslation();
  const q = useConfigGaps();
  const regs = useRegions().data ?? [];
  const admin = isAdmin(useMe(true).data);
  if (q.isLoading) return <p className="text-mute">{t('common.loading')}</p>;
  if (q.isError || !q.data) return <p role="alert" className="text-lateInk">{t('errors.generic')}</p>;
  const g = q.data;
  const rn = (id: number) => { const r = regs.find((x) => x.id === id); return (i18n.language === 'ar' && r?.name_ar) || r?.name_en || String(id); };
  return (
    <div className="grid gap-3 md:grid-cols-2" data-testid="wh-gaps">
      <GapBox k="pending" rows={g.pending_need_rules.map((r) => `${r.item_code} · ${r.need_unit}`)} />
      <GapBox k="codes" rows={g.provisional_codes.map((r) => `${r.item_code} · ${r.item_name}`)} />
      {admin ? <RegionVendors rn={rn} /> : <GapBox k="vendor" rows={g.regions_without_wl_vendor.map(rn)} />}
      <GapBox k="sequence" rows={g.regions_without_sequence.map((r) => `${rn(r.region_id ?? 0)}: ${(r.record_types ?? []).map((x) => x.toUpperCase()).join(', ')}`)} />
    </div>
  );
}

export function Warehouse() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('items');
  return (
    <div data-testid="page-warehouse">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-2xl font-bold">{t('wh.title')}</h1>
        <span className="ms-auto flex items-center gap-2"><ScreenSettingsLink screen="warehouse" /><Link className="btn" data-testid="wh-register-link" to="/registers/warehouse">{t('wh.open_register')}</Link></span>
      </div>
      <div role="tablist" className="mb-3 flex gap-1 border-b border-line">
        {(['items', 'movements', 'stock', 'reorder', 'rma', 'dispatch', 'gaps'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} data-testid={`wh-tab-${k}`} onClick={() => setTab(k)}
            className={`px-3 py-2 text-sm ${tab === k ? 'border-b-2 border-accent font-semibold' : 'text-mute'}`}>{t(`wh.tab_${k}`)}</button>
        ))}
      </div>
      {tab === 'items' && <Items />}{tab === 'movements' && <Movements />}{tab === 'stock' && <Stock />}{tab === 'reorder' && <ReorderLimits />}{tab === 'rma' && <SupplierReturns />}{tab === 'dispatch' && <Dispatch />}{tab === 'gaps' && <Gaps />}
    </div>
  );
}
