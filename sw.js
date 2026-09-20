/* 수업용 오프라인 캐시.

   교실에서 30명이 동시에 처음 접속하면 Pyodide 내려받기가 한꺼번에 몰린다.
   한 번 받은 것을 여기서 붙잡아 두면 그 다음 수업부터는 네트워크를 거의 쓰지 않는다.
   브라우저 캐시와 달리 용량 압박으로 먼저 버려지지 않고, 인터넷이 끊겨도 열린다. */

const VERSION = 'deep-v1';
const SHELL = `${VERSION}-shell`;   // 우리가 고치는 파일: 새 것이 있으면 조용히 갱신
const HEAVY = `${VERSION}-heavy`;   // 버전이 박힌 라이브러리: 한 번 받으면 그대로

const SHELL_FILES = [
  './',
  './index.html',
  './assets/styles.css',
  './assets/app.js',
  './assets/charts.js',
  './assets/py-client.js',
  './assets/share.js',
  './assets/store.js',
  './assets/worker.js',
  './assets/kernel.py',
  './vendor/plotly-cartesian.min.js',
  './vendor/plotly-locale-ko.js',
];

// 한 번 받으면 바뀌지 않는 것들 — 버전이 주소에 박혀 있거나 우리가 버전을 올릴 때만 바뀐다.
const isHeavy = (url) =>
  url.includes('/pyodide/') ||
  url.includes('cdn.jsdelivr.net') ||
  url.includes('/vendor/') ||
  url.endsWith('.whl') ||
  url.endsWith('.wasm') ||
  url.endsWith('.zip');

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) =>
      // 한 파일이 실패해도 설치 자체를 막지는 않는다.
      Promise.allSettled(SHELL_FILES.map((file) => cache.add(file)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => !name.startsWith(VERSION)).map((name) => caches.delete(name)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'clear-cache') {
    event.waitUntil(caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))));
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = request.url;
  if (url.startsWith('chrome-extension:') || url.includes('/__')) return;

  if (isHeavy(url)) {
    // 캐시 우선. 없으면 받아서 넣어 둔다.
    event.respondWith(
      caches.open(HEAVY).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        // 다른 출처의 응답이라도 CORS가 열려 있으면(jsdelivr가 그렇다) 저장된다.
        if (response.ok && response.type !== 'opaque') {
          cache.put(request, response.clone()).catch(() => {});
        }
        return response;
      })
    );
    return;
  }

  if (new URL(url).origin !== self.location.origin) return;

  // 우리 파일: 캐시를 바로 주고 뒤에서 새 것을 받아 둔다.
  event.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const hit = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone()).catch(() => {});
          return response;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});
