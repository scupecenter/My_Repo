import { KeyRound, Lock, Mail, Phone, ShieldCheck, ShieldOff, UserRound } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { fieldErrors } from '@/api/auth';
import { ApiError } from '@/api/client';
import { useSession } from '@/api/hooks';
import type { TwoFactorEnrolment } from '@/api/types';
import {
  type MyProfile, useCancelEmailChange, useCancelPhoneChange, useChangeMyPassword, useMyProfile, useRequestEmailChange, useRequestPhoneChange,
  useResendEmailCode, useSelfDisableTwoFactor, useSelfEnrolConfirm, useSelfEnrolStart, useUpdateMyProfile, useVerifyEmailChange,
} from '@/api/profile';
import { errText } from '@/components/FormDialog';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, LoadingSkeleton } from '@/components/States';
import { useToast } from '@/components/Toast';
import { CodeField, codeComplete, codeErrorText, digitsOnly, QrCode, RecoveryCodesView, TwoFactorCard } from '@/components/TwoFactor';
import { ruleKey } from '@/lib/passwordRules';
import { fmtDateTime } from '@/lib/time';

const REGION_NAMES: Record<number, string> = { 1: 'Tripoli', 2: 'Middle', 3: 'WM', 4: 'Zawia', 5: 'Benghazi', 6: 'GM', 7: 'Sebha' };
const E164 = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function Section({ id, icon, title, children }: { id: string; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="card space-y-3 p-4" aria-labelledby={`${id}-title`} data-testid={`profile-${id}`}>
      <h2 id={`${id}-title`} className="flex items-center gap-2 text-lg font-bold">{icon}{title}</h2>
      {children}
    </section>
  );
}

function Err({ id, msg }: { id: string; msg?: string | null }) {
  return msg ? <p role="alert" data-testid={id} className="mt-1 text-sm text-lateInk">{msg}</p> : null;
}

/**
 * "My profile" (contract 0.9.2, 0.12.6): the user's own details, the email and phone change requests, password and two-factor. Admin-owned data
 * is read-only; the phone is a sign-in identifier and changes only through a request an admin approves (D156).
 */
export function Profile() {
  const { t } = useTranslation();
  const q = useMyProfile();
  if (q.isLoading) return <LoadingSkeleton />;
  if (q.isError || !q.data) return <ErrorState onRetry={() => void q.refetch()} />;
  const p = q.data;
  return (
    <div className="space-y-4" data-testid="page-profile">
      <PageHeader title={t('profile.title')} subtitle={t('profile.subtitle')} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Details key={p.version} p={p} />
        <EmailSection p={p} />
        <PhoneSection p={p} />
        <PasswordSection p={p} />
        <TwoFactorSection p={p} />
      </div>
    </div>
  );
}

