// ClaimGuard offline worker. Generated at build time from sw.template.js.
const VERSION = __VERSION__;
const PRECACHE = __PRECACHE__;
const CACHE = `claimguard-${VERSION}`;
const RUNTIME = "claimguard-runtime-v1";
const CACHE_ON_USE = [/\/ocr-runtime\/core\//, /^https:\/\/www\.gstatic\.com\/firebasejs\//];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith("claimguard-") && key !== CACHE && key !== RUNTIME).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return; // Model calls and App Check are POSTs: never cached.
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  const onUse = CACHE_ON_USE.some(pattern => pattern.test(url.href));
  // App code: network first so a new deploy is never mixed with old cached modules; the cache is
  // the offline fallback. Large, versioned runtime files (OCR core, Firebase SDK): cache first.
  if (sameOrigin && !onUse) {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(RUNTIME).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(async () => (await caches.match(request, { ignoreSearch: true })) ?? caches.match("./")));
    return;
  }
  if (onUse) {
    event.respondWith(caches.match(request).then(cached => cached ?? fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(RUNTIME).then(cache => cache.put(request, copy));
      }
      return response;
    })));
  }
});
