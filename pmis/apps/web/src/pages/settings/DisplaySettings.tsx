import { useState } from 'react';
import { UnsavedGuard } from '@/lib/unsavedGuard';
import { useTranslation } from 'react-i18next';
import { useSaveTableDisplay, useTableDisplaySetting } from '@/api/display';
import { useMe } from '@/api/hooks';
import { errText, FormDialog } from '@/components/FormDialog';
import { canEditDisplayDefaults, displayAttrs } from '@/components/TableStandard';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { DENSITIES, DISPLAY_SEED, type Display } from '@/lib/tablePrefs';
import { FieldErr } from './Calendar';

/**
 * Administration > Settings > Display (W8 item 4, migration 0148): the defaults of the Display menu of every site-data table (text size, alignment of
 * text cells, row density, wrap long text, zebra rows). A user's own choice and a saved view keep their values; the defaults apply where the user has
 * none. Saved by a System Admin or an all-regions delegate of admin.settings, with a reason, If-Match and an audit row (before and after).
 */
export function DisplaySettings() {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useMe(true).data;
  const q = useTableDisplaySetting(), save = useSaveTableDisplay();
  const [f, setF] = useState<Display | null>(null);
  const [open, setOpen] = useState(false);
  const v: Display = f ?? { ...DISPLAY_SEED, ...q.data?.defaults };
  const can = canEditDisplayDefaults(me);
  const errs = fieldErrors(save.error);
  const radio = <T extends string>(name: string, values: readonly T[], cur: T, set: (x: T) => void, label: (x: T) => string) => (
    <fieldset className="space-y-1" disabled={!can}>
      <legend className="text-sm font-semibold">{t(`tstd.display_${name}`)}</legend>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t(`tstd.display_${name}`)}>
        {values.map((x) => <button key={x} type="button" role="radio" aria-checked={cur === x} data-testid={`display-default-${name}-${x}`} onClick={() => set(x)} className={`btn px-2 py-1 text-xs ${cur === x ? 'bg-accentSoft text-accentText' : ''}`}>{label(x)}</button>)}
      </div>
      <FieldErr errs={errs} path={`/defaults/${name}`} />
    </fieldset>
  );
  if (q.isError) return <p role="alert" className="card p-4 text-lateInk" data-testid="display-settings-error">{errText(q.error, t)}</p>;
  if (!q.data) return <p className="text-mute">{t('common.loading')}</p>;
  return (
    <section className="card space-y-4 p-4" data-testid="page-display-settings">
      <div>
        <h2 className="font-bold">{t('tstd.settings_title')}</h2>
        <p className="text-sm text-mute">{t('tstd.settings_note')}</p>
      </div>
      {radio('size', ['sm', 'md', 'lg'] as const, v.size, (x) => setF({ ...v, size: x }), (x) => t(`tstd.size_${x}`))}
      {radio('align', ['start', 'center'] as const, v.align, (x) => setF({ ...v, align: x }), (x) => t(`tstd.align_${x}`))}
      {radio('density', DENSITIES, v.density, (x) => setF({ ...v, density: x }), (x) => t(`table.${x}`))}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!can} data-testid="display-default-wrap" checked={v.wrap} onChange={(e) => setF({ ...v, wrap: e.target.checked })} />{t('tstd.display_wrap')}</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!can} data-testid="display-default-zebra" checked={v.zebra} onChange={(e) => setF({ ...v, zebra: e.target.checked })} />{t('tstd.display_zebra')}</label>
      {/* a small sample drawn with the chosen options */}
      <div className="card gx overflow-hidden" {...displayAttrs(v)} data-testid="display-preview">
        {['TR101', 'MI102', 'WM103'].map((code, i) => (
          <div key={code} role="row" data-zebra={i % 2 ? '1' : '0'} className="gx-row grid grid-cols-[52px_120px_1fr] items-center border-b border-line px-2 py-1 text-sm">
            <span data-col="rowno" className="mono text-end text-mute">{i + 1}</span>
            <span data-col="code" className="mono font-bold">{code}</span>
            <span data-col="name"><span className="block truncate">{t('tstd.preview_name')}</span></span>
          </div>
        ))}
      </div>
      {q.data.updated_by && <p className="text-xs text-mute" data-testid="display-updated">{t('tstd.settings_updated', { name: q.data.updated_by.display_name, at: q.data.updated_at ?? '' })}</p>}
      {can ? (
        <div className="flex gap-2">
          <button type="button" className="btn btn-accent" data-testid="display-save" disabled={!f} onClick={() => setOpen(true)}>{t('common.save')}</button>
          <button type="button" className="btn" data-testid="display-discard" disabled={!f} onClick={() => setF(null)}>{t('common.cancel')}</button>
        </div>
      ) : <p className="text-sm text-mute" data-testid="display-read-only">{t('tstd.settings_read_only')}</p>}
      <UnsavedGuard scope="settings" dirty={!!f} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => save.mutate({ defaults: v, reason, version: q.data.version }, { onSuccess: () => res(true), onError: () => res(false) }))} />
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="display-dialog" title={t('tstd.settings_title')} busy={save.isPending} error={save.isError && !Object.keys(errs).length ? errText(save.error, t) : null}
          onSubmit={(reason) => save.mutate({ defaults: v, reason, version: q.data.version }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setF(null); } })} />
      )}
    </section>
  );
}