function Details({ p }: { p: MyProfile }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const save = useUpdateMyProfile();
  const [f, setF] = useState({ name: p.display_name, locale: p.locale, theme: p.theme });
  const bad = { name: !f.name.trim() || f.name.trim().length > 200 };
  const patch = {
    ...(f.name.trim() !== p.display_name ? { display_name: f.name.trim() } : {}),
    ...(f.locale !== p.locale ? { locale: f.locale } : {}),
    ...(f.theme !== p.theme ? { theme: f.theme } : {}),
  };
  const dirty = Object.keys(patch).length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || bad.name || save.isPending) return;
    save.mutate({ version: p.version, patch }, { onSuccess: () => toast(t('profile.saved')) });
  };
  const ar = i18n.language === 'ar';
  const ro = p.admin_owned;
  const regions = ro.region_ids === 'all' ? t('profile.all_regions') : ro.region_ids.length ? ro.region_ids.map((r) => REGION_NAMES[r] ?? String(r)).join(', ') : t('profile.none');
  return (
    <Section id="details" icon={<UserRound size={18} aria-hidden />} title={t('profile.details')}>
      <form onSubmit={submit} className="space-y-3" noValidate data-testid="profile-details-form">
        <div>
          <label className="block text-sm font-semibold" htmlFor="pf-name">{t('profile.display_name')}</label>
          <input id="pf-name" data-testid="pf-name" className="input mt-1" value={f.name} maxLength={200} onChange={(e) => setF({ ...f, name: e.target.value })} aria-invalid={bad.name} />
          <Err id="pf-name-error" msg={bad.name ? t('profile.err_name') : null} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-semibold">{t('profile.locale')}
            <select className="input mt-1 font-normal" data-testid="pf-locale" value={f.locale} onChange={(e) => setF({ ...f, locale: e.target.value as 'en' | 'ar' })}>
              <option value="en">English</option><option value="ar">العربية</option>
            </select></label>
          <label className="block text-sm font-semibold">{t('profile.theme')}
            <select className="input mt-1 font-normal" data-testid="pf-theme" value={f.theme} onChange={(e) => setF({ ...f, theme: e.target.value as 'light' | 'dark' })}>
              <option value="light">{t('profile.theme_light')}</option><option value="dark">{t('profile.theme_dark')}</option>
            </select></label>
        </div>
        <Err id="pf-error" msg={save.isError ? (save.error.status === 412 ? t('profile.err_stale') : errText(save.error, t)) : null} />
        <div className="flex justify-end"><button type="submit" className="btn btn-accent" data-testid="pf-save" disabled={!dirty || bad.name || save.isPending}>{t('common.save')}</button></div>
      </form>
      <div className="rounded-md bg-card2 p-3 text-sm" data-testid="profile-admin-owned">
        <p className="mb-2 flex items-center gap-1 font-semibold"><Lock size={14} aria-hidden />{t('profile.admin_owned')}</p>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
          <dt className="text-mute">{t('profile.employee_id')}</dt><dd className="mono" dir="ltr" data-testid="pf-employee-id">{p.employee_id ?? '—'}</dd>
          <dt className="text-mute">{t('profile.status')}</dt><dd>{t(`userStatus.${p.status}`)}</dd>
          <dt className="text-mute">{t('profile.roles')}</dt><dd data-testid="pf-roles">{ro.roles.length ? ro.roles.map((r) => (ar && r.name_ar) || r.name_en).join('، ') : t('profile.none')}</dd>
          <dt className="text-mute">{t('profile.teams')}</dt><dd>{ro.teams.length ? ro.teams.join(', ').toUpperCase() : t('profile.none')}</dd>
          <dt className="text-mute">{t('profile.regions')}</dt><dd data-testid="pf-regions">{regions}</dd>
          <dt className="text-mute">{t('profile.department')}</dt><dd>{ro.department ? (ar && ro.department.name_ar) || ro.department.name_en : '—'}</dd>
          <dt className="text-mute">{t('profile.manager')}</dt><dd>{ro.manager?.display_name ?? '—'}</dd>
        </dl>
        <p className="mt-2 text-xs text-mute">{t('profile.admin_owned_note')}</p>
      </div>
    </Section>
  );
}

