import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCreateRole, useRolePatch, useRoles } from '@/api/admin';
import type { Role } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';

function RoleForm({ role, onClose }: { role?: Role; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const create = useCreateRole(), patch = useRolePatch();
  const [code, setCode] = useState(''), [en, setEn] = useState(role?.name_en ?? ''), [ar, setAr] = useState(role?.name_ar ?? '');
  const [desc, setDesc] = useState(role?.description_en ?? ''), [hold, setHold] = useState(role?.can_hold_matrix_levels ?? false), [active, setActive] = useState(role?.is_active ?? true);
  const m = role ? patch : create;
  const bad = en.trim().length < 2 || (!role && !/^[A-Z][A-Z0-9_]{1,40}$/.test(code));
  const done = () => { toast(t('roles.saved')); onClose(); };
  return (
    <FormDialog open onClose={onClose} testid="role-dialog" title={role ? t('roles.edit') : t('roles.new')} disabled={bad} busy={m.isPending} error={m.isError ? errText(m.error, t) : null}
      onSubmit={(reason) => (role
        ? patch.mutate({ role, reason, patch: { name_en: en, name_ar: ar, description_en: desc, can_hold_matrix_levels: hold, is_active: active } }, { onSuccess: done })
        : create.mutate({ code, name_en: en, name_ar: ar || undefined, description_en: desc || undefined, can_hold_matrix_levels: hold, reason }, { onSuccess: done }))}>
      {!role && <label className="block text-sm font-semibold">{t('roles.code')}<input className="input mono mt-1 font-normal" data-testid="role-code" dir="ltr" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /><span className="text-xs font-normal text-mute">{t('roles.code_hint')}</span></label>}
      <label className="block text-sm font-semibold">{t('roles.name_en')}<input className="input mt-1 font-normal" data-testid="role-name-en" value={en} onChange={(e) => setEn(e.target.value)} /></label>
      <label className="block text-sm font-semibold">{t('roles.name_ar')}<input className="input mt-1 font-normal" data-testid="role-name-ar" dir="rtl" value={ar ?? ''} onChange={(e) => setAr(e.target.value)} /></label>
      <label className="block text-sm font-semibold">{t('roles.description')}<textarea className="input mt-1 font-normal" data-testid="role-desc" value={desc ?? ''} onChange={(e) => setDesc(e.target.value)} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="role-can-hold" checked={hold} onChange={(e) => setHold(e.target.checked)} />{t('roles.can_hold')}</label>
      {role && <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="role-active" checked={active} onChange={(e) => setActive(e.target.checked)} />{t('roles.active')}</label>}
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
