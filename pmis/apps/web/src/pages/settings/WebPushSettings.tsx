import { useTranslation } from 'react-i18next';
import { useAdminWebPush } from '@/api/push';
import { QueryFallback } from '@/components/States';

/**
 * Settings > Alerts > Web push (item 13, contract 0.15.105), System Admin, read only. Says plainly whether Web Push is on. It is on only when the server
 * has its VAPID keys in the environment (the app never creates or stores keys); nothing is set from this screen.
 */
export function WebPushSettings() {
  const { t, i18n } = useTranslation();
  const q = useAdminWebPush();
  if (!q.data) return <QueryFallback queries={[q]} />;
  const d = q.data;
  return (
    <div className="space-y-4" data-testid="settings-web-push">
      <div><h2 className="font-bold">{t('wps.title')}</h2><p className="text-sm text-mute">{t('wps.note')}</p></div>
      <p className={`card max-w-xl p-3 text-sm ${d.enabled ? '' : 'border-warn'}`} data-testid={d.enabled ? 'wps-on' : 'wps-off'}>{d.enabled ? t('wps.on') : t('wps.off')}</p>
      <dl className="grid max-w-xl grid-cols-2 gap-2">
        <div className="card p-3" data-testid="wps-browsers"><dt className="text-sm text-mute">{t('wps.browsers')}</dt><dd className="text-xl font-bold">{d.subscriptions}</dd></div>
        <div className="card p-3" data-testid="wps-people"><dt className="text-sm text-mute">{t('wps.people')}</dt><dd className="text-xl font-bold">{d.users}</dd></div>
      </dl>
      <p className="text-sm text-mute">{d.last_pushed_at ? t('wps.last', { at: new Date(d.last_pushed_at).toLocaleString(i18n.language) }) : t('wps.never')}</p>
    </div>
  );
}
