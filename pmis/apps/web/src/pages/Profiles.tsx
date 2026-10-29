import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCatalogue, useCreateProfile, useProfiles, useReplaceProfile } from '@/api/admin';
import type { PermissionProfile, PermissionProfileInput } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';

const gk = (m: string, a: string) => `${m}\u0000${a}`;

/** Editor: code, names, and the module x action grid from the server catalogue. Field rules are kept as they are (sent back unchanged on save). */
function ProfileForm({ profile, onClose }: { profile?: PermissionProfile; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const cat = useCatalogue();
  const create = useCreateProfile(), replace = useReplaceProfile();
  const [code, setCode] = useState(profile?.code ?? ''), [en, setEn] = useState(profile?.name_en ?? ''), [ar, setAr] = useState(profile?.name_ar ?? '');
  const [desc, setDesc] = useState(profile?.description ?? ''), [active, setActive] = useState(profile?.is_active ?? true);
  const [on, setOn] = useState(() => new Set((profile?.grants ?? []).map((g) => gk(g.module_key, g.action))));
  const m = profile ? replace : create;
  // The seeded profiles predate the code pattern, so it is checked on create only.
  const bad = en.trim().length < 1 || (!profile && !/^[A-Z][A-Z0-9_]{1,40}$/.test(code));
  const actions = cat.data?.actions ?? [];
  const modules = (cat.data?.modules ?? []).flatMap((mod) => [{ key: mod.key, name: (i18n.language === 'ar' && mod.name_ar) || mod.name_en, allowed: mod.actions ?? [], sub: false }, ...(mod.screens ?? []).map((s) => ({ key: s.key ?? '', name: (i18n.language === 'ar' && s.name_ar) || s.name_en || '', allowed: mod.actions ?? [], sub: true }))]);
  const toggle = (k: string, v: boolean) => setOn((p) => { const n = new Set(p); if (v) n.add(k); else n.delete(k); return n; });
  const done = () => { toast(t('profiles.saved')); onClose(); };
  return (
    <FormDialog open onClose={onClose} testid="profile-dialog" wide title={profile ? t('profiles.edit') : t('profiles.new')} disabled={bad} busy={m.isPending} error={m.isError ? errText(m.error, t) : null}
      onSubmit={(reason) => {
        const body: PermissionProfileInput = {
          code, name_en: en.trim(), ...(ar.trim() ? { name_ar: ar.trim() } : {}), ...(desc.trim() ? { description: desc.trim() } : {}), is_active: active,
          grants: [...on].map((k) => { const [module_key, action] = k.split('\u0000'); return { module_key, action } as PermissionProfileInput['grants'][number]; }),
          field_rules: (profile?.field_rules ?? []).map((r) => ({ field_id: r.field_id, access: r.access })),
          reason,
        };
        if (profile) replace.mutate({ profile, body }, { onSuccess: done });
        else create.mutate(body, { onSuccess: done });
      }}>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm font-semibold">{t('profiles.code')}<input className="input mono mt-1 font-normal" data-testid="profile-code" dir="ltr" disabled={!!profile} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /></label>
        <label className="block text-sm font-semibold">{t('profiles.name_en')}<input className="input mt-1 font-normal" data-testid="profile-name-en" value={en} onChange={(e) => setEn(e.target.value)} /></label>
        <label className="block text-sm font-semibold">{t('profiles.name_ar')}<input className="input mt-1 font-normal" data-testid="profile-name-ar" dir="rtl" value={ar} onChange={(e) => setAr(e.target.value)} /></label>
      </div>
      <label className="block text-sm font-semibold">{t('profiles.description')}<textarea className="input mt-1 font-normal" data-testid="profile-desc" value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="profile-active" checked={active} onChange={(e) => setActive(e.target.checked)} />{t('profiles.active')}</label>
      {!!profile?.field_rules?.length && <p className="text-sm text-mute" data-testid="profile-field-rules">{t('profiles.field_rules', { count: profile.field_rules.length })}</p>}
      <div className="card max-h-72 overflow-auto" data-testid="profile-grid" role="region" aria-label={t('profiles.grants')}>
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card2 text-mute"><tr><th className="p-1.5 text-start">{t('profiles.module')}</th>{actions.map((a) => <th key={a} className="p-1.5 text-center font-semibold">{t(`profiles.action.${a}`)}</th>)}</tr></thead>
          <tbody>
            {modules.map((mod) => (
              <tr key={mod.key} className="border-t border-line">
                <td className={`p-1.5 ${mod.sub ? 'ps-5 text-mute' : 'font-semibold'}`}>{mod.name} <span className="mono text-mute" dir="ltr">{mod.key}</span></td>
                {actions.map((a) => (
                  <td key={a} className="p-1.5 text-center">
                    {mod.allowed.includes(a) && <input type="checkbox" data-testid={`grant-${mod.key}-${a}`} aria-label={`${mod.name} ${t(`profiles.action.${a}`)}`} checked={on.has(gk(mod.key, a))} onChange={(e) => toggle(gk(mod.key, a), e.target.checked)} />}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </FormDialog>
  );
}

export function Profiles() {
  const { t, i18n } = useTranslation();
  const [all, setAll] = useState(false);
  const list = useProfiles(all);
  const [dlg, setDlg] = useState<null | 'new' | PermissionProfile>(null);
  return (
    <div data-testid="page-profiles">
      <div className="mb-4 flex items-center gap-3">
        <div className="me-auto"><h2 className="text-lg font-bold">{t('profiles.title')}</h2><p className="text-mute">{t('profiles.subtitle')}</p></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="profiles-inactive" checked={all} onChange={(e) => setAll(e.target.checked)} />{t('profiles.include_inactive')}</label>
        <button className="btn btn-accent" data-testid="profile-new" onClick={() => setDlg('new')}><Plus size={16} />{t('profiles.new')}</button>
      </div>
      <div className="card overflow-x-auto"><table className="w-full text-sm">
        <thead className="border-b border-line bg-card2 text-mute"><tr><th className="p-2 text-start">{t('roles.name')}</th><th className="p-2 text-start">{t('profiles.code')}</th><th className="p-2 text-start">{t('profiles.grants')}</th><th className="p-2 text-start">{t('profiles.assignments')}</th><th className="p-2 text-start">{t('users.status')}</th><th className="p-2" /></tr></thead>
        <tbody data-testid="profiles-list">
          {(list.data ?? []).map((p) => (
            <tr key={p.id} className="border-b border-line" data-testid={`profile-row-${p.code}`}>
              <td className="p-2 font-semibold">{(i18n.language === 'ar' && p.name_ar) || p.name_en}{p.description && <div className="text-xs font-normal text-mute">{p.description}</div>}</td>
              <td className="mono p-2 text-xs" dir="ltr">{p.code}</td>
              <td className="p-2">{t('profiles.n_grants', { count: p.grants.length })}</td>
              <td className="p-2">{p.assignment_count ?? 0}</td>
              <td className="p-2"><span className={`chip ${p.is_active ? 'bg-doneBg text-doneInk' : 'bg-lockBg text-lockInk'}`}>{p.is_active ? t('profiles.active') : t('profiles.inactive')}</span></td>
              <td className="p-2 text-end"><button className="btn" data-testid={`profile-edit-${p.code}`} onClick={() => setDlg(p)}>{t('common.edit')}</button></td>
            </tr>
          ))}
          {list.isSuccess && !(list.data ?? []).length && <tr><td colSpan={6} className="p-6 text-center text-mute" data-testid="profiles-empty">{t('profiles.empty')}</td></tr>}
        </tbody>
      </table></div>
      {dlg && <ProfileForm key={dlg === 'new' ? 'new' : dlg.id} profile={dlg === 'new' ? undefined : dlg} onClose={() => setDlg(null)} />}
    </div>
  );
}
