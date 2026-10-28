import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDepartments, useSetOrg } from '@/api/msg';
import type { UserDetail, UserPickerItem } from '@/api/types';
import { errorCodes } from '@/lib/time';
import { errText, FormDialog } from './FormDialog';
import { PeoplePicker } from './PeoplePicker';
import { useToast } from './Toast';

/** Edit manager and department of one user (`PUT /users/{id}/org`; step-up is handled by the client). */
export function OrgDialog({ user, onClose }: { user: UserDetail; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const depts = useDepartments();
  const set = useSetOrg(user.id);
  const [mgr, setMgr] = useState<UserPickerItem[]>(user.manager ? [{ id: user.manager.id, display_name: user.manager.display_name, employee_id: user.manager.employee_id ?? '' }] : []);
  const [dept, setDept] = useState(user.department?.id ?? '');
  const ar = i18n.language === 'ar';
  const list = depts.data ?? [];
  const loop = set.isError && errorCodes(set.error).includes('manager_loop');
  const error = set.isError ? (loop ? t('org.manager_loop') : errText(set.error, t)) : null;
  return (
    <FormDialog open onClose={onClose} testid="org-dialog" title={t('org.edit_title', { name: user.display_name })} busy={set.isPending} error={error}
      onSubmit={(reason) => set.mutate(
        { manager: mgr[0] ? { id: mgr[0].id, display_name: mgr[0].display_name, employee_id: mgr[0].employee_id } : null, department: list.find((d) => d.id === dept) ?? null, reason },
        { onSuccess: () => { toast(t('org.saved')); onClose(); } })}>
      <div>
        <span className="text-sm font-semibold">{t('org.manager')}</span>
        <PeoplePicker id="org-manager" single value={mgr} onChange={setMgr} blockId={user.id} blockHint={t('org.self_manager')} />
        <p className="mt-1 text-xs text-mute">{t('org.manager_hint')}</p>
      </div>
      <label className="block text-sm font-semibold">{t('org.department')}
        <select className="input mt-1 font-normal" data-testid="org-department" value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">{t('org.no_department')}</option>
          {list.map((d) => <option key={d.id} value={d.id}>{(ar && d.name_ar) || d.name_en}</option>)}
        </select>
      </label>
    </FormDialog>
  );
}
