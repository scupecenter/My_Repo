import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCapacitySettings, useSetCapacitySettings } from '@/api/settings';
import { useRegions } from '@/api/sites';
import type { CapacityPlanSettings } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { QueryFallback } from '@/components/States';
import { useToast } from '@/components/Toast';
import { fmtDateTime } from '@/lib/time';
import { UnsavedGuard } from '@/lib/unsavedGuard';

type Draft = Pick<CapacityPlanSettings, 'skills' | 'crews' | 'efforts' | 'days_per_week' | 'utilization_pct' | 'horizon_weeks'>;

const clean = (d: Draft): Draft => ({
  ...d,
  skills: d.skills.map((s) => ({ code: s.code.trim(), name_en: s.name_en.trim(), name_ar: s.name_ar.trim() })),
  crews: d.crews.map((c) => ({ ...c, id: c.id.trim(), name: c.name.trim() })),
  efforts: d.efforts.map((e) => ({ ...e, task_code: e.task_code.trim() })),
});
const CODE = /^[a-z0-9_]{2,30}$/;

/**
 * Settings > Screens > Capacity planning (migration 0666, contract 0.15.595): the skills, the crews of each region with their skills, the
 * person-days one task of each definition needs, and the working-week parameters the /capacity page computes from. A System Admin or a
 * delegate of settings edit for all regions saves it with a reason and a step-up (audited).
 */
