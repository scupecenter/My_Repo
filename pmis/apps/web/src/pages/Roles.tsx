import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCreateRole, useProfiles, useRolePatch, useRoles } from '@/api/admin';
import { useRegions } from '@/api/sites';
import type { Role, RoleInput, RolePatch } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { ScopePicker, useModuleOptions } from '@/components/ScopePicker';
import { useToast } from '@/components/Toast';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function RoleForm({ role, onClose }: { role?: Role; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const toast = useToast();
  const create = useCreateRole(), patch = useRolePatch();
  const profiles = useProfiles(), regions = useRegions(), modules = useModuleOptions();
  const [code, setCode] = useState(''), [en, setEn] = useState(role?.name_en ?? ''), [arName, setAr] = useState(role?.name_ar ?? '');
  const [desc, setDesc] = useState(role?.description_en ?? ''), [hold, setHold] = useState(role?.can_hold_matrix_levels ?? false), [active, setActive] = useState(role?.is_active ?? true);
  const [profile, setProfile] = useState(role?.default_profile_id ?? '');
  const [reg, setReg] = useState<'all' | number[]>(role?.default_region_ids ?? 'all'), [mods, setMods] = useState<'all' | string[]>(role?.default_module_keys ?? 'all');
  const m = role ? patch : create;
  const bad = en.trim().length < 2 || (!role && !/^[A-Z][A-Z0-9_]{1,40}$/.test(code));
  const done = () => { toast(t('roles.saved')); onClose(); };
  return (
    <FormDialog open onClose={onClose} testid="role-dialog" wide title={role ? t('roles.edit') : t('roles.new')} disabled={bad} busy={m.isPending} error={m.isError ? errText(m.error, t) : null}
      onSubmit={(reason) => {
        if (role) {
          // Only what changed goes in the PATCH: the server writes each given default as an audited change.
          const p: Partial<RolePatch> = { name_en: en, name_ar: arName ?? '', description_en: desc, can_hold_matrix_levels: hold, is_active: active };
          if ((profile || null) !== (role.default_profile_id ?? null)) p.default_profile_id = profile || null;
          if (!same(reg, role.default_region_ids ?? 'all')) p.default_region_ids = reg;
          if (!same(mods, role.default_module_keys ?? 'all')) p.default_module_keys = mods;
          patch.mutate({ role, reason, patch: p as Partial<Role> }, { onSuccess: done });
        } else {
          const body: RoleInput = { code, name_en: en, name_ar: arName || undefined, description_en: desc || undefined, can_hold_matrix_levels: hold, default_profile_id: profile || null, default_region_ids: reg, default_module_keys: mods, reason };
          create.mutate(body as unknown as Record<string, unknown>, { onSuccess: done });
        }
      }}>
      {!role && <label className="block text-sm font-semibold">{t('roles.code')}<input className="input mono mt-1 font-normal" data-testid="role-code" dir="ltr" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /><span className="text-xs font-normal text-mute">{t('roles.code_hint')}</span></label>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-semibold">{t('roles.name_en')}<input className="input mt-1 font-normal" data-testid="role-name-en" value={en} onChange={(e) => setEn(e.target.value)} /></label>
        <label className="block text-sm font-semibold">{t('roles.name_ar')}<input className="input mt-1 font-normal" data-testid="role-name-ar" dir="rtl" value={arName ?? ''} onChange={(e) => setAr(e.target.value)} /></label>
      </div>
      <label className="block text-sm font-semibold">{t('roles.description')}<textarea className="input mt-1 font-normal" data-testid="role-desc" value={desc ?? ''} onChange={(e) => setDesc(e.target.value)} /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-semibold">{t('roles.default_profile')}
          <select className="input mt-1 font-normal" data-testid="role-profile" value={profile} onChange={(e) => setProfile(e.target.value)}>
            <option value="">{t('roles.no_profile')}</option>{(profiles.data ?? []).map((p) => <option key={p.id} value={p.id}>{(ar && p.name_ar) || p.name_en}</option>)}
          </select></label>
      </div>
      <ScopePicker id="role-regions" label={t('roles.default_regions')} options={(regions.data ?? []).map((r): [number, string] => [r.id, (ar && r.name_ar) || r.name_en])} value={reg} onChange={setReg} />
      <ScopePicker id="role-modules" label={t('roles.default_modules')} options={modules} value={mods} onChange={setMods} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="role-can-hold" checked={hold} onChange={(e) => setHold(e.target.checked)} />{t('roles.can_hold')}</label>
      {role && <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="role-active" checked={active} onChange={(e) => setActive(e.target.checked)} />{t('roles.active')}</label>}
      {role && !active && role.is_active && (role.active_assignment_count ?? 0) > 0 && <p className="text-sm text-lateInk" data-testid="role-in-use-hint">{t('roles.in_use_hint')}</p>}
    </FormDialog>
  );
}

export function Roles() {
  const { t, i18n } = useTranslation();
  const roles = useRoles();
  const [dlg, setDlg] = useState<null | 'new' | Role>(null);
  return (
    <div data-testid="page-roles">
      <div className="mb-4 flex items-center gap-3">
        <div className="me-auto"><h2 className="text-lg font-bold">{t('roles.title')}</h2><p className="text-mute">{t('roles.subtitle')}</p></div>
        <button className="btn btn-accent" data-testid="role-new" onClick={() => setDlg('new')}><Plus size={16} />{t('roles.new')}</button>
      </div>
      <div className="card overflow-x-auto"><table className="w-full text-sm">
        <thead className="border-b border-line bg-card2 text-mute"><tr><th className="p-2 text-start">{t('roles.name')}</th><th className="p-2 text-start">{t('roles.code')}</th><th className="p-2 text-start">{t('roles.matrix')}</th><th className="p-2 text-start">{t('roles.people')}</th><th className="p-2 text-start">{t('users.status')}</th><th className="p-2" /></tr></thead>
        <tbody data-testid="roles-list">
          {(roles.data ?? []).map((r) => (
            <tr key={r.id} className="border-b border-line" data-testid={`role-row-${r.code}`}>
              <td className="p-2 font-semibold">{(i18n.language === 'ar' && r.name_ar) || r.name_en}</td>
              <td className="mono p-2 text-xs" dir="ltr">{r.code}</td>
              <td className="p-2"><span className={`chip ${r.can_hold_matrix_levels ? 'bg-doneBg text-doneInk' : 'bg-lockBg text-lockInk'}`}>{r.can_hold_matrix_levels ? t('roles.holds_levels') : t('roles.no_levels')}</span></td>
              <td className="p-2">{r.active_assignment_count ?? 0}</td>
              <td className="p-2"><span className={`chip ${r.is_active ? 'bg-doneBg text-doneInk' : 'bg-lockBg text-lockInk'}`}>{r.is_active ? t('roles.active') : t('roles.inactive')}</span></td>
              <td className="p-2 text-end"><button className="btn" data-testid={`role-edit-${r.code}`} onClick={() => setDlg(r)}>{t('common.edit')}</button></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {dlg && <RoleForm key={dlg === 'new' ? 'new' : dlg.id} role={dlg === 'new' ? undefined : dlg} onClose={() => setDlg(null)} />}
    </div>
  );
}