function EmailSection({ p }: { p: MyProfile }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const ask = useRequestEmailChange(), cancel = useCancelEmailChange();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const local = p.auth_method === 'local' && p.local_sign_in;
  const ch = p.email_change;
  const pending = ch?.status === 'pending' ? ch : null;
  const srv = fieldErrors(ask.error);
  const badEmail = !!email && !EMAIL.test(email.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!EMAIL.test(email.trim()) || !pw || ask.isPending) return;
    ask.mutate({ new_email: email.trim(), password: pw }, { onSuccess: () => { setEmail(''); setPw(''); toast(t('profile.email_sent')); }, onError: () => setPw('') });
  };
  const askErr = !ask.isError ? null
    : ask.error.status === 401 ? t('profile.err_password')
      : srv.new_email?.includes('duplicate') ? t('profile.err_email_dup')
        : srv.new_email?.includes('same_as_current') ? t('profile.err_email_same')
          : ask.error.status === 429 ? t('login.rate') : errText(ask.error, t);
  return (
    <Section id="email" icon={<Mail size={18} aria-hidden />} title={t('profile.email')}>
      <p className="text-sm">{t('profile.email_current')}: <b dir="ltr" data-testid="pf-email">{p.email}</b></p>
      <p className="text-sm text-mute">{t('profile.email_note')}</p>
      {pending && (
        <div className="space-y-2 rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="pf-email-pending">
          <p>{t('profile.email_pending', { email: pending.new_email, date: fmtDateTime(pending.requested_at, i18n.language) })}</p>
          <EmailVerify pending={pending} />
          <button className="btn mt-2" data-testid="pf-email-cancel" disabled={cancel.isPending} onClick={() => cancel.mutate(undefined, { onSuccess: () => toast(t('profile.email_cancelled')) })}>{t('profile.email_cancel')}</button>
          <Err id="pf-email-cancel-error" msg={cancel.isError ? errText(cancel.error, t) : null} />
        </div>
      )}
      {ch && ch.status === 'rejected' && <p className="rounded-md bg-lateBg p-2 text-sm text-lateInk" data-testid="pf-email-rejected">{t('profile.email_rejected', { email: ch.new_email, reason: ch.decision_reason ?? '' })}</p>}
      {ch && ch.status === 'approved' && <p className="rounded-md bg-doneBg p-2 text-sm text-doneInk" data-testid="pf-email-approved">{t('profile.email_approved', { email: ch.new_email })}</p>}
      {!local
        ? <p className="text-sm text-mute" data-testid="pf-email-m365">{t('profile.email_m365')}</p>
        : !pending && (
          <form onSubmit={submit} className="space-y-3" noValidate data-testid="pf-email-form">
            <div>
              <label className="block text-sm font-semibold" htmlFor="pf-new-email">{t('profile.email_new')}</label>
              <input id="pf-new-email" data-testid="pf-new-email" className="input mt-1" dir="ltr" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={badEmail} />
              <Err id="pf-new-email-error" msg={badEmail ? t('profile.err_email') : null} />
            </div>
            <div>
              <label className="block text-sm font-semibold" htmlFor="pf-email-password">{t('profile.password_confirm')}</label>
              <input id="pf-email-password" data-testid="pf-email-password" className="input mt-1" dir="ltr" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
            </div>
            <Err id="pf-email-error" msg={askErr} />
            <div className="flex justify-end"><button type="submit" className="btn btn-accent" data-testid="pf-email-submit" disabled={!EMAIL.test(email.trim()) || !pw || ask.isPending}>{t('profile.email_submit')}</button></div>
          </form>
        )}
    </Section>
  );
}

/** 0.12.6 (Q158): the code mailed to the new address; until it is entered the admin cannot approve (except with a documented identity check). */
function EmailVerify({ pending }: { pending: NonNullable<MyProfile['email_change']> }) {
  const { t } = useTranslation();
  const toast = useToast();
  const verify = useVerifyEmailChange(), resend = useResendEmailCode();
  const [code, setCode] = useState('');
  if (pending.verified_at) return <p data-testid="pf-email-verified">{t('profile.email_verified')}</p>;
  const reason = verify.isError ? (fieldErrors(verify.error).code?.[0] ?? '') : '';
  const err = !verify.isError ? null
    : reason === 'locked' ? t('profile.email_code_locked') : reason === 'expired' ? t('profile.email_code_expired')
      : verify.error.code === 'invalid_code' ? t('profile.email_code_bad') : errText(verify.error, t);
  const ready = code.replace(/[\s-]/g, '').length === 8;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || verify.isPending) return;
    verify.mutate({ code: code.trim() }, { onSuccess: () => { setCode(''); toast(t('profile.email_verified_done')); }, onError: () => setCode('') });
  };
  return (
    <form onSubmit={submit} className="space-y-2" noValidate data-testid="pf-email-verify-form">
      <p>{t('profile.email_code_note')}</p>
      <label className="block font-semibold" htmlFor="pf-email-code">{t('profile.email_code')}</label>
      <input id="pf-email-code" data-testid="pf-email-code" className="input mono" dir="ltr" autoComplete="one-time-code" placeholder="XXXX-XXXX" maxLength={16} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
      <Err id="pf-email-code-error" msg={err ?? (resend.isError ? errText(resend.error, t) : null)} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn-accent" data-testid="pf-email-verify" disabled={!ready || verify.isPending}>{t('profile.email_verify')}</button>
        <button type="button" className="btn" data-testid="pf-email-resend" disabled={resend.isPending} onClick={() => { verify.reset(); resend.mutate(undefined, { onSuccess: () => toast(t('profile.email_code_sent')) }); }}>{t('profile.email_resend')}</button>
      </div>
    </form>
  );
}