export function CapacitySettings() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const q = useCapacitySettings(), set = useSetCapacitySettings(), regions = useRegions();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState(false);
  if (!q.data) return <QueryFallback queries={[q]} testid="capset-loading" />;
  const cur = q.data;
  const base: Draft = { skills: cur.skills, crews: cur.crews, efforts: cur.efforts, days_per_week: cur.days_per_week, utilization_pct: cur.utilization_pct, horizon_weeks: cur.horizon_weeks };
  const v = draft ?? base;
  const dirty = JSON.stringify(clean(v)) !== JSON.stringify(clean(base));
  const ro = !cur.can_edit;
  const ar = i18n.language === 'ar';
  const patch = (p: Partial<Draft>) => setDraft({ ...v, ...p });
  const skillCodes = v.skills.map((s) => s.code.trim());
  const dupSkill = new Set(skillCodes).size !== skillCodes.length;
  const crewIds = v.crews.map((c) => c.id.trim());
  const taskCodes = v.efforts.map((e) => e.task_code.trim());
  const ok = v.skills.every((s) => CODE.test(s.code.trim()) && s.name_en.trim()) && !dupSkill
    && v.crews.every((c) => c.id.trim() && c.name.trim() && c.size >= 1 && c.skills.every((s) => skillCodes.includes(s))) && new Set(crewIds).size === crewIds.length
    && v.efforts.every((e) => e.task_code.trim() && skillCodes.includes(e.skill) && e.person_days > 0 && e.person_days <= 365) && new Set(taskCodes).size === taskCodes.length;
  const setSkill = (i: number, p: Partial<Draft['skills'][number]>) => patch({ skills: v.skills.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  const setCrew = (i: number, p: Partial<Draft['crews'][number]>) => patch({ crews: v.crews.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const setEffort = (i: number, p: Partial<Draft['efforts'][number]>) => patch({ efforts: v.efforts.map((e, j) => (j === i ? { ...e, ...p } : e)) });
  const num = (s: string) => (s === '' || Number.isNaN(Number(s)) ? 0 : Number(s));
  const save = (reason: string) => set.mutate({ version: cur.version, ...clean(v), reason }, { onSuccess: () => { toast(t('settings.audited')); setOpen(false); setDraft(null); } });
  return (
    <section className="card space-y-5 p-4" data-testid="page-capacity-settings">
      <div>
        <h2 className="font-bold">{t('capset.title')}</h2>
        <p className="text-sm text-mute">{t('capset.note')}</p>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">{t('capset.week')}</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-semibold text-mute">{t('capset.days_per_week')}
            <input type="number" min={1} max={7} className="input mt-1 w-full" data-testid="capset-days" disabled={ro} title={t('capset.days_tip')} value={v.days_per_week} onChange={(e) => patch({ days_per_week: num(e.target.value) })} />
          </label>
          <label className="text-xs font-semibold text-mute">{t('capset.utilization')}
            <input type="number" min={10} max={100} className="input mt-1 w-full" data-testid="capset-util" disabled={ro} title={t('capset.util_tip')} value={v.utilization_pct} onChange={(e) => patch({ utilization_pct: num(e.target.value) })} />
          </label>
          <label className="text-xs font-semibold text-mute">{t('capset.horizon')}
            <input type="number" min={1} max={26} className="input mt-1 w-full" data-testid="capset-horizon" disabled={ro} title={t('capset.horizon_tip')} value={v.horizon_weeks} onChange={(e) => patch({ horizon_weeks: num(e.target.value) })} />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-sm font-semibold">{t('capset.skills')}</legend>
        <p className="mb-2 text-xs text-mute">{t('capset.skills_note')}</p>
        <div className="space-y-2">
          {v.skills.map((s, i) => (
            <div key={i} className="grid gap-2 rounded-md border border-line p-2 sm:grid-cols-[1fr_1fr_1fr_auto]" data-testid={`capset-skill-${i}`}>
              <input className="input" dir="ltr" maxLength={30} placeholder={t('capset.skill_code')} aria-label={t('capset.skill_code')} data-testid={`capset-skill-${i}-code`} disabled={ro} value={s.code} onChange={(e) => setSkill(i, { code: e.target.value })} />
              <input className="input" dir="ltr" maxLength={60} placeholder={t('capset.name_en')} aria-label={t('capset.name_en')} data-testid={`capset-skill-${i}-en`} disabled={ro} value={s.name_en} onChange={(e) => setSkill(i, { name_en: e.target.value })} />
              <input className="input" dir="rtl" maxLength={60} placeholder={t('capset.name_ar')} aria-label={t('capset.name_ar')} data-testid={`capset-skill-${i}-ar`} disabled={ro} value={s.name_ar} onChange={(e) => setSkill(i, { name_ar: e.target.value })} />
              <button type="button" className="btn btn-danger" disabled={ro} aria-label={t('capset.remove')} data-testid={`capset-skill-${i}-remove`}
                onClick={() => patch({ skills: v.skills.filter((_, j) => j !== i), crews: v.crews.map((c) => ({ ...c, skills: c.skills.filter((x) => x !== s.code) })), efforts: v.efforts.filter((e) => e.skill !== s.code) })}><Trash2 size={15} aria-hidden /></button>
            </div>
          ))}
        </div>
        {dupSkill && <p className="mt-1 text-xs text-danger" role="alert">{t('capset.dup_skill')}</p>}
        <button type="button" className="btn mt-2 gap-1" data-testid="capset-skill-add" disabled={ro || v.skills.length >= 30} onClick={() => patch({ skills: [...v.skills, { code: '', name_en: '', name_ar: '' }] })}><Plus size={15} aria-hidden />{t('capset.add_skill')}</button>
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-sm font-semibold">{t('capset.crews')}</legend>
        <p className="mb-2 text-xs text-mute">{t('capset.crews_note')}</p>
        <div className="space-y-2">
          {v.crews.map((c, i) => (
            <div key={i} className="space-y-2 rounded-md border border-line p-2" data-testid={`capset-crew-${i}`}>
              <div className="grid gap-2 sm:grid-cols-[1fr_1.4fr_1fr_6rem_auto]">
                <input className="input" dir="ltr" maxLength={40} placeholder={t('capset.crew_id')} aria-label={t('capset.crew_id')} data-testid={`capset-crew-${i}-id`} disabled={ro} value={c.id} onChange={(e) => setCrew(i, { id: e.target.value })} />
                <input className="input" maxLength={80} placeholder={t('capset.crew_name')} aria-label={t('capset.crew_name')} data-testid={`capset-crew-${i}-name`} disabled={ro} value={c.name} onChange={(e) => setCrew(i, { name: e.target.value })} />
                <select className="input" aria-label={t('capset.region')} data-testid={`capset-crew-${i}-region`} disabled={ro} value={c.region_id} onChange={(e) => setCrew(i, { region_id: Number(e.target.value) })}>
                  {(regions.data ?? []).map((r) => <option key={r.id} value={r.id}>{(ar && r.name_ar) || r.name_en}</option>)}
                </select>
                <input type="number" min={1} max={200} className="input" aria-label={t('capset.crew_size')} title={t('capset.size_tip')} data-testid={`capset-crew-${i}-size`} disabled={ro} value={c.size} onChange={(e) => setCrew(i, { size: num(e.target.value) })} />
                <button type="button" className="btn btn-danger" disabled={ro} aria-label={t('capset.remove')} data-testid={`capset-crew-${i}-remove`} onClick={() => patch({ crews: v.crews.filter((_, j) => j !== i) })}><Trash2 size={15} aria-hidden /></button>
              </div>
              <div className="flex flex-wrap gap-2" role="group" aria-label={t('capset.crew_skills')}>
                {v.skills.filter((s) => CODE.test(s.code.trim())).map((s) => (
                  <label key={s.code} className={`chip cursor-pointer gap-1 border ${c.skills.includes(s.code) ? 'border-accent bg-accentSoft text-accentText' : 'border-line bg-card text-mute'}`}>
                    <input type="checkbox" className="sr-only" data-testid={`capset-crew-${i}-skill-${s.code}`} disabled={ro} checked={c.skills.includes(s.code)}
                      onChange={(e) => setCrew(i, { skills: e.target.checked ? [...c.skills, s.code] : c.skills.filter((x) => x !== s.code) })} />
                    {(ar && s.name_ar) || s.name_en}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
        <button type="button" className="btn mt-2 gap-1" data-testid="capset-crew-add" disabled={ro || v.crews.length >= 200 || !regions.data?.length}
          onClick={() => patch({ crews: [...v.crews, { id: `crew_${v.crews.length + 1}`, region_id: regions.data![0]!.id, name: '', size: 1, skills: [] }] })}><Plus size={15} aria-hidden />{t('capset.add_crew')}</button>
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-sm font-semibold">{t('capset.efforts')}</legend>
        <p className="mb-2 text-xs text-mute">{t('capset.efforts_note')}</p>
        <div className="space-y-2">
          {v.efforts.map((e, i) => (
            <div key={i} className="grid gap-2 rounded-md border border-line p-2 sm:grid-cols-[1.4fr_1fr_6rem_auto]" data-testid={`capset-effort-${i}`}>
              <input className="input" dir="ltr" maxLength={60} placeholder={t('capset.task_code')} aria-label={t('capset.task_code')} data-testid={`capset-effort-${i}-code`} disabled={ro} value={e.task_code} onChange={(x) => setEffort(i, { task_code: x.target.value })} />
              <select className="input" aria-label={t('capset.skill')} data-testid={`capset-effort-${i}-skill`} disabled={ro} value={e.skill} onChange={(x) => setEffort(i, { skill: x.target.value })}>
                {v.skills.filter((s) => CODE.test(s.code.trim())).map((s) => <option key={s.code} value={s.code}>{(ar && s.name_ar) || s.name_en}</option>)}
              </select>
              <input type="number" min={0.1} max={365} step={0.1} className="input" aria-label={t('capset.person_days')} title={t('capset.pd_tip')} data-testid={`capset-effort-${i}-days`} disabled={ro} value={e.person_days} onChange={(x) => setEffort(i, { person_days: num(x.target.value) })} />
              <button type="button" className="btn btn-danger" disabled={ro} aria-label={t('capset.remove')} data-testid={`capset-effort-${i}-remove`} onClick={() => patch({ efforts: v.efforts.filter((_, j) => j !== i) })}><Trash2 size={15} aria-hidden /></button>
            </div>
          ))}
        </div>
        <button type="button" className="btn mt-2 gap-1" data-testid="capset-effort-add" disabled={ro || v.efforts.length >= 500 || !v.skills.some((s) => CODE.test(s.code.trim()))}
          onClick={() => patch({ efforts: [...v.efforts, { task_code: '', skill: v.skills.find((s) => CODE.test(s.code.trim()))!.code, person_days: 1 }] })}><Plus size={15} aria-hidden />{t('capset.add_effort')}</button>
      </fieldset>

      <p className="text-xs text-mute" data-testid="capset-updated">
        {cur.updated_by && cur.updated_at ? t('capset.updated', { name: cur.updated_by.display_name, when: fmtDateTime(cur.updated_at, ar ? 'ar' : 'en') }) : t('capset.never')}
      </p>
      {ro
        ? <p className="text-sm text-mute" data-testid="capset-readonly">{t('capset.readonly')}</p>
        : <button className="btn btn-accent" data-testid="capset-save" disabled={!dirty || !ok} onClick={() => setOpen(true)}>{t('common.save')}</button>}
      <UnsavedGuard scope="settings" dirty={dirty} needsReason label={t('ui.guard_settings')} onSave={(reason) => new Promise<boolean>((res) => set.mutate({ version: cur.version, ...clean(v), reason }, { onSuccess: () => res(true), onError: () => res(false) }))} />
      {open && (
        <FormDialog open onClose={() => setOpen(false)} testid="capset-dialog" title={t('capset.title')} busy={set.isPending} error={set.isError ? errText(set.error, t) : null} onSubmit={save}>
          <p className="text-sm text-mute" data-testid="capset-confirm">{t('capset.confirm')}</p>
        </FormDialog>
      )}
    </section>
  );
}
