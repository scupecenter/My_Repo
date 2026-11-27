import { UnsavedGuard } from '@/lib/unsavedGuard';
import { Gauge } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOpsLimits, useSetOpsLimits } from '@/api/settings';
import type { OpsLimitItem } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { Tip } from '@/components/Tip';
import { useToast } from '@/components/Toast';
import { fmtDateTime } from '@/lib/time';

const GROUPS = ['sessions', 'rows', 'exports'] as const;
const id = (key: string): string => key.replace(/\./g, '_');

/**
 * Settings, Security, Limits (migration 0402, contract 0.15.312): the numbers that used to sit in the code, in three groups. Everyone reads them; only a System Admin
 * changes them, with a reason and a step-up, and the change is audited. Every default is the number the system used before. A field that equals its default is
 * not stored, so "back to default" is just typing the default (or the button beside the field).
 */
export function OpsLimits() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useOpsLimits(), set = useSetOpsLimits();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  if (!q.data) return <QueryFallback queries={[q]} testid="oplimits-loading" />;
  const cur = q.data;
  const ro = !cur.can_edit;
  const ar = i18n.language === 'ar';
  const text = (i: OpsLimitItem): string => draft[i.key] ?? String(i.value);
  const num = (i: OpsLimitItem): number | null => { const s = text(i).trim(); return /^\d+$/.test(s) ? Number(s) : null; };
  const bad = (i: OpsLimitItem): boolean => { const n = num(i); return n === null || n < i.min || n > i.max; };
  const get = (k: string): OpsLimitItem => cur.items.find((i) => i.key === k)!;
  const sessionBad = !bad(get('session.idle_hours')) && !bad(get('session.absolute_hours')) && num(get('session.absolute_hours'))! < num(get('session.idle_hours'))!;
  const dirty = cur.items.some((i) => num(i) !== i.value);
  const invalid = cur.items.some(bad) || sessionBad;
  const values = (): Record<string, number> => Object.fromEntries(cur.items.filter((i) => num(i) !== i.default).map((i) => [i.key, num(i)!]));
  const changed = Object.keys(values()).length;
  const unit = (i: OpsLimitItem): string => t(`oplimits.unit_${i.unit}`);
  return (
    <section className="card space-y-5 p-4" data-testid="page-ops-limits">
      <div>
        <h2 className="flex items-center gap-2 font-bold"><Gauge size={16} aria-hidden />{t('oplimits.title')}</h2>
        <p className="text-sm text-mute">{t('oplimits.note')}</p>
      </div>
      {GROUPS.map((g) => (
        <fieldset key={g} className="space-y-3" data-testid={`oplimits-group-${g}`}>
          <legend className="mb-1 text-sm font-semibold">{t(`oplimits.group_${g}`)}</legend>
          {cur.items.filter((i) => i.group === g).map((i) => {
            const isCustom = num(i) !== i.default;
            return (
              <div key={i.key} className="grid gap-1 sm:grid-cols-[minmax(0,18rem)_1fr] sm:items-start sm:gap-4">
                <label htmlFor={`oplimits-${id(i.key)}`} className="text-sm font-medium">
                  <Tip text={t(`oplimits.${id(i.key)}_hint`)}><span className="cursor-help border-b border-dotted border-mute">{t(`oplimits.${id(i.key)}`)}</span></Tip>
                  {isCustom && <span className="chip ms-2 bg-state-locked-bg text-state-locked-fg" data-testid={`oplimits-${id(i.key)}-custom`}>{t('oplimits.custom')}</span>}
                </label>
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <input id={`oplimits-${id(i.key)}`} type="text" inputMode="numeric" dir="ltr" className="input w-32 text-end" data-testid={`oplimits-${id(i.key)}`}
                      value={text(i)} disabled={ro} aria-invalid={bad(i)} onChange={(e) => setDraft({ ...draft, [i.key]: e.target.value })} />
                    <span className="text-sm text-mute">{unit(i)}</span>
                    {!ro && isCustom && <button type="button" className="btn px-2 py-1 text-xs" data-testid={`oplimits-${id(i.key)}-reset`} onClick={() => setDraft({ ...draft, [i.key]: String(i.default) })}>{t('oplimits.reset')}</button>}
                  </div>
                  <p className="text-xs text-mute">{t(`oplimits.${id(i.key)}_hint`)} {t('oplimits.default', { value: i.default, unit: unit(i) })}. {t('oplimits.range', { min: i.min, max: i.max })}.</p>
                  {bad(i) && <p className="text-xs text-danger" role="alert" data-testid={`oplimits-${id(i.key)}-error`}>{t('oplimits.bad_value', { min: i.min, max: i.max })}</p>}
                </div>
              </div>
            );
          })}
        </fieldset>
      ))}
      {sessionBad && <p className="text-sm text-danger" role="alert" data-testid="oplimits-session-error">{t('oplimits.bad_session')}</p>}
      <p className="text-xs text-mute" data-testid="oplimits-updated">
        {cur.updated_by && cur.updated_at ? t('oplimits.updated', { name: cur.updated_by.display_name, when: fmtDateTime(cur.updated_at, ar ? 'ar' : 'en') }) : t('oplimits.never')}
      </p>
      {!ro && (
        <UnsavedGuard scope="settings" dirty={dirty && !invalid} needsReason label={t('ui.guard_settings')}
          onSave={(reason) => new Promise<boolean>((res) => set.mutate({ version: cur.version, values: values(), reason }, { onSuccess: () => { setDraft({}); res(true); }, onError: () => res(false) }))} />
      )}
      {ro
        ? <p className="text-sm text-mute" data-testid="oplimits-readonly">{t('oplimits.readonly')}</p>
        : (
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-accent" data-testid="oplimits-save" disabled={!dirty || invalid} onClick={() => setOpen(true)}>{t('common.save')}</button>
            <button className="btn" data-testid="oplimits-reset-all" onClick={() => setDraft(Object.fromEntries(cur.items.map((i) => [i.key, String(i.default)])))}>{t('oplimits.reset_all')}</button>
          </div>
        )}
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="oplimits-dialog" title={t('oplimits.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: cur.version, values: values(), reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft({}); } })}>
          <p className="text-sm text-mute" data-testid="oplimits-confirm">{changed === 0 ? t('oplimits.confirm_default') : t('oplimits.confirm', { count: changed })}</p>
        </FormDialog>
      )}
    </section>
  );
}