/** 0.12.6 (D156): the sign-in phone changes through a request an admin approves (password re-entered; empty = remove the phone). */
function PhoneSection({ p }: { p: MyProfile }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const ask = useRequestPhoneChange(), cancel = useCancelPhoneChange();
  const [phone, setPhone] = useState('');
  const [pw, setPw] = useState('');
  const local = p.auth_method === 'local' && p.local_sign_in;
  const ch = p.phone_change;
  const pending = ch?.status === 'pending' ? ch : null;
  const clean = phone.replace(/[\s().-]/g, '');
  const remove = !clean;
  const bad = !!clean && !E164.test(clean);
  const ready = !!pw && !bad && (remove ? !!p.phone : clean !== p.phone);
  const srv = fieldErrors(ask.error);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || ask.isPending) return;
    ask.mutate({ new_phone: remove ? null : clean, password: pw }, { onSuccess: () => { setPhone(''); setPw(''); toast(t('profile.phone_sent')); }, onError: () => setPw('') });
  };
  const askErr = !ask.isError ? null
    : ask.error.status === 401 ? t('profile.err_password')
      : srv.new_phone?.includes('duplicate') ? t('profile.err_phone_dup')
        : srv.new_phone?.includes('same_as_current') ? t('profile.err_phone_same')
          : ask.error.status === 429 ? t('login.rate') : errText(ask.error, t);
  const shown = (v: string | null | undefined) => v ?? t('profile.phone_none');
  return (
    <Section id="phone" icon={<Phone size={18} aria-hidden />} title={t('profile.phone')}>
      <p className="text-sm">{t('profile.phone_current')}: <b dir="ltr" data-testid="pf-phone">{shown(p.phone)}</b></p>
      <p className="text-sm text-mute">{t('profile.phone_note')}</p>
      {pending && (
        <div className="rounded-md bg-waitBg p-3 text-sm text-waitInk" data-testid="pf-phone-pending">
          <p>{t('profile.phone_pending', { phone: shown(pending.new_phone), date: fmtDateTime(pending.requested_at, i18n.language) })}</p>
          <button className="btn mt-2" data-testid="pf-phone-cancel" disabled={cancel.isPending} onClick={() => cancel.mutate(undefined, { onSuccess: () => toast(t('profile.phone_cancelled')) })}>{t('profile.phone_cancel')}</button>
          <Err id="pf-phone-cancel-error" msg={cancel.isError ? errText(cancel.error, t) : null} />
        </div>
      )}
      {ch && ch.status === 'rejected' && <p className="rounded-md bg-lateBg p-2 text-sm text-lateInk" data-testid="pf-phone-rejected">{t('profile.phone_rejected', { phone: shown(ch.new_phone), reason: ch.decision_reason ?? '' })}</p>}
      {ch && ch.status === 'approved' && <p className="rounded-md bg-doneBg p-2 text-sm text-doneInk" data-testid="pf-phone-approved">{t('profile.phone_approved', { phone: shown(ch.new_phone) })}</p>}
      {!local
        ? <p className="text-sm text-mute" data-testid="pf-phone-m365">{t('profile.phone_m365')}</p>
        : !pending && (
          <form onSubmit={submit} className="space-y-3" noValidate data-testid="pf-phone-form">
            <div>
              <label className="block text-sm font-semibold" htmlFor="pf-new-phone">{t('profile.phone_new')}</label>
              <input id="pf-new-phone" data-testid="pf-new-phone" className="input mt-1" dir="ltr" type="tel" placeholder="+218911234567" value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={bad} />
              <p className="mt-1 text-xs text-mute">{t('profile.phone_hint')}</p>
              <Err id="pf-new-phone-error" msg={bad ? t('profile.err_phone') : null} />
            </div>
            <div>
              <label className="block text-sm font-semibold" htmlFor="pf-phone-password">{t('profile.password_confirm')}</label>
              <input id="pf-phone-password" data-testid="pf-phone-password" className="input mt-1" dir="ltr" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
            </div>
            <Err id="pf-phone-error" msg={askErr} />
            <div className="flex justify-end"><button type="submit" className="btn btn-accent" data-testid="pf-phone-submit" disabled={!ready || ask.isPending}>{remove && p.phone ? t('profile.phone_remove') : t('profile.phone_submit')}</button></div>
          </form>
        )}
    </Section>
  );
}

