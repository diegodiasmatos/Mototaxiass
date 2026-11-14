/* VAIRO — utilitários compartilhados (passageiro, motorista, empresa, central).
   Depende de icons.js, carregado antes deste arquivo. */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const init = { headers: {}, credentials: 'same-origin', ...opts };
  if (opts.body !== undefined && typeof opts.body !== 'string') {
    init.body = JSON.stringify(opts.body);
    init.headers['Content-Type'] = 'application/json';
  }
  let r;
  try { r = await fetch(path, init); }
  catch { throw new Error('Sem conexão com o servidor. Verifique sua internet.'); }
  let data = {};
  try { data = await r.json(); } catch { /* respostas sem corpo */ }
  if (!r.ok) {
    const err = new Error(data.error || `Erro ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

/* ---------- formatação (pt-BR) ---------- */
const fmt = {
  money: c => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
  dist: m => m >= 1000 ? `${(m / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km` : `${Math.round(m)} m`,
  dur: s => s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round(s % 3600 / 60)}min` : `${Math.max(1, Math.round(s / 60))} min`,
  dt: ts => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
  date: ts => new Date(ts).toLocaleDateString('pt-BR'),
  time: ts => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
  ago(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'agora';
    if (s < 3600) return `${Math.floor(s / 60)} min atrás`;
    if (s < 86400) return `${Math.floor(s / 3600)}h atrás`;
    return fmt.date(ts);
  },
  initials: name => (name || '?').split(' ').filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join(''),
};

const STATUS_PT = {
  pending_payment: 'Aguardando pagamento',
  requested: 'Procurando mototaxista', accepted: 'Mototaxista a caminho',
  in_progress: 'Em andamento', awaiting_confirmation: 'Aguardando confirmação',
  completed: 'Concluída', cancelled: 'Cancelada', disputed: 'Em análise',
};
const STATUS_PILL = {
  pending_payment: 'yellow', requested: 'yellow', accepted: 'blue', in_progress: 'blue',
  awaiting_confirmation: 'yellow', completed: 'green', cancelled: 'red', disputed: 'red',
};
const PAY_PT = { dinheiro: '💵 Dinheiro', pix: '⚡ Pix', cartao: '💳 Cartão' };
const PAYMENT_STATUS_PT = {
  criado: 'criado', aguardando_pagamento: 'aguardando pagamento', autorizado: 'autorizado',
  pago: 'pago', recusado: 'recusado', estornado: 'estornado', cancelado: 'cancelado',
  dinheiro_pendente: 'a receber em dinheiro', dinheiro_recebido: 'recebido em dinheiro',
  expirado: 'expirado',
};

/* ---------- toasts ---------- */
function toast(msg, type = '') {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 3800);
}

/**
 * Executa a ação mostrando carregamento no botão e sinalizando sucesso/erro.
 * Evita duplo clique (fonte comum de pagamento/corrida duplicados).
 */
async function withLoading(btn, fn, { okMsg, errToast = true } = {}) {
  if (!btn || btn.classList.contains('is-loading')) return;
  btn.classList.add('is-loading');
  btn.disabled = true;
  try {
    const out = await fn();
    btn.classList.remove('is-loading');
    btn.classList.add('is-ok');
    if (okMsg) toast(okMsg, 'ok');
    setTimeout(() => btn.classList.remove('is-ok'), 1200);
    btn.disabled = false;
    return out;
  } catch (e) {
    btn.classList.remove('is-loading');
    btn.classList.add('is-err');
    setTimeout(() => btn.classList.remove('is-err'), 1600);
    btn.disabled = false;
    if (errToast) toast(e.message, 'err');
    throw e;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- SSE (tempo real) com reconexão e replay ---------- */
let _sse = null;
let _lastEventAt = 0;
const _seenNotifications = new Set();

/**
 * Conecta ao fluxo de eventos. Ao reconectar, busca no servidor o que foi
 * perdido enquanto esteve offline (replay por `since`), descartando repetidos.
 * Assim nenhuma notificação importante some por queda de internet.
 */
function connectSSE(handlers) {
  if (_sse) _sse.close();
  _sse = new EventSource('/api/events');
  _lastEventAt = _lastEventAt || Date.now();

  const wrap = (event, fn) => _sse.addEventListener(event, e => {
    let data = {};
    try { data = JSON.parse(e.data); } catch { }
    _lastEventAt = Date.now();
    if (event === 'notification') {
      if (data.id && _seenNotifications.has(data.id)) return;   // dedup
      if (data.id) {
        _seenNotifications.add(data.id);
        api(`/api/notifications/${data.id}/ack`, { method: 'POST' }).catch(() => { });
      }
    }
    fn(data);
  });

  for (const [event, fn] of Object.entries(handlers)) wrap(event, fn);

  _sse.addEventListener('hello', async () => {
    // reconectou: recupera o que perdeu
    if (!handlers.notification) return;
    try {
      const { notifications } = await api(`/api/notifications?since=${_lastEventAt - 60000}`);
      for (const n of notifications.reverse()) {
        if (_seenNotifications.has(n.id)) continue;
        _seenNotifications.add(n.id);
        handlers.notification(n);
      }
    } catch { /* tenta na próxima */ }
  });

  _sse.onerror = () => { /* EventSource reconecta sozinho (retry: 3000) */ };

  // sinaliza perda de conexão em tempo real
  setInterval(() => {
    const dead = _sse && _sse.readyState === EventSource.CLOSED;
    document.body.classList.toggle('realtime-down', !!dead);
  }, 5000);
  return _sse;
}

/* ---------- notificações do navegador (opt-in) ---------- */
function canBrowserNotify() { return 'Notification' in window; }
async function askNotifPermission() {
  if (!canBrowserNotify()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}
function browserNotify(title, body) {
  if (canBrowserNotify() && Notification.permission === 'granted' && document.hidden) {
    try { new Notification(title, { body, icon: '/img/icon-192.png' }); } catch { }
  }
}

/* ---------- Web Push: receber chamadas com o app fechado ---------- */
function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

/**
 * Ativa as notificações do sistema: pede permissão, inscreve no Web Push e
 * registra o aparelho no servidor. Retorna um texto explicando o resultado.
 */
async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: false, msg: 'Este navegador não aceita notificações. Mantenha o app aberto para receber os avisos na tela.' };
  }
  if (!await askNotifPermission()) {
    return { ok: false, msg: 'Permissão negada. Autorize as notificações nas configurações do navegador.' };
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = await api('/api/push/key');
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(publicKey),
      });
    }
    const j = sub.toJSON();
    await api('/api/push/subscribe', {
      method: 'POST', body: { endpoint: j.endpoint, keys: j.keys },
    });
    return { ok: true, msg: 'Notificações ativadas! Você será avisado mesmo com o app fechado. 🔔' };
  } catch (e) {
    return { ok: false, msg: `Não foi possível ativar o push: ${e.message}. Os avisos continuam aparecendo com o app aberto.` };
  }
}

