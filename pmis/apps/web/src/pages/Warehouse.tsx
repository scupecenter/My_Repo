import { Lock, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useMe } from '@/api/hooks';
import { useRegions } from '@/api/sites';
import type { StockLevel, WarehouseItem } from '@/api/types';
import { useConfigGaps, useDispatchList, useMovements, useQuarantineExit, useSaveItem, useStock, useWhItems, type QuarantineExitBody } from '@/api/warehouse';
import { NEED_TONE } from '@/components/SiteDispatch';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { hasGrant, isAdmin } from '@/lib/perm';
import { registerErrorMessage } from '@/lib/registerErrors';

type Tab = 'items' | 'movements' | 'stock' | 'dispatch' | 'gaps';
type Dlg = { mode: 'new' } | { mode: 'edit' | 'off'; item: WarehouseItem } | null;
type Rule = NonNullable<WarehouseItem['need_rules']>[number];
type Form = { code: string; name_en: string; name_ar: string; uom: string; category: string; serial_tracked: boolean; code_source: string; rules: Rule[] };
const EMPTY: Form = { code: '', name_en: '', name_ar: '', uom: '', category: '', serial_tracked: false, code_source: 'internal_provisional', rules: [] };
/** A need rule as the API takes it back (no id; Q107 status kept). */
const ruleBody = (r: Rule) => ({ need_unit: r.need_unit, quantity: r.quantity ?? null, status: r.status ?? 'pending_configuration', quantity_rule: r.quantity_rule ?? null, applies_when: r.applies_when ?? null });
const TONE: Record<string, string> = { pending: 'bg-lateBg text-lateInk', posted: 'bg-doneBg text-doneInk', cancelled: 'bg-lockBg text-lockInk' };
const useName = () => { const { i18n } = useTranslation(); return (x: { name_en?: string; name_ar?: string | null }) => (i18n.language === 'ar' && x.name_ar) || x.name_en || ''; };

