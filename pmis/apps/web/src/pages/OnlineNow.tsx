import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '@/api/hooks';
import { LIVE_POLL_MS, useActiveSessions, useRevokeSessions } from '@/api/settings';
import type { ActiveSession } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { PersonTag } from '@/components/PersonTag';
import { useToast } from '@/components/Toast';
import { isAdmin } from '@/lib/perm';

type Target = { session: ActiveSession } | { user: ActiveSession['user'] };

export function OnlineNow() {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useMe(true);
  const [f, setF] = useState({ q: '', status: '' });
  const list = useActiveSessions(f), revoke = useRevokeSessions();
  const [target, setTarget] = useState<Target | null>(null);
  const admin = isAdmin(me.data);
  const items = list.data ?? [];
  const when = (s: string) => new Date(s).toISOString().replace('T', ' ').slice(11, 19);
  return (
    <div data-testid="page-online" className="space-y-3">
      <div><h1 className="text-2xl font-bold">{t('nav.admin.online')}</h1><p className="text-mute">{t('online.subtitle', { seconds: LIVE_POLL_MS / 1000 })}</p></div>
      <div className="flex flex-wrap gap-2">
        <input className="input max-w-64" data-testid="online-search" aria-label={t('users.search')} placeholder={t('users.search')} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select className="input w-auto" data-testid="online-status" aria-label={t('users.status')} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">{t('users.all_statuses')}</option><option value="online">{t('online.online')}</option><option value="idle">{t('online.idle')}</option></select>
      </div>
      <div className="card overflow-x-auto"><table className="w-full text-sm">
        <thead className="border-b border-line bg-card2 text-mute"><tr>{['user', 'status', 'last', 'screen', 'since', 'client'].map((k) => <th key={k} className="p-2 text-start">{t(`online.col_${k}`)}</th>)}{admin && <th className="p-2 text-start">IP</th>}<th className="p-2" /></tr></thead>
        <tbody data-testid="online-list">
          {items.map((s) => (
            <tr key={s.session_id} className="border-b border-line" data-testid={`session-${s.session_id}`} data-status={s.status}>
              <td className="p-2"><PersonTag name={s.user.display_name} employeeId={s.user.employee_id} />{s.is_current && <span className="chip ms-2 bg-openBg text-openInk" data-testid="session-own">{t('online.you')}</span>}</td>
              <td className="p-2"><span className={`chip ${s.status === 'online' ? 'bg-doneBg text-doneInk' : 'bg-lockBg text-lockInk'}`}>{t(`online.${s.status}`)}</span></td>
              <td className="mono p-2 text-xs">{when(s.last_activity_at)}</td><td className="mono p-2 text-xs" dir="ltr">{s.current_screen ?? '—'}</td><td className="mono p-2 text-xs">{when(s.signed_in_at)}</td><td className="p-2">{t(`online.client_${s.client_type}`)}</td>
              {admin && <td className="mono p-2 text-xs" dir="ltr">{s.ip ?? '—'}</td>}
              <td className="p-2 text-end">{!s.is_current && (
                <span className="inline-flex gap-1">
                  <button className="btn" data-testid={`session-revoke-${s.session_id}`} onClick={() => setTarget({ session: s })}><LogOut size={14} />{t('online.end_session')}</button>
                  <button className="btn" data-testid={`user-revoke-${s.user.employee_id}-${s.session_id}`} onClick={() => setTarget({ user: s.user })}>{t('online.end_all')}</button></span>)}</td>
            </tr>))}
          {list.isSuccess && !items.length && <tr><td colSpan={8} className="p-6 text-center text-mute" data-testid="online-empty">{t('online.empty')}</td></tr>}
        </tbody>
      </table></div>
      {target && (
        <FormDialog open onClose={() => setTarget(null)} testid="revoke-session-dialog" title={t('session' in target ? 'online.end_session' : 'online.end_all')} busy={revoke.isPending} error={revoke.isError ? errText(revoke.error, t) : null}
          onSubmit={(reason) => revoke.mutate({ ...('session' in target ? { session: target.session } : { user: target.user }), reason }, { onSuccess: (r) => { toast(t('online.revoked', { count: r.revoked_count })); setTarget(null); } })}>
          <p className="text-sm text-mute">{t('online.revoke_note')}</p>
        </FormDialog>
      )}
    </div>
  );
}
