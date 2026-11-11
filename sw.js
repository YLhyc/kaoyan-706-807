// 考研背诵手卷 · 离线 PWA Service Worker (v2.5.0)
const CACHE_NAME = 'kaoyan-all-in-one-v3.2.1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './app.css?v=3.2.1',
  './app.js?v=3.2.1',
  './kubai_icons.js?v=3.1.2',
  './data/kaoyan_data.js?v=3.2.1',
  './data/kaoyan_data_pol.js?v=3.2.1',
  './version.json',
  './manifest.json',
  './favicon.svg',
  './icon-192.png',
  './icon-256.png',
  './icon-512.png',
  './icon.svg'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('SW pre-caching partial failure:', err);
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('SW purging old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 显式排除音视频大文件和 Range 请求（iOS Safari 依赖 206 Partial Content 进行拖动缓冲，Service Worker 缓存 206 会破坏断点续传）
  const isMedia = url.pathname.endsWith('.mp3') || 
                  url.pathname.endsWith('.wav') || 
                  url.pathname.endsWith('.m4a') || 
                  url.pathname.includes('/audio_cards/') || 
                  url.pathname.includes('/audio_xutao/') || 
                  url.pathname.includes('/audio_tuijie/');
  const isRange = event.request.headers.has('range');
  if (isMedia || isRange) {
    return; // 直接由浏览器原生网络引擎处理，绝不拦截与缓存
  }

  // 0. 核心数据包 (4MB+ 离线全量数据)：优先命中缓存秒级直开，彻底杜绝外网阻塞与移动端“加载中...”白屏假死
  if (url.pathname.endsWith('kaoyan_data.js') || url.pathname.endsWith('kaoyan_data_pol.js') || url.pathname.endsWith('kaoyan_all_manifest.json')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        }).catch(() => {
          // 弱网或离线时，即使带 query 参数也宽容回退到已有缓存
          return caches.match(event.request, { ignoreSearch: true });
        });
      })
    );
    return;
  }

  // 1. 版本检测清单走实时 Network-First (确保用户立即感知最新发布)
  if (url.pathname.endsWith('version.json')) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return networkResponse;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // 2. 核心样式与脚本（自带版本指纹，Cache-First 快速响应）
  const isStaticCode = url.pathname.endsWith('app.css') || 
                       url.pathname.endsWith('app.js') || 
                       url.pathname.endsWith('kubai_icons.js');

  if (isStaticCode) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        }).catch(() => caches.match(event.request, { ignoreSearch: true }));
      })
    );
    return;
  }

  // 3. PWA 页面主入口导航：Stale-While-Revalidate (彻底解决 iPhone PWA 白屏时间长，毫秒级秒开)
  if (event.request.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname === '/' || url.pathname.endsWith('/')) {
    event.respondWith(
      caches.match('./index.html').then((cached) => {
        const netFetch = fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', clone));
          }
          return networkResponse;
        }).catch(() => null);

        // 如果已有离线缓存，0ms 立即展示页面 (消除白屏)，后台静默更新缓存
        if (cached) return cached;
        return netFetch.then((res) => res || caches.match('./index.html'));
      })
    );
    return;
  }

  // 4. 其他静态资源 Cache-First
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && event.request.url.startsWith(self.location.origin)) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      }).catch(() => {
        return cachedResponse;
      });
    })
  );
});
