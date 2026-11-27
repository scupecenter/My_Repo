import { BellRing } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keyBytes, pushSupported, useMyPush, usePushSubscribe, usePushUnsubscribe } from '@/api/push';

/**
 * Profile > Notifications on this device (item 13, contract 0.15.105). Turns Web Push on or off for this browser only. The bell and the e-mail
 * stay as they are. When the server has no push keys the card says so and the button is off.
 */
export function PushSection() {
  const { t } = useTranslation();
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const supported = pushSupported();
  const q = useMyPush(endpoint);
  const sub = usePushSubscribe();
  const unsub = usePushUnsubscribe();
  useEffect(() => {
    if (!supported) return;
    void navigator.serviceWorker.getRegistration('/sw.js').then((r) => r?.pushManager.getSubscription()).then((s) => setEndpoint(s?.endpoint ?? null)).catch(() => undefined);
  }, [supported]);

  const turnOn = async () => {
    setErr(null);
    try {
      if (!q.data?.public_key) return;
      if ((await Notification.requestPermission()) !== 'granted') { setErr(t('push.denied')); return; }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const s = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(q.data.public_key) as BufferSource });
      const j = s.toJSON();
      await sub.mutateAsync({ endpoint: s.endpoint, keys: { p256dh: j.keys?.p256dh ?? '', auth: j.keys?.auth ?? '' }, user_agent: navigator.userAgent.slice(0, 300) });
      setEndpoint(s.endpoint);
    } catch { setErr(t('push.failed')); }
  };
  const turnOff = async () => {
    setErr(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const s = await reg?.pushManager.getSubscription();
      if (s) { await unsub.mutateAsync({ endpoint: s.endpoint }); await s.unsubscribe(); }
      setEndpoint(null);
    } catch { setErr(t('push.failed')); }
  };

  const on = q.data?.this_browser === true;
  return (
    <section className="card space-y-2 p-4" id="push" data-testid="profile-push">
      <h2 className="flex items-center gap-2 font-bold"><BellRing size={18} aria-hidden />{t('push.title')}</h2>
      <p className="text-sm text-mute">{t('push.note')}</p>
      {!q.data ? null : !q.data.enabled ? <p className="text-sm" data-testid="push-off">{t('push.server_off')}</p>
        : !supported ? <p className="text-sm" data-testid="push-unsupported">{t('push.unsupported')}</p>
        : (
          <div className="flex items-center gap-3">
            <span className="text-sm" data-testid="push-state">{on ? t('push.on') : t('push.off')}</span>
            {on
              ? <button type="button" className="btn" data-testid="push-disable" onClick={() => void turnOff()}>{t('push.disable')}</button>
              : <button type="button" className="btn btn-accent" data-testid="push-enable" onClick={() => void turnOn()}>{t('push.enable')}</button>}
          </div>)}
      {err && <p role="alert" className="text-sm text-danger" data-testid="push-error">{err}</p>}
    </section>
  );
}
