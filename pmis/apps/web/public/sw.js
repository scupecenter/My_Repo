/* Field mode service worker (contract 0.15.340). It caches ONLY the app shell: the page and its built files, which are the same for every user.
 * It never touches /api/: no answer of the server is stored here, so nothing of one person can reach another on a shared device. The lists a person sees
 * offline are kept by the app itself in a database of that person (see src/lib/fieldOutbox.ts) and wiped on sign-out.
 * It is registered by the app only while the setting ui.features > field_pwa.enabled is on, and removed when it is turned off. */
const SHELL = 'gsdn-field-shell-v1';
const SHELL_FILES = ['/index.html', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('gsdn-field-') && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'wipe') e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('gsdn-field-')).map((k) => caches.delete(k)))));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    // the page: the network first, the cached shell when there is no connection
    e.respondWith(fetch(req).catch(() => caches.match('/index.html').then((r) => r || Response.error())));
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
    // built files have a hash in the name: the cached copy is the right one
    e.respondWith(
      caches.open(SHELL).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok) void c.put(req, res.clone()); return res; }))),
    );
  }
});
