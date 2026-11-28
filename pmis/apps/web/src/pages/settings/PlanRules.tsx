import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePlanRules, useSetPlanRules } from '@/api/planDates';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { UnsavedGuard } from '@/lib/unsavedGuard';

/**
 * Settings, SLA and time, Planned dates (A4, contract 0.15.463, migration 0603): how a planned date is proposed for a task. The start is the latest date of its
 * predecessors (actual, else planned, else their own proposal when the cascade is on); the proposal adds the SLA maximum (or minimum) working days of the task on
 * the calendar of its rule. Nothing changes until the engineer confirms on the site. The setting is `plan.rules`; it has its own save, reason and audit row.
 */
export function PlanRules() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = usePlanRules();
  const set = useSetPlanRules();
  const [draft, setDraft] = useState<{ enabled: boolean; basis: 'max' | 'min'; cascade: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return <fieldset className="rounded-md border border-line p-3"><QueryFallback queries={[q]} testid="plan-rules-loading" /></fieldset>;
  const s = q.data;
  const cur = draft ?? { enabled: s.enabled, basis: s.basis, cascade: s.cascade };
  const changed = cur.enabled !== s.enabled || cur.basis !== s.basis || cur.cascade !== s.cascade;
  const save = (reason: string, done: (ok: boolean) => void) =>
    set.mutate({ version: s.version, body: { ...cur, reason } }, { onSuccess: () => done(true), onError: () => done(false) });
  return (
    <fieldset className="space-y-3 rounded-md border border-line p-3" data-testid="plan-rules">
      <legend className="px-1 text-sm font-semibold">{t('planRules.title')}</legend>
      <p className="text-xs text-mute">{t('planRules.note')}</p>
      <p className="mono text-xs text-mute" data-testid="plan-rules-version">{t('scopeMatch.version', { version: s.version })}</p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" data-testid="plan-rules-enabled" checked={cur.enabled} onChange={(e) => setDraft({ ...cur, enabled: e.target.checked })} />
        {t('planRules.enabled')}
      </label>
      <label className="block text-sm">
        {t('planRules.basis')}
        <select className="input mt-1 block w-72" data-testid="plan-rules-basis" value={cur.basis} onChange={(e) => setDraft({ ...cur, basis: e.target.value as 'max' | 'min' })}>
          <option value="max">{t('planRules.basis_max')}</option>
          <option value="min">{t('planRules.basis_min')}</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" data-testid="plan-rules-cascade" checked={cur.cascade} onChange={(e) => setDraft({ ...cur, cascade: e.target.checked })} />
        {t('planRules.cascade')}
      </label>
      <UnsavedGuard scope="settings" dirty={!!draft && changed} needsReason label={t('ui.guard_settings')}
        onSave={(reason) => new Promise<boolean>((res) => save(reason, (ok) => { if (ok) setDraft(null); res(ok); }))} />
      <button className="btn btn-accent" data-testid="plan-rules-save" disabled={!draft || !changed} onClick={() => setOpen(true)}>{t('scopeMatch.save')}</button>
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="plan-rules-dialog" title={t('planRules.title')} busy={set.isPending}
          error={set.isError ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: s.version, body: { ...cur, reason } }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } })} />
      )}
    </fieldset>
  );
}