const RULES = ['len', 'identity', 'common', 'current'] as const;

function PasswordSection({ p }: { p: MyProfile }) {
  const { t } = useTranslation();
  const toast = useToast();
  const change = useChangeMyPassword();
  const [f, setF] = useState({ cur: '', next: '', again: '' });
  const [local, setLocal] = useState<{ cur?: string; next?: string; again?: string }>({});
  if (p.auth_method !== 'local' || !p.local_sign_in) {
    return <Section id="password" icon={<KeyRound size={18} aria-hidden />} title={t('profile.password')}><p className="text-sm text-mute" data-testid="pf-password-m365">{t('top.no_password')}</p></Section>;
  }
  const srv = change.isError && change.error.status === 422 && change.error.code === 'weak_password' ? (fieldErrors(change.error).new_password ?? ['weak']) : [];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (change.isPending) return;
    const l: typeof local = {};
    if (!f.cur) l.cur = t('changePw.err_current_required');
    if (f.next.length < 12) l.next = t('changePw.rule_too_short');
    else if (f.next.length > 128) l.next = t('changePw.rule_too_long');
    else if (f.next === f.cur) l.next = t('changePw.rule_same_as_current');
    if (f.again !== f.next) l.again = t('changePw.err_mismatch');
    setLocal(l);
    if (Object.keys(l).length) return;
    change.mutate({ current_password: f.cur, new_password: f.next }, { onSuccess: () => { setF({ cur: '', next: '', again: '' }); toast(t('profile.password_done')); }, onError: () => setF((x) => ({ ...x, cur: '' })) });
  };
  const curErr = local.cur ?? (change.isError && change.error.status === 401 ? t('changePw.err_current_wrong') : undefined);
  const nextErrs = [...(local.next ? [local.next] : []), ...srv.map((c) => t(`changePw.rule_${ruleKey(c)}`))];
  const general = change.isError && change.error.status === 429 ? t('profile.err_locked') : change.isError && ![401, 422].includes(change.error.status) ? errText(change.error, t) : null;
  const pwField = (id: string, label: string, k: keyof typeof f, auto: string, errs: string[]) => (
    <div>
      <label className="block text-sm font-semibold" htmlFor={id}>{label}</label>
      <input id={id} data-testid={id} type="password" className="input mt-1" dir="ltr" autoComplete={auto} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} aria-invalid={errs.length > 0} />
      {errs.map((m) => <p key={m} role="alert" data-testid={`${id}-error`} className="mt-1 text-sm text-lateInk">{m}</p>)}
    </div>
  );
  return (
    <Section id="password" icon={<KeyRound size={18} aria-hidden />} title={t('profile.password')}>
      <form onSubmit={submit} className="space-y-3" noValidate data-testid="pf-password-form">
        {pwField('pf-cur', t('changePw.current'), 'cur', 'current-password', curErr ? [curErr] : [])}
        {pwField('pf-next', t('changePw.new'), 'next', 'new-password', nextErrs)}
        {pwField('pf-again', t('changePw.confirm'), 'again', 'new-password', local.again ? [local.again] : [])}
        <ul className="list-disc ps-5 text-sm text-mute">{RULES.map((r) => <li key={r}>{t(`changePw.policy_${r}`)}</li>)}</ul>
        <p className="text-xs text-mute">{t('profile.password_sessions')}</p>
        <Err id="pf-password-error" msg={general} />
        <div className="flex justify-end"><button type="submit" className="btn btn-accent" data-testid="pf-password-submit" disabled={change.isPending}>{t('changePw.submit')}</button></div>
      </form>
    </Section>
  );
}

