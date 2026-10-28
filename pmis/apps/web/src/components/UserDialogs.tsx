import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { fieldErrors, useCreateLocalUser, useResetPassword } from '@/api/auth';
import { api, ApiError } from '@/api/client';
import type { BulkResult, User, UserDetail } from '@/api/types';
import { errText, FormDialog } from './FormDialog';
import { PasswordMode, TempPasswordDialog } from './TempPassword';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const compact = (s: string) => s.replace(/[\s-]/g, '');

/** Badges "Local sign-in" and "Must change password" from the User fields. */
export function LocalBadges({ user }: { user: Pick<User, 'local_sign_in' | 'must_change_password' | 'employee_id' | 'id'> }) {
  const { t } = useTranslation();
  const k = user.employee_id ?? user.id;
  return (
    <>
      {user.local_sign_in && <span className="chip bg-openBg text-openInk" data-testid={`local-badge-${k}`}>{t('badges.local')}</span>}
      {user.must_change_password && <span className="chip bg-waitBg text-waitInk" data-testid={`must-change-badge-${k}`}>{t('badges.must_change')}</span>}
    </>
  );
}

export function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const create = useCreateLocalUser();
  const [f, setF] = useState({ name: '', email: '', emp: '', phone: '' });
  const [typed, setTyped] = useState(false);
  const [pw, setPw] = useState('');
  const [shown, setShown] = useState<{ password: string; name: string } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const bad = {
    email: !!f.email && !EMAIL.test(f.email.trim()),
    emp: !!f.emp && !/^[0-9]{4}$/.test(f.emp.trim()),
    phone: !!f.phone && !E164.test(compact(f.phone)),
    pw: typed && pw.length < 12,
  };
  const incomplete = !f.name.trim() || !EMAIL.test(f.email.trim()) || bad.emp || bad.phone || (typed && !pw);
  const srv = fieldErrors(create.error);
  const close = () => { create.reset(); setShown(null); setPw(''); onClose(); };

  if (shown) return <TempPasswordDialog title={t('newUser.created_title')} subject={shown.name} password={shown.password} onClose={close} />;
  const fieldErr = (k: string, local: boolean) => {
    const dup = srv[k]?.includes('duplicate');
    const msg = dup ? t(`newUser.dup_${k}`) : local || srv[k] ? t(`newUser.err_${k}`) : '';
    return msg ? <p role="alert" data-testid={`new-user-${k}-error`} className="mt-1 text-sm font-normal text-lateInk">{msg}</p> : null;
  };
  return (
    <FormDialog open onClose={close} testid="new-user-dialog" title={t('newUser.title')} submitLabel={t('newUser.submit')} busy={create.isPending} disabled={incomplete || bad.email || bad.pw}
      error={create.isError && !Object.keys(srv).length ? errText(create.error, t) : null}
      onSubmit={(reason) => create.mutate({
        display_name: f.name.trim(), email: f.email.trim(), employee_id: f.emp.trim() || null, phone: compact(f.phone) || null, reason,
        ...(typed ? { temporary_password: pw } : {}),
      }, { onSuccess: (r) => setShown({ password: r.temporary_password, name: r.user.display_name }) })}>
      <label className="block text-sm font-semibold">{t('newUser.name')}
        <input className="input mt-1 font-normal" data-testid="new-user-name" value={f.name} onChange={set('name')} autoComplete="off" />{fieldErr('display_name', false)}</label>
      <label className="block text-sm font-semibold">{t('newUser.email')}
        <input className="input mt-1 font-normal" dir="ltr" type="email" data-testid="new-user-email" value={f.email} onChange={set('email')} autoComplete="off" />{fieldErr('email', bad.email)}</label>
      <label className="block text-sm font-semibold">{t('newUser.employee_id')}
        <input className="input mt-1 font-normal" dir="ltr" inputMode="numeric" maxLength={4} data-testid="new-user-employee-id" value={f.emp} onChange={set('emp')} autoComplete="off" />
        <span className="text-xs font-normal text-mute">{t('newUser.employee_id_hint')}</span>{fieldErr('employee_id', bad.emp)}</label>
      <label className="block text-sm font-semibold">{t('newUser.phone')}
        <input className="input mt-1 font-normal" dir="ltr" type="tel" placeholder="+218911234567" data-testid="new-user-phone" value={f.phone} onChange={set('phone')} autoComplete="off" />
        <span className="text-xs font-normal text-mute">{t('newUser.phone_hint')}</span>{fieldErr('phone', bad.phone)}</label>
      <PasswordMode id="new-user" typed={typed} onTyped={setTyped} value={pw} onValue={setPw} errors={srv.temporary_password ?? (bad.pw ? ['too_short'] : undefined)} />
    </FormDialog>
  );
}

