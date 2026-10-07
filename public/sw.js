/* Slowly · 离线外壳
   只缓存界面文件，让"电脑关机时手机打开页面"还能看到界面并给出提示。
   数据接口（/api/）一律不缓存，始终走网络。 */
const CACHE = "slowly-shell-v1";
const SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/manifest.webmanifest",
  "/assets/slowly-icon.svg",
  "/assets/slowly-256.png",
  "/assets/slowly-32.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;   // 数据永远走网络

  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/index.html")))
  );
});
