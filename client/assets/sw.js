const BUILD_ID = '__INPX_WEB_BUILD_ID__';
// Каталог сборки (build/appdir.js) без ведущего "/": иначе подстановка rootPath при распаковке изменила бы и его
const APP_DIR = '__INPX_WEB_APP_DIR__';
const CACHE_NAME = `inpx-web-shell-${BUILD_ID}`;
const BASE_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, '');
const withBase = (path) => `${BASE_PATH}${path}`;
const APP_SHELL = [
  '/index.html',
  '/pwa-icon.svg',
  '/pwa-icon-192.png',
  '/pwa-icon-512.png',
  '/reader-icon.svg',
  '/reader-icon-192.png',
  '/reader-icon-512.png',
  '/favicon.ico',
  '/reader-favicon.ico'
].map(withBase);

function noStoreRequest(request) {
  return new Request(request, {cache: 'no-store'});
}

function isFreshShellPath(pathname) {
  return [
    withBase('/'),
    withBase('/index.html'),
    withBase('/sw.js'),
    withBase('/manifest.webmanifest'),
    withBase('/reader.webmanifest'),
    withBase('/build-id.txt'),
    withBase('/version.txt')
  ].includes(pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('inpx-web-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET')
    return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin)
    return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(noStoreRequest(request))
        .then((response) => {
          // Кэшируем только саму страницу приложения: навигацией бывают и скачивания книг и резервных копий
          if (response.ok && [withBase('/'), withBase('/index.html')].includes(url.pathname)
              && (response.headers.get('content-type') || '').startsWith('text/html')) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(withBase('/index.html'), copy));
          }
          return response;
        })
        .catch(() => caches.match(withBase('/index.html')))
    );
    return;
  }

  if (isFreshShellPath(url.pathname)) {
    event.respondWith(
      fetch(noStoreRequest(request))
        .catch(() => (
          [withBase('/'), withBase('/index.html')].includes(url.pathname)
            ? caches.match(withBase('/index.html'))
            : caches.match(request)
        ))
    );
    return;
  }

  // Кэшируются только файлы сборки и APP_SHELL. Остальное (API, OPDS, книги, обложки, резервные копии) идёт мимо:
  // на Cache API не действует no-store, и после выхода из профиля следующий получил бы чужие данные
  if (!url.pathname.startsWith(withBase(`/${APP_DIR}/`)) && !APP_SHELL.includes(url.pathname))
    return;

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    }))
  );
});