/**
 * Diagnóstico honesto das notificações no aparelho atual.
 * No iPhone o push só existe depois que o app é instalado na tela de início
 * (limitação do iOS, não do sistema) — aqui isso é dito com todas as letras.
 */
function notificationDiagnosis() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = isStandalone();
  const hasSW = 'serviceWorker' in navigator;
  const hasPush = 'PushManager' in window;
  const perm = canBrowserNotify() ? Notification.permission : 'indisponível';

  const items = [];
  if (ios && !standalone) {
    items.push({
      ok: false, critical: true,
      title: 'Instale o app para receber avisos com a tela desligada',
      detail: 'No iPhone, o Safari só entrega notificações depois que o app é adicionado à Tela de Início: toque em Compartilhar → "Adicionar à Tela de Início" e abra pelo ícone.',
    });
  } else if (!hasPush) {
    items.push({
      ok: false, critical: true,
      title: 'Este navegador não entrega notificações em segundo plano',
      detail: 'Mantenha o aplicativo aberto para receber as chamadas na tela. No Android, use o Chrome e instale o app.',
    });
  } else {
    items.push({
      ok: perm === 'granted',
      title: perm === 'granted' ? 'Notificações autorizadas' : 'Notificações ainda não autorizadas',
      detail: perm === 'denied'
        ? 'Você negou antes. Reautorize nas configurações do navegador (site → Notificações → Permitir).'
        : perm === 'granted' ? 'Você recebe chamadas mesmo com o app fechado.'
          : 'Toque no botão abaixo para ativar.',
    });
  }
  items.push({
    ok: standalone,
    title: standalone ? 'App instalado na tela de início' : 'Rodando pelo navegador',
    detail: standalone ? 'Modo aplicativo: tela cheia e notificações mais confiáveis.'
      : 'Instalar melhora a entrega dos avisos e abre em tela cheia.',
  });
  items.push({
    ok: hasSW,
    title: hasSW ? 'Service worker ativo' : 'Service worker indisponível',
    detail: hasSW ? 'Responsável por entregar o aviso com o app fechado.'
      : 'Acesse por HTTPS (ou localhost) para habilitar.',
  });
  return { ios, standalone, items, canPush: hasPush && !(ios && !standalone) };
}