function TwoFactorSection({ p }: { p: MyProfile }) {
  const { t } = useTranslation();
  const session = useSession();
  const tf = p.two_factor;
  const local = p.auth_method === 'local' && p.local_sign_in;
  const [mode, setMode] = useState<'idle' | 'enrol' | 'disable'>('idle');
  const start = useSelfEnrolStart();
  const [startErr, setStartErr] = useState('');
  const begin = () => {
    setStartErr(''); setMode('enrol');
    // the client asks for the step-up (password) when the server answers step_up_required, then retries
    start.mutate(undefined, { onError: (x) => setStartErr(x instanceof ApiError && x.status === 401 ? t('profile.tf_stepup_needed') : errText(x, t)) });
  };
  const stop = () => { start.reset(); setMode('idle'); };
  return (
    <Section id="two-factor" icon={tf.state === 'off' ? <ShieldOff size={18} aria-hidden /> : <ShieldCheck size={18} aria-hidden />} title={t('profile.two_factor')}>
      <p className="text-sm" data-testid="pf-tf-state" data-state={tf.state}>{t(`profile.tf_state_${tf.state}`)}</p>
      {tf.enforced && <p className="rounded-md bg-card2 p-2 text-sm" data-testid="pf-tf-enforced"><Lock size={14} className="me-1 inline" aria-hidden />{t('profile.tf_enforced')}</p>}
      {!local && <p className="text-sm text-mute" data-testid="pf-tf-m365">{t('profile.tf_m365')}</p>}
      {mode === 'enrol' ? <SelfEnrol enrolment={start.data} startError={startErr} onDone={stop} />
        : mode === 'disable' ? <SelfDisable onDone={() => setMode('idle')} />
          : <div className="flex flex-wrap gap-2">
              {tf.can_enable && <button className="btn btn-accent" data-testid="pf-tf-enable" onClick={begin}><ShieldCheck size={16} />{t('profile.tf_enable')}</button>}
              {tf.can_disable && <button className="btn" data-testid="pf-tf-disable" onClick={() => setMode('disable')}><ShieldOff size={16} />{t('profile.tf_disable')}</button>}
            </div>}
      {tf.can_enable && mode === 'idle' && <p className="text-xs text-mute">{t('profile.tf_enable_note')}</p>}
      {tf.state === 'on' && local && mode === 'idle' && <TwoFactorCard session={session.data} />}
    </Section>
  );
}

