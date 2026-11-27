import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRegisterLinks, useSaveRegisterLinks, type RegisterLink } from '@/api/registerLinks';
import { useRegisterDefs } from '@/api/registers';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';

type Flag = 'enabled' | 'validate' | 'same_site' | 'approved_only';
type Dlg = { k: 'flag'; i: number; flag: Flag } | { k: 'add' } | null;

/**
 * Settings > Register links: the one catalogue of the links between registers (migration 0431). A link is switched on or off and given its checks here; a new link is added
 * by choosing a text field of a register and the register it points to. The picker, the Related records panel and the check on save follow at once. Nothing is ever removed.
 */
export function RegisterLinksPanel() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useRegisterLinks();
  const defs = useRegisterDefs();
  const save = useSaveRegisterLinks();
  const [dlg, setDlg] = useState<Dlg>(null);
  const [err, setErr] = useState<string | null>(null);
  const [add, setAdd] = useState({ from: '', field: '', to: '', en: '', ar: '' });
  const ar = i18n.language === 'ar';
  const links = q.data?.links ?? [];
  const regs = defs.data ?? [];
  const nameOf = (k: string) => { const d = regs.find((x) => x.register_key === k); return d ? (ar && d.name_ar) || d.name_en : k; };
  const textFields = regs.find((d) => d.register_key === add.from)?.fields.filter((f) => f.type === 'text') ?? [];
  const close = () => { setDlg(null); setErr(null); };
  const run = async (next: RegisterLink[], reason: string) => {
    setErr(null);
    try { await save.mutateAsync({ version: q.data?.version, links: next, reason }); toast(t('links.saved')); close(); } catch (e) { setErr(errText(e, t)); }
  };
  if (q.isError) return null;
  return (
    <div className="card space-y-3 p-4" data-testid="register-links-panel">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-bold">{t('links.title')}</h2>
        {q.data?.can_edit && <button type="button" className="btn ms-auto" data-testid="links-add" onClick={() => { setAdd({ from: '', field: '', to: '', en: '', ar: '' }); setDlg({ k: 'add' }); }}>{t('links.add')}</button>}
      </div>
      <p className="text-sm text-mute">{t('links.note')}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr>{(['from', 'field', 'to', 'enabled', 'validate', 'same_site', 'approved_only'] as const).map((h) => <th key={h} className="p-2 text-start text-mute">{t(`links.${h}`)}</th>)}</tr></thead>
          <tbody>
            {links.map((l, i) => (
              <tr key={`${l.from_register}.${l.field}`} className="border-t border-line" data-testid={`link-row-${l.from_register}-${l.field}`}>
                <td className="p-2">{nameOf(l.from_register)}</td>
                <td className="p-2"><code>{l.field}</code>{l.builtin && <span className="ms-2 rounded bg-surface-2 px-1 text-xs text-mute">{t('links.builtin')}</span>}</td>
                <td className="p-2">{nameOf(l.to_register)}</td>
                {(['enabled', 'validate', 'same_site', 'approved_only'] as const).map((f) => (
                  <td key={f} className="p-2">
                    <input type="checkbox" role="switch" data-testid={`link-${f}-${l.from_register}-${l.field}`} aria-label={`${t(`links.${f}`)} ${l.field}`} disabled={!q.data?.can_edit}
                      checked={f === 'enabled' || f === 'validate' ? l[f] !== false : l[f] === true} onChange={() => setDlg({ k: 'flag', i, flag: f })} />
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
          void run(links.map((l, i) => (i === d.i ? { ...l, [d.flag]: !(d.flag === 'enabled' || d.flag === 'validate' ? l[d.flag] !== false : l[d.flag] === true) } : l)), reason);
        }} />
      <FormDialog inline open={dlg?.k === 'add'} onClose={close} testid="link-add-dialog" title={t('links.add_title')} error={err} busy={save.isPending} disabled={!add.from || !add.field || !add.to}
        onSubmit={(reason) => void run([...links, { from_register: add.from, field: add.field, to_register: add.to, label_en: add.en.trim() || null, label_ar: add.ar.trim() || null, picker: add.to === 'procurement' ? 'order' : 'record', validate: true, same_site: false, approved_only: add.to === 'procurement', enabled: true }], reason)}>
        <select className="input" data-testid="link-add-from" aria-label={t('links.from')} value={add.from} onChange={(e) => setAdd({ ...add, from: e.target.value, field: '' })}>
          <option value="">{t('links.choose')}</option>{regs.map((d) => <option key={d.register_key} value={d.register_key}>{nameOf(d.register_key)}</option>)}
        </select>
        <select className="input" data-testid="link-add-field" aria-label={t('links.field')} value={add.field} onChange={(e) => setAdd({ ...add, field: e.target.value })}>
          <option value="">{t('links.choose')}</option>{textFields.filter((f) => !links.some((l) => l.from_register === add.from && l.field === f.code)).map((f) => <option key={f.code} value={f.code}>{f.label_en} ({f.code})</option>)}
        </select>
        <select className="input" data-testid="link-add-to" aria-label={t('links.to')} value={add.to} onChange={(e) => setAdd({ ...add, to: e.target.value })}>
          <option value="">{t('links.choose')}</option>{regs.map((d) => <option key={d.register_key} value={d.register_key}>{nameOf(d.register_key)}</option>)}
        </select>
        <input className="input" aria-label={t('links.label_en')} placeholder={t('links.label_en')} value={add.en} onChange={(e) => setAdd({ ...add, en: e.target.value })} />
        <input className="input" dir="rtl" aria-label={t('links.label_ar')} placeholder={t('links.label_ar')} value={add.ar} onChange={(e) => setAdd({ ...add, ar: e.target.value })} />
      </FormDialog>
    </div>
  );
}
