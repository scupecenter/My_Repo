// Service worker of GSDN Workspace for Web Push (item 13). It only shows a fixed, generic notice and opens the inbox. The push message carries no
// site, task or record text; the detail is read in the app after sign-in. The bell and the e-mail are not affected.
self.addEventListener('push', (event) => {
  let url = '/inbox';
  try { const d = event.data ? event.data.json() : null; if (d && typeof d.url === 'string' && d.url.startsWith('/')) url = d.url; } catch (_e) { /* fixed notice below */ }
  event.waitUntil(self.registration.showNotification('GSDN Workspace', { body: 'You have a new notification. / لديك إشعار جديد.', tag: 'gsdn-notification', renotify: true, data: { url }, dir: 'auto' }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/inbox';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.navigate(url).catch(() => undefined); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
