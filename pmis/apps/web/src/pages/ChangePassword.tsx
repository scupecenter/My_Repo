import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { fieldErrors, useChangePassword } from '@/api/auth';
import { ApiError } from '@/api/client';
import { useLogout } from '@/api/hooks';
import { ruleKey } from '@/lib/passwordRules';
import { useToast } from '@/components/Toast';
import { useQueryClient } from '@tanstack/react-query';

const RULES = ['len', 'identity', 'common', 'current'] as const;

/** Changing the password. `forced` = a temporary password is waiting: nothing else is reachable and there is no shell. */
export function ChangePassword({ forced = false }: { forced?: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const nav = useNavigate();
  const qc = useQueryClient();
  const logout = useLogout();
  const change = useChangePassword();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [local, setLocal] = useState<{ cur?: string; next?: string; again?: string }>({});
  const [server, setServer] = useState<{ cur?: string; next?: string[] ; general?: string }>({});

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (change.isPending) return;
    const l: typeof local = {};
    if (!cur) l.cur = t('changePw.err_current_required');
    if (next.length < 12) l.next = t('changePw.rule_too_short');
    else if (next.length > 128) l.next = t('changePw.rule_too_long');
    else if (next === cur) l.next = t('changePw.rule_same_as_current');
    if (again !== next) l.again = t('changePw.err_mismatch');
    setLocal(l); setServer({});
    if (Object.keys(l).length) return;
    change.mutate({ current_password: cur, new_password: next }, {
      onSuccess: () => { toast(t('changePw.done')); nav('/', { replace: true }); },
      onError: (x) => {
        if (x instanceof ApiError && x.status === 422 && x.code === 'weak_password') {
          const codes = (fieldErrors(x).new_password ?? []);
          setServer({ next: codes.length ? codes : ['weak'] });
        } else if (x instanceof ApiError && x.status === 401) setServer({ cur: t('changePw.err_current_wrong') });
        else if (x instanceof ApiError && x.status === 429) setServer({ general: t('login.rate') });
        else setServer({ general: t('errors.generic') });
      },
    });
  };
  const nextErrors = [...(local.next ? [local.next] : []), ...(server.next ?? []).map((c) => t(`changePw.rule_${ruleKey(c)}`))];
  const form = (
    <form onSubmit={submit} className="card w-[min(460px,100%)] space-y-4 p-6" data-testid="change-password-form" noValidate>
      <h1 className="text-xl font-bold">{t('changePw.title')}</h1>
      {forced && <p className="rounded-md bg-waitBg p-2 text-sm text-waitInk" data-testid="change-password-forced">{t('changePw.forced')}</p>}
      <Field id="cp-current" label={t('changePw.current')} value={cur} onChange={setCur} auto="current-password" error={local.cur ?? server.cur} />
      <Field id="cp-new" label={t('changePw.new')} value={next} onChange={setNext} auto="new-password" errors={nextErrors} />
      <Field id="cp-confirm" label={t('changePw.confirm')} value={again} onChange={setAgain} auto="new-password" error={local.again} />
      <div className="rounded-md bg-card2 p-3 text-sm" data-testid="cp-policy">
        <b>{t('changePw.policy_title')}</b>
        <ul className="mt-1 list-disc ps-5 text-mute">{RULES.map((r) => <li key={r}>{t(`changePw.policy_${r}`)}</li>)}</ul>
      </div>
      {server.general && <p role="alert" data-testid="cp-error" className="text-lateInk">{server.general}</p>}
      <div className="flex justify-end gap-2">
        {forced
          ? <button type="button" className="btn" data-testid="cp-signout" onClick={() => logout.mutate(undefined, { onSuccess: () => { void qc.invalidateQueries({ queryKey: ['session'] }); nav('/login'); } })}>{t('top.sign_out')}</button>
          : <button type="button" className="btn" data-testid="cp-cancel" onClick={() => nav(-1)}>{t('common.cancel')}</button>}
        <button type="submit" className="btn btn-accent" data-testid="cp-submit" disabled={change.isPending}>{t('changePw.submit')}</button>
      </div>
    </form>
  );
  return forced ? <div className="grid min-h-screen place-items-center p-4">{form}</div> : <div className="grid place-items-start" data-testid="page-change-password">{form}</div>;
}

function Field({ id, label, value, onChange, auto, error, errors }: { id: string; label: string; value: string; onChange: (v: string) => void; auto: string; error?: string; errors?: string[] }) {
  const all = errors ?? (error ? [error] : []);
  return (
    <div>
      <label className="block text-sm font-semibold" htmlFor={id}>{label}</label>
      <input id={id} data-testid={id} type="password" className="input mt-1" dir="ltr" autoComplete={auto} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={all.length > 0} />
      {all.map((m) => <p key={m} role="alert" data-testid={`${id}-error`} className="mt-1 text-sm text-lateInk">{m}</p>)}
    </div>
  );
}
