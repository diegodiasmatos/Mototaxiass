/* Assis MotoTáxi — utilitários compartilhados (passageiro, mototaxista, admin) */
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
  requested: 'Procurando mototaxista', accepted: 'Mototaxista a caminho',
  in_progress: 'Em andamento', completed: 'Concluída', cancelled: 'Cancelada',
};
const STATUS_PILL = {
  requested: 'yellow', accepted: 'blue', in_progress: 'blue', completed: 'green', cancelled: 'red',
};
const PAY_PT = { dinheiro: '💵 Dinheiro', pix: '⚡ Pix', cartao: '💳 Cartão' };

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

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- SSE (tempo real) ---------- */
let _sse = null;
function connectSSE(handlers) {
  if (_sse) _sse.close();
  _sse = new EventSource('/api/events');
  for (const [event, fn] of Object.entries(handlers)) {
    _sse.addEventListener(event, e => {
      let data = {};
      try { data = JSON.parse(e.data); } catch { }
      fn(data);
    });
  }
  _sse.onerror = () => { /* EventSource reconecta sozinho */ };
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
    try { new Notification(title, { body, icon: '/img/icon.svg' }); } catch { }
  }
}

/* ---------- barra de offline ---------- */
window.addEventListener('offline', () => {
  if ($('#offline-bar')) return;
  const b = document.createElement('div');
  b.id = 'offline-bar'; b.textContent = '📡 Sem internet — tentando reconectar…';
  document.body.appendChild(b);
});
window.addEventListener('online', () => { $('#offline-bar')?.remove(); toast('Conexão restabelecida', 'ok'); });

/* ---------- mapa (Leaflet + OpenStreetMap) ---------- */
function hasLeaflet() { return typeof L !== 'undefined'; }

function makeMap(elId, center, zoom = 14) {
  const el = document.getElementById(elId);
  if (!hasLeaflet()) {
    el.innerHTML = '<div class="map-fallback">🗺️ O mapa não pôde ser carregado (sem internet?).<br>Os endereços e preços continuam funcionando normalmente.</div>';
    return null;
  }
  const map = L.map(el, { zoomControl: false, attributionControl: true })
    .setView([center.lat, center.lng], zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap',
  }).addTo(map);
  return map;
}
function emojiMarker(map, lat, lng, emoji, title = '') {
  return L.marker([lat, lng], {
    title,
    icon: L.divIcon({ className: 'marker-moto', html: emoji, iconSize: [26, 26], iconAnchor: [13, 13] }),
  }).addTo(map);
}
function drawRoute(map, geometry, color = '#0d1b2e') {
  // geometry: [[lng,lat],...] (GeoJSON)
  const latlngs = geometry.map(([lng, lat]) => [lat, lng]);
  return L.polyline(latlngs, { color, weight: 5, opacity: .75 }).addTo(map);
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

/* ---------- logo ---------- */
const LOGO_SVG = `
<svg class="logo" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-label="Assis MotoTáxi">
  <rect x="2" y="2" width="60" height="60" rx="16" fill="#ffb703"/>
  <g fill="none" stroke="#0d1b2e" stroke-width="4" stroke-linecap="round">
    <circle cx="18" cy="43" r="7.5"/>
    <circle cx="46" cy="43" r="7.5"/>
    <path d="M18 43 L28 28 H40 L46 43"/>
    <path d="M28 28 L24 21 H31"/>
    <path d="M40 28 L46 24 H52"/>
  </g>
  <path d="M6 14 h14 M4 20 h12" stroke="#0d1b2e" stroke-width="3" stroke-linecap="round" opacity=".55"/>
</svg>`;

function renderBrand(el, subtitle) {
  el.innerHTML = `${LOGO_SVG}<span>Assis MotoTáxi<small>${escapeHtml(subtitle || 'Assis Chateaubriand - PR')}</small></span>`;
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
