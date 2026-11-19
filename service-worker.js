const CACHE_NAME = "artexplorer-cashbook-v7";
const APP_FILES = ["./", "./index.html", "./styles.css", "./app.js", "./supabase-config.js", "./manifest.webmanifest", "./artex-icon.jpg"];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  const url = new URL(event.request.url);
  if (url.pathname.endsWith("/supabase-config.local.js")) {
    event.respondWith(fetch(event.request).catch(() => new Response("window.ARTEPLORER_SUPABASE_CONFIG = null;", {
      status: 200,
      headers: { "Content-Type": "application/javascript; charset=utf-8" }
    })));
    return;
  }

  const updateFrequently = event.request.mode === "navigate" || /\.(js|css)$/.test(url.pathname);
  if (updateFrequently) {
    event.respondWith(fetch(event.request).then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
      }
      return response;
    }).catch(async () => {
      const cached = await caches.match(event.request);
      return cached || new Response("This page is unavailable offline.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }));
    return;
  }

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    return response;
  })));
});
