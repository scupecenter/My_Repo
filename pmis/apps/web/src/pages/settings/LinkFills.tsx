import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLinkFills, useSaveLinkFills, type LinkFill } from '@/api/linkFills';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { UnsavedGuard } from '@/lib/unsavedGuard';

/**
 * Settings > Registers > Fill linked records (automation item 9, migration 0772). A rule says: when a record of this register gets its final approval, copy this field of it
 * into that field of the record it links to (a link declared in Register links). Only a linked record still in entry is filled, only an empty field, and every fill is audited;
 * a value a person typed is never overwritten. A rule is hidden, never deleted. Nothing fires until a rule is added here.
 */
export function LinkFills() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useLinkFills(), save = useSaveLinkFills();
  const [rows, setRows] = useState<LinkFill[] | null>(null);
  const [open, setOpen] = useState(false);
  const [n, setN] = useState({ link: '', source_field: '', target_field: '' });
  if (!q.data) return <section className="card p-4" data-testid="page-link-fills"><QueryFallback queries={[q]} testid="lf-loading" /></section>;
  const ar = i18n.language === 'ar';
  const list = rows ?? q.data.rows;
  const can = q.data.can_edit;
  const errs = fieldErrors(save.error);
  const links = q.data.links;
  const lk = (r: string, f: string) => links.find((l) => l.register_key === r && l.link_field === f);
  const lname = (f: { label_en: string; label_ar?: string | null }) => (ar && f.label_ar) || f.label_en;
  const fieldName = (r: string, f: string, side: 'source_fields' | 'target_fields') => { const x = lk(r, f)?.[side]; return x ? x : []; };
  const label = (r: string, lf: string, code: string, side: 'source_fields' | 'target_fields') => { const f = fieldName(r, lf, side).find((x) => x.code === code); return f ? lname(f) : code; };
  const key = (x: { register_key: string; link_field: string; target_field: string }) => `${x.register_key}-${x.link_field}-${x.target_field}`;
  const set = (x: LinkFill, p: Partial<LinkFill>) => setRows(list.map((y) => (key(y) === key(x) ? { ...y, ...p } : y)));
  const body = (reason: string) => ({ version: q.data.version, body: { reason, rows: list } });
  const sel = links.find((l) => `${l.register_key}/${l.link_field}` === n.link);
  const srcType = sel?.source_fields.find((f) => f.code === n.source_field)?.field_type;
  const targets = (sel?.target_fields ?? []).filter((f) => !srcType || f.field_type === srcType);
  const addable = !!sel && !!n.source_field && !!n.target_field && !list.some((x) => key(x) === `${sel.register_key}-${sel.link_field}-${n.target_field}`);
  return (
    <section className="card space-y-3 p-4" data-testid="page-link-fills">
      <h2 className="font-bold">{t('linkFills.title')}</h2>
      <p className="text-sm text-mute">{t('linkFills.note')}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr><th className="text-start">{t('linkFills.from')}</th><th className="text-start">{t('linkFills.link')}</th><th className="text-start">{t('linkFills.to')}</th><th className="text-start">{t('companyDocs.shown')}</th></tr></thead>
          <tbody>
            {list.map((x) => (
              <tr key={key(x)} data-testid={`lf-row-${key(x)}`} className={x.is_active ? '' : 'opacity-60'}>
                <td>{x.register_key}: {label(x.register_key, x.link_field, x.source_field, 'source_fields')}</td>
                <td className="text-mute">{x.link_field} &rarr; {lk(x.register_key, x.link_field)?.target_register ?? ''}</td>
                <td>{label(x.register_key, x.link_field, x.target_field, 'target_fields')}</td>
                <td><input type="checkbox" disabled={!can} data-testid={`lf-active-${key(x)}`} checked={x.is_active} onChange={(e) => set(x, { is_active: e.target.checked })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && <p className="p-2 text-sm text-mute" data-testid="lf-empty">{t('linkFills.empty')}</p>}
      </div>
      {can && (
        <div className="flex flex-wrap items-end gap-2" role="group" aria-label={t('linkFills.add_title')}>
          <label className="text-sm font-semibold">{t('linkFills.link')}
            <select className="input mt-1 font-normal" data-testid="lf-new-link" value={n.link} onChange={(e) => setN({ link: e.target.value, source_field: '', target_field: '' })}>
              <option value="">{t('taskSrc.pick')}</option>
              {links.map((l) => <option key={`${l.register_key}/${l.link_field}`} value={`${l.register_key}/${l.link_field}`}>{l.register_key}.{l.link_field} &rarr; {l.target_register}</option>)}
            </select></label>
          <label className="text-sm font-semibold">{t('linkFills.from')}
            <select className="input mt-1 font-normal" data-testid="lf-new-source" value={n.source_field} onChange={(e) => setN({ ...n, source_field: e.target.value, target_field: '' })}>
              <option value="">{t('taskSrc.pick')}</option>
              {(sel?.source_fields ?? []).map((f) => <option key={f.code} value={f.code}>{lname(f)}</option>)}
            </select></label>
          <label className="text-sm font-semibold">{t('linkFills.to')}
            <select className="input mt-1 font-normal" data-testid="lf-new-target" value={n.target_field} onChange={(e) => setN({ ...n, target_field: e.target.value })}>
              <option value="">{t('taskSrc.pick')}</option>
              {targets.map((f) => <option key={f.code} value={f.code}>{lname(f)}</option>)}
            </select></label>
          <button className="btn" data-testid="lf-new-add" disabled={!addable}
            onClick={() => {
              if (!sel) return;
              setRows([...list, { register_key: sel.register_key, link_field: sel.link_field, source_field: n.source_field, target_field: n.target_field, sort_order: 0, is_active: true }]);
              setN({ link: '', source_field: '', target_field: '' });
            }}>{t('companyDocs.add')}</button>
        </div>
      )}
      {Object.entries(errs).map(([p, c]) => <p key={p} role="alert" className="text-xs text-lateInk">{p}: {t(`fieldError.${c}`, { defaultValue: c })}</p>)}
      <p className="mono text-xs text-mute" data-testid="lf-version">{t('scopeMatch.version', { version: q.data.version })}</p>
      <button className="btn btn-accent" data-testid="lf-save" disabled={!can || !rows} onClick={() => setOpen(true)}>{t('common.save')}</button>
      <UnsavedGuard scope="settings" dirty={!!rows} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => save.mutate(body(reason), { onSuccess: () => res(true), onError: () => res(false) }))} />
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="lf-dialog" title={t('linkFills.title')} busy={save.isPending} error={save.isError && !Object.keys(errs).length ? errText(save.error, t) : null}
          onSubmit={(reason) => save.mutate(body(reason), { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setRows(null); } })} />
      )}
    </section>
  );
}
