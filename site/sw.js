// Service Worker: 外殼網路優先(確保更新),ffmpeg 大檔案快取優先(獨立快取,更新 App 不會丟掉 31 MB)
const SHELL_CACHE = 'tts-shell-v1';
const VENDOR_CACHE = 'tts-vendor-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'core.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== SHELL_CACHE && k !== VENDOR_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;           // Gemini API 等跨來源請求完全不攔截

  if (url.pathname.includes('/vendor/')) {
    e.respondWith(
      caches.open(VENDOR_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok && res.status === 200) cache.put(req, res.clone()).catch(() => {});
        return res;
      }),
    );
    return;
  }

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./'))),
  );
});
