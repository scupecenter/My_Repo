import { Building2, Pencil, Power } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { useCreateDepartment, useDepartments, useUpdateDepartment } from '@/api/msg';
import type { Department } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { useToast } from '@/components/Toast';
import { isAdmin } from '@/lib/perm';

type Act = { kind: 'create' } | { kind: 'edit'; dept: Department } | { kind: 'toggle'; dept: Department };
const CODE = /^[A-Za-z0-9_]{2,20}$/;

function DeptDialog({ act, onClose }: { act: Act; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const create = useCreateDepartment(), update = useUpdateDepartment();
  const d = act.kind === 'create' ? null : act.dept;
  const [code, setCode] = useState(d?.code ?? '');
  const [en, setEn] = useState(d?.name_en ?? '');
  const [ar, setAr] = useState(d?.name_ar ?? '');
  const m = act.kind === 'create' ? create : update;
  const toggle = act.kind === 'toggle';
  const bad = !toggle && (!CODE.test(code) || !en.trim());
  const done = { onSuccess: () => { toast(t(`dept.done_${act.kind}`)); onClose(); } };
  return (
    <FormDialog open onClose={onClose} testid="dept-dialog" busy={m.isPending} disabled={bad} error={m.isError ? errText(m.error, t) : null}
      title={toggle ? t(d!.is_active ? 'dept.deactivate_title' : 'dept.activate_title', { name: d!.name_en }) : t(act.kind === 'create' ? 'dept.new' : 'dept.edit')}
      submitLabel={toggle ? t(d!.is_active ? 'dept.deactivate' : 'dept.activate') : undefined}
      onSubmit={(reason) => {
        const base = { code: (d?.code ?? code).trim(), name_en: (d?.name_en ?? en).trim(), name_ar: (d?.name_ar ?? ar.trim()) || null, reason };
        if (act.kind === 'create') create.mutate({ code: code.trim(), name_en: en.trim(), name_ar: ar.trim() || null, reason }, done);
        else if (act.kind === 'edit') update.mutate({ dept: act.dept, patch: { code: code.trim(), name_en: en.trim(), name_ar: ar.trim() || null, reason } }, done);
        else update.mutate({ dept: act.dept, patch: { ...base, is_active: !act.dept.is_active } }, done);
      }}>
      {toggle ? <p className="rounded-md bg-card2 p-2 text-sm text-mute" data-testid="dept-toggle-note">{t(d!.is_active ? 'dept.deactivate_note' : 'dept.activate_note')}</p> : (
        <>
          <label className="block text-sm font-semibold">{t('dept.code')}<input className="input mono mt-1 font-normal" dir="ltr" data-testid="dept-code" maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={!!code && !CODE.test(code)} /><span className="text-xs font-normal text-mute">{t('dept.code_hint')}</span></label>
          <label className="block text-sm font-semibold">{t('dept.name_en')}<input className="input mt-1 font-normal" dir="ltr" data-testid="dept-name-en" maxLength={120} value={en} onChange={(e) => setEn(e.target.value)} /></label>
          <label className="block text-sm font-semibold">{t('dept.name_ar')}<input className="input mt-1 font-normal" dir="rtl" data-testid="dept-name-ar" maxLength={120} value={ar} onChange={(e) => setAr(e.target.value)} /></label>
        </>
      )}
    </FormDialog>
  );
}

/** The "Departments" sub-tab of Users: the admin-managed list that people are placed in. */
export function Departments() {
  const { t, i18n } = useTranslation();
  const me = useMe(true);
  const q = useDepartments(true);
  const [act, setAct] = useState<Act | null>(null);
  const canEdit = isAdmin(me.data) || !!me.data?.effective.grants.some((g) => (g.action as string) === 'edit' && ['users', 'admin.users'].includes(g.module_key as string));
  const items = q.data ?? [];
  return (
    <div data-testid="page-departments" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="me-auto text-mute">{t('dept.subtitle')}</p>
        {canEdit && <button className="btn btn-accent" data-testid="dept-new" onClick={() => setAct({ kind: 'create' })}><Building2 size={16} />{t('dept.new')}</button>}
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-card2 text-mute"><tr>
            <th className="p-2 text-start">{t('dept.code')}</th><th className="p-2 text-start">{t('dept.name')}</th><th className="p-2 text-end">{t('dept.members')}</th><th className="p-2 text-start">{t('users.status')}</th><th className="p-2" />
          </tr></thead>
          <tbody data-testid="dept-list">
            {items.map((d) => (
              <tr key={d.id} className="border-b border-line hover:bg-hover" data-testid={`dept-row-${d.code}`}>
                <td className="mono p-2" dir="ltr">{d.code}</td>
                <td className="p-2">{(i18n.language === 'ar' && d.name_ar) || d.name_en}{i18n.language === 'ar' ? (d.name_ar ? <span className="ms-2 text-xs text-mute" dir="ltr">{d.name_en}</span> : null) : (d.name_ar ? <span className="ms-2 text-xs text-mute" dir="rtl">{d.name_ar}</span> : null)}</td>
                <td className="p-2 text-end" data-testid={`dept-members-${d.code}`}>{d.member_count ?? 0}</td>
                <td className="p-2"><span className={`chip ${d.is_active ? 'bg-doneBg text-doneInk' : 'bg-lockBg text-lockInk'}`} data-testid={`dept-status-${d.code}`}>{t(d.is_active ? 'dept.active' : 'dept.inactive')}</span></td>
                <td className="p-2 text-end">{canEdit && (
                  <span className="inline-flex gap-1">
                    <button className="btn" data-testid={`dept-edit-${d.code}`} onClick={() => setAct({ kind: 'edit', dept: d })}><Pencil size={14} />{t('common.edit')}</button>
                    <button className="btn" data-testid={`dept-toggle-${d.code}`} onClick={() => setAct({ kind: 'toggle', dept: d })}><Power size={14} />{t(d.is_active ? 'dept.deactivate' : 'dept.activate')}</button>
                  </span>
                )}</td>
              </tr>
            ))}
            {q.isSuccess && !items.length && <tr><td colSpan={5} className="p-6 text-center text-mute" data-testid="dept-empty">{t('dept.empty')}</td></tr>}
          </tbody>
        </table>
      </div>
      {act && <DeptDialog act={act} onClose={() => setAct(null)} />}
    </div>
  );
}
