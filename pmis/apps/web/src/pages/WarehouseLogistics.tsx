import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { useStock, useWhItems } from '@/api/warehouse';
import { useCreateRma, useReorderLimits, useRmaList, useSaveReorderLimit, useSetRmaStatus, type Rma } from '@/api/warehouseLogistics';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { hasGrant, isAdmin } from '@/lib/perm';

/** Warehouse > Reorder limits (contract 0.15.342): the level under which an item is flagged, and the quantity to reorder. Admins edit; everyone with the Warehouse view reads. */
export function ReorderLimits() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const me = useMe(true).data;
  const admin = isAdmin(me);
  const [below, setBelow] = useState(false);
  const lim = useReorderLimits();
  const items = useWhItems({ q: '', include_inactive: false }, admin);
  const save = useSaveReorderLimit();
  const [dlg, setDlg] = useState<{ item_id: string; label: string; version?: number } | null>(null);
  const [level, setLevel] = useState('');
  const [qty, setQty] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const rows = (lim.data?.items ?? []).filter((r) => !below || r.below_reorder);
  const open = (item_id: string, label: string, cur?: { reorder_level: number; reorder_qty: number | null; version: number }) => {
    setDlg({ item_id, label, version: cur?.version }); setLevel(cur ? String(cur.reorder_level) : ''); setQty(cur?.reorder_qty ? String(cur.reorder_qty) : ''); setErr(null);
  };
  const lv = Number(level);
  const bad = level === '' || !(lv >= 0) || (qty !== '' && !(Number(qty) > 0));
  const submit = (reason: string, clear = false) => {
    if (!dlg) return;
    save.mutate({ item_id: dlg.item_id, version: dlg.version, reorder_level: clear ? null : lv, reorder_qty: clear || qty === '' ? null : Number(qty), reason }, {
      onSuccess: () => { toast(t('wh.rl_saved'), 'ok'); setDlg(null); }, onError: (e) => setErr(errText(e, t)),
    });
  };
  const free = (items.data?.items ?? []).filter((i) => !(lim.data?.items ?? []).some((r) => r.item_id === i.id));
  return (
    <div data-testid="wh-reorder">
      <p className="mb-2 text-sm text-mute">{t('wh.rl_note')}</p>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="wh-rl-below" checked={below} onChange={(e) => setBelow(e.target.checked)} />{t('wh.rl_only_below')}</label>
        {admin && (
          <select className="input ms-auto w-auto" aria-label={t('wh.rl_add')} data-testid="wh-rl-add" value="" onChange={(e) => { const i = free.find((x) => x.id === e.target.value); if (i) open(i.id, `${i.code}`); }}>
            <option value="">{t('wh.rl_add')}</option>
            {free.map((i) => <option key={i.id} value={i.id}>{i.code}</option>)}
          </select>
        )}
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line bg-card2 text-mute">{['code', 'rl_level', 'rl_qty', 'rl_available'].map((c) => <th key={c} className="px-3 py-2 text-start font-semibold">{t(c === 'code' ? 'wh.code' : `wh.${c}`)}</th>)}<th /></tr></thead>
          <tbody data-testid="wh-rl-list">
            {rows.map((r) => (
              <tr key={r.item_id} data-testid={`wh-rl-${r.item_code}`} className="border-b border-line">
                <td className="px-3 py-2"><b className="mono">{r.item_code}</b> {r.item_name}</td>
                <td className="px-3 py-2">{r.reorder_level.toLocaleString(i18n.language)}</td>
                <td className="px-3 py-2">{r.reorder_qty?.toLocaleString(i18n.language) ?? '-'}</td>
                <td className={`px-3 py-2 ${r.below_reorder ? 'text-lateInk' : ''}`}>{r.available.toLocaleString(i18n.language)}{r.below_reorder && <span className="chip ms-2 bg-waitBg font-normal text-waitInk" data-testid={`wh-rl-flag-${r.item_code}`}>{t('wh.rl_below')}</span>}</td>
                <td className="px-3 py-2 text-end">{admin && <button className="btn" data-testid={`wh-rl-edit-${r.item_code}`} onClick={() => open(r.item_id, r.item_code, r)}>{t('common.edit')}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {lim.isSuccess && !rows.length && <p className="p-6 text-center text-mute" data-testid="wh-rl-empty">{t('wh.rl_empty')}</p>}
        {lim.isError && <p role="alert" className="p-6 text-center text-lateInk">{t('errors.generic')}</p>}
      </div>
      {dlg && (
        <FormDialog open onClose={() => setDlg(null)} testid="wh-rl-dialog" title={t('wh.rl_title', { item: dlg.label })} busy={save.isPending} error={err} disabled={bad} onSubmit={(r) => submit(r)}>
          <label className="block text-sm font-semibold">{t('wh.rl_level')}
            <input type="number" min={0} step="any" className="input mt-1 font-normal" data-testid="wh-rl-level" value={level} onChange={(e) => setLevel(e.target.value)} /></label>
          <label className="block text-sm font-semibold">{t('wh.rl_qty')}
            <input type="number" min={0} step="any" className="input mt-1 font-normal" data-testid="wh-rl-qty" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
          {dlg.version !== undefined && <button type="button" className="btn" data-testid="wh-rl-clear" onClick={() => submit(t('wh.rl_clear_reason'), true)}>{t('wh.rl_clear')}</button>}
        </FormDialog>
      )}
    </div>
  );
}

const NEXT: Record<string, Array<'replaced' | 'credited' | 'rejected' | 'closed'>> = { sent: ['replaced', 'credited', 'rejected'], replaced: ['closed'], credited: ['closed'], rejected: ['closed'] };

/** Warehouse > Supplier returns (RMA, contract 0.15.342): what the supplier did with the items sent back from quarantine. Tracking only; the stock moves through the quarantine exit. */
export function SupplierReturns() {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useMe(true).data;
  const can = isAdmin(me) || hasGrant(me, 'create');
  const [status, setStatus] = useState('');
  const list = useRmaList(status);
  const stock = useStock('');
  const create = useCreateRma();
  const setS = useSetRmaStatus();
  const [add, setAdd] = useState(false);
  const [f, setF] = useState({ item_id: '', qty: '', supplier: '' });
  const [step, setStep] = useState<{ rma: Rma; to: 'replaced' | 'credited' | 'rejected' | 'closed' } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const items = (stock.data?.items ?? []).filter((s) => (s.quarantine ?? 0) > 0);
  const ok = f.item_id !== '' && Number(f.qty) > 0 && f.supplier.trim() !== '';
  return (
    <div data-testid="wh-rma">
      <p className="mb-2 text-sm text-mute">{t('wh.rma_note')}</p>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <select className="input w-auto" aria-label={t('wh.status')} data-testid="wh-rma-filter" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('wh.rma_all')}</option>
          {['sent', 'replaced', 'credited', 'rejected', 'closed'].map((s) => <option key={s} value={s}>{t(`wh.rma_${s}`)}</option>)}
        </select>
        {can && <button className="btn btn-primary ms-auto" data-testid="wh-rma-new" onClick={() => { setF({ item_id: '', qty: '', supplier: '' }); setErr(null); setAdd(true); }}>{t('wh.rma_new')}</button>}
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line bg-card2 text-mute">{['rma_no', 'code', 'rma_qty', 'rma_supplier', 'status', 'rma_sent_on'].map((c) => <th key={c} className="px-3 py-2 text-start font-semibold">{t(c === 'code' ? 'wh.code' : c === 'status' ? 'wh.status' : `wh.${c}`)}</th>)}<th /></tr></thead>
          <tbody data-testid="wh-rma-list">
            {(list.data?.items ?? []).map((r) => (
              <tr key={r.id} data-testid={`wh-rma-${r.rma_no}`} className="border-b border-line">
                <td className="mono px-3 py-2 font-bold">{r.rma_no}</td><td className="px-3 py-2"><b className="mono">{r.item_code}</b> {r.item_name}</td>
                <td className="px-3 py-2">{r.qty}</td><td className="px-3 py-2">{r.supplier}</td><td className="px-3 py-2">{t(`wh.rma_${r.status}`)}</td><td className="px-3 py-2">{r.sent_on}</td>
                <td className="px-3 py-2 text-end">{can && (NEXT[r.status] ?? []).map((to) => <button key={to} className="btn ms-1" data-testid={`wh-rma-${r.rma_no}-${to}`} onClick={() => { setStep({ rma: r, to }); setErr(null); }}>{t(`wh.rma_to_${to}`)}</button>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.isSuccess && !list.data?.items.length && <p className="p-6 text-center text-mute" data-testid="wh-rma-empty">{t('wh.rma_empty')}</p>}
        {list.isError && <p role="alert" className="p-6 text-center text-lateInk">{t('errors.generic')}</p>}
      </div>
      {add && (
        <FormDialog open onClose={() => setAdd(false)} testid="wh-rma-dialog" title={t('wh.rma_new')} busy={create.isPending} error={err} disabled={!ok}
          onSubmit={(reason) => create.mutate({ item_id: f.item_id, qty: Number(f.qty), supplier: f.supplier.trim(), reason }, { onSuccess: () => { toast(t('wh.rma_saved'), 'ok'); setAdd(false); }, onError: (e) => setErr(errText(e, t)) })}>
          <label className="block text-sm font-semibold">{t('wh.code')}
            <select className="input mt-1 font-normal" data-testid="wh-rma-item" value={f.item_id} onChange={(e) => setF({ ...f, item_id: e.target.value })}>
              <option value="" />{items.map((s) => <option key={s.item_id} value={s.item_id}>{s.item_code} ({s.quarantine})</option>)}
            </select></label>
          <label className="block text-sm font-semibold">{t('wh.rma_qty')}
            <input type="number" min={0} step="any" className="input mt-1 font-normal" data-testid="wh-rma-qty" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></label>
          <label className="block text-sm font-semibold">{t('wh.rma_supplier')}
            <input className="input mt-1 font-normal" maxLength={200} data-testid="wh-rma-supplier" value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} /></label>
        </FormDialog>
      )}
      {step && (
        <FormDialog open onClose={() => setStep(null)} testid="wh-rma-step" title={t(`wh.rma_to_${step.to}`)} withReason={false} busy={setS.isPending} error={err}
          onSubmit={() => setS.mutate({ id: step.rma.id, version: step.rma.version, status: step.to, note: '' }, { onSuccess: () => { toast(t('wh.rma_saved'), 'ok'); setStep(null); }, onError: (e) => setErr(errText(e, t)) })}>
          <p className="text-sm"><b className="mono">{step.rma.rma_no}</b> {step.rma.item_code}</p>
        </FormDialog>
      )}
    </div>
  );
}