function Items() {
  const { t } = useTranslation();
  const toast = useToast();
  const name = useName();
  const admin = isAdmin(useMe(true).data);
  const [q, setQ] = useState('');
  const [inactive, setInactive] = useState(false);
  const list = useWhItems({ q, include_inactive: inactive });
  const save = useSaveItem<WarehouseItem>('/warehouse/items', 'wh-items');
  const [dlg, setDlg] = useState<Dlg>(null);
  const [f, setF] = useState<Form>(EMPTY);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  const close = () => { setDlg(null); setFe({}); setErr(null); };
  const open = (d: Dlg) => {
    setF(d && d.mode === 'edit' ? { code: d.item.code, name_en: d.item.name_en ?? '', name_ar: d.item.name_ar ?? '', uom: d.item.uom ?? '', category: d.item.category ?? '', serial_tracked: !!d.item.serial_tracked, code_source: d.item.code_source ?? 'internal_provisional', rules: d.item.need_rules ?? [] } : EMPTY);
    setFe({}); setErr(null); setDlg(d);
  };
  const set = (k: keyof Form) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const setRule = (i: number, patch: Partial<Rule>) => setF((x) => ({ ...x, rules: x.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  const submit = (reason: string) => {
    if (!dlg) return;
    const item = dlg.mode === 'new' ? undefined : dlg.item;
    let body: Record<string, unknown>;
    if (dlg.mode === 'off') body = { is_active: false, reason };
    else {
      const all: Record<string, unknown> = { name_en: f.name_en.trim(), name_ar: f.name_ar.trim() || null, uom: f.uom.trim(), category: f.category.trim() || null, serial_tracked: f.serial_tracked, code_source: f.code_source };
      const cur = dlg.mode === 'edit' ? dlg.item : null;
      body = { ...(cur ? Object.fromEntries(Object.entries(all).filter(([k, v]) => v !== ((cur as Record<string, unknown>)[k] ?? null))) : { code: f.code.trim(), ...all }), reason };
      // need rules (Q107): sent only when the quantity or the status of one changed
      if (cur && JSON.stringify(f.rules.map(ruleBody)) !== JSON.stringify((cur.need_rules ?? []).map(ruleBody))) body.need_rules = f.rules.map(ruleBody);
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

  return (
    <div data-testid="wh-items">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input className="input max-w-64" data-testid="wh-search" placeholder={t('wh.search')} aria-label={t('wh.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="wh-show-inactive" checked={inactive} onChange={(e) => setInactive(e.target.checked)} />{t('wh.show_inactive')}</label>
        {admin && <button className="btn btn-primary ms-auto" data-testid="wh-new" onClick={() => open({ mode: 'new' })}><Plus size={16} />{t('wh.new_item')}</button>}
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line bg-card2 text-start text-mute">{['code', 'name', 'uom', 'category', 'serial', 'status'].map((c) => <th key={c} className="px-3 py-2 text-start font-semibold">{t(`wh.${c}`)}</th>)}<th /></tr></thead>
          <tbody data-testid="wh-item-list">
            {items.map((x) => (
              <tr key={x.id} data-testid={`wh-item-${x.code}`} className="border-b border-line">
                <td className="mono px-3 py-2 font-bold">{x.code}{x.code_source === 'internal_provisional' && <span className="chip ms-2 bg-waitBg font-normal text-waitInk" data-testid={`wh-provisional-${x.code}`} title={t('wh.code_source')}>{t('wh.cs_internal_provisional')}</span>}</td>
                <td className="px-3 py-2">{name(x)}{(() => { const pend = (x.need_rules ?? []).filter((r) => r.status !== 'confirmed').length; return pend > 0 ? <span className="chip ms-2 bg-waitBg text-waitInk" data-testid={`wh-need-pending-${x.code}`}>{t('wh.need_pending_n', { count: pend })}</span> : null; })()}</td><td className="px-3 py-2">{x.uom}</td><td className="px-3 py-2">{x.category ?? '—'}</td>
                <td className="px-3 py-2">{x.serial_tracked ? t('wh.yes') : t('wh.no')}</td>
                <td className="px-3 py-2"><span className={`chip ${x.is_active ? 'bg-doneBg text-doneInk' : 'bg-lockBg text-lockInk'}`}>{t(x.is_active ? 'wh.active' : 'wh.inactive')}</span></td>
                <td className="px-3 py-2 text-end">{admin && x.is_active && <>
                  <button className="btn" data-testid={`wh-edit-${x.code}`} onClick={() => open({ mode: 'edit', item: x })}>{t('wh.edit')}</button>{' '}
                  <button className="btn" data-testid={`wh-off-${x.code}`} onClick={() => open({ mode: 'off', item: x })}>{t('wh.deactivate')}</button></>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.isSuccess && !items.length && <p className="p-6 text-center text-mute" data-testid="wh-empty">{t('wh.empty')}</p>}
        {list.isError && <p role="alert" className="p-6 text-center text-lateInk">{t('errors.generic')}</p>}
      </div>
      {dlg && (
        <FormDialog open onClose={close} testid="wh-dialog" busy={save.isPending} error={err} onSubmit={submit}
          title={t(dlg.mode === 'new' ? 'wh.new_title' : dlg.mode === 'edit' ? 'wh.edit_title' : 'wh.deactivate_title')}
          disabled={dlg.mode !== 'off' && (!f.code.trim() || !f.name_en.trim() || !f.uom.trim())}>
          {dlg.mode === 'off' ? <p>{name(dlg.item)} ({dlg.item.code})</p> : <>
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
  const list = useMovements(status);
  // DN and RN, and the quarantine exits (Q270); the other documents (PL, OPEN, ADJ) have no site and are kept in the register.
  const items = (list.data?.items ?? []).filter((m) => m.kind === 'issue' || m.kind === 'return' || m.kind === 'quarantine_exit');
  return (
    <div data-testid="wh-movements">
      <div className="mb-3 flex gap-2">
        <select className="input w-auto" aria-label={t('wh.status')} data-testid="wh-filter-status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('wh.all_statuses')}</option>{['pending', 'posted', 'cancelled'].map((s) => <option key={s} value={s}>{t(`wh.st_${s}`)}</option>)}
        </select>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line bg-card2 text-mute">{['doc_no', 'type', 'site', 'qty', 'status'].map((c) => <th key={c} className="px-3 py-2 text-start font-semibold">{t(`wh.${c}`)}</th>)}</tr></thead>
          <tbody data-testid="wh-movement-list">
            {items.map((m) => (
              <tr key={m.id} data-testid={`wh-mv-${m.doc_no ?? m.id}`} data-status={m.status} className="border-b border-line">
                <td className="mono px-3 py-2 font-bold">{m.register_record_id ? <Link className="underline" to={`/registers/warehouse?record=${m.register_record_id}`}>{m.doc_no ?? '—'}</Link> : (m.doc_no ?? '—')}</td>
                <td className="px-3 py-2">{(m.record_type ?? m.kind).toUpperCase()}{m.exit_kind && <span className="chip ms-2 bg-waitBg font-normal text-waitInk" data-testid={`wh-mv-exit-${m.doc_no ?? m.id}`} title={m.exit_reason ?? undefined}>{t(`wh.qx_${m.exit_kind}`)}</span>}{m.doc_no_locked && <Lock size={12} className="ms-1 inline text-mute" aria-label={t('wh.locked_hint')} data-testid={`wh-mv-locked-${m.doc_no ?? m.id}`} />}</td><td className="px-3 py-2">{m.site_code ?? '—'}</td>
                <td className="px-3 py-2">{m.lines.reduce((a, l) => a + l.qty, 0)}</td>
                <td className="px-3 py-2"><span className={`chip ${TONE[m.status]}`} data-testid={`wh-mv-status-${m.doc_no ?? m.id}`}>{t(`wh.st_${m.status}`)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.isSuccess && !items.length && <p className="p-6 text-center text-mute" data-testid="wh-mv-empty">{t('wh.empty')}</p>}
        {list.isError && <p role="alert" className="p-6 text-center text-lateInk">{t('errors.generic')}</p>}
      </div>
    </div>
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
  return (
    <div data-testid="wh-stock">
      <input className="input mb-3 max-w-64" data-testid="wh-stock-search" placeholder={t('wh.search')} aria-label={t('wh.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line bg-card2 text-mute"><th className="px-3 py-2 text-start font-semibold">{t('wh.code')}</th><th className="px-3 py-2 text-start font-semibold">{t('wh.uom')}</th>{cols.map((c) => <th key={c} className="px-3 py-2 text-start font-semibold">{t(`wh.${c}`)}</th>)}<th /></tr></thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.item_id} data-testid={`wh-stock-${s.item_code}`} className="border-b border-line">
                <td className="px-3 py-2"><b className="mono">{s.item_code}</b> {s.item_name}</td><td className="px-3 py-2">{s.uom}</td>
                {cols.map((c) => <td key={c} data-testid={`wh-stock-${s.item_code}-${c}`} className={`px-3 py-2 ${c === 'quarantine' && (s[c] ?? 0) > 0 ? 'text-lateInk' : ''}`} title={c === 'quarantine' ? t('wh.quarantine_hint') : undefined}>
                  {(s[c] ?? 0).toLocaleString(i18n.language)}
                  {c === 'quarantine' && (s.quarantine_pending ?? 0) > 0 && <span className="chip ms-2 bg-waitBg font-normal text-waitInk" data-testid={`wh-stock-${s.item_code}-qx-pending`}>{t('wh.qx_pending_n', { count: s.quarantine_pending })}</span>}
                </td>)}
                <td className="px-3 py-2 text-end">{canExit && (s.quarantine ?? 0) - (s.quarantine_pending ?? 0) > 0 && <button className="btn" data-testid={`wh-qx-open-${s.item_code}`} onClick={() => setExit(s)}>{t('wh.qx_action')}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.isSuccess && !items.length && <p className="p-6 text-center text-mute">{t('wh.empty')}</p>}
        {list.isError && <p role="alert" className="p-6 text-center text-lateInk">{t('errors.generic')}</p>}
      </div>
      {exit && <ExitDialog row={exit} onClose={() => setExit(null)} />}
    </div>
  );
}

/** D6: per TE site, the Q65 date (latest approved TE DN) and the PMIS need status, side by side. */
function Dispatch() {
  const { t } = useTranslation();
  const [status, setStatus] = useState('');
  const list = useDispatchList(status);
  const items = list.data?.items ?? [];
  return (
    <div data-testid="wh-dispatch">
      <div className="mb-3 flex gap-2">
        <select className="input w-auto" aria-label={t('wh.need_status')} data-testid="wh-dispatch-filter" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('wh.all_statuses')}</option>{['complete', 'short', 'pending_configuration'].map((s) => <option key={s} value={s}>{t(`wh.ns_${s}`)}</option>)}
        </select>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line bg-card2 text-mute">
            <th className="px-3 py-2 text-start font-semibold">{t('wh.site')}</th>
            <th className="px-3 py-2 text-start font-semibold" title={t('wh.dispatch_date_hint')}>{t('wh.dispatch_date')}</th>
            <th className="px-3 py-2 text-start font-semibold" title={t('wh.need_status_hint')}>{t('wh.need_status')}</th>
          </tr></thead>
          <tbody data-testid="wh-dispatch-list">
            {items.map((d) => (
              <tr key={d.site_id} data-testid={`wh-dispatch-${d.site_code}`} className="border-b border-line">
                <td className="mono px-3 py-2 font-bold"><Link className="underline" to={`/sites/${d.site_id}?tab=warehouse`}>{d.site_code}</Link>{d.router_only && <span className="chip ms-2 bg-lockBg font-normal text-lockInk">{t('wh.router_only')}</span>}</td>
                <td className="mono px-3 py-2" data-testid={`wh-dispatch-date-${d.site_code}`}>{d.te_dispatch_complete_date ?? '—'}</td>
                <td className="px-3 py-2"><span className={`chip ${NEED_TONE[d.need_status]}`} data-testid={`wh-dispatch-status-${d.site_code}`}>{t(`wh.ns_${d.need_status}`)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.isSuccess && !items.length && <p className="p-6 text-center text-mute">{t('wh.empty')}</p>}
        {list.isError && <p role="alert" className="p-6 text-center text-lateInk">{t('errors.generic')}</p>}
      </div>
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

/** Q107: the owner data that is still missing (need quantities, manufacturer codes, region WL vendor, numbering of the other regions). */
function Gaps() {
  const { t, i18n } = useTranslation();
  const q = useConfigGaps();
  const regs = useRegions().data ?? [];
  if (q.isLoading) return <p className="text-mute">{t('common.loading')}</p>;
  if (q.isError || !q.data) return <p role="alert" className="text-lateInk">{t('errors.generic')}</p>;
  const g = q.data;
  const rn = (id: number) => { const r = regs.find((x) => x.id === id); return (i18n.language === 'ar' && r?.name_ar) || r?.name_en || String(id); };
  return (
    <div className="grid gap-3 md:grid-cols-2" data-testid="wh-gaps">
      <GapBox k="pending" rows={g.pending_need_rules.map((r) => `${r.item_code} · ${r.need_unit}`)} />
      <GapBox k="codes" rows={g.provisional_codes.map((r) => `${r.item_code} · ${r.item_name}`)} />
      <GapBox k="vendor" rows={g.regions_without_wl_vendor.map(rn)} />
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
        <Link className="btn ms-auto" data-testid="wh-register-link" to="/registers/warehouse">{t('wh.open_register')}</Link>
      </div>
      <div role="tablist" className="mb-3 flex gap-1 border-b border-line">
        {(['items', 'movements', 'stock', 'dispatch', 'gaps'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} data-testid={`wh-tab-${k}`} onClick={() => setTab(k)}
            className={`px-3 py-2 text-sm ${tab === k ? 'border-b-2 border-accent font-semibold' : 'text-mute'}`}>{t(`wh.tab_${k}`)}</button>
        ))}
      </div>
      {tab === 'items' && <Items />}{tab === 'movements' && <Movements />}{tab === 'stock' && <Stock />}{tab === 'dispatch' && <Dispatch />}{tab === 'gaps' && <Gaps />}
    </div>
  );
}
