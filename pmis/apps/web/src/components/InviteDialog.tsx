import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGroups, useProfiles, useRoles } from '@/api/admin';
import { type UserInvitationAssignment, useCreateInvitation } from '@/api/invitations';
import { useDepartments } from '@/api/msg';
import { useRegions } from '@/api/sites';
import type { UserPickerItem } from '@/api/types';
import { LEVELS, TEAMS } from '@/components/AssignDialog';
import { errText, FormDialog } from '@/components/FormDialog';
import { PeoplePicker } from '@/components/PeoplePicker';
import { ScopePicker, useModuleOptions } from '@/components/ScopePicker';
import { useToast } from '@/components/Toast';
import { fieldErrors } from '@/api/auth';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
interface Row { role_id: string; level: (typeof LEVELS)[number]; team: (typeof TEAMS)[number]; reg: 'all' | number[]; mods: 'all' | string[]; profile: string; to: string }
const blank = (): Row => ({ role_id: '', level: 'entry', team: 'none', reg: 'all', mods: 'all', profile: '', to: '' });

/** Invite a new person by email, choosing now what the account will hold (decision 5). The server checks every ceiling against the inviter's own rights. */
export function InviteDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const toast = useToast();
  const create = useCreateInvitation();
  const roles = useRoles(), regions = useRegions(), profiles = useProfiles(), groups = useGroups(), depts = useDepartments(), modules = useModuleOptions();
  const [f, setF] = useState({ name: '', email: '', emp: '', phone: '' });
  const [rows, setRows] = useState<Row[]>([]);
  const [dept, setDept] = useState('');
  const [manager, setManager] = useState<UserPickerItem[]>([]);
  const [gids, setGids] = useState<string[]>([]);
  const [tf, setTf] = useState(false);
  const srv = fieldErrors(create.error);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const bad = { email: !!f.email && !EMAIL.test(f.email.trim()), emp: !!f.emp && !/^[0-9]{4}$/.test(f.emp.trim()), phone: !!f.phone && !E164.test(f.phone.replace(/[\s-]/g, '')) };
  const rowBad = (r: Row) => !r.role_id || (r.reg !== 'all' && !r.reg.length) || (r.mods !== 'all' && !r.mods.length);
  const incomplete = !f.name.trim() || !EMAIL.test(f.email.trim()) || bad.emp || bad.phone || rows.some(rowBad);
  const rname = (r: { name_en: string; name_ar?: string | null }) => (ar && r.name_ar) || r.name_en;
  const upd = (i: number, p: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const asRow = (r: Row): UserInvitationAssignment => {
    // The invitation stores exactly the profiles named, so the role's default profile is named here when none is picked.
    const prof = r.profile || (roles.data?.find((x) => x.id === r.role_id)?.default_profile_id ?? '');
    return {
      role_id: r.role_id, permission_level: r.level, team: r.team, all_regions: r.reg === 'all', region_ids: r.reg === 'all' ? [] : r.reg,
      all_modules: r.mods === 'all', module_keys: r.mods === 'all' ? [] : r.mods, profile_ids: prof ? [prof] : [], valid_to: r.to ? `${r.to}T23:59:59Z` : null,
    };
  };
  const fieldErr = (k: string, local: boolean) => {
    const msg = srv[k]?.includes('duplicate') ? t(`newUser.dup_${k}`) : local || srv[k] ? t(`newUser.err_${k}`) : '';
    return msg ? <p role="alert" data-testid={`invite-${k}-error`} className="mt-1 text-sm font-normal text-lateInk">{msg}</p> : null;
  };
  const activeRoles = (roles.data ?? []).filter((r) => r.is_active);
  return (
    <FormDialog open onClose={() => { create.reset(); onClose(); }} wide testid="invite-dialog" title={t('invite.dialog_title')} submitLabel={t('invite.send')} busy={create.isPending}
      disabled={incomplete || bad.email}
      error={create.isError && !Object.keys(srv).some((k) => ['email', 'employee_id', 'phone'].includes(k)) ? errText(create.error, t) : null}
      onSubmit={(reason) => create.mutate({
        email: f.email.trim(), display_name: f.name.trim(), employee_id: f.emp.trim() || null, phone: f.phone.replace(/[\s-]/g, '') || null, reason,
        assignments: rows.map(asRow), department_id: dept || null, manager_id: manager[0]?.id ?? null, group_ids: gids, require_two_factor: tf,
      }, { onSuccess: () => { toast(t('invite.sent', { email: f.email.trim() })); onClose(); } })}>
      <p className="rounded-md bg-card2 p-2 text-sm text-mute">{t('invite.note')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-semibold">{t('newUser.name')}<input className="input mt-1 font-normal" data-testid="invite-name" value={f.name} onChange={set('name')} autoComplete="off" /></label>
        <label className="block text-sm font-semibold">{t('newUser.email')}<input className="input mt-1 font-normal" dir="ltr" type="email" data-testid="invite-email" value={f.email} onChange={set('email')} autoComplete="off" />{fieldErr('email', bad.email)}</label>
        <label className="block text-sm font-semibold">{t('newUser.employee_id')}<input className="input mt-1 font-normal" dir="ltr" inputMode="numeric" maxLength={4} data-testid="invite-employee-id" value={f.emp} onChange={set('emp')} autoComplete="off" />{fieldErr('employee_id', bad.emp)}</label>
        <label className="block text-sm font-semibold">{t('newUser.phone')}<input className="input mt-1 font-normal" dir="ltr" type="tel" placeholder="+218911234567" data-testid="invite-phone" value={f.phone} onChange={set('phone')} autoComplete="off" />{fieldErr('phone', bad.phone)}</label>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between"><b className="text-sm">{t('invite.roles')}</b>
          <button type="button" className="btn" data-testid="invite-add-role" onClick={() => setRows([...rows, blank()])}><Plus size={14} />{t('invite.add_role')}</button></div>
        {!rows.length && <p className="text-sm text-mute" data-testid="invite-no-roles">{t('invite.no_roles')}</p>}
        {rows.map((r, i) => (
          <div key={i} className="card space-y-2 p-3" data-testid={`invite-row-${i}`}>
            <div className="grid gap-2 sm:grid-cols-5">
              <label className="text-sm font-semibold sm:col-span-2">{t('assign.pick_role')}
                <select className="input mt-1 font-normal" data-testid={`invite-role-${i}`} value={r.role_id} onChange={(e) => upd(i, { role_id: e.target.value })}><option value="">—</option>{activeRoles.map((x) => <option key={x.id} value={x.id}>{rname(x)}</option>)}</select></label>
              <label className="text-sm font-semibold">{t('assign.level')}
                <select className="input mt-1 font-normal" data-testid={`invite-level-${i}`} value={r.level} onChange={(e) => upd(i, { level: e.target.value as Row['level'] })}>{LEVELS.map((l) => <option key={l} value={l}>{t(`level_name.${l}`)}</option>)}</select></label>
              <label className="text-sm font-semibold">{t('assign.team')}
                <select className="input mt-1 font-normal" data-testid={`invite-team-${i}`} value={r.team} onChange={(e) => upd(i, { team: e.target.value as Row['team'] })}>{TEAMS.map((l) => <option key={l} value={l}>{t(`team.${l}`)}</option>)}</select></label>
              <label className="text-sm font-semibold">{t('assign.valid_to')}
                <input type="date" className="input mt-1 font-normal" data-testid={`invite-valid-to-${i}`} value={r.to} onChange={(e) => upd(i, { to: e.target.value })} /></label>
            </div>
            <label className="block text-sm font-semibold">{t('assign.profile')}
              <select className="input mt-1 font-normal" data-testid={`invite-profile-${i}`} value={r.profile} onChange={(e) => upd(i, { profile: e.target.value })}><option value="">{t('assign.role_default')}</option>{(profiles.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name_en}</option>)}</select></label>
            <ScopePicker id={`invite-regions-${i}`} label={t('assign.regions')} options={(regions.data ?? []).map((x): [number, string] => [x.id, (ar && x.name_ar) || x.name_en])} value={r.reg} onChange={(v) => upd(i, { reg: v })} />
            <ScopePicker id={`invite-modules-${i}`} label={t('assign.modules')} options={modules} value={r.mods} onChange={(v) => upd(i, { mods: v })} />
            <div className="text-end"><button type="button" className="btn" data-testid={`invite-remove-role-${i}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 size={14} />{t('invite.remove_role')}</button></div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-semibold">{t('users.department')}
          <select className="input mt-1 font-normal" data-testid="invite-department" value={dept} onChange={(e) => setDept(e.target.value)}><option value="">—</option>
            {(depts.data ?? []).filter((d) => d.is_active !== false).map((d) => <option key={d.id} value={d.id}>{(ar && d.name_ar) || d.name_en}</option>)}</select></label>
        <div><b className="text-sm">{t('invite.manager')}</b><div className="mt-1"><PeoplePicker id="invite-manager" single value={manager} onChange={setManager} /></div></div>
      </div>
      <fieldset data-testid="invite-groups"><legend className="text-sm font-semibold">{t('invite.groups')}</legend>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">
          {(groups.data ?? []).map((g) => <label key={g.id} className="flex items-center gap-1"><input type="checkbox" data-testid={`invite-group-${g.id}`} checked={gids.includes(g.id)} onChange={(e) => setGids(e.target.checked ? [...gids, g.id] : gids.filter((x) => x !== g.id))} />{g.name}</label>)}
        </div></fieldset>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="invite-two-factor" checked={tf} onChange={(e) => setTf(e.target.checked)} />{t('invite.two_factor')}</label>
      {tf && <p className="text-xs text-mute">{t('invite.two_factor_hint')}</p>}
    </FormDialog>
  );
}
