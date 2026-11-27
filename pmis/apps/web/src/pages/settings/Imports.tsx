import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useImportsSettings, useImportsUploadPolicy, useSetImportsSettings, useSetImportsUploadPolicy, useSetTemplateNoticeSettings, useTemplateNoticeSettings, type ImportsUploadPolicy } from '@/api/settings';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { QueryFallback } from '@/components/States';

const MIN = 10;
const MAX = 500;

/**
 * Settings, Imports / Background processing (contract 0.14.6, migration 0075): the number of rows above which a send or a decision of a batch (New sites, register,
 * stream, and each staged batch of a Master import apply) runs in the background. Every signed-in user sees the value; a System Admin or a delegate of settings edit
 * for all regions changes it, with a reason (audited). The range is 10 to 500 rows, checked here and again by the database.
 */
export function Imports() {
  return (
    <div className="space-y-4">
      <ImportsThreshold />
      <UploadPolicy />
    </div>
  );
}

/**
 * Settings, Imports / Upload policy (contract 0.15.322, migration 0492, D49 part 3): what the Master import apply does with incomplete data. Enforce (default) changes
 * nothing; Accept incomplete opens the sites of the file first (unlock right, reason, step-up, audited). Only the modes the server enforces are offered.
 */
function UploadPolicy() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useImportsUploadPolicy(), set = useSetImportsUploadPolicy();
  const [draft, setDraft] = useState<ImportsUploadPolicy['policy'] | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return <QueryFallback queries={[q]} testid="upload-policy-loading" />;
  const cur = q.data;
  const pick = draft ?? cur.policy;
  const dirty = pick !== cur.policy;
  return (
    <section className="card space-y-3 p-4" data-testid="page-upload-policy">
      <h2 className="font-bold">{t('importsSettings.policy_title')}</h2>
      <p className="text-sm text-mute">{t('importsSettings.policy_note')}</p>
      <fieldset className="space-y-2" disabled={!cur.can_edit}>
        {cur.policies.map((p) => (
          <label key={p} className="flex items-start gap-2 text-sm">
            <input type="radio" name="upload-policy" className="mt-1" data-testid={`upload-policy-${p}`} checked={pick === p} onChange={() => setDraft(p)} />
            <span><span className="font-semibold">{t(`importsSettings.policy_${p}`)}</span><br /><span className="text-mute">{t(`importsSettings.policy_${p}_hint`)}</span></span>
          </label>
        ))}
      </fieldset>
      <p className="text-sm" data-testid="upload-policy-current">{t('importsSettings.policy_current', { policy: t(`importsSettings.policy_${cur.policy}`) })}</p>
      {cur.can_edit
        ? <button className="btn btn-accent" data-testid="upload-policy-save" disabled={!dirty} onClick={() => setOpen(true)}>{t('importsSettings.policy_save')}</button>
        : <p className="text-sm text-mute" data-testid="upload-policy-readonly">{t('importsSettings.readonly')}</p>}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="upload-policy-dialog" title={t('importsSettings.policy_title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: cur.version, policy: pick, reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } })}>
          <p className="text-sm text-mute" data-testid="upload-policy-confirm">{t('importsSettings.policy_confirm', { from: t(`importsSettings.policy_${cur.policy}`), to: t(`importsSettings.policy_${pick}`) })}</p>
        </FormDialog>
      )}
    </section>
  );
}

function ImportsThreshold() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useImportsSettings(), set = useSetImportsSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return <QueryFallback queries={[q]} testid="imports-loading" />;
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

/** P3 (migration 0367): the notice of a new template version. On or off, and how many days after the version is issued people are still told. Audited, with a reason. */
export function TemplateNoticeCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useTemplateNoticeSettings(), set = useSetTemplateNoticeSettings();
  const [on, setOn] = useState<boolean | null>(null);
  const [days, setDays] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return <QueryFallback queries={[q]} testid="tplnotice-loading" />;
  const cur = q.data;
  const enabled = on ?? cur.enabled;
  const text = days ?? String(cur.days);
  const n = Number(text);
  const invalid = !/^[0-9]+$/.test(text.trim()) || n < cur.min || n > cur.max;
  const dirty = (on !== null || days !== null) && !invalid && (enabled !== cur.enabled || n !== cur.days);
  return (
    <section className="card mt-4 space-y-3 p-4" data-testid="page-tplnotice-settings">
      <h2 className="font-bold">{t('tplNoticeSettings.title')}</h2>
      <p className="text-sm text-mute">{t('tplNoticeSettings.note')}</p>
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" data-testid="tplnotice-enabled" checked={enabled} disabled={!cur.can_edit} onChange={(e) => setOn(e.target.checked)} />
        {t('tplNoticeSettings.enabled')}
      </label>
      <div>
        <label htmlFor="tplnotice-days" className="text-sm font-semibold">{t('tplNoticeSettings.days')}</label>
        <div className="mt-1 flex items-center gap-2">
          <input id="tplnotice-days" className="input w-24" type="number" min={cur.min} max={cur.max} step={1} dir="ltr" data-testid="tplnotice-days" value={text} disabled={!cur.can_edit || !enabled}
            aria-invalid={invalid} onChange={(e) => setDays(e.target.value)} />
          <span className="text-sm text-mute">{t('tplNoticeSettings.unit')}</span>
        </div>
        <p className="mt-1 text-xs text-mute">{t('tplNoticeSettings.hint', { min: cur.min, max: cur.max, def: cur.default_days })}</p>
        {invalid && <p role="alert" className="mt-1 text-sm text-lateInk" data-testid="tplnotice-error">{t('importsSettings.range', { min: cur.min, max: cur.max })}</p>}
      </div>
      {cur.can_edit
        ? <button className="btn btn-accent" data-testid="tplnotice-save" disabled={!dirty} onClick={() => setOpen(true)}>{t('common.save')}</button>
        : <p className="text-sm text-mute" data-testid="tplnotice-readonly">{t('importsSettings.readonly')}</p>}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="tplnotice-dialog" title={t('tplNoticeSettings.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: cur.version, enabled, days: n, reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setOn(null); setDays(null); } })}>
          <p className="text-sm text-mute">{t('tplNoticeSettings.confirm', { state: enabled ? t('tplNoticeSettings.on') : t('tplNoticeSettings.off'), days: n })}</p>
        </FormDialog>
      )}
    </section>
  );
}
