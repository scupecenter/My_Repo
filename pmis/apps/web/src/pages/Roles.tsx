import { ROLE_CODE_RE, isBuiltInRoleCode } from '@/lib/roleCodes';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCreateRole, useProfiles, useRolePatch, useRoles } from '@/api/admin';
import { useMe } from '@/api/hooks';
import { isAdmin } from '@/lib/perm';
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
  const [code, setCode] = useState(role?.code ?? ''), [en, setEn] = useState(role?.name_en ?? ''), [arName, setAr] = useState(role?.name_ar ?? '');
  const [descAr, setDescAr] = useState(role?.description_ar ?? '');
  const [desc, setDesc] = useState(role?.description_en ?? ''), [hold, setHold] = useState(role?.can_hold_matrix_levels ?? false), [active, setActive] = useState(role?.is_active ?? true);
  const [profile, setProfile] = useState(role?.default_profile_id ?? '');
  // Q165 (contract 0.12.3): who reads the whole Audit Log, and who reads it as a Team Lead. System Admin only.
  const admin = isAdmin(useMe(true).data);
  const [caps, setCaps] = useState<string[]>([...(role?.capabilities ?? [])].sort());
  // 0163 (contract 0.15.80): what holders of the role see of the dashboard and the menu. System Admin only.
  const [tabs, setTabs] = useState<string[]>(role?.dashboard_tabs ?? ['pmo', 'cw', 'te']);
  const [hideMsg, setHideMsg] = useState(role?.hide_messages_inbox ?? false);
  const [reg, setReg] = useState<'all' | number[]>(role?.default_region_ids ?? 'all'), [mods, setMods] = useState<'all' | string[]>(role?.default_module_keys ?? 'all');
  const m = role ? patch : create;
  const builtIn = !!role && isBuiltInRoleCode(role.code);
  const bad = tabs.length === 0 || en.trim().length < 2 || (code !== (role?.code ?? '') && !ROLE_CODE_RE.test(code));
  const done = () => { toast(t('roles.saved')); onClose(); };
  return (
    <FormDialog open onClose={onClose} testid="role-dialog" wide title={role ? t('roles.edit') : t('roles.new')} disabled={bad} busy={m.isPending} error={m.isError ? errText(m.error, t) : null}
      onSubmit={(reason) => {
        if (role) {
          // Only what changed goes in the PATCH: the server writes each given default as an audited change.
          const p: Partial<RolePatch> = { name_en: en, name_ar: arName ?? '', description_en: desc, description_ar: descAr, can_hold_matrix_levels: hold, is_active: active };
          if (code !== role.code) (p as Record<string, unknown>).code = code;
          if ((profile || null) !== (role.default_profile_id ?? null)) p.default_profile_id = profile || null;
          if (!same(reg, role.default_region_ids ?? 'all')) p.default_region_ids = reg;
          if (!same(mods, role.default_module_keys ?? 'all')) p.default_module_keys = mods;
          if (admin && !same(caps, [...(role.capabilities ?? [])].sort())) (p as Record<string, unknown>).capabilities = caps;
          if (admin && !same([...tabs].sort(), [...(role.dashboard_tabs ?? ['pmo', 'cw', 'te'])].sort())) (p as Record<string, unknown>).dashboard_tabs = ['pmo', 'cw', 'te'].filter((x) => tabs.includes(x));
          if (admin && hideMsg !== (role.hide_messages_inbox ?? false)) (p as Record<string, unknown>).hide_messages_inbox = hideMsg;
          patch.mutate({ role, reason, patch: p as Partial<Role> }, { onSuccess: done });
        } else {
          const body: RoleInput = { code, name_en: en, name_ar: arName || undefined, description_en: desc || undefined, description_ar: descAr || undefined, can_hold_matrix_levels: hold, default_profile_id: profile || null, default_region_ids: reg, default_module_keys: mods, reason };
          create.mutate(body as unknown as Record<string, unknown>, { onSuccess: done });
        }
      }}>
      <label className="block text-sm font-semibold">{t('roles.code')}
        <input className="input mono mt-1 font-normal" data-testid="role-code" dir="ltr" value={code} disabled={!!role && builtIn} title={builtIn ? t('roles.code_locked') : undefined} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        <span className="text-xs font-normal text-mute">{builtIn ? t('roles.code_locked') : t('roles.code_hint')}</span>
        {role && !builtIn && code !== role.code && <span className="mt-1 block rounded border border-warn/40 bg-warn/10 p-2 text-xs font-normal" role="note" data-testid="role-code-warning">{t('roles.code_change_warning')}</span>}
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-semibold">{t('roles.name_en')}<input className="input mt-1 font-normal" data-testid="role-name-en" value={en} onChange={(e) => setEn(e.target.value)} /></label>
        <label className="block text-sm font-semibold">{t('roles.name_ar')}<input className="input mt-1 font-normal" data-testid="role-name-ar" dir="rtl" value={arName ?? ''} onChange={(e) => setAr(e.target.value)} /></label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-semibold">{t('roles.description')}<textarea className="input mt-1 font-normal" data-testid="role-desc" value={desc ?? ''} onChange={(e) => setDesc(e.target.value)} /></label>
        <label className="block text-sm font-semibold">{t('roles.description_ar')}<textarea className="input mt-1 font-normal" data-testid="role-desc-ar" dir="rtl" value={descAr} onChange={(e) => setDescAr(e.target.value)} /></label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-semibold">{t('roles.default_profile')}
          <select className="input mt-1 font-normal" data-testid="role-profile" value={profile} onChange={(e) => setProfile(e.target.value)}>
            <option value="">{t('roles.no_profile')}</option>{(profiles.data ?? []).map((p) => <option key={p.id} value={p.id}>{(ar && p.name_ar) || p.name_en}</option>)}
          </select></label>
      </div>
      <ScopePicker id="role-regions" label={t('roles.default_regions')} options={(regions.data ?? []).map((r): [number, string] => [r.id, (ar && r.name_ar) || r.name_en])} value={reg} onChange={setReg} />
      <ScopePicker id="role-modules" label={t('roles.default_modules')} options={modules} value={mods} onChange={setMods} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="role-can-hold" checked={hold} onChange={(e) => setHold(e.target.checked)} />{t('roles.can_hold')}</label>
      {role && admin && (
        <fieldset className="space-y-1 rounded-md border border-line p-2" data-testid="role-capabilities">
          <legend className="px-1 text-sm font-semibold">{t('roles.capabilities')}</legend>
          {(['audit_full_reader', 'team_lead'] as const).map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid={`role-cap-${c}`} checked={caps.includes(c)}
              onChange={(e) => setCaps((x) => (e.target.checked ? [...x, c].sort() : x.filter((y) => y !== c)))} />{t(`roles.cap_${c}`)}</label>))}
          <p className="text-xs text-mute">{t('roles.cap_hint')}</p>
        </fieldset>
      )}
      {role && admin && (
        <fieldset className="space-y-1 rounded-md border border-line p-2" data-testid="role-dashboard-access">
          <legend className="px-1 text-sm font-semibold">{t('roles.dash_access')}</legend>
          <p className="text-xs text-mute">{t('roles.dash_tabs')}</p>
          {(['pmo', 'cw', 'te'] as const).map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid={`role-tab-${k}`} checked={tabs.includes(k)}
              onChange={(e) => setTabs((x) => (e.target.checked ? [...x, k] : x.filter((y) => y !== k)))} />{t(`dash.tabs.${k}`)}</label>))}
          {tabs.length === 0 && <p className="text-xs text-lateInk" data-testid="role-tabs-none">{t('roles.dash_tabs_none')}</p>}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="role-hide-msg" checked={hideMsg} onChange={(e) => setHideMsg(e.target.checked)} />{t('roles.hide_msg')}</label>
          <p className="text-xs text-mute">{t('roles.dash_hint')}</p>
        </fieldset>
      )}
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
