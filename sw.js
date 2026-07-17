// Service Worker для «Зав. Склад» — обеспечивает установку приложения
// на телефон (PWA). Данные всегда идут напрямую в Firebase (сеть нужна),
// кешируется только "каркас" приложения — HTML/CSS/JS/иконки.

const CACHE_NAME = 'zavsklad-shell-v8';
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './firebase-config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Каркас приложения — cache-first (быстрая загрузка + установка).
  // Всё остальное (Firebase, CDN, API) — сеть напрямую, без вмешательства.
  const url = new URL(req.url);
  const isShell = url.origin === self.location.origin;

  if (!isShell) return; // не трогаем внешние запросы (Firebase, CDN)

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => cached);
    })
  );
});
