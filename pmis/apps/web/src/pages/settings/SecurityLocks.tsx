import { Lock } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSecurityLocks, useSetSecurityLocks } from '@/api/settings';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { fmtDateTime } from '@/lib/time';

type Draft = { sharing: boolean; exporting: boolean };

/**
 * Settings, Security, Lock keys (migration 0290, contract 0.15.190): two switches a System Admin turns on to make the system safer in one step. Both are off by default.
 * "Block public sharing" stops any feature from creating a public link; "Disable export" refuses every export and file download of data. Everyone reads the state;
 * only a System Admin changes it, with a reason and a step-up, and the change is audited. Turning a lock off is as easy as turning it on.
 */
export function SecurityLocks() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useSecurityLocks(), set = useSetSecurityLocks();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return <QueryFallback queries={[q]} testid="locks-loading" />;
  const cur = q.data;
  const v = draft ?? { sharing: cur.block_public_sharing, exporting: cur.disable_export };
  const dirty = v.sharing !== cur.block_public_sharing || v.exporting !== cur.disable_export;
  const ro = !cur.can_edit;
  const ar = i18n.language === 'ar';
  const rows: { key: keyof Draft; id: string; on: boolean }[] = [
    { key: 'sharing', id: 'sharing', on: v.sharing },
    { key: 'exporting', id: 'export', on: v.exporting },
  ];
  return (
    <section className="card space-y-4 p-4" data-testid="page-security-locks">
      <div>
        <h2 className="flex items-center gap-2 font-bold"><Lock size={16} aria-hidden />{t('seclocks.title')}</h2>
        <p className="text-sm text-mute">{t('seclocks.note')}</p>
      </div>
      <div className="space-y-3">
        {rows.map((r) => (
          <label key={r.id} className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" data-testid={`locks-${r.id}`} checked={r.on} disabled={ro} onChange={(e) => setDraft({ ...v, [r.key]: e.target.checked })} />
            <span>
              <span className="font-semibold">{t(`seclocks.${r.id}`)}</span>
              {(r.key === 'sharing' ? cur.block_public_sharing : cur.disable_export) && <span className="chip ms-2 bg-state-locked-bg text-state-locked-fg" data-testid={`locks-${r.id}-in-force`}>{t('seclocks.in_force')}</span>}
              <span className="block text-xs text-mute">{t(`seclocks.${r.id}_note`)}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs text-mute" data-testid="locks-updated">
        {cur.updated_by && cur.updated_at ? t('seclocks.updated', { name: cur.updated_by.display_name, when: fmtDateTime(cur.updated_at, ar ? 'ar' : 'en') }) : t('seclocks.never')}
      </p>
      {ro
        ? <p className="text-sm text-mute" data-testid="locks-readonly">{t('seclocks.readonly')}</p>
        : <button className="btn btn-accent" data-testid="locks-save" disabled={!dirty} onClick={() => setOpen(true)}>{t('common.save')}</button>}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="locks-dialog" title={t('seclocks.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: cur.version, block_public_sharing: v.sharing, disable_export: v.exporting, reason },
            { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } })}>
          <p className="text-sm text-mute" data-testid="locks-confirm">
            {t('seclocks.confirm', { sharing: t(v.sharing ? 'locks.on' : 'locks.off'), exporting: t(v.exporting ? 'locks.on' : 'locks.off') })}
          </p>
        </FormDialog>
      )}
    </section>
  );
}
