import { ArrowDown, ArrowUp } from 'lucide-react';
import { UnsavedGuard } from '@/lib/unsavedGuard';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDailyPlanSettings, useSetDailyPlanSettings, type DailyPlanColumn, type DailyPlanSettings as Cfg } from '@/api/dailyPlan';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/lib/fields';
import { FieldErr } from './Calendar';

type Tab = 'progress' | 'tomorrow';
interface Form { progress: DailyPlanColumn[]; tomorrow: DailyPlanColumn[]; scope: 'mine' | 'all'; lock: string; hour: string }
const toForm = (c: Cfg): Form => ({
  progress: [...c.columns.progress], tomorrow: [...c.columns.tomorrow], scope: c.default_region_scope, lock: c.auto_lock_time ?? '', hour: c.reminder_hour === null || c.reminder_hour === undefined ? '' : String(c.reminder_hour),
});

/** The visible columns of one tab and their order: a checkbox per known column, up and down for the shown ones. Site ID is always shown. */
function Columns({ tab, f, setF, known, errs }: { tab: Tab; f: Form; setF: (f: Form) => void; known: DailyPlanColumn[]; errs: Record<string, string> }) {
  const { t } = useTranslation();
  const shown = f[tab];
  const rest = known.filter((k) => !shown.includes(k));
  const set = (cols: DailyPlanColumn[]) => setF({ ...f, [tab]: cols });
  const move = (i: number, d: -1 | 1) => { const n = [...shown]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j]!, n[i]!]; set(n); };
  return (
    <fieldset className="card space-y-2 p-3" data-testid={`dps-columns-${tab}`}>
      <legend className="px-1 font-semibold">{t(`dailyPlan.tab_${tab}`)}</legend>
      <ol className="space-y-1">
        {shown.map((c, i) => (
          <li key={c} className="flex items-center gap-2 text-sm" data-testid={`dps-col-${tab}-${c}`}>
            <input type="checkbox" checked disabled={c === 'site_code'} aria-label={t(`dailyPlan.col.${c}`)} data-testid={`dps-toggle-${tab}-${c}`} onChange={() => set(shown.filter((x) => x !== c))} />
            <span className="flex-1">{t(`dailyPlan.col.${c}`)}</span>
            <button type="button" className="btn px-1.5 py-0.5" aria-label={t('dailyPlanSettings.move_up', { col: t(`dailyPlan.col.${c}`) })} data-testid={`dps-up-${tab}-${c}`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={12} aria-hidden /></button>
            <button type="button" className="btn px-1.5 py-0.5" aria-label={t('dailyPlanSettings.move_down', { col: t(`dailyPlan.col.${c}`) })} data-testid={`dps-down-${tab}-${c}`} disabled={i === shown.length - 1} onClick={() => move(i, 1)}><ArrowDown size={12} aria-hidden /></button>
          </li>
        ))}
      </ol>
      {rest.length > 0 && (
        <ul className="space-y-1 border-t border-line pt-2">
          {rest.map((c) => (
            <li key={c} className="flex items-center gap-2 text-sm text-mute">
              <input type="checkbox" checked={false} aria-label={t(`dailyPlan.col.${c}`)} data-testid={`dps-toggle-${tab}-${c}`} onChange={() => set([...shown, c])} />{t(`dailyPlan.col.${c}`)}
            </li>
          ))}
        </ul>
      )}
      <FieldErr errs={errs} path={`/columns/${tab}`} />
    </fieldset>
  );
}

/** Settings > My Work > Daily Plan (plan W7, owner decision 7): visible columns and order, default region scope, automatic lock time, reminder hour. */
export function DailyPlanSettings() {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useDailyPlanSettings(), set = useSetDailyPlanSettings();
  const [form, setForm] = useState<Form | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return <p className="text-mute" data-testid="dps-loading">{q.isError ? errText(q.error, t) : t('common.loading')}</p>;
  const f = form ?? toForm(q.data);
  const errs = fieldErrors(set.error);
  const known = q.data.known_columns;
  return (
    <section className="space-y-4" data-testid="page-daily-plan-settings">
      <div className="card space-y-1 p-4">
        <h2 className="font-bold">{t('dailyPlanSettings.title')}</h2>
        <p className="text-sm text-mute">{t('dailyPlanSettings.note')}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Columns tab="progress" f={f} setF={setForm} known={known} errs={errs} />
        <Columns tab="tomorrow" f={f} setF={setForm} known={known} errs={errs} />
      </div>
      <div className="card grid gap-3 p-4 sm:grid-cols-3">
        <label className="text-sm font-semibold">{t('dailyPlanSettings.scope')}
          <select className="input mt-1 font-normal" data-testid="dps-scope" value={f.scope} onChange={(e) => setForm({ ...f, scope: e.target.value as Form['scope'] })}>
            <option value="mine">{t('dailyPlanSettings.scope_mine')}</option>
            <option value="all">{t('dailyPlanSettings.scope_all')}</option>
          </select>
          <FieldErr errs={errs} path="/default_region_scope" />
        </label>
        <label className="text-sm font-semibold">{t('dailyPlanSettings.lock_time')}
          <input type="time" className="input mt-1 font-normal" data-testid="dps-lock" value={f.lock} onChange={(e) => setForm({ ...f, lock: e.target.value })} />
          <span className="text-xs font-normal text-mute">{t('dailyPlanSettings.lock_time_hint')}</span>
          <FieldErr errs={errs} path="/auto_lock_time" />
        </label>
        <label className="text-sm font-semibold">{t('dailyPlanSettings.reminder')}
          <select className="input mt-1 font-normal" data-testid="dps-hour" value={f.hour} onChange={(e) => setForm({ ...f, hour: e.target.value })}>
            <option value="">{t('dailyPlanSettings.no_reminder')}</option>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={String(h)}>{`${String(h).padStart(2, '0')}:00`}</option>)}
          </select>
          <span className="text-xs font-normal text-mute">{t('dailyPlanSettings.reminder_hint')}</span>
          <FieldErr errs={errs} path="/reminder_hour" />
        </label>
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn btn-accent" data-testid="dps-save" onClick={() => setOpen(true)}>{t('common.save')}</button>
        <button type="button" className="btn" data-testid="dps-defaults" onClick={() => setForm({ ...f, progress: [...q.data.default_columns.progress!], tomorrow: [...q.data.default_columns.tomorrow!] })}>{t('dailyPlanSettings.defaults')}</button>
      </div>
      <UnsavedGuard scope="settings" dirty={!!form} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => set.mutate({ version: q.data.version, reason, columns: { progress: f.progress, tomorrow: f.tomorrow }, default_region_scope: f.scope, auto_lock_time: f.lock || null, reminder_hour: f.hour === '' ? null : Number(f.hour) }, { onSuccess: () => res(true), onError: () => res(false) }))} />
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="dps-dialog" title={t('dailyPlanSettings.title')} busy={set.isPending} error={set.isError && !Object.keys(errs).length ? errText(set.error, t) : null}
          onSubmit={(reason) => set.mutate({ version: q.data.version, reason, columns: { progress: f.progress, tomorrow: f.tomorrow }, default_region_scope: f.scope,
            auto_lock_time: f.lock || null, reminder_hour: f.hour === '' ? null : Number(f.hour) }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setForm(null); }, onError: () => setOpen(false) })} />
      )}
    </section>
  );
}
