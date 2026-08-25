// M13-W7 最小离线壳：仅缓存 SPA 壳资源；API/SSE 永不缓存（网络直连）。
// daemon 不可达 fallback：fetch 失败且非 API → 离线提示页（service worker 拦截）。
const CACHE = 'ecode-shell-v1'
const OFFLINE_URL = '/offline.html'

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', OFFLINE_URL, '/icon.svg'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.pathname.startsWith('/api/')) return // API/SSE 直连
  if (e.request.method !== 'GET') return
  // 壳资源：缓存优先回退网络；失败回 offline.html
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit ??
        fetch(e.request)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone()
              void caches.open(CACHE).then((c) => c.put(e.request, copy))
            }
            return res
          })
          .catch(() => caches.match(OFFLINE_URL)),
    ),
  )
})
