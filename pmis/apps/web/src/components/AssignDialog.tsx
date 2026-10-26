import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBulkAssign, useProfiles, useRoles } from '@/api/admin';
import { useRegions } from '@/api/sites';
import type { BulkAssignRequest, BulkResult, UserPickerItem } from '@/api/types';
import { errText, FormDialog } from './FormDialog';
import { PeoplePicker } from './PeoplePicker';
import { MODULES, ScopePicker } from './ScopePicker';
import { useToast } from './Toast';

export const LEVELS = ['view', 'entry', 'review', 'approve', 'admin'] as const;
export const TEAMS = ['cw', 'te', 'both', 'none'] as const;

/** Assign by role (one role, many people) or by person (one person, many roles). Each created row carries its own level, regions, modules, validity and profile. */
export function AssignDialog({ open, onClose, initialPeople = [], initialMode = 'role' }: { open: boolean; onClose: () => void; initialPeople?: UserPickerItem[]; initialMode?: 'role' | 'person' }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const roles = useRoles(), regions = useRegions(), profiles = useProfiles();
  const assign = useBulkAssign();
  const [mode, setMode] = useState<'role' | 'person'>(initialMode);
  const [people, setPeople] = useState<UserPickerItem[]>(initialPeople);
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('entry');
  const [team, setTeam] = useState<(typeof TEAMS)[number]>('none');
  const [reg, setReg] = useState<'all' | number[]>('all');
  const [mods, setMods] = useState<'all' | string[]>('all');
  const [profile, setProfile] = useState('');
  const [to, setTo] = useState('');
  const [preview, setPreview] = useState<BulkResult | null>(null);
  const ar = i18n.language === 'ar';
  const activeRoles = (roles.data ?? []).filter((r) => r.is_active);
  const body = (reason: string, dry_run: boolean): BulkAssignRequest => ({
    user_ids: people.map((p) => p.id), role_ids: roleIds, reason, dry_run,
    defaults: ({ permission_level: level, team, region_ids: reg, module_keys: mods, ...(profile ? { profile_ids: [profile] } : {}), ...(to ? { valid_to: `${to}T23:59:59Z` } : {}) }) as unknown as BulkAssignRequest['defaults'],
  });
  const bad = !people.length || !roleIds.length || (reg !== 'all' && !reg.length) || (mods !== 'all' && !mods.length) || (mode === 'person' && people.length !== 1) || (mode === 'role' && roleIds.length !== 1);
  const run = (reason: string, dry: boolean) => assign.mutate(body(reason, dry), {
    onSuccess: (r) => {
      if (dry) return setPreview(r);
      toast(t('assign.result', { done: r.done.length, skipped: r.skipped.length }));
      onClose();
    },
  });
  const switchMode = (m: 'role' | 'person') => { setMode(m); setRoleIds([]); setPreview(null); if (m === 'person') setPeople((p) => p.slice(0, 1)); };
  const rname = (r: { name_en: string; name_ar?: string | null }) => (ar && r.name_ar) || r.name_en;

  return (
    <FormDialog open={open} onClose={onClose} testid="assign-dialog" wide title={t('assign.title')} submitLabel={t('assign.submit')} busy={assign.isPending} disabled={bad} error={assign.isError ? errText(assign.error, t) : null} onSubmit={(r) => run(r, false)}>
      <div role="group" aria-label={t('assign.mode')} className="flex gap-2">
        {(['role', 'person'] as const).map((m) => (
          <button key={m} type="button" data-testid={`assign-mode-${m}`} aria-pressed={mode === m} className={`btn ${mode === m ? 'btn-accent' : ''}`} onClick={() => switchMode(m)}>{t(`assign.by_${m}`)}</button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <b className="text-sm">{mode === 'role' ? t('assign.pick_role') : t('assign.pick_roles')}</b>
          {mode === 'role' ? (
            <select className="input mt-1" data-testid="assign-role-select" aria-label={t('assign.pick_role')} value={roleIds[0] ?? ''} onChange={(e) => { setRoleIds(e.target.value ? [e.target.value] : []); setPreview(null); }}>
              <option value="">—</option>{activeRoles.map((r) => <option key={r.id} value={r.id}>{rname(r)}</option>)}
            </select>
          ) : (
            <ul className="card mt-1 max-h-44 overflow-y-auto p-1 text-sm">
              {activeRoles.map((r) => (
                <li key={r.id}><label className="flex items-center gap-2 px-1 py-0.5"><input type="checkbox" data-testid={`assign-role-${r.code}`} checked={roleIds.includes(r.id)} onChange={(e) => { setRoleIds(e.target.checked ? [...roleIds, r.id] : roleIds.filter((x) => x !== r.id)); setPreview(null); }} />{rname(r)}</label></li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <b className="text-sm">{mode === 'role' ? t('assign.pick_people') : t('assign.pick_person')}</b>
          <div className="mt-1"><PeoplePicker id="assign-people" value={people} single={mode === 'person'} onChange={(v) => { setPeople(v); setPreview(null); }} /></div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="text-sm font-semibold">{t('assign.level')}
          <select className="input mt-1 font-normal" data-testid="assign-level" value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>{LEVELS.map((l) => <option key={l} value={l}>{t(`level_name.${l}`)}</option>)}</select></label>
        <label className="text-sm font-semibold">{t('assign.team')}
          <select className="input mt-1 font-normal" data-testid="assign-team" value={team} onChange={(e) => setTeam(e.target.value as typeof team)}>{TEAMS.map((l) => <option key={l} value={l}>{t(`team.${l}`)}</option>)}</select></label>
        <label className="text-sm font-semibold">{t('assign.profile')}
          <select className="input mt-1 font-normal" data-testid="assign-profile" value={profile} onChange={(e) => setProfile(e.target.value)}><option value="">—</option>{(profiles.data ?? []).map((p) => <option key={p.id} value={p.id}>{(ar && p.name_ar) || p.name_en}</option>)}</select></label>
        <label className="text-sm font-semibold">{t('assign.valid_to')}
          <input type="date" className="input mt-1 font-normal" data-testid="assign-valid-to" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <ScopePicker id="assign-regions" label={t('assign.regions')} options={(regions.data ?? []).map((r): [number, string] => [r.id, (ar && r.name_ar) || r.name_en])} value={reg} onChange={setReg} />
      <ScopePicker id="assign-modules" label={t('assign.modules')} options={MODULES.map((m): [string, string] => [m, t(`module.${m}`)])} value={mods} onChange={setMods} />
      <div className="flex items-center gap-2">
        <button type="button" className="btn" data-testid="assign-preview" disabled={bad || assign.isPending} onClick={() => run('preview', true)}>{t('assign.preview')}</button>
        {preview && <span data-testid="assign-preview-result" className="text-sm text-mute">{t('assign.result', { done: preview.done.length, skipped: preview.skipped.length })}</span>}
      </div>
    </FormDialog>
  );
}