/** Desenha o diagnóstico + botão de ativar/testar dentro de um elemento. */
function renderNotificationStatus(el) {
  const d = notificationDiagnosis();
  el.innerHTML = d.items.map(i => `
    <div class="list-item">
      <span style="font-size:1.2rem">${i.ok ? '✅' : (i.critical ? '⛔' : '⚠️')}</span>
      <div class="li-main"><div class="li-title">${escapeHtml(i.title)}</div>
        <div class="li-sub">${escapeHtml(i.detail)}</div></div>
    </div>`).join('') + `
    <div class="row mt" style="flex-wrap:wrap">
      ${d.canPush ? '<button class="btn btn-primary btn-sm" data-enable-push>Ativar notificações</button>' : ''}
      ${d.canPush ? '<button class="btn btn-outline btn-sm" data-test-push>Enviar teste</button>' : ''}
      ${!d.standalone ? '<button class="btn btn-navy btn-sm" data-install-app>📲 Instalar app</button>' : ''}
    </div>`;

  const en = $('[data-enable-push]', el);
  if (en) en.onclick = () => withLoading(en, async () => {
    const r = await enablePush();
    toast(r.msg, r.ok ? 'ok' : 'err');
    renderNotificationStatus(el);
  });
  const tp = $('[data-test-push]', el);
  if (tp) tp.onclick = () => withLoading(tp, async () => {
    const r = await api('/api/push/test', { method: 'POST' });
    toast(r.sent
      ? `Teste enviado para ${r.sent} aparelho(s).`
      : 'Nenhum aparelho inscrito ainda — toque em "Ativar notificações".',
      r.sent ? 'ok' : 'err');
  });
  const ia = $('[data-install-app]', el);
  if (ia) ia.onclick = promptInstall;
}

/** Reaplica a inscrição silenciosamente a cada sessão (o endpoint pode mudar). */
async function refreshPushSubscription() {
  try {
    if (!('serviceWorker' in navigator) || Notification?.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) { await enablePush(); return; }
    const j = sub.toJSON();
    await api('/api/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys } });
  } catch { /* silencioso */ }
}

/* ---------- instalação no celular (PWA) ---------- */
let _installPrompt = null;

if ('serviceWorker' in navigator) {
  // registra só em HTTPS ou localhost (exigência do navegador)
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* opcional */ });
  });
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _installPrompt = e;
  showInstallButton();
});
// iOS e navegadores sem o evento: mostra o botão com instruções manuais
addEventListener('DOMContentLoaded', () => setTimeout(showInstallButton, 1500));
window.addEventListener('appinstalled', () => {
  _installPrompt = null;
  $('#install-btn')?.remove();
  toast('App instalado! Procure o ícone na tela inicial. 🏍️', 'ok');
});

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

/** Botão flutuante de instalação; no iPhone mostra as instruções manuais. */
function showInstallButton() {
  if (isStandalone() || $('#install-btn')) return;
  const b = document.createElement('button');
  b.id = 'install-btn';
  b.innerHTML = '📲 Instalar app';
  b.onclick = promptInstall;
  document.body.appendChild(b);
}

