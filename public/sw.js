/* VAIRO — service worker (instalação no celular + resiliência offline).
   Política deliberada:
   - API, SSE e documentos: SEMPRE rede, nunca cache (dados sensíveis e em tempo real).
   - HTML/CSS/JS: rede primeiro, cache como reserva → nunca serve código velho.
   - Imagens e mapas: cache primeiro (economiza dados do celular do usuário).
   Atualização: o servidor troca a linha VERSION abaixo pela versão publicada
   (hash dos arquivos, server/version.ts). Mudou a versão, o navegador instala
   este arquivo de novo, o cache do app é trocado e a página avisa/recarrega.
   Login (cookie) e preferências (localStorage) não ficam no cache: não se perdem. */
'use strict';

const VERSION = 'amt-v4';
const SHELL = `${VERSION}-shell`;
// imagens e blocos do mapa: cache que sobrevive às versões (não baixa tudo de novo)
const MEDIA = 'amt-media';
const MEDIA_MAX = 600;

const PRECACHE = [
  '/visao-geral', '/passageiro', '/motorista', '/empresa', '/admin',
  '/css/app.css', '/fonts/inter-latin-var.woff2',
  '/js/icons.js', '/js/common.js', '/js/passenger.js', '/js/driver.js', '/js/admin.js',
  '/img/icon.svg?v=2', '/img/icon-192.png?v=2', '/offline.html',
  '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // falha em um item não pode abortar a instalação inteira;
    // 'reload' pula o cache HTTP do aparelho: guarda o arquivo da versão nova
    await Promise.allSettled(PRECACHE.map(u => cache.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // apaga só caches de versões antigas do app (o de imagens/mapa fica)
    await Promise.all(keys.filter(k => k !== SHELL && k !== MEDIA).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'skip-waiting') self.skipWaiting(); });

/* ---------- Web Push: chamadas de corrida com o app fechado ---------- */
self.addEventListener('push', event => {
  let d = { title: 'VAIRO', body: '', url: '/' };
  try { if (event.data) d = { ...d, ...event.data.json() }; }
  catch { if (event.data) d.body = event.data.text(); }

  const isOffer = d.kind === 'ride_offer';
  event.waitUntil(self.registration.showNotification(d.title, {
    body: d.body || '',
    icon: '/img/icon-192.png?v=2',
    badge: '/img/icon-192.png?v=2',
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
    const target = new URL(url, self.location.origin);
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // a mesma tela (passageiro, motorista ou central) já aberta: traz para frente e navega lá dentro
    for (const c of all) {
      if (new URL(c.url).pathname === target.pathname) {
        await c.focus();
        c.postMessage({ type: 'notification-click', data: event.notification.data });
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});

/** Mantém o cache de imagens/mapa abaixo do limite (apaga os mais antigos). */
async function trimMedia(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MEDIA_MAX; i++) await cache.delete(keys[i]);
}

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
  // Nunca interceptar o Mapbox (biblioteca, estilo, blocos do mapa): ele
  // gerencia o próprio cache e os termos de uso não permitem guardar os
  // blocos por fora. O mesmo vale para os scripts do Google (login).
  if (/(^|\.)mapbox\.com$|(^|\.)googleapis\.com$|(^|\.)gstatic\.com$|(^|\.)google\.com$/
    .test(url.hostname)) return;

  const isMedia = /\.(png|jpg|jpeg|svg|webp|ico)$/i.test(url.pathname)
    || url.hostname.endsWith('tile.openstreetmap.org');
  if (isMedia) {
    const own = url.origin === self.location.origin;
    event.respondWith((async () => {
      const cache = await caches.open(MEDIA);
      const hit = await cache.match(req);
      const refresh = fetch(req).then(fresh => {
        if (fresh.ok && (own || fresh.type === 'cors')) {
          cache.put(req, fresh.clone()).then(() => trimMedia(cache)).catch(() => { });
        }
        return fresh;
      });
      if (hit) {
        // imagem do próprio app (logo, ícones): mostra a guardada e confere em
        // segundo plano, para um logo novo aparecer na próxima abertura
        if (own) event.waitUntil(refresh.catch(() => { }));
        return hit;
      }
      try { return await refresh; }
      catch { return (await caches.match('/img/icon.svg?v=2')) || new Response('', { status: 504 }); }
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
