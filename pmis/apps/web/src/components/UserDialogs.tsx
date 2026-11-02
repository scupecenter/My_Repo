import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { fieldErrors, useCreateLocalUser, useIssueEnrolCode, useResetPassword, useResetTwoFactor, useSetTwoFactor } from '@/api/auth';
import { useSetTwoFactorEnforced } from '@/api/profile';
import { api, ApiError } from '@/api/client';
import type { BulkResult, TwoFactorLabel, TwoFactorState, User, UserDetail } from '@/api/types';
import { EnrolCodeDialog } from './EnrolCodeDialog';
import { errText, FormDialog } from './FormDialog';
import { useToast } from './Toast';
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

const TF_TONE: Record<TwoFactorLabel, string> = { on: 'bg-doneBg text-doneInk', pending_enrolment: 'bg-waitBg text-waitInk', off: 'bg-lockBg text-lockInk' };

/** The "2FA" badge on Users & Roles: on, pending enrolment (on, not set up yet) or off. Shown for local accounts only (the field is absent otherwise). */
export function TwoFactorBadge({ user }: { user: Pick<User, 'two_factor' | 'employee_id' | 'id' | 'local_sign_in'> & { two_factor_enforced?: boolean } }) {
  const { t } = useTranslation();
  const state = user.two_factor;
  if (!state || (!user.local_sign_in && state === 'off')) return null;
  const k = user.employee_id ?? user.id;
  return <span className={`chip ${TF_TONE[state]}`} data-testid={`tf-badge-${k}`} data-state={state} title={t(`twoFactor.badge_title_${state}`)}>{t('twoFactor.badge_label')}: {t(`twoFactor.badge_${state}`)}{state !== 'off' && user.two_factor_enforced ? <span data-testid={`tf-enforced-${k}`}> · {t('twoFactor.badge_enforced')}</span> : null}</span>;
}

/**
 * Admin action on a user's two-factor: turn on, turn off, reset (lost phone) or issue a new enrolment code. Reason required; the step-up
 * (password and code) is asked by the client. Turning on, reset and a new code return a one-time enrolment code (contract 0.6.0): it is shown
 * once in a dialog that closes only with its button, with the date it expires.
 */
export function TwoFactorDialog({ user, action, onClose }: { user: Pick<User, 'id' | 'display_name'>; action: 'on' | 'off' | 'reset' | 'code'; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const set = useSetTwoFactor(user.id), reset = useResetTwoFactor(user.id), issue = useIssueEnrolCode(user.id);
  const [shown, setShown] = useState<{ code: string; expires: string } | null>(null);
  const m = action === 'reset' ? reset : action === 'code' ? issue : set;
  const close = () => { set.reset(); reset.reset(); issue.reset(); setShown(null); onClose(); };
  const done = {
    onSuccess: (r: TwoFactorState) => {
      if (r.enrol_code && r.enrol_code_expires_at) setShown({ code: r.enrol_code, expires: r.enrol_code_expires_at });
      else { toast(t(`twoFactor.done_${action}`)); close(); }
    },
  };
  if (shown) return <EnrolCodeDialog code={shown.code} expiresAt={shown.expires} name={user.display_name} onClose={() => { toast(t(`twoFactor.done_${action}`)); close(); }} />;
  return (
    <FormDialog open onClose={close} testid="two-factor-dialog" title={t(`twoFactor.${action}_title`, { name: user.display_name })} busy={m.isPending} error={m.isError ? errText(m.error, t) : null}
      submitLabel={t(action === 'on' ? 'twoFactor.admin_turn_on' : action === 'off' ? 'twoFactor.admin_turn_off' : action === 'reset' ? 'twoFactor.admin_reset' : 'twoFactor.admin_new_code')}
      onSubmit={(reason) => (action === 'reset' ? reset.mutate({ reason }, done) : action === 'code' ? issue.mutate({ reason }, done) : set.mutate({ enabled: action === 'on', reason }, done))}>
      <p className="rounded-md bg-card2 p-2 text-sm text-mute" data-testid="two-factor-dialog-note">{t(`twoFactor.${action}_note`)}</p>
    </FormDialog>
  );
}

/** Contract 0.9.2: mark or unmark two-factor as "enforced by admin" (the user cannot turn it off). Reason; the step-up is asked by the client. */
export function EnforceTwoFactorDialog({ user, enforce, onClose }: { user: Pick<User, 'id' | 'display_name'>; enforce: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const m = useSetTwoFactorEnforced(user.id);
  return (
    <FormDialog open onClose={onClose} testid="two-factor-enforce-dialog" title={t(enforce ? 'twoFactor.enforce_title' : 'twoFactor.unenforce_title', { name: user.display_name })} busy={m.isPending}
      error={m.isError ? errText(m.error, t) : null} submitLabel={t(enforce ? 'twoFactor.enforce' : 'twoFactor.unenforce')}
      onSubmit={(reason) => m.mutate({ enforced: enforce, reason }, { onSuccess: () => { toast(t(enforce ? 'twoFactor.done_enforce' : 'twoFactor.done_unenforce')); onClose(); } })}>
      <p className="rounded-md bg-card2 p-2 text-sm text-mute">{t(enforce ? 'twoFactor.enforce_note' : 'twoFactor.unenforce_note')}</p>
    </FormDialog>
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
