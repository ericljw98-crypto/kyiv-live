'use strict';

const CACHE = 'kyiv-live-v10';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './zh.js',
  './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png',
  './icon-maskable-512.png', './config.json', './version.json', './aftermath.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map((a) => cache.add(a).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API 一律走网络：民防信息不允许被离线缓存伪装成实时状态
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(req);
      if (fresh.ok && url.origin === self.location.origin) {
        cache.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      return new Response('离线且无缓存', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
