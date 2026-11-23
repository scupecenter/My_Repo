import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/api/client';
import type { Session } from '@/api/types';
import { IdBadge } from '@/components/PersonTag';

export function Pending({ session }: { session: Session }) {
  const { t } = useTranslation();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // contract 0.15.57: one request per cooldown (429 rate_limited); a refusal is shown, never swallowed
  const notify = () => {
    setBusy(true);
    setErr('');
    api.post('/me/notify-admins', { body: {} })
      .then(() => setSent(true))
      .catch((e: unknown) => setErr(e instanceof ApiError && e.code === 'rate_limited' ? t('pending.rate_limited') : t('pending.failed')))
      .finally(() => setBusy(false));
  };
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <div className="card w-[min(460px,100%)] space-y-3 p-6" data-testid="pending-screen">
        <h1 className="text-xl font-bold">{t('pending.title')}</h1>
        <p className="text-mute">{t('pending.body')}</p>
        <p>{session.user?.display_name} {session.user?.employee_id && <IdBadge employeeId={session.user.employee_id} />}</p>
        <button className="btn" data-testid="pending-notify" disabled={sent || busy} onClick={notify}>{t('pending.notify')}</button>
        {sent && <p role="status" className="text-doneInk">{t('pending.sent')}</p>}
        {err && <p role="alert" data-testid="pending-notify-error" className="text-lateInk">{err}</p>}
      </div>
    </div>
  );
}
