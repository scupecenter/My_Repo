import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useRecycleBin, useRestoreRecord, useSetRecycleRetention, type RecycleBinItem } from '@/api/recycleBin';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';

/**
 * Settings > Registers > Recycle bin (contract 0.15.98, System Admin only). The register records that were voided and can still be restored inside the
 * retention window. A restore returns the record to a draft (it goes through the workflow again). Nothing is ever deleted; the retention only decides
 * how long the restore button is offered. Filters: register and a text search on the label, site and reason.
 */
export function RecycleBinScreen() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useRecycleBin();
  const restore = useRestoreRecord();
  const setRet = useSetRecycleRetention();
  const [reg, setReg] = useState('');
  const [text, setText] = useState('');
  const [target, setTarget] = useState<RecycleBinItem | null>(null);
  const [editDays, setEditDays] = useState<string | null>(null);
  const d = q.data;
  if (!d) return <section className="card p-4" data-testid="page-recycle-bin"><QueryFallback queries={[q]} testid="rb-loading" /></section>;
  const ar = i18n.language.startsWith('ar');
  const regs = [...new Map(d.items.map((i) => [i.register_key, ar && i.register_name_ar ? i.register_name_ar : i.register_name_en])).entries()];
  const needle = text.trim().toLowerCase();
  const items = d.items.filter((i) => (!reg || i.register_key === reg) && (!needle || `${i.label} ${i.site_code ?? ''} ${i.void_reason ?? ''}`.toLowerCase().includes(needle)));
  return (
    <section className="card space-y-3 p-4" data-testid="page-recycle-bin">
      <h2 className="font-bold">{t('recycleBin.title')}</h2>
      <p className="text-sm text-mute">{t('recycleBin.note', { days: d.retention_days })}</p>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1">{t('recycleBin.register')}
          <select className="input" value={reg} onChange={(e) => setReg(e.target.value)} data-testid="rb-register"><option value="">{t('recycleBin.all')}</option>{regs.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
        </label>
        <input className="input" placeholder={t('recycleBin.search')} value={text} onChange={(e) => setText(e.target.value)} data-testid="rb-search" />
        <button type="button" className="btn ms-auto" onClick={() => setEditDays(String(d.retention_days))} data-testid="rb-edit-retention">{t('recycleBin.edit_retention')}</button>
      </div>
      {items.length === 0 ? <p className="text-sm text-mute" data-testid="rb-none">{t('recycleBin.none')}</p> : (
        <table className="w-full text-sm" data-testid="rb-table">
          <thead><tr className="text-mute"><th className="text-start">{t('recycleBin.record')}</th><th className="text-start">{t('recycleBin.voided')}</th><th className="text-start">{t('recycleBin.reason')}</th><th className="text-start">{t('recycleBin.until')}</th><th /></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} data-testid={`rb-row-${i.id}`}>
                <td>{i.label}</td>
                <td>{new Date(i.voided_at).toLocaleDateString()}{i.voided_by_name ? ` · ${i.voided_by_name}` : ''}</td>
                <td>{i.void_reason}</td>
                <td>{new Date(i.restorable_until).toLocaleDateString()}</td>
                <td className="text-end">
                  {i.blocked ? <span className="text-warn" data-testid={`rb-blocked-${i.id}`}>{t(`recycleBin.blocked_${i.blocked}`)}</span>
                    : <button type="button" className="btn" onClick={() => setTarget(i)} data-testid={`rb-restore-${i.id}`}>{t('recycleBin.restore')}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-xs text-mute"><Link className="link" to="/audit">{t('recycleBin.audit_link')}</Link></p>
      <FormDialog open={!!target} onClose={() => setTarget(null)} title={t('recycleBin.restore_title', { label: target?.label ?? '' })} testid="rb-restore-dialog"
        busy={restore.isPending} error={restore.error ? errText(restore.error, t) : null} submitLabel={t('recycleBin.restore')}
        onSubmit={(reason) => target && restore.mutate({ id: target.id, version: target.version, reason }, { onSuccess: () => { toast(t('recycleBin.restored')); setTarget(null); } })}>
        <p className="text-sm">{t('recycleBin.restore_note')}</p>
      </FormDialog>
      <FormDialog open={editDays !== null} onClose={() => setEditDays(null)} title={t('recycleBin.edit_retention')} testid="rb-retention-dialog"
        busy={setRet.isPending} error={setRet.error ? errText(setRet.error, t) : null}
        onSubmit={(reason) => setRet.mutate({ version: d.version, retention_days: Number(editDays), reason }, { onSuccess: () => { toast(t('settings.audited')); setEditDays(null); } })}>
        <label className="flex items-center gap-2 text-sm">{t('recycleBin.days')}
          <input className="input w-24" type="number" min={30} max={730} value={editDays ?? ''} onChange={(e) => setEditDays(e.target.value)} data-testid="rb-days" />
        </label>
      </FormDialog>
    </section>
  );
}