async function promptInstall() {
  if (_installPrompt) {
    _installPrompt.prompt();
    const { outcome } = await _installPrompt.userChoice;
    _installPrompt = null;
    if (outcome === 'accepted') $('#install-btn')?.remove();
    return;
  }
  // iOS (Safari) não oferece prompt automático
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  openModal(`
    <h3>📲 Instalar a VAIRO</h3>
    ${ios ? `
      <p class="muted mb">No iPhone, use o Safari e siga:</p>
      <div class="list-item"><div class="li-main"><div class="li-title">1. Toque em Compartilhar</div>
        <div class="li-sub">O ícone do quadrado com a seta para cima, na barra de baixo.</div></div></div>
      <div class="list-item"><div class="li-main"><div class="li-title">2. Toque em "Adicionar à Tela de Início"</div>
        <div class="li-sub">Role a lista de opções até encontrar.</div></div></div>
      <div class="list-item"><div class="li-main"><div class="li-title">3. Confirme em "Adicionar"</div>
        <div class="li-sub">O ícone da VAIRO aparece junto dos seus apps.</div></div></div>`
      : `
      <p class="muted mb">No Android (Chrome), siga:</p>
      <div class="list-item"><div class="li-main"><div class="li-title">1. Toque no menu ⋮</div>
        <div class="li-sub">Os três pontinhos no canto superior direito do navegador.</div></div></div>
      <div class="list-item"><div class="li-main"><div class="li-title">2. Toque em "Instalar app"</div>
        <div class="li-sub">Pode aparecer como "Adicionar à tela inicial".</div></div></div>
      <div class="list-item"><div class="li-main"><div class="li-title">3. Confirme</div>
        <div class="li-sub">O app abre em tela cheia, igual a um aplicativo da loja.</div></div></div>`}
  `);
}

/* ---------- barra de offline ---------- */
window.addEventListener('offline', () => {
  if ($('#offline-bar')) return;
  const b = document.createElement('div');
  b.id = 'offline-bar'; b.textContent = '📡 Sem internet — tentando reconectar…';
  document.body.appendChild(b);
});
window.addEventListener('online', () => { $('#offline-bar')?.remove(); toast('Conexão restabelecida', 'ok'); });

/* ============================================================
   MAPA — adaptador único para Mapbox GL JS e Leaflet/OpenStreetMap.
   O resto do aplicativo usa sempre a mesma API (makeMap, emojiMarker,
   drawRoute, accuracyCircle), sem saber qual provedor está ativo.
   O Mapbox entra quando há token público configurado; sem ele, o
   OpenStreetMap continua funcionando (mapa real, não simulado).
   ============================================================ */

// Versão fixa de propósito: uma versão nova só entra depois de testada aqui.
const MAPBOX_GL_VERSION = '3.33.0';
const MAPBOX_DEFAULT_STYLE = 'mapbox://styles/mapbox/streets-v12';

let _mapsProvider = 'osm';
let _mapboxReady = null;
let _mapboxStyle = MAPBOX_DEFAULT_STYLE;
let _mapboxSeq = 0;

function mapsProvider() { return _mapsProvider; }
function hasLeaflet() { return typeof L !== 'undefined'; }

/**
 * O Mapbox recusou o token (inválido, revogado ou domínio fora da restrição
 * de URL): volta para o OpenStreetMap e manda as telas refazerem os mapas.
 */
function mapboxFailed(message) {
  if (_mapsProvider !== 'mapbox') return;
  _mapsProvider = 'osm';
  toast(message, 'err');
  // recria os mapas já abertos no provedor de reserva — fora do evento de
  // erro do próprio mapa, que não pode ser destruído enquanto o dispara
  setTimeout(() => document.dispatchEvent(
    new CustomEvent('maps-provider-changed', { detail: 'osm' })), 0);
}

