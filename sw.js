/* العمل بدون إنترنت: يحاول الشبكة أولاً (ليأخذ آخر تحديث) وخلال 3 ثوانٍ يرجع للنسخة المحفوظة. */
const CACHE = 'labor-offline-app';
const FILES = ['./', 'index.html', 'style.css', 'config.js', 'xlsx.js', 'core.js', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.endsWith('issuer.html')) return;            // صفحة الإصدار لا تُخزَّن
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const net = fetch(r).then(res => { if (res.ok) cache.put(r, res.clone()); return res; });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000));
    try { return await Promise.race([net, timeout]); }
    catch (err) {
      net.catch(() => {});
      const hit = await cache.match(r, { ignoreSearch: true });
      if (hit) return hit;
      if (r.mode === 'navigate') { const idx = await cache.match('index.html'); if (idx) return idx; }
      return new Response('offline', { status: 503 });
    }
  })());
});
