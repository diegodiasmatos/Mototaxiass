/* Assis MotoTáxi — service worker (instalação no celular + resiliência offline).
   Política deliberada:
   - API, SSE e documentos: SEMPRE rede, nunca cache (dados sensíveis e em tempo real).
   - HTML/CSS/JS: rede primeiro, cache como reserva → nunca serve código velho.
   - Imagens e mapas: cache primeiro (economiza dados do celular do usuário). */
'use strict';

const VERSION = 'amt-v1';
const SHELL = `${VERSION}-shell`;
const MEDIA = `${VERSION}-media`;

const PRECACHE = [
  '/', '/motorista', '/admin',
  '/css/app.css', '/js/common.js', '/js/passenger.js', '/js/driver.js', '/js/admin.js',
  '/img/icon.svg', '/img/icon-192.png', '/offline.html',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // falha em um item não pode abortar a instalação inteira
    await Promise.allSettled(PRECACHE.map(u => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'skip-waiting') self.skipWaiting(); });

/* ---------- Web Push: chamadas de corrida com o app fechado ---------- */
self.addEventListener('push', event => {
  let d = { title: 'Assis MotoTáxi', body: '', url: '/' };
  try { if (event.data) d = { ...d, ...event.data.json() }; }
  catch { if (event.data) d.body = event.data.text(); }

  const isOffer = d.kind === 'ride_offer';
  event.waitUntil(self.registration.showNotification(d.title, {
    body: d.body || '',
    icon: '/img/icon-192.png',
    badge: '/img/icon-192.png',
    tag: d.tag || d.kind || 'amt',
    renotify: true,
    requireInteraction: isOffer || d.kind === 'confirm_required',
    vibrate: isOffer ? [200, 100, 200, 100, 200] : [120],
    data: { url: d.url || '/', rideId: d.rideId, kind: d.kind },
    actions: isOffer ? [{ action: 'open', title: 'Ver corrida' }] : [],
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(self.location.origin)) {
        await c.focus();
        c.postMessage({ type: 'notification-click', data: event.notification.data });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

function isApi(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/');
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // nunca interceptar API, eventos em tempo real ou documentos privados
  if (url.origin === self.location.origin && isApi(url)) return;

  // navegação (abrir uma tela): rede primeiro, cache, e por fim página offline
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        return (await caches.match(req))
          || (await caches.match('/offline.html'))
          || new Response('Sem conexão', { status: 503 });
      }
    })());
    return;
  }

  // imagens próprias e tiles de mapa: cache primeiro
  // Nunca interceptar o Google Maps: ele gerencia o próprio cache e
  // precisa das requisições originais para a cobrança/uso funcionarem.
  if (/(^|\.)googleapis\.com$|(^|\.)gstatic\.com$|(^|\.)google\.com$/.test(url.hostname)) return;

  const isMedia = /\.(png|jpg|jpeg|svg|webp|ico)$/i.test(url.pathname)
    || url.hostname.endsWith('tile.openstreetmap.org');
  if (isMedia) {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const fresh = await fetch(req);
        if (fresh.ok && (url.origin === self.location.origin || fresh.type === 'cors')) {
          const cache = await caches.open(MEDIA);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch {
        return caches.match('/img/icon.svg') || new Response('', { status: 504 });
      }
    })());
    return;
  }

  // CSS/JS (inclusive CDN do Leaflet): rede primeiro, cache como reserva
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh.ok) {
        const cache = await caches.open(SHELL);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch {
      return (await caches.match(req)) || new Response('', { status: 504 });
    }
  })());
});
