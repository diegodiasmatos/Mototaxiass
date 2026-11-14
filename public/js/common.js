/* VAIRO — utilitários compartilhados (passageiro, mototaxista, admin) */
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
    <h3>📲 Instalar o VAIRO</h3>
    ${ios ? `
      <p class="muted mb">No iPhone, use o Safari e siga:</p>
      <div class="list-item"><div class="li-main"><div class="li-title">1. Toque em Compartilhar</div>
        <div class="li-sub">O ícone do quadrado com a seta para cima, na barra de baixo.</div></div></div>
      <div class="list-item"><div class="li-main"><div class="li-title">2. Toque em "Adicionar à Tela de Início"</div>
        <div class="li-sub">Role a lista de opções até encontrar.</div></div></div>
      <div class="list-item"><div class="li-main"><div class="li-title">3. Confirme em "Adicionar"</div>
        <div class="li-sub">O ícone do mototáxi aparece junto dos seus apps.</div></div></div>`
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
   MAPA — adaptador único para Google Maps e Leaflet/OpenStreetMap.
   O resto do aplicativo usa sempre a mesma API (makeMap, emojiMarker,
   drawRoute, accuracyCircle), sem saber qual provedor está ativo.
   Google entra quando há chave de navegador configurada; sem ela, o
   OpenStreetMap continua funcionando (mapa real, não simulado).
   ============================================================ */

let _mapsProvider = 'osm';
let _googleReady = null;

function mapsProvider() { return _mapsProvider; }
function hasLeaflet() { return typeof L !== 'undefined'; }

/** Chamado pelo próprio Google quando a chave é inválida ou o domínio não é autorizado. */
window.gm_authFailure = () => {
  _mapsProvider = 'osm';
  toast('Chave do Google Maps recusada (verifique a restrição de domínio). Usando OpenStreetMap.', 'err');
  // recria os mapas já abertos no provedor de reserva
  document.dispatchEvent(new CustomEvent('maps-provider-changed', { detail: 'osm' }));
};

/** Carrega a Maps JavaScript API uma única vez. */
function loadGoogleMaps(key) {
  if (_googleReady) return _googleReady;
  _googleReady = new Promise((resolve, reject) => {
    if (window.google?.maps) { resolve(window.google.maps); return; }
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`
      + '&v=weekly&language=pt-BR&region=BR&libraries=geometry&loading=async';
    s.async = true;
    s.onload = () => (window.google?.maps
      ? resolve(window.google.maps)
      : reject(new Error('Google Maps carregou sem a biblioteca esperada.')));
    s.onerror = () => reject(new Error('Falha ao carregar o Google Maps.'));
    // rede lenta não pode travar a abertura do aplicativo
    setTimeout(() => reject(new Error('Google Maps demorou demais para responder.')), 9000);
    document.head.appendChild(s);
  });
  return _googleReady;
}

/**
 * Prepara o provedor de mapas a partir de /api/config.
 * Se a chave do Google falhar (domínio não autorizado, cota, sem rede),
 * cai para o OpenStreetMap e avisa — nunca fica sem mapa silenciosamente.
 */
async function initMaps(config) {
  const key = config?.maps?.browser_key;
  if (!key) { _mapsProvider = 'osm'; return 'osm'; }
  try {
    await loadGoogleMaps(key);
    _mapsProvider = 'google';
  } catch {
    _mapsProvider = 'osm';
    toast('Google Maps indisponível — usando OpenStreetMap.', 'err');
  }
  return _mapsProvider;
}

/* ---------- adaptador Google com a mesma interface do Leaflet ---------- */
function googleMapAdapter(el, center, zoom) {
  const gm = window.google.maps;
  const map = new gm.Map(el, {
    center: { lat: center.lat, lng: center.lng },
    zoom,
    disableDefaultUI: true,
    gestureHandling: 'greedy',
    clickableIcons: false,
    mapId: undefined,
  });
  const clickHandlers = new Map();

  return {
    _google: map,
    _provider: 'google',
    setView([lat, lng], z) { map.setCenter({ lat, lng }); if (z) map.setZoom(z); },
    fitBounds(bounds, opts = {}) {
      const pad = (opts.padding && opts.padding[0]) || 30;
      map.fitBounds(bounds, pad);
    },
    invalidateSize() { gm.event.trigger(map, 'resize'); },
    on(evt, fn) {
      if (evt !== 'click') return;
      const l = map.addListener('click', e => fn({ latlng: { lat: e.latLng.lat(), lng: e.latLng.lng() } }));
      clickHandlers.set(fn, l);
    },
    off(evt, fn) {
      const l = clickHandlers.get(fn);
      if (l) { l.remove(); clickHandlers.delete(fn); }
    },
    remove() { el.innerHTML = ''; },
  };
}

function makeMap(elId, center, zoom = 14) {
  const el = document.getElementById(elId);
  if (!el) return null;

  if (_mapsProvider === 'google' && window.google?.maps) {
    try { return googleMapAdapter(el, center, zoom); }
    catch { /* cai para o Leaflet abaixo */ }
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
  if (map._provider === 'google') {
    const gm = window.google.maps;
    const marker = new gm.Marker({
      position: { lat, lng }, map: map._google, title,
      // emoji desenhado como rótulo: mesmo visual dos marcadores do Leaflet
      label: { text: emoji, fontSize: '22px' },
      icon: {
        path: gm.SymbolPath.CIRCLE, scale: 0,
        fillOpacity: 0, strokeOpacity: 0,
      },
    });
    return {
      setLatLng([la, ln]) { marker.setPosition({ lat: la, lng: ln }); },
      remove() { marker.setMap(null); },
      _google: marker,
    };
  }
  return L.marker([lat, lng], {
    title,
    icon: L.divIcon({ className: 'marker-moto', html: emoji, iconSize: [26, 26], iconAnchor: [13, 13] }),
  }).addTo(map);
}

/** geometry: [[lng,lat],...] (GeoJSON) */
function drawRoute(map, geometry, color = '#0d1b2e') {
  if (!map) return null;
  if (map._provider === 'google') {
    const gm = window.google.maps;
    const path = geometry.map(([lng, lat]) => ({ lat, lng }));
    const line = new gm.Polyline({
      path, map: map._google,
      strokeColor: color, strokeWeight: 5, strokeOpacity: .75,
    });
    const bounds = new gm.LatLngBounds();
    path.forEach(p => bounds.extend(p));
    return {
      getBounds() { return bounds; },
      remove() { line.setMap(null); },
      _google: line,
    };
  }
  const latlngs = geometry.map(([lng, lat]) => [lat, lng]);
  return L.polyline(latlngs, { color, weight: 5, opacity: .75 }).addTo(map);
}

/** Círculo de precisão do GPS. */
function accuracyCircle(map, lat, lng, radius) {
  if (!map) return null;
  if (map._provider === 'google') {
    const c = new window.google.maps.Circle({
      map: map._google, center: { lat, lng }, radius,
      strokeColor: '#2563eb', strokeWeight: 1, fillColor: '#2563eb', fillOpacity: .08,
    });
    return {
      setLatLng([la, ln]) { c.setCenter({ lat: la, lng: ln }); return this; },
      setRadius(r) { c.setRadius(r); return this; },
      remove() { c.setMap(null); },
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

/* ---------- ícones: Font Awesome Free 6.5.2 (solid) — CC BY 4.0, https://fontawesome.com ---------- */
const ICONS = {
  layers: ['0 0 576 512', 'M264.5 5.2c14.9-6.9 32.1-6.9 47 0l218.6 101c8.5 3.9 13.9 12.4 13.9 21.8s-5.4 17.9-13.9 21.8l-218.6 101c-14.9 6.9-32.1 6.9-47 0L45.9 149.8C37.4 145.8 32 137.3 32 128s5.4-17.9 13.9-21.8L264.5 5.2zM476.9 209.6l53.2 24.6c8.5 3.9 13.9 12.4 13.9 21.8s-5.4 17.9-13.9 21.8l-218.6 101c-14.9 6.9-32.1 6.9-47 0L45.9 277.8C37.4 273.8 32 265.3 32 256s5.4-17.9 13.9-21.8l53.2-24.6 152 70.2c23.4 10.8 50.4 10.8 73.8 0l152-70.2zm-152 198.2l152-70.2 53.2 24.6c8.5 3.9 13.9 12.4 13.9 21.8s-5.4 17.9-13.9 21.8l-218.6 101c-14.9 6.9-32.1 6.9-47 0L45.9 405.8C37.4 401.8 32 393.3 32 384s5.4-17.9 13.9-21.8l53.2-24.6 152 70.2c23.4 10.8 50.4 10.8 73.8 0z'],
  user: ['0 0 448 512', 'M224 256A128 128 0 1 0 224 0a128 128 0 1 0 0 256zm-45.7 48C79.8 304 0 383.8 0 482.3C0 498.7 13.3 512 29.7 512H418.3c16.4 0 29.7-13.3 29.7-29.7C448 383.8 368.2 304 269.7 304H178.3z'],
  bike: ['0 0 640 512', 'M280 32c-13.3 0-24 10.7-24 24s10.7 24 24 24h57.7l16.4 30.3L256 192l-45.3-45.3c-12-12-28.3-18.7-45.3-18.7H64c-17.7 0-32 14.3-32 32v32h96c88.4 0 160 71.6 160 160c0 11-1.1 21.7-3.2 32h70.4c-2.1-10.3-3.2-21-3.2-32c0-52.2 25-98.6 63.7-127.8l15.4 28.6C402.4 276.3 384 312 384 352c0 70.7 57.3 128 128 128s128-57.3 128-128s-57.3-128-128-128c-13.5 0-26.5 2.1-38.7 6L418.2 128H480c17.7 0 32-14.3 32-32V64c0-17.7-14.3-32-32-32H459.6c-7.5 0-14.7 2.6-20.5 7.4L391.7 78.9l-14-26c-7-12.9-20.5-21-35.2-21H280zM462.7 311.2l28.2 52.2c6.3 11.7 20.9 16 32.5 9.7s16-20.9 9.7-32.5l-28.2-52.2c2.3-.3 4.7-.4 7.1-.4c35.3 0 64 28.7 64 64s-28.7 64-64 64s-64-28.7-64-64c0-15.5 5.5-29.7 14.7-40.8zM187.3 376c-9.5 23.5-32.5 40-59.3 40c-35.3 0-64-28.7-64-64s28.7-64 64-64c26.9 0 49.9 16.5 59.3 40h66.4C242.5 268.8 190.5 224 128 224C57.3 224 0 281.3 0 352s57.3 128 128 128c62.5 0 114.5-44.8 125.8-104H187.3zM128 384a32 32 0 1 0 0-64 32 32 0 1 0 0 64z'],
  store: ['0 0 576 512', 'M547.6 103.8L490.3 13.1C485.2 5 476.1 0 466.4 0H109.6C99.9 0 90.8 5 85.7 13.1L28.3 103.8c-29.6 46.8-3.4 111.9 51.9 119.4c4 .5 8.1 .8 12.1 .8c26.1 0 49.3-11.4 65.2-29c15.9 17.6 39.1 29 65.2 29c26.1 0 49.3-11.4 65.2-29c15.9 17.6 39.1 29 65.2 29c26.2 0 49.3-11.4 65.2-29c16 17.6 39.1 29 65.2 29c4.1 0 8.1-.3 12.1-.8c55.5-7.4 81.8-72.5 52.1-119.4zM499.7 254.9l-.1 0c-5.3 .7-10.7 1.1-16.2 1.1c-12.4 0-24.3-1.9-35.4-5.3V384H128V250.6c-11.2 3.5-23.2 5.4-35.6 5.4c-5.5 0-11-.4-16.3-1.1l-.1 0c-4.1-.6-8.1-1.3-12-2.3V384v64c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V384 252.6c-4 1-8 1.8-12.3 2.3z'],
  shield: ['0 0 512 512', 'M256 0c4.6 0 9.2 1 13.4 2.9L457.7 82.8c22 9.3 38.4 31 38.3 57.2c-.5 99.2-41.3 280.7-213.6 363.2c-16.7 8-36.1 8-52.8 0C57.3 420.7 16.5 239.2 16 140c-.1-26.2 16.3-47.9 38.3-57.2L242.7 2.9C246.8 1 251.4 0 256 0zm0 66.8V444.8C394 378 431.1 230.1 432 141.4L256 66.8l0 0z'],
  gauge: ['0 0 512 512', 'M0 256a256 256 0 1 1 512 0A256 256 0 1 1 0 256zM288 96a32 32 0 1 0 -64 0 32 32 0 1 0 64 0zM256 416c35.3 0 64-28.7 64-64c0-17.4-6.9-33.1-18.1-44.6L366 161.7c5.3-12.1-.2-26.3-12.3-31.6s-26.3 .2-31.6 12.3L257.9 288c-.6 0-1.3 0-1.9 0c-35.3 0-64 28.7-64 64s28.7 64 64 64zM176 144a32 32 0 1 0 -64 0 32 32 0 1 0 64 0zM96 288a32 32 0 1 0 0-64 32 32 0 1 0 0 64zm352-32a32 32 0 1 0 -64 0 32 32 0 1 0 64 0z'],
  utensils: ['0 0 448 512', 'M416 0C400 0 288 32 288 176V288c0 35.3 28.7 64 64 64h32V480c0 17.7 14.3 32 32 32s32-14.3 32-32V352 240 32c0-17.7-14.3-32-32-32zM64 16C64 7.8 57.9 1 49.7 .1S34.2 4.6 32.4 12.5L2.1 148.8C.7 155.1 0 161.5 0 167.9c0 45.9 35.1 83.6 80 87.7V480c0 17.7 14.3 32 32 32s32-14.3 32-32V255.6c44.9-4.1 80-41.8 80-87.7c0-6.4-.7-12.8-2.1-19.1L191.6 12.5c-1.8-8-9.3-13.3-17.4-12.4S160 7.8 160 16V150.2c0 5.4-4.4 9.8-9.8 9.8c-5.1 0-9.3-3.9-9.8-9L127.9 14.6C127.2 6.3 120.3 0 112 0s-15.2 6.3-15.9 14.6L83.7 151c-.5 5.1-4.7 9-9.8 9c-5.4 0-9.8-4.4-9.8-9.8V16zm48.3 152l-.3 0-.3 0 .3-.7 .3 .7z'],
  check: ['0 0 448 512', 'M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z'],
  home: ['0 0 576 512', 'M575.8 255.5c0 18-15 32.1-32 32.1h-32l.7 160.2c0 2.7-.2 5.4-.5 8.1V472c0 22.1-17.9 40-40 40H456c-1.1 0-2.2 0-3.3-.1c-1.4 .1-2.8 .1-4.2 .1H416 392c-22.1 0-40-17.9-40-40V448 384c0-17.7-14.3-32-32-32H256c-17.7 0-32 14.3-32 32v64 24c0 22.1-17.9 40-40 40H160 128.1c-1.5 0-3-.1-4.5-.2c-1.2 .1-2.4 .2-3.6 .2H104c-22.1 0-40-17.9-40-40V360c0-.9 0-1.9 .1-2.8V287.6H32c-18 0-32-14-32-32.1c0-9 3-17 10-24L266.4 8c7-7 15-8 22-8s15 2 21 7L564.8 231.5c8 7 12 15 11 24z'],
  receipt: ['0 0 384 512', 'M14 2.2C22.5-1.7 32.5-.3 39.6 5.8L80 40.4 120.4 5.8c9-7.7 22.3-7.7 31.2 0L192 40.4 232.4 5.8c9-7.7 22.3-7.7 31.2 0L304 40.4 344.4 5.8c7.1-6.1 17.1-7.5 25.6-3.6s14 12.4 14 21.8V488c0 9.4-5.5 17.9-14 21.8s-18.5 2.5-25.6-3.6L304 471.6l-40.4 34.6c-9 7.7-22.3 7.7-31.2 0L192 471.6l-40.4 34.6c-9 7.7-22.3 7.7-31.2 0L80 471.6 39.6 506.2c-7.1 6.1-17.1 7.5-25.6 3.6S0 497.4 0 488V24C0 14.6 5.5 6.1 14 2.2zM96 144c-8.8 0-16 7.2-16 16s7.2 16 16 16H288c8.8 0 16-7.2 16-16s-7.2-16-16-16H96zM80 352c0 8.8 7.2 16 16 16H288c8.8 0 16-7.2 16-16s-7.2-16-16-16H96c-8.8 0-16 7.2-16 16zM96 240c-8.8 0-16 7.2-16 16s7.2 16 16 16H288c8.8 0 16-7.2 16-16s-7.2-16-16-16H96z'],
  wallet: ['0 0 512 512', 'M64 32C28.7 32 0 60.7 0 96V416c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V192c0-35.3-28.7-64-64-64H80c-8.8 0-16-7.2-16-16s7.2-16 16-16H448c17.7 0 32-14.3 32-32s-14.3-32-32-32H64zM416 272a32 32 0 1 1 0 64 32 32 0 1 1 0-64z'],
  bell: ['0 0 448 512', 'M224 0c-17.7 0-32 14.3-32 32V51.2C119 66 64 130.6 64 208v18.8c0 47-17.3 92.4-48.5 127.6l-7.4 8.3c-8.4 9.4-10.4 22.9-5.3 34.4S19.4 416 32 416H416c12.6 0 24-7.4 29.2-18.9s3.1-25-5.3-34.4l-7.4-8.3C401.3 319.2 384 273.9 384 226.8V208c0-77.4-55-142-128-156.8V32c0-17.7-14.3-32-32-32zm45.3 493.3c12-12 18.7-28.3 18.7-45.3H224 160c0 17 6.7 33.3 18.7 45.3s28.3 18.7 45.3 18.7s33.3-6.7 45.3-18.7z'],
  dashboard: ['0 0 512 512', 'M64 64c0-17.7-14.3-32-32-32S0 46.3 0 64V400c0 44.2 35.8 80 80 80H480c17.7 0 32-14.3 32-32s-14.3-32-32-32H80c-8.8 0-16-7.2-16-16V64zm406.6 86.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L320 210.7l-57.4-57.4c-12.5-12.5-32.8-12.5-45.3 0l-112 112c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L240 221.3l57.4 57.4c12.5 12.5 32.8 12.5 45.3 0l128-128z'],
  users: ['0 0 640 512', 'M144 0a80 80 0 1 1 0 160A80 80 0 1 1 144 0zM512 0a80 80 0 1 1 0 160A80 80 0 1 1 512 0zM0 298.7C0 239.8 47.8 192 106.7 192h42.7c15.9 0 31 3.5 44.6 9.7c-1.3 7.2-1.9 14.7-1.9 22.3c0 38.2 16.8 72.5 43.3 96c-.2 0-.4 0-.7 0H21.3C9.6 320 0 310.4 0 298.7zM405.3 320c-.2 0-.4 0-.7 0c26.6-23.5 43.3-57.8 43.3-96c0-7.6-.7-15-1.9-22.3c13.6-6.3 28.7-9.7 44.6-9.7h42.7C592.2 192 640 239.8 640 298.7c0 11.8-9.6 21.3-21.3 21.3H405.3zM224 224a96 96 0 1 1 192 0 96 96 0 1 1 -192 0zM128 485.3C128 411.7 187.7 352 261.3 352H378.7C452.3 352 512 411.7 512 485.3c0 14.7-11.9 26.7-26.7 26.7H154.7c-14.7 0-26.7-11.9-26.7-26.7z'],
  route: ['0 0 512 512', 'M512 96c0 50.2-59.1 125.1-84.6 155c-3.8 4.4-9.4 6.1-14.5 5H320c-17.7 0-32 14.3-32 32s14.3 32 32 32h96c53 0 96 43 96 96s-43 96-96 96H139.6c8.7-9.9 19.3-22.6 30-36.8c6.3-8.4 12.8-17.6 19-27.2H416c17.7 0 32-14.3 32-32s-14.3-32-32-32H320c-53 0-96-43-96-96s43-96 96-96h39.8c-21-31.5-39.8-67.7-39.8-96c0-53 43-96 96-96s96 43 96 96zM117.1 489.1c-3.8 4.3-7.2 8.1-10.1 11.3l-1.8 2-.2-.2c-6 4.6-14.6 4-20-1.8C59.8 473 0 402.5 0 352c0-53 43-96 96-96s96 43 96 96c0 30-21.1 67-43.5 97.9c-10.7 14.7-21.7 28-30.8 38.5l-.6 .7zM128 352a32 32 0 1 0 -64 0 32 32 0 1 0 64 0zM416 128a32 32 0 1 0 0-64 32 32 0 1 0 0 64z'],
  coins: ['0 0 512 512', 'M512 80c0 18-14.3 34.6-38.4 48c-29.1 16.1-72.5 27.5-122.3 30.9c-3.7-1.8-7.4-3.5-11.3-5C300.6 137.4 248.2 128 192 128c-8.3 0-16.4 .2-24.5 .6l-1.1-.6C142.3 114.6 128 98 128 80c0-44.2 86-80 192-80S512 35.8 512 80zM160.7 161.1c10.2-.7 20.7-1.1 31.3-1.1c62.2 0 117.4 12.3 152.5 31.4C369.3 204.9 384 221.7 384 240c0 4-.7 7.9-2.1 11.7c-4.6 13.2-17 25.3-35 35.5c0 0 0 0 0 0c-.1 .1-.3 .1-.4 .2l0 0 0 0c-.3 .2-.6 .3-.9 .5c-35 19.4-90.8 32-153.6 32c-59.6 0-112.9-11.3-148.2-29.1c-1.9-.9-3.7-1.9-5.5-2.9C14.3 274.6 0 258 0 240c0-34.8 53.4-64.5 128-75.4c10.5-1.5 21.4-2.7 32.7-3.5zM416 240c0-21.9-10.6-39.9-24.1-53.4c28.3-4.4 54.2-11.4 76.2-20.5c16.3-6.8 31.5-15.2 43.9-25.5V176c0 19.3-16.5 37.1-43.8 50.9c-14.6 7.4-32.4 13.7-52.4 18.5c.1-1.8 .2-3.5 .2-5.3zm-32 96c0 18-14.3 34.6-38.4 48c-1.8 1-3.6 1.9-5.5 2.9C304.9 404.7 251.6 416 192 416c-62.8 0-118.6-12.6-153.6-32C14.3 370.6 0 354 0 336V300.6c12.5 10.3 27.6 18.7 43.9 25.5C83.4 342.6 135.8 352 192 352s108.6-9.4 148.1-25.9c7.8-3.2 15.3-6.9 22.4-10.9c6.1-3.4 11.8-7.2 17.2-11.2c1.5-1.1 2.9-2.3 4.3-3.4V304v5.7V336zm32 0V304 278.1c19-4.2 36.5-9.5 52.1-16c16.3-6.8 31.5-15.2 43.9-25.5V272c0 10.5-5 21-14.9 30.9c-16.3 16.3-45 29.7-81.3 38.4c.1-1.7 .2-3.5 .2-5.3zM192 448c56.2 0 108.6-9.4 148.1-25.9c16.3-6.8 31.5-15.2 43.9-25.5V432c0 44.2-86 80-192 80S0 476.2 0 432V396.6c12.5 10.3 27.6 18.7 43.9 25.5C83.4 438.6 135.8 448 192 448z'],
  alert: ['0 0 512 512', 'M256 32c14.2 0 27.3 7.5 34.5 19.8l216 368c7.3 12.4 7.3 27.7 .2 40.1S486.3 480 472 480H40c-14.3 0-27.6-7.7-34.7-20.1s-7-27.8 .2-40.1l216-368C228.7 39.5 241.8 32 256 32zm0 128c-13.3 0-24 10.7-24 24V296c0 13.3 10.7 24 24 24s24-10.7 24-24V184c0-13.3-10.7-24-24-24zm32 224a32 32 0 1 0 -64 0 32 32 0 1 0 64 0z'],
  card: ['0 0 576 512', 'M64 32C28.7 32 0 60.7 0 96v32H576V96c0-35.3-28.7-64-64-64H64zM576 224H0V416c0 35.3 28.7 64 64 64H512c35.3 0 64-28.7 64-64V224zM112 352h64c8.8 0 16 7.2 16 16s-7.2 16-16 16H112c-8.8 0-16-7.2-16-16s7.2-16 16-16zm112 16c0-8.8 7.2-16 16-16H368c8.8 0 16 7.2 16 16s-7.2 16-16 16H240c-8.8 0-16-7.2-16-16z'],
  map: ['0 0 576 512', 'M384 476.1L192 421.2V35.9L384 90.8V476.1zm32-1.2V88.4L543.1 37.5c15.8-6.3 32.9 5.3 32.9 22.3V394.6c0 9.8-6 18.6-15.1 22.3L416 474.8zM15.1 95.1L160 37.2V423.6L32.9 474.5C17.1 480.8 0 469.2 0 452.2V117.4c0-9.8 6-18.6 15.1-22.3z'],
  settings: ['0 0 512 512', 'M495.9 166.6c3.2 8.7 .5 18.4-6.4 24.6l-43.3 39.4c1.1 8.3 1.7 16.8 1.7 25.4s-.6 17.1-1.7 25.4l43.3 39.4c6.9 6.2 9.6 15.9 6.4 24.6c-4.4 11.9-9.7 23.3-15.8 34.3l-4.7 8.1c-6.6 11-14 21.4-22.1 31.2c-5.9 7.2-15.7 9.6-24.5 6.8l-55.7-17.7c-13.4 10.3-28.2 18.9-44 25.4l-12.5 57.1c-2 9.1-9 16.3-18.2 17.8c-13.8 2.3-28 3.5-42.5 3.5s-28.7-1.2-42.5-3.5c-9.2-1.5-16.2-8.7-18.2-17.8l-12.5-57.1c-15.8-6.5-30.6-15.1-44-25.4L83.1 425.9c-8.8 2.8-18.6 .3-24.5-6.8c-8.1-9.8-15.5-20.2-22.1-31.2l-4.7-8.1c-6.1-11-11.4-22.4-15.8-34.3c-3.2-8.7-.5-18.4 6.4-24.6l43.3-39.4C64.6 273.1 64 264.6 64 256s.6-17.1 1.7-25.4L22.4 191.2c-6.9-6.2-9.6-15.9-6.4-24.6c4.4-11.9 9.7-23.3 15.8-34.3l4.7-8.1c6.6-11 14-21.4 22.1-31.2c5.9-7.2 15.7-9.6 24.5-6.8l55.7 17.7c13.4-10.3 28.2-18.9 44-25.4l12.5-57.1c2-9.1 9-16.3 18.2-17.8C227.3 1.2 241.5 0 256 0s28.7 1.2 42.5 3.5c9.2 1.5 16.2 8.7 18.2 17.8l12.5 57.1c15.8 6.5 30.6 15.1 44 25.4l55.7-17.7c8.8-2.8 18.6-.3 24.5 6.8c8.1 9.8 15.5 20.2 22.1 31.2l4.7 8.1c6.1 11 11.4 22.4 15.8 34.3zM256 336a80 80 0 1 0 0-160 80 80 0 1 0 0 160z'],
  scroll: ['0 0 576 512', 'M0 80v48c0 17.7 14.3 32 32 32H48 96V80c0-26.5-21.5-48-48-48S0 53.5 0 80zM112 32c10 13.4 16 30 16 48V384c0 35.3 28.7 64 64 64s64-28.7 64-64v-5.3c0-32.4 26.3-58.7 58.7-58.7H480V128c0-53-43-96-96-96H112zM464 480c61.9 0 112-50.1 112-112c0-8.8-7.2-16-16-16H314.7c-14.7 0-26.7 11.9-26.7 26.7V384c0 53-43 96-96 96H368h96z'],
  lifebuoy: ['0 0 512 512', 'M367.2 412.5C335.9 434.9 297.5 448 256 448s-79.9-13.1-111.2-35.5l58-58c15.8 8.6 34 13.5 53.3 13.5s37.4-4.9 53.3-13.5l58 58zm90.7 .8c33.8-43.4 54-98 54-157.3s-20.2-113.9-54-157.3c9-12.5 7.9-30.1-3.4-41.3S425.8 45 413.3 54C369.9 20.2 315.3 0 256 0S142.1 20.2 98.7 54c-12.5-9-30.1-7.9-41.3 3.4S45 86.2 54 98.7C20.2 142.1 0 196.7 0 256s20.2 113.9 54 157.3c-9 12.5-7.9 30.1 3.4 41.3S86.2 467 98.7 458c43.4 33.8 98 54 157.3 54s113.9-20.2 157.3-54c12.5 9 30.1 7.9 41.3-3.4s12.4-28.8 3.4-41.3zm-45.5-46.1l-58-58c8.6-15.8 13.5-34 13.5-53.3s-4.9-37.4-13.5-53.3l58-58C434.9 176.1 448 214.5 448 256s-13.1 79.9-35.5 111.2zM367.2 99.5l-58 58c-15.8-8.6-34-13.5-53.3-13.5s-37.4 4.9-53.3 13.5l-58-58C176.1 77.1 214.5 64 256 64s79.9 13.1 111.2 35.5zM157.5 309.3l-58 58C77.1 335.9 64 297.5 64 256s13.1-79.9 35.5-111.2l58 58c-8.6 15.8-13.5 34-13.5 53.3s4.9 37.4 13.5 53.3zM208 256a48 48 0 1 1 96 0 48 48 0 1 1 -96 0z'],
  logout: ['0 0 512 512', 'M377.9 105.9L500.7 228.7c7.2 7.2 11.3 17.1 11.3 27.3s-4.1 20.1-11.3 27.3L377.9 406.1c-6.4 6.4-15 9.9-24 9.9c-18.7 0-33.9-15.2-33.9-33.9l0-62.1-128 0c-17.7 0-32-14.3-32-32l0-64c0-17.7 14.3-32 32-32l128 0 0-62.1c0-18.7 15.2-33.9 33.9-33.9c9 0 17.6 3.6 24 9.9zM160 96L96 96c-17.7 0-32 14.3-32 32l0 256c0 17.7 14.3 32 32 32l64 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-64 0c-53 0-96-43-96-96L0 128C0 75 43 32 96 32l64 0c17.7 0 32 14.3 32 32s-14.3 32-32 32z']
};
const icon = name => { const i = ICONS[name]; return i ? `<svg viewBox="${i[0]}" fill="currentColor" aria-hidden="true"><path d="${i[1]}"/></svg>` : ''; };
function hydrateIcons(root = document) {
  $$('[data-ico]', root).forEach(el => { if (!el.firstChild) el.innerHTML = icon(el.dataset.ico); });
}
hydrateIcons();

/* ---------- logo (tile escuro, borda limão, "V" branco) ---------- */
const LOGO_SVG = `
<svg class="logo" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-label="VAIRO">
  <rect x=".5" y=".5" width="39" height="39" rx="11.5" fill="#090909" stroke="#e7ff00" stroke-opacity=".4"/>
  <path d="M10 11.5h5.2L20 22.6l4.8-11.1H30l-7.9 16.3h-4.2z" fill="#fff"/>
</svg>`;

function renderBrand(el, subtitle) {
  el.innerHTML = `${LOGO_SVG}<span><span class="bname">VAIRO <span class="tag-pro">Pro Ecosystem</span></span><small>${escapeHtml(subtitle || 'A cidade no seu ritmo — Mobilidade & Marketplace')}</small></span>`;
}

/* ---------- abas do cabeçalho (Visão Geral · Passageiro · Motorista · Empresa) ----------
   Só aparecem para visitante: depois do login cada perfil vê apenas a própria navegação. */
function setTopnav(active) {
  const nav = $('#topnav');
  if (!nav) return;
  nav.hidden = !active;
  $$('[data-tab]', nav).forEach(t => t.classList.toggle('active', t.dataset.tab === active));
}
function openEmpresaInfo() {
  const m = openModal(`
    <h3>Empresa &amp; Lojas</h3>
    <p class="muted mb">A área de Empresa &amp; Lojas ainda não está disponível neste aplicativo.</p>
    <button class="btn btn-primary" data-ok>Entendi</button>`);
  $('[data-ok]', m).onclick = () => m.close();
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-empresa]')) { e.preventDefault(); openEmpresaInfo(); }
});

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