/** Turning two-factor on from the profile: the client asks for the step-up (password), then the QR code, the first code and the recovery codes. */
function SelfEnrol({ enrolment: e, startError, onDone }: { enrolment: TwoFactorEnrolment | undefined; startError: string; onDone: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useSelfEnrolConfirm();
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [codeErr, setErr] = useState('');
  if (codes) return <RecoveryCodesView codes={codes} onDone={() => { toast(t('profile.tf_enabled')); onDone(); }} />;
  const err = codeErr || startError;
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!codeComplete(code) || confirm.isPending) return;
    setErr('');
    confirm.mutate({ code: digitsOnly(code) }, { onSuccess: (r) => setCodes(r.recovery_codes), onError: (x) => { setCode(''); setErr(codeErrorText(x, t)); } });
  };
  if (!e) {
    return (
      <div className="space-y-2" data-testid="pf-tf-enrol-wait">
        {err ? <><Err id="pf-tf-enrol-error" msg={err} /><button className="btn" data-testid="pf-tf-enrol-back" onClick={onDone}>{t('common.cancel')}</button></> : <p className="text-sm text-mute">{t('profile.tf_starting')}</p>}
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-3" data-testid="pf-tf-enrol-form">
      <p className="text-sm">{t('twoFactor.enrol_step1')}</p>
      <div className="flex justify-center"><QrCode value={e.otpauth_uri} label={t('twoFactor.qr_alt')} /></div>
      <p className="text-sm">{t('twoFactor.enrol_step2')}</p>
      <code className="mono block select-all break-all rounded-md border border-line bg-card2 p-2 text-sm" dir="ltr" aria-label={t('twoFactor.manual_key')} data-testid="pf-tf-key">{e.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
      <p className="text-sm">{t('twoFactor.enrol_step3')}</p>
      <CodeField id="pf-tf-code" value={code} onChange={setCode} error={err} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onDone}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-accent" data-testid="pf-tf-confirm" disabled={!codeComplete(code) || confirm.isPending}>{t('twoFactor.confirm')}</button>
      </div>
    </form>
  );
}

function SelfDisable({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const off = useSelfDisableTwoFactor();
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [rc, setRc] = useState('');
  const [recovery, setRecovery] = useState(false);
  const ready = !!pw && (recovery ? rc.trim().length >= 10 : codeComplete(code));
  const err = !off.isError ? null
    : off.error.code === 'two_factor_enforced' ? t('profile.tf_enforced')
      : off.error.code === 'invalid_credentials' ? t('profile.err_password')
        : off.error.code === 'invalid_code' || off.error.status === 429 ? codeErrorText(off.error, t) : errText(off.error, t);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || off.isPending) return;
    off.mutate({ password: pw, ...(recovery ? { recovery_code: rc.trim() } : { code: digitsOnly(code) }) }, {
      onSuccess: () => { toast(t('profile.tf_disabled')); onDone(); },
      onError: () => { setPw(''); setCode(''); setRc(''); },
    });
  };
  return (
    <form onSubmit={submit} className="space-y-3" data-testid="pf-tf-disable-form">
      <p className="rounded-md bg-waitBg p-2 text-sm text-waitInk">{t('profile.tf_disable_warn')}</p>
      <div>
        <label className="block text-sm font-semibold" htmlFor="pf-tf-password">{t('profile.password_confirm')}</label>
        <input id="pf-tf-password" data-testid="pf-tf-password" className="input mt-1" dir="ltr" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </div>
      {recovery
        ? <div>
            <label className="block text-sm font-semibold" htmlFor="pf-tf-recovery">{t('twoFactor.recovery_label')}</label>
            <input id="pf-tf-recovery" data-testid="pf-tf-recovery" className="input mono mt-1" dir="ltr" autoComplete="off" placeholder="XXXXX-XXXXX" value={rc} onChange={(e) => setRc(e.target.value)} />
          </div>
        : <CodeField id="pf-tf-off-code" value={code} onChange={setCode} />}
      <button type="button" className="text-sm text-accent underline" data-testid="pf-tf-toggle" onClick={() => setRecovery(!recovery)}>{recovery ? t('twoFactor.use_code') : t('twoFactor.use_recovery')}</button>
      <Err id="pf-tf-disable-error" msg={err} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onDone}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-accent" data-testid="pf-tf-disable-submit" disabled={!ready || off.isPending}>{t('profile.tf_disable')}</button>
      </div>
    </form>
  );
}