export function ResetPasswordDialog({ user, onClose }: { user: Pick<User, 'id' | 'display_name'>; onClose: () => void }) {
  const { t } = useTranslation();
  const reset = useResetPassword(user.id);
  const [typed, setTyped] = useState(false);
  const [pw, setPw] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  const srv = fieldErrors(reset.error);
  const close = () => { reset.reset(); setShown(null); setPw(''); onClose(); };
  if (shown) return <TempPasswordDialog title={t('resetPw.done_title')} subject={user.display_name} password={shown} onClose={close} />;
  const short = typed && pw.length < 12;
  return (
    <FormDialog open onClose={close} testid="reset-password-dialog" title={t('resetPw.title', { name: user.display_name })} submitLabel={t('resetPw.submit')} busy={reset.isPending} disabled={typed && (!pw || short)}
      error={reset.isError && !srv.temporary_password ? errText(reset.error, t) : null}
      onSubmit={(reason) => reset.mutate({ reason, ...(typed ? { temporary_password: pw } : {}) }, { onSuccess: (r) => setShown(r.temporary_password) })}>
      <p className="rounded-md bg-card2 p-2 text-sm text-mute">{t('resetPw.note')}</p>
      <PasswordMode id="reset-pw" typed={typed} onTyped={setTyped} value={pw} onValue={setPw} errors={srv.temporary_password ?? (short ? ['too_short'] : undefined)} />
    </FormDialog>
  );
}

/**
 * "Make System Admin" / "Remove System Admin" on the user page. Membership of the System Admins group is what makes an
 * admin (ADR 0003); a pending account is activated first, because pending users cannot join a group. Step-up and the
 * last-admin rule are enforced by the API.
 */
export function SystemAdminDialog({ user, adminGroupId, remove, onClose }: { user: UserDetail; adminGroupId: string; remove: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const run = useMutation<void, ApiError, string>({
    mutationFn: async (reason) => {
      if (remove) {
        await api.del(`/groups/${adminGroupId}/members/${user.id}`, { query: { reason } });
        return;
      }
      if (user.status !== 'active') await api.patch(`/users/${user.id}`, { version: user.version, body: { status: 'active', reason } });
      const r = await api.post<BulkResult>(`/groups/${adminGroupId}/members`, { body: { user_ids: [user.id], reason } });
      const bad = [...(r.failed ?? []), ...(r.skipped ?? [])].find((x) => x.code !== 'already_assigned');
      if (bad) throw new ApiError(422, { type: 'about:blank', title: bad.message ?? bad.code, status: 422, code: bad.code as never });
    },
    onSuccess: onClose,
    onSettled: () => ['user', 'users', 'group', 'groups', 'me'].forEach((k) => void qc.invalidateQueries({ queryKey: [k] })),
  });
  return (
    <FormDialog open onClose={onClose} testid="sysadmin-dialog" busy={run.isPending} error={run.error ? errText(run.error, t) : null}
      title={t(remove ? 'sysAdmin.remove_title' : 'sysAdmin.make_title', { name: user.display_name })}
      submitLabel={t(remove ? 'sysAdmin.remove' : 'sysAdmin.make')} onSubmit={(reason) => run.mutate(reason)}>
      <p className="rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="sysadmin-warning">
        {t(remove ? 'sysAdmin.remove_warning' : 'sysAdmin.make_warning')}
      </p>
      {!remove && user.status !== 'active' && <p className="text-sm text-mute" data-testid="sysadmin-activate-note">{t('sysAdmin.activate_note')}</p>}
    </FormDialog>
  );
}
