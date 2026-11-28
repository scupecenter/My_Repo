import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { useSetStructurePolicy, useStructurePolicy, type StructurePolicy } from '@/api/structureProposals';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';

type Draft = Partial<Pick<StructurePolicy, 'who_proposes' | 'who_approves' | 'two_person' | 'max_items' | 'notify_approvers' | 'notify_proposer'>>;

/**
 * Settings > Registers > Columns (and Data > Edit through templates): the rules of structure changes (setting `registers.structure_change`, contract 0.15.403).
 * Who proposes, who approves, when a second person is required, the most items in one proposal and the two notices. Saving needs a reason (audited) and the step-up.
 */
export function StructurePolicyCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useStructurePolicy();
  const set = useSetStructurePolicy();
  const [d, setD] = useState<Draft>({});
  const [open, setOpen] = useState(false);
  if (!q.data) return <section className="card p-4" data-testid="structp-policy-wait"><QueryFallback queries={[q]} testid="structp-loading" /></section>;
  const cur = q.data;
  const v = { ...cur, ...d };
  const n = Number(v.max_items);
  const invalid = !Number.isInteger(n) || n < 1 || n > 500;
  const dirty = Object.keys(d).length > 0 && !invalid;
  const sel = (k: 'who_proposes' | 'who_approves' | 'two_person', opts: string[]) => (
    <select id={`structp-${k}`} className="input w-auto" data-testid={`structp-${k}`} value={v[k]} disabled={!cur.can_edit} onChange={(e) => setD({ ...d, [k]: e.target.value } as Draft)}>
      {opts.map((o) => <option key={o} value={o}>{t(`structp.${k}_${o}`)}</option>)}
    </select>
  );
  return (
    <section className="card space-y-2 p-4" data-testid="structp-policy">
      <h3 className="font-bold">{t('structp.policy_title')}</h3>
      <p className="text-xs text-mute"><Info size={12} aria-hidden className="inline" /> {t('structp.policy_note')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-2 text-sm" htmlFor="structp-who_proposes">{t('structp.who_proposes')}{sel('who_proposes', ['fields_editors', 'admins'])}</label>
        <label className="flex items-center justify-between gap-2 text-sm" htmlFor="structp-who_approves">{t('structp.who_approves')}{sel('who_approves', ['admins', 'fields_editors'])}</label>
        <label className="flex items-center justify-between gap-2 text-sm" htmlFor="structp-two_person">{t('structp.two_person')}{sel('two_person', ['risky_only', 'always'])}</label>
        <label className="flex items-center justify-between gap-2 text-sm" htmlFor="structp-max">{t('structp.max_items')}
          <input id="structp-max" className="input w-24" type="number" min={1} max={500} dir="ltr" data-testid="structp-max" value={String(v.max_items)} disabled={!cur.can_edit} aria-invalid={invalid}
            onChange={(e) => setD({ ...d, max_items: Number(e.target.value) })} />
        </label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="structp-notify_approvers" checked={v.notify_approvers} disabled={!cur.can_edit} onChange={(e) => setD({ ...d, notify_approvers: e.target.checked })} />{t('structp.notify_approvers')}</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="structp-notify_proposer" checked={v.notify_proposer} disabled={!cur.can_edit} onChange={(e) => setD({ ...d, notify_proposer: e.target.checked })} />{t('structp.notify_proposer')}</label>
      </div>
      <p className="text-xs text-mute">{t('structp.always_note')}</p>
      {invalid && <p role="alert" className="text-sm text-lateInk">{t('importsSettings.range', { min: 1, max: 500 })}</p>}
      {cur.can_edit
        ? <button type="button" className="btn btn-accent" data-testid="structp-save" disabled={!dirty} onClick={() => setOpen(true)}>{t('common.save')}</button>
        : <p className="text-sm text-mute" data-testid="structp-readonly">{t('structp.readonly')}</p>}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="structp-policy-dialog" title={t('structp.policy_title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: cur.version, reason, ...d, ...(d.max_items !== undefined ? { max_items: n } : {}) }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setD({}); } })}>
          <p className="text-sm text-mute">{t('structp.policy_confirm')}</p>
        </FormDialog>
      )}
    </section>
  );
}