/** Carrega o Mapbox GL JS (script + CSS) uma única vez. */
function loadMapboxGL() {
  if (_mapboxReady) return _mapboxReady;
  _mapboxReady = new Promise((resolve, reject) => {
    if (window.mapboxgl) { resolve(window.mapboxgl); return; }
    const base = `https://api.mapbox.com/mapbox-gl-js/v${MAPBOX_GL_VERSION}`;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${base}/mapbox-gl.css`;
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = `${base}/mapbox-gl.js`;
    s.async = true;
    s.onload = () => (window.mapboxgl
      ? resolve(window.mapboxgl)
      : reject(new Error('Mapbox GL carregou sem a biblioteca esperada.')));
    s.onerror = () => reject(new Error('Falha ao carregar o Mapbox GL.'));
    // rede lenta não pode travar a abertura do aplicativo
    setTimeout(() => reject(new Error('Mapbox GL demorou demais para responder.')), 9000);
    document.head.appendChild(s);
  });
  return _mapboxReady;
}

/**
 * Prepara o provedor de mapas a partir de /api/config.
 * Se o Mapbox falhar (sem rede, biblioteca bloqueada), cai para o
 * OpenStreetMap e avisa — nunca fica sem mapa silenciosamente.
 */
async function initMaps(config) {
  const token = config?.maps?.mapbox_token;
  if (!token) { _mapsProvider = 'osm'; return 'osm'; }
  try {
    const mb = await loadMapboxGL();
    mb.accessToken = token;
    _mapboxStyle = config.maps.style || MAPBOX_DEFAULT_STYLE;
    _mapsProvider = 'mapbox';
  } catch {
    _mapsProvider = 'osm';
    toast('Mapbox indisponível — usando OpenStreetMap.', 'err');
  }
  return _mapsProvider;
}

/* ---------- adaptador Mapbox com a mesma interface do Leaflet ---------- */

// O Mapbox usa blocos de 512 px: o zoom dele fica 1 abaixo do zoom do Leaflet.
const mbZoom = z => Math.max(0, z - 1);

function mapboxAdapter(el, center, zoom) {
  const mb = window.mapboxgl;
  const map = new mb.Map({
    container: el,
    style: _mapboxStyle,
    center: [center.lng, center.lat],
    zoom: mbZoom(zoom),
    language: 'pt-BR',
    attributionControl: false,
    // mapa sempre com o norte para cima: girar/inclinar sem querer confunde
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new mb.AttributionControl({ compact: true }), 'bottom-left');

  // rotas e círculos só podem entrar depois que o estilo carrega
  let ready = false, queue = [];
  map.once('load', () => { ready = true; queue.forEach(fn => fn()); queue = []; });
  map.on('error', e => {
    const status = e?.error?.status;
    if (status === 401 || status === 403) {
      mapboxFailed('Token do Mapbox recusado (confira o token e a restrição de URL). Usando OpenStreetMap.');
    }
  });

  const clickHandlers = new Map();
  return {
    _mapbox: map,
    _provider: 'mapbox',
    _whenReady(fn) { if (ready) fn(); else queue.push(fn); },
    setView([lat, lng], z) {
      map.jumpTo({ center: [lng, lat], ...(z ? { zoom: mbZoom(z) } : {}) });
    },
    fitBounds(bounds, opts = {}) {
      if (!bounds || bounds.isEmpty()) return;
      const pad = (opts.padding && opts.padding[0]) || 30;
      map.fitBounds(bounds, { padding: pad, maxZoom: 16, duration: 0 });
    },
    invalidateSize() { map.resize(); },
    on(evt, fn) {
      if (evt !== 'click') return;
      const h = e => fn({ latlng: { lat: e.lngLat.lat, lng: e.lngLat.lng } });
      clickHandlers.set(fn, h);
      map.on('click', h);
    },
    off(evt, fn) {
      const h = clickHandlers.get(fn);
      if (h) { map.off('click', h); clickHandlers.delete(fn); }
    },
    remove() { queue = []; map.remove(); },
  };
}

/** Polígono aproximando um círculo de `radius` metros (o Mapbox não tem círculo em metros). */
function circleFeature(lat, lng, radius, steps = 48) {
  const dLat = radius / 111320;
  const dLng = dLat / Math.max(0.01, Math.cos(lat * Math.PI / 180));
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

/**
 * Camada GeoJSON do Mapbox (fonte + camadas) com remoção segura: funciona
 * mesmo se pedida antes de o estilo carregar ou depois de o mapa ser destruído.
 */
function mapboxGeoLayer(map, data, layers) {
  const m = map._mapbox;
  const id = `amt-${++_mapboxSeq}`;
  let removed = false, added = false;
  map._whenReady(() => {
    if (removed) return;
    m.addSource(id, { type: 'geojson', data });
    // acima das ruas e abaixo dos nomes, para o traçado não cobrir o texto do mapa
    const before = m.getStyle().layers
      .find(l => l.type === 'symbol' && l.layout?.['text-field'])?.id;
    layers.forEach((layer, i) => m.addLayer({ ...layer, id: `${id}-${i}`, source: id }, before));
    added = true;
  });
  return {
    setData(next) { data = next; if (added && !removed) m.getSource(id)?.setData(next); },
    remove() {
      if (removed) return;
      removed = true;
      if (!added) return;
      try {
        layers.forEach((_, i) => { if (m.getLayer(`${id}-${i}`)) m.removeLayer(`${id}-${i}`); });
        if (m.getSource(id)) m.removeSource(id);
      } catch { /* mapa já destruído: não há o que remover */ }
    },
  };
}

function makeMap(elId, center, zoom = 14) {
  const el = document.getElementById(elId);
  if (!el) return null;

  if (_mapsProvider === 'mapbox' && window.mapboxgl) {
    try { return mapboxAdapter(el, center, zoom); }
    catch {
      // aparelho sem WebGL: o Mapbox não desenha — este mapa e os próximos
      // seguem no Leaflet abaixo
      _mapsProvider = 'osm';
      el.replaceChildren();
      el.classList.remove('mapboxgl-map');
    }
  }
  if (!hasLeaflet()) {
    el.innerHTML = '<div class="map-fallback">🗺️ O mapa não pôde ser carregado (sem internet?).<br>Os endereços e preços continuam funcionando normalmente.</div>';
    return null;
  }
  const map = L.map(el, { zoomControl: false, attributionControl: true })
    .setView([center.lat, center.lng], zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap',
  }).addTo(map);
  map._provider = 'osm';
  return map;
}

function emojiMarker(map, lat, lng, emoji, title = '') {
  if (!map) return null;
  if (map._provider === 'mapbox') {
    // mesmo visual dos marcadores do Leaflet: o emoji num elemento HTML
    const el = document.createElement('div');
    el.className = 'marker-moto';
    el.textContent = emoji;
    if (title) el.title = title;
    const marker = new window.mapboxgl.Marker({ element: el, anchor: 'center' })
      .setLngLat([lng, lat]).addTo(map._mapbox);
    return {
      setLatLng([la, ln]) { marker.setLngLat([ln, la]); return this; },
      remove() { marker.remove(); },
      _mapbox: marker,
    };
  }
  return L.marker([lat, lng], {
    title,
    icon: L.divIcon({ className: 'marker-moto', html: emoji, iconSize: [26, 26], iconAnchor: [13, 13] }),
  }).addTo(map);
}

/** geometry: [[lng,lat],...] (GeoJSON) */
function drawRoute(map, geometry, color = '#111118') {
  if (!map) return null;
  if (map._provider === 'mapbox') {
    const layout = { 'line-join': 'round', 'line-cap': 'round' };
    const layer = mapboxGeoLayer(map,
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: geometry } },
      [
        // contorno claro: a rota continua visível sobre ruas escuras e satélite
        { type: 'line', layout, paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': .7 } },
        { type: 'line', layout, paint: { 'line-color': color, 'line-width': 5, 'line-opacity': .85 } },
      ]);
    const bounds = new window.mapboxgl.LngLatBounds();
    geometry.forEach(c => bounds.extend(c));
    return {
      getBounds() { return bounds; },
      remove() { layer.remove(); },
    };
  }
  const latlngs = geometry.map(([lng, lat]) => [lat, lng]);
  return L.polyline(latlngs, { color, weight: 5, opacity: .75 }).addTo(map);
}

/** Círculo de precisão do GPS. */
function accuracyCircle(map, lat, lng, radius) {
  if (!map) return null;
  if (map._provider === 'mapbox') {
    const layer = mapboxGeoLayer(map, circleFeature(lat, lng, radius), [
      { type: 'fill', paint: { 'fill-color': '#2563eb', 'fill-opacity': .08 } },
      { type: 'line', paint: { 'line-color': '#2563eb', 'line-width': 1 } },
    ]);
    return {
      setLatLng([la, ln]) { lat = la; lng = ln; layer.setData(circleFeature(lat, lng, radius)); return this; },
      setRadius(r) { radius = r; layer.setData(circleFeature(lat, lng, radius)); return this; },
      remove() { layer.remove(); },
    };
  }
  return L.circle([lat, lng], {
    radius, color: '#2563eb', weight: 1, fillOpacity: .08,
  }).addTo(map);
}

/* ---------- geolocalização ---------- */
function getPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('Seu dispositivo não oferece GPS pelo navegador.')); return; }
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      err => reject(new Error(err.code === 1
        ? 'Permissão de localização negada. Autorize nas configurações do navegador.'
        : 'Não foi possível obter sua localização (GPS indisponível).')),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000, ...options });
  });
}

/* ---------- navegação de telas ---------- */
function showScreen(id) {
  $$('.screen').forEach(s => { s.hidden = s.id !== id; });
  $$('.bottomnav button').forEach(b => b.classList.toggle('active', b.dataset.screen === id));
  syncScreenMenu();
  window.scrollTo({ top: 0 });
}

/* ---------- modal genérico ---------- */
function openModal(html, { onClose } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal"><div class="drag"></div>${html}</div>`;
  back.addEventListener('click', e => { if (e.target === back) close(); });
  function close() { back.remove(); onClose?.(); }
  back.close = close;
  document.body.appendChild(back);
  return back;
}

function confirmModal(title, text, confirmLabel = 'Confirmar', danger = false) {
  return new Promise(resolve => {
    const m = openModal(`
      <h3>${escapeHtml(title)}</h3>
      <p class="muted mb">${escapeHtml(text)}</p>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${escapeHtml(confirmLabel)}</button>
      <button class="btn btn-outline mt" data-no>Voltar</button>
    `, { onClose: () => resolve(false) });
    // resolve ANTES de fechar: close() dispara onClose, que resolveria false
    $('[data-ok]', m).onclick = () => { resolve(true); m.close(); };
    $('[data-no]', m).onclick = () => { resolve(false); m.close(); };
  });
}

/* ---------- marca ---------- */
// "V" da VAIRO redesenhado a partir da referência (não havia o arquivo original).
const LOGO_MARK = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path fill="#fff" d="M3.4 4.8h4.7l3.9 10.4 3.9-10.4h4.7l-6.3 14.6H9.7z"/>
  <path d="M15.3 9.7l2.8-2.1" stroke="#090909" stroke-width=".95"/></svg>`;
const logoTile = (cls = '') => `<span class="logo-tile${cls ? ' ' + cls : ''}">${LOGO_MARK}</span>`;
/** Logo grande (tela de entrada da central). */
const LOGO_SVG = `<span class="logo-tile lg" role="img" aria-label="VAIRO">${LOGO_MARK}</span>`;

const BRAND_TAGLINE = 'A cidade no seu ritmo — Mobilidade & Marketplace';

function renderBrand(el, tagline) {
  if (!el) return;
  el.innerHTML = `${logoTile()}
    <span class="brand-text">
      <span class="brand-line"><span class="brand-name">VAIRO</span><span class="brand-badge">Pro Ecosystem</span></span>
      <span class="brand-tag">${escapeHtml(tagline || BRAND_TAGLINE)}</span>
    </span>`;
}

/* ---------- cabeçalho: áreas do ecossistema e tema ---------- */
const AREAS = [
  { id: 'visao', label: 'Visão Geral', href: '/visao-geral', icon: 'layer-group' },
  { id: 'passageiro', label: 'Passageiro', href: '/passageiro', icon: 'user' },
  { id: 'motorista', label: 'Motorista', href: '/motorista', icon: 'motorcycle' },
  { id: 'empresa', label: 'Empresa', href: '/empresa', icon: 'store' },
];

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}
function applyTheme(theme) {
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('vairo-theme', theme); } catch { /* modo privado */ }
  $('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#ffffff' : '#101014');
  const btn = $('#btn-theme');
  if (btn) {
    // no escuro o botão mostra o sol (como na referência); no claro, a lua
    btn.innerHTML = icon(theme === 'light' ? 'moon' : 'sun');
    btn.title = theme === 'light' ? 'Usar tema escuro' : 'Usar tema claro';
    btn.setAttribute('aria-label', btn.title);
  }
}

/**
 * Monta o cabeçalho comum: marca, áreas (Visão Geral · Passageiro ·
 * Motorista · Empresa) e botão de tema. A área ativa vem de
 * <body data-area="…">; a central administrativa não mostra as áreas.
 */
function initChrome() {
  const bar = $('.topbar');
  if (!bar) return;
  const area = document.body.dataset.area || '';
  renderBrand($('#brand'), area === 'central' ? 'Central Administrativa' : undefined);

  const anchor = $('#btn-notifs', bar) || null;
  if (area !== 'central' && !$('.areanav', bar)) {
    const nav = document.createElement('nav');
    nav.className = 'areanav';
    nav.setAttribute('aria-label', 'Áreas da VAIRO');
    nav.innerHTML = AREAS.map(a =>
      `<a href="${a.href}" class="${a.id === area ? 'active' : ''}"${a.id === area ? ' aria-current="page"' : ''}>${icon(a.icon)}${a.label}</a>`).join('');
    bar.insertBefore(nav, anchor);
  }
  if (!$('#btn-theme')) {
    const btn = document.createElement('button');
    btn.id = 'btn-theme';
    btn.className = 'iconbtn theme';
    btn.type = 'button';
    btn.onclick = () => applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
    bar.insertBefore(btn, anchor);
  }
  applyTheme(currentTheme());
  hydrateIcons();
}

/* ---------- submenu de telas da área ---------- */
/**
 * Seletor "Tela N de M" no topo de cada área, com as telas da referência.
 * Cada item:
 *   label  — nome da tela
 *   soon   — true quando a tela ainda não existe no app (fica desabilitada)
 *   match  — () => true quando o app está nessa tela agora
 *   go     — () => leva até a tela; devolve um texto quando não dá
 *            (ex.: "viagem ativa" sem corrida em andamento)
 * `fallback` devolve o nome da tela atual quando ela não está na lista
 * (ex.: Perfil), para o seletor nunca mostrar a tela errada.
 */
let _screenMenu = null;

function setupScreenMenu(items, fallback) {
  const sel = $('#screen-select');
  if (!sel) return;
  _screenMenu = { items, fallback, picked: -1 };
  sel.innerHTML = '<option value="" hidden></option>' + items.map((it, i) =>
    `<option value="${i}"${it.soon ? ' disabled' : ''}>${i + 1}. ${escapeHtml(it.label)}${it.soon ? ' — em breve' : ''}</option>`).join('');
  sel.onchange = () => {
    const i = Number(sel.value);
    const it = items[i];
    if (!it || it.soon) { syncScreenMenu(); return; }
    _screenMenu.picked = i;
    const msg = it.go();
    if (typeof msg === 'string' && msg) toast(msg);
    syncScreenMenu();
  };
  syncScreenMenu();
}

function syncScreenMenu() {
  const m = _screenMenu, sel = $('#screen-select');
  if (!m || !sel) return;
  const matches = m.items.map((it, i) => (!it.soon && it.match?.()) ? i : -1).filter(i => i >= 0);
  // várias telas da lista podem ser a mesma tela do app: vale a que o usuário escolheu
  const cur = matches.includes(m.picked) ? m.picked : (matches[0] ?? -1);
  if (cur !== m.picked) m.picked = -1;
  const count = $('#sb-count');
  if (cur >= 0) {
    sel.value = String(cur);
    if (count) count.textContent = `Tela ${cur + 1} de ${m.items.length}`;
  } else {
    sel.options[0].textContent = m.fallback?.() || '';
    sel.value = '';
    if (count) count.textContent = `${m.items.length} telas`;
  }
}

/* ---------- leitura de arquivos (upload base64 com compressão de imagem) ---------- */
function fileToDataUrl(file, maxDim = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (file.size > 10 * 1024 * 1024) { reject(new Error('Arquivo muito grande (máx. 10 MB).')); return; }
    if (file.type === 'application/pdf') {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('Falha ao ler o arquivo.'));
      fr.readAsDataURL(file);
      return;
    }
    if (!/^image\//.test(file.type)) { reject(new Error('Envie uma imagem ou PDF.')); return; }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Imagem inválida.')); };
    img.src = url;
  });
}

/* ---------- sino de notificações ---------- */
async function openNotifications() {
  try {
    const { notifications } = await api('/api/notifications');
    const items = notifications.length
      ? notifications.map(n => `
        <div class="list-item">
          <div class="li-main">
            <div class="li-title">${escapeHtml(n.title)}</div>
            <div class="li-sub">${escapeHtml(n.body || '')} · ${fmt.ago(n.created_at)}</div>
          </div>
          ${n.read ? '' : '<span class="pill yellow">nova</span>'}
        </div>`).join('')
      : '<div class="empty"><div class="eico">🔔</div>Nenhuma notificação por enquanto.</div>';
    openModal(`<h3>Notificações</h3><div>${items}</div>`);
    await api('/api/notifications/read', { method: 'POST' });
    $('#notif-badge')?.remove();
  } catch (e) { toast(e.message, 'err'); }
}

function setNotifBadge(count) {
  const btn = $('#btn-notifs');
  if (!btn) return;
  $('#notif-badge')?.remove();
  if (count > 0) {
    const b = document.createElement('span');
    b.id = 'notif-badge'; b.className = 'badge'; b.textContent = count > 9 ? '9+' : count;
    btn.appendChild(b);
  }
}

initChrome();
