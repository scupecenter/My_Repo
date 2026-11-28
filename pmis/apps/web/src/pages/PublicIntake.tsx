import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { usePublicIntakeForm, useSubmitPublicIntake, type PublicIntakeForm } from '@/api/intake';

const Shell = ({ children, testid }: { children: React.ReactNode; testid: string }) => (
  <div className="grid min-h-screen place-items-center p-4"><div className="card w-[min(560px,100%)] space-y-4 p-6" data-testid={testid}>{children}</div></div>
);

type Field = PublicIntakeForm['fields'][number];

/**
 * The page of a shared intake link (contract 0.15.600). No session, no sign-in: anybody with the link fills it. It shows the asked fields, a name and a way to reach
 * the sender (both optional), and one hidden field that only a robot fills (the honeypot). An unknown link shows one answer and never says why.
 */
export function PublicIntake() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language.startsWith('ar');
  const { token = '' } = useParams();
  const form = usePublicIntakeForm(token);
  const send = useSubmitPublicIntake(token);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [trap, setTrap] = useState('');

  if (form.isLoading) return <Shell testid="intake-loading"><p className="text-mute">{t('common.loading')}</p></Shell>;
  if (form.isError || !form.data) {
    const limited = form.error instanceof ApiError && form.error.status === 429;
    return <Shell testid="intake-invalid"><h1 className="text-xl font-bold">{t('pubintake.invalid_title')}</h1><p className="text-mute">{limited ? t('login.rate') : t('pubintake.invalid_text')}</p></Shell>;
  }
  const f = form.data;
  const label = (x: Field) => (ar && x.label_ar ? x.label_ar : x.label_en);
  const fieldErr = (code: string) => (send.error instanceof ApiError ? send.error.problem.errors?.find((e) => e.path === `/values/${code}`) : undefined);
  const missing = f.fields.some((x) => x.required && !(vals[x.code] ?? '').trim());

  if (send.isSuccess) {
    const msg = (ar ? send.data.thanks_ar : send.data.thanks_en) ?? t('pubintake.thanks');
    return <Shell testid="intake-done"><h1 className="text-xl font-bold">{t('pubintake.thanks_title')}</h1><p data-testid="intake-thanks">{msg}</p></Shell>;
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (missing || send.isPending) return;
    const values: Record<string, string | number | boolean | null> = {};
    for (const x of f.fields) {
      const v = (vals[x.code] ?? '').trim();
      if (v) values[x.code] = x.type === 'yes_no' ? v === 'yes' : v;
    }
    send.mutate({ values, ...(name.trim() ? { reporter_name: name.trim() } : {}), ...(f.ask_contact && contact.trim() ? { reporter_contact: contact.trim() } : {}), website: trap });
  };
  const limited = send.error instanceof ApiError && send.error.status === 429;
  const gone = send.error instanceof ApiError && send.error.status === 404;

  return (
    <Shell testid="intake-form">
      <div>
        <h1 className="text-xl font-bold" data-testid="intake-title">{f.name}</h1>
        {(ar ? f.intro_ar : f.intro_en) || f.intro_en || f.intro_ar ? <p className="mt-1 whitespace-pre-line text-sm text-mute">{(ar ? f.intro_ar : f.intro_en) ?? f.intro_en ?? f.intro_ar}</p> : null}
      </div>
      <form className="space-y-3" onSubmit={submit} noValidate>
        {f.fields.map((x) => {
          const err = fieldErr(x.code);
          const common = { id: `pi-${x.code}`, className: 'input mt-1 w-full', 'data-testid': `intake-field-${x.code}`, 'aria-invalid': err ? true : undefined, value: vals[x.code] ?? '', required: x.required } as const;
          const set = (v: string) => setVals((p) => ({ ...p, [x.code]: v }));
          return (
            <label key={x.code} className="block text-sm" htmlFor={`pi-${x.code}`}>
              <bdi>{label(x)}</bdi>{x.required && <span className="text-lateInk" aria-hidden> *</span>}
              {x.type === 'list' && x.options ? (
                <select {...common} onChange={(e) => set(e.target.value)}><option value="">{t('pubintake.choose')}</option>{x.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>
              ) : x.type === 'yes_no' ? (
                <select {...common} onChange={(e) => set(e.target.value)}><option value="">{t('pubintake.choose')}</option><option value="yes">{t('common.yes')}</option><option value="no">{t('common.no')}</option></select>
              ) : x.type === 'text' ? (
                <textarea {...common} rows={3} maxLength={2000} onChange={(e) => set(e.target.value)} />
              ) : (
                <input {...common} type={x.type === 'number' ? 'number' : x.type === 'date' ? 'date' : 'text'} step={x.type === 'number' ? 'any' : undefined} onChange={(e) => set(e.target.value)} />
              )}
              {err && <span className="mt-0.5 block text-xs text-lateInk" role="alert">{t(`pubintake.err_${err.code}`, { defaultValue: t('pubintake.err_invalid') })}</span>}
            </label>
          );
        })}
        <label className="block text-sm">{t('pubintake.name')}<input className="input mt-1 w-full" data-testid="intake-name" maxLength={120} value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} /></label>
        {f.ask_contact && <label className="block text-sm">{t('pubintake.contact')}<input className="input mt-1 w-full" data-testid="intake-contact" maxLength={160} value={contact} autoComplete="off" onChange={(e) => setContact(e.target.value)} /></label>}
        {/* the honeypot: out of sight and out of the tab order; a person never fills it */}
        <div aria-hidden style={{ position: 'absolute', insetInlineStart: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
          <label>Website<input tabIndex={-1} autoComplete="off" name="website" data-testid="intake-website" value={trap} onChange={(e) => setTrap(e.target.value)} /></label>
        </div>
        {send.isError && !(send.error instanceof ApiError && (send.error.problem.errors?.length ?? 0) > 0) && <p className="text-sm text-lateInk" role="alert" data-testid="intake-error">{limited ? t('login.rate') : gone ? t('pubintake.invalid_text') : t('pubintake.error')}</p>}
        <button type="submit" className="btn btn-accent w-full" data-testid="intake-send" disabled={missing || send.isPending}>{send.isPending ? t('common.loading') : t('pubintake.send')}</button>
        <p className="text-xs text-mute">{t('pubintake.privacy')}</p>
      </form>
    </Shell>
  );
}
