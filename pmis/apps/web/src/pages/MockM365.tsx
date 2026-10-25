import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { API_BASE, api } from '@/api/client';

/** Stand-in for the Microsoft sign-in page; exists only with VITE_USE_MOCKS=true. */
export function MockM365() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [state, setState] = useState('');
  const [hint, setHint] = useState('');
  const [err, setErr] = useState(false);

  useEffect(() => {
    // Ask the mock API exactly like the real flow would; follow its redirect to read state + hint.
    const id = params.get('identifier');
    void fetch(`${API_BASE}/auth/login${id ? `?identifier=${encodeURIComponent(id)}` : ''}`, { credentials: 'include' }).then((r) => {
      const u = new URL(r.url, window.location.origin);
      setState(u.searchParams.get('state') ?? '');
      setHint(u.searchParams.get('login_hint') ?? '');
    });
  }, [params]);

  const pick = async (account: string) => {
    try {
      await api.post('/__mock/signin', { body: { account, state } });
      await qc.invalidateQueries({ queryKey: ['session'] });
      nav(params.get('return_to') ?? '/my-work');
    } catch { setErr(true); }
  };
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <div className="card w-[min(440px,100%)] space-y-3 p-6" data-testid="mock-m365">
        <h1 className="text-xl font-bold">{t('mock.title')}</h1>
        {hint && <p className="text-sm text-mute" data-testid="mock-hint">{t('mock.hint')}: <span dir="ltr">{hint}</span></p>}
        <p className="font-semibold">{t('mock.pick')}</p>
        {(['pm', 'reviewer', 'newbie', 'pending'] as const).map((a) => (
          <button key={a} className="btn w-full justify-start" data-testid={`mock-account-${a}`} onClick={() => void pick(a)}>{t(`mock.${a}`)}</button>
        ))}
        {err && <p role="alert" className="text-lateInk">{t('login.error')}</p>}
      </div>
    </div>
  );
}

export function MockStepUp() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const verify = async () => { await api.post('/__mock/step-up'); window.location.assign(params.get('return_to') ?? '/step-up-done'); };
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <div className="card w-[min(380px,100%)] space-y-3 p-6">
        <h1 className="text-xl font-bold">{t('mock.stepTitle')}</h1>
        <p className="text-mute">{t('mock.stepBody')}</p>
        <button className="btn btn-accent w-full" data-testid="mock-stepup-verify" onClick={() => void verify()}>{t('mock.verify')}</button>
      </div>
    </div>
  );
}

export function StepUpDone() {
  const { t } = useTranslation();
  useEffect(() => {
    window.opener?.postMessage({ type: 'pmis-step-up-ok' }, window.location.origin);
    window.close();
  }, []);
  return <p className="p-6" data-testid="stepup-done">{t('mock.done')}</p>;
}
