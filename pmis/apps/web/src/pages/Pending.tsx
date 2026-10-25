import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { Session } from '@/api/types';
import { IdBadge } from '@/components/PersonTag';

export function Pending({ session }: { session: Session }) {
  const { t } = useTranslation();
  const [sent, setSent] = useState(false);
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <div className="card w-[min(460px,100%)] space-y-3 p-6" data-testid="pending-screen">
        <h1 className="text-xl font-bold">{t('pending.title')}</h1>
        <p className="text-mute">{t('pending.body')}</p>
        <p>{session.user?.display_name} {session.user?.employee_id && <IdBadge employeeId={session.user.employee_id} />}</p>
        <button className="btn" data-testid="pending-notify" disabled={sent} onClick={() => void api.post('/me/notify-admins', { body: {} }).then(() => setSent(true))}>{t('pending.notify')}</button>
        {sent && <p role="status" className="text-doneInk">{t('pending.sent')}</p>}
      </div>
    </div>
  );
}
