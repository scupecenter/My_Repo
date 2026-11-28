import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRegisterLinkCatalogue, useSaveRegisterLinkCatalogue, type RegisterLinkEntry } from '@/api/registerLinks';
import { useRegisterDefs } from '@/api/registers';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';

type Flag = 'enabled' | 'enforce' | 'same_site';
type Dlg = { k: 'flag'; i: number; flag: Flag } | { k: 'add' } | null;

/**
 * Settings > Register links: the one catalogue of the links between registers (migration 0713, on the D60 table register_links). A link is switched on or off and given its checks here; a new
 * link is added by choosing a text field of a register and the register it points to. The picker, the Related records panel and the check on save follow at once. Nothing is ever removed.
 */
export function RegisterLinksPanel() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useRegisterLinkCatalogue();
  const defs = useRegisterDefs();
  const save = useSaveRegisterLinkCatalogue();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [err, setErr] = useState<string | null>(null);
  const [add, setAdd] = useState({ from: '', field: '', to: '' });
  const ar = i18n.language === 'ar';
  const links = q.data?.links ?? [];
  const regs = defs.data ?? [];
  const nameOf = (k: string) => { const d = regs.find((x) => x.register_key === k); return d ? (ar && d.name_ar) || d.name_en : k; };
  const textFields = regs.find((d) => d.register_key === add.from)?.fields.filter((f) => f.type === 'text') ?? [];
  const close = () => { setDlg(null); setErr(null); };
  const run = async (next: RegisterLinkEntry[], reason: string) => {
    setErr(null);
    try { await save.mutateAsync({ version: q.data?.version, links: next, reason }); toast(t('links.saved')); close(); } catch (e) { setErr(errText(e, t)); }
  };
  if (q.isError) return null;
  return (
    <div className="card space-y-3 p-4" data-testid="register-links-panel">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-bold">{t('links.title')}</h2>
        {q.data?.can_edit && <button type="button" className="btn ms-auto" data-testid="links-add" onClick={() => { setAdd({ from: '', field: '', to: '' }); setDlg({ k: 'add' }); }}>{t('links.add')}</button>}
      </div>
      <p className="text-sm text-mute">{t('links.note')}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr>{(['from', 'field', 'to', 'state', 'enabled', 'enforce', 'same_site'] as const).map((h) => <th key={h} className="p-2 text-start text-mute">{t(`links.${h}`)}</th>)}</tr></thead>
          <tbody>
            {links.map((l, i) => (
              <tr key={`${l.from_register}.${l.field}`} className="border-t border-line" data-testid={`link-row-${l.from_register}-${l.field}`}>
                <td className="p-2">{nameOf(l.from_register)}</td>
                <td className="p-2"><code>{l.field}</code></td>
                <td className="p-2">{nameOf(l.to_register)}</td>
                <td className="p-2 text-mute">{l.target_state}{l.target_record_type ? ` / ${l.target_record_type}` : ''}</td>
                {(['enabled', 'enforce', 'same_site'] as const).map((f) => (
                  <td key={f} className="p-2">
                    <input type="checkbox" role="switch" data-testid={`link-${f}-${l.from_register}-${l.field}`} aria-label={`${t(`links.${f}`)} ${l.field}`} disabled={!q.data?.can_edit}
                      checked={l[f] === true} onChange={() => setDlg({ k: 'flag', i, flag: f })} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <FormDialog inline open={dlg?.k === 'flag'} onClose={close} testid="link-flag-dialog" title={t('links.toggle_title')} error={err} busy={save.isPending}
        onSubmit={(reason) => {
          if (dlg?.k !== 'flag') return;
          const d = dlg;
          void run(links.map((l, i) => (i === d.i ? { ...l, [d.flag]: !(l[d.flag] === true) } : l)), reason);
        }} />
      <FormDialog inline open={dlg?.k === 'add'} onClose={close} testid="link-add-dialog" title={t('links.add_title')} error={err} busy={save.isPending} disabled={!add.from || !add.field || !add.to}
        onSubmit={(reason) => void run([...links, { from_register: add.from, field: add.field, to_register: add.to, enforce: false, same_site: false, enabled: true }], reason)}>
        <select className="input" data-testid="link-add-from" aria-label={t('links.from')} value={add.from} onChange={(e) => setAdd({ ...add, from: e.target.value, field: '' })}>
          <option value="">{t('links.choose')}</option>{regs.map((d) => <option key={d.register_key} value={d.register_key}>{nameOf(d.register_key)}</option>)}
        </select>
        <select className="input" data-testid="link-add-field" aria-label={t('links.field')} value={add.field} onChange={(e) => setAdd({ ...add, field: e.target.value })}>
          <option value="">{t('links.choose')}</option>{textFields.filter((f) => !links.some((l) => l.from_register === add.from && l.field === f.code)).map((f) => <option key={f.code} value={f.code}>{f.label_en} ({f.code})</option>)}
        </select>
        <select className="input" data-testid="link-add-to" aria-label={t('links.to')} value={add.to} onChange={(e) => setAdd({ ...add, to: e.target.value })}>
          <option value="">{t('links.choose')}</option>{regs.map((d) => <option key={d.register_key} value={d.register_key}>{nameOf(d.register_key)}</option>)}
        </select>
      </FormDialog>
    </div>
  );
}
