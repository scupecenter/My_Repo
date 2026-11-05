import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useImportsSettings, useSetImportsSettings } from '@/api/settings';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';

const MIN = 10;
const MAX = 500;

/**
 * Settings, Imports / Background processing (contract 0.14.6, migration 0075): the number of rows above which a send or a decision of a batch (New sites, register,
 * stream, and each staged batch of a Master import apply) runs in the background. Every signed-in user sees the value; a System Admin or a delegate of settings edit
 * for all regions changes it, with a reason (audited). The range is 10 to 500 rows, checked here and again by the database.
 */
export function Imports() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useImportsSettings(), set = useSetImportsSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return <p>{q.isError ? t('common.error') : t('common.loading')}</p>;
  const cur = q.data;
  const text = draft ?? String(cur.async_rows);
  const n = Number(text);
  const invalid = !/^[0-9]+$/.test(text.trim()) || n < MIN || n > MAX;
  const dirty = draft !== null && !invalid && n !== cur.async_rows;
  const server = fieldErrors(set.error)['/async_rows'];
  const when = cur.updated_at ? new Date(cur.updated_at).toLocaleString(i18n.language === 'ar' ? 'ar-LY-u-nu-latn' : 'en-GB') : null;
  return (
    <section className="card space-y-3 p-4" data-testid="page-imports-settings">
      <h2 className="font-bold">{t('importsSettings.title')}</h2>
      <p className="text-sm text-mute">{t('importsSettings.note')}</p>
      <div>
        <label htmlFor="imports-async-rows" className="text-sm font-semibold">{t('importsSettings.field')}</label>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input id="imports-async-rows" className="input w-28" type="number" inputMode="numeric" min={MIN} max={MAX} step={1} dir="ltr" data-testid="imports-async-rows"
            value={text} disabled={!cur.can_edit} aria-invalid={invalid} aria-describedby="imports-async-rows-hint" onChange={(e) => setDraft(e.target.value)} />
          <span className="text-sm text-mute">{t('importsSettings.rows')}</span>
        </div>
        <p id="imports-async-rows-hint" className="mt-1 text-xs text-mute" data-testid="imports-async-rows-hint">{t('importsSettings.hint', { min: MIN, max: MAX, def: cur.default_async_rows })}</p>
        {invalid && <p role="alert" className="mt-1 text-sm text-lateInk" data-testid="imports-async-rows-error">{t('importsSettings.range', { min: MIN, max: MAX })}</p>}
        {server && <p role="alert" className="mt-1 text-sm text-lateInk" data-testid="err-async_rows">{t(`fieldError.${server}`, { defaultValue: t('importsSettings.range', { min: MIN, max: MAX }) })}</p>}
      </div>
      <p className="text-sm" data-testid="imports-current">{t('importsSettings.current', { n: cur.async_rows, def: cur.default_async_rows })}</p>
      <p className="text-xs text-mute" data-testid="imports-updated">
        {cur.updated_by && when ? t('importsSettings.updated', { name: cur.updated_by.display_name, id: cur.updated_by.employee_id ?? '', when }) : t('importsSettings.never')}
      </p>
      {cur.can_edit
        ? <button className="btn btn-accent" data-testid="imports-save" disabled={!dirty} onClick={() => setOpen(true)}>{t('common.save')}</button>
        : <p className="text-sm text-mute" data-testid="imports-readonly">{t('importsSettings.readonly')}</p>}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="imports-dialog" title={t('importsSettings.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: cur.version, async_rows: n, reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } })}>
          <p className="text-sm text-mute" data-testid="imports-confirm">{t('importsSettings.confirm', { from: cur.async_rows, to: n })}</p>
        </FormDialog>
      )}
    </section>
  );
}
