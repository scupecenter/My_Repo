import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { fieldErrors } from '@/api/auth';
import { ApiError } from '@/api/client';
import { useAcceptInvitation, useInvitationPreview } from '@/api/invitations';
import { ruleKey } from '@/lib/passwordRules';

const Shell = ({ children, testid }: { children: React.ReactNode; testid: string }) => (
  <div className="grid min-h-screen place-items-center p-4"><div className="card w-[min(460px,100%)] space-y-4 p-6" data-testid={testid}>{children}</div></div>
);

/** Public page of the mailed invitation link: shows who is invited, the person chooses a password, the account is created. No session. */
export function InviteAccept() {
  const { t } = useTranslation();
  const { token = '' } = useParams();
  const preview = useInvitationPreview(token);
  const accept = useAcceptInvitation(token);
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [mismatch, setMismatch] = useState(false);

  if (preview.isLoading) return <Shell testid="invite-loading"><p className="text-mute">{t('common.loading')}</p></Shell>;
  if (preview.isError || !preview.data) {
    // One answer for every link that does not work: the page never says why.
    const limited = preview.error instanceof ApiError && preview.error.status === 429;
    return <Shell testid="invite-invalid"><h1 className="text-xl font-bold">{t('invite.invalid_title')}</h1><p className="text-mute">{limited ? t('login.rate') : t('invite.invalid_text')}</p><Link className="btn" to="/login">{t('invite.to_login')}</Link></Shell>;
  }
  if (accept.isSuccess) {
    return (
      <Shell testid="invite-done"><h1 className="text-xl font-bold">{t('invite.done_title')}</h1><p>{t('invite.done_text')}</p>
        {accept.data.two_factor_enrolment_pending && <p className="rounded-md bg-waitBg p-2 text-sm text-waitInk" data-testid="invite-done-2fa">{t('invite.done_2fa')}</p>}
        <Link className="btn btn-accent" data-testid="invite-to-login" to="/login">{t('invite.to_login')}</Link></Shell>
    );
  }
  const p = preview.data;
  const weak = accept.error instanceof ApiError && accept.error.code === 'weak_password' ? (fieldErrors(accept.error).password ?? ['weak']) : [];
  const conflict = accept.error instanceof ApiError && accept.error.status === 409;
  const gone = accept.error instanceof ApiError && accept.error.status === 404;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (accept.isPending) return;
    if (pw !== again) return setMismatch(true);
    setMismatch(false);
    accept.mutate({ password: pw });
  };
  if (gone) return <Shell testid="invite-invalid"><h1 className="text-xl font-bold">{t('invite.invalid_title')}</h1><p className="text-mute">{t('invite.invalid_text')}</p></Shell>;
  return (
    <form onSubmit={submit} noValidate className="grid min-h-screen place-items-center p-4" data-testid="invite-form">
      <div className="card w-[min(460px,100%)] space-y-4 p-6">
        <h1 className="text-xl font-bold">{t('invite.title', { name: p.display_name })}</h1>
        <p className="text-mute">{t('invite.intro')}</p>
        <dl className="rounded-md bg-card2 p-3 text-sm" data-testid="invite-facts">
          <div className="flex justify-between gap-2"><dt className="text-mute">{t('newUser.email')}</dt><dd dir="ltr">{p.email}</dd></div>
          {p.employee_id && <div className="flex justify-between gap-2"><dt className="text-mute">{t('newUser.employee_id')}</dt><dd dir="ltr">{p.employee_id}</dd></div>}
          {p.phone && <div className="flex justify-between gap-2"><dt className="text-mute">{t('newUser.phone')}</dt><dd dir="ltr">{p.phone}</dd></div>}
        </dl>
        <div>
          <label className="block text-sm font-semibold" htmlFor="invite-password">{t('changePw.new')}</label>
          <input id="invite-password" data-testid="invite-password" type="password" dir="ltr" className="input mt-1" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          {weak.map((c) => <p key={c} role="alert" data-testid="invite-password-error" className="mt-1 text-sm text-lateInk">{t(`changePw.rule_${ruleKey(c)}`)}</p>)}
        </div>
        <div>
          <label className="block text-sm font-semibold" htmlFor="invite-confirm">{t('changePw.confirm')}</label>
          <input id="invite-confirm" data-testid="invite-confirm" type="password" dir="ltr" className="input mt-1" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          {mismatch && <p role="alert" data-testid="invite-confirm-error" className="mt-1 text-sm text-lateInk">{t('changePw.err_mismatch')}</p>}
        </div>
        <p className="text-sm text-mute">{t('invite.policy', { min: p.password_policy.min_length, max: p.password_policy.max_length })}</p>
        {conflict && <p role="alert" data-testid="invite-error" className="text-lateInk">{t('invite.conflict')}</p>}
        {accept.isError && !weak.length && !conflict && <p role="alert" data-testid="invite-error" className="text-lateInk">{t('errors.generic')}</p>}
        <div className="flex justify-end"><button type="submit" className="btn btn-accent" data-testid="invite-submit" disabled={accept.isPending || !pw}>{t('invite.submit')}</button></div>
      </div>
    </form>
  );
}
