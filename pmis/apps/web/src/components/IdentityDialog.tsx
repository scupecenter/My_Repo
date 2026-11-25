import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSetIdentity } from '@/api/msg';
import type { UserDetail } from '@/api/types';
import { ApiError } from '@/api/client';
import { errText, FormDialog } from './FormDialog';
import { useToast } from './Toast';

/** Edit the display name and the employee number of one user. E-mail and phone are not here: they change only through the verified request flow. */
export function IdentityDialog({ user, isSelf, onClose }: { user: UserDetail; isSelf: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const set = useSetIdentity(user);
  const [name, setName] = useState(user.display_name);
  const [emp, setEmp] = useState(user.employee_id ?? '');
  const bad = !name.trim() || (emp !== '' && !/^[0-9]{4}$/.test(emp));
  const dup = set.error instanceof ApiError && set.error.status === 409;
  const error = set.isError ? (dup ? t('userIdentity.duplicate') : errText(set.error, t)) : null;
  return (
    <FormDialog open onClose={onClose} testid="identity-dialog" title={t('userIdentity.title', { name: user.display_name })} busy={set.isPending} disabled={bad} error={error}
      onSubmit={(reason) => {
        const body: { display_name?: string; employee_id?: string; reason: string } = { reason };
        if (name.trim() !== user.display_name) body.display_name = name.trim();
        if (emp && emp !== (user.employee_id ?? '')) body.employee_id = emp;
        if (Object.keys(body).length === 1) return onClose();
        set.mutate(body, { onSuccess: () => { toast(t('userIdentity.saved')); onClose(); } });
      }}>
      <label className="block text-sm font-semibold">{t('userIdentity.name')}
        <input className="input mt-1 font-normal" data-testid="identity-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></label>
      <label className="block text-sm font-semibold">{t('userIdentity.employee_id')}
        <input className="input mono mt-1 font-normal" data-testid="identity-emp" inputMode="numeric" maxLength={4} value={emp} disabled={isSelf} onChange={(e) => setEmp(e.target.value.replace(/\D/g, ''))} dir="ltr" /></label>
      <p className="text-xs text-mute" data-testid="identity-note">{isSelf ? t('userIdentity.self_note') : t('userIdentity.note')}</p>
    </FormDialog>
  );
}
