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
  catch {
    // fetch só falha assim quando não há resposta nenhuma: sem internet no
    // aparelho, ou o servidor fora do ar
    throw new Error(navigator.onLine === false
      ? 'Sem internet no aparelho. Verifique os dados móveis ou o Wi-Fi.'
      : 'Não foi possível falar com o servidor da VAIRO agora. Tente de novo em alguns minutos.');
  }
  // proxy da hospedagem sem o app por trás (fora do ar ou reiniciando)
  if ([502, 503, 504].includes(r.status) && !String(r.headers.get('content-type') || '').includes('json')) {
    const err = new Error('O servidor da VAIRO está reiniciando ou fora do ar. Tente de novo em alguns minutos.');
    err.status = r.status;
    throw err;
  }
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
    try { new Notification(title, { body, icon: '/img/icon-192.png?v=2' }); } catch { }
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

/* ---------- atualização do app para quem já tem instalado ----------
   O servidor publica a versão (hash dos arquivos) em /api/version e dentro de
   cada página (<meta name="app-version">). Quando as duas diferem, existe
   versão nova:
   - app em segundo plano, ou voltando para a tela, sem nada em andamento:
     recarrega sozinho (a pessoa nem percebe);
   - com algo em andamento (corrida, formulário preenchido, janela aberta):
     só mostra o aviso "Nova versão disponível · Atualizar".
   Recarregar não perde o login (cookie) nem as preferências (localStorage). */
const APP_VERSION = document.querySelector('meta[name="app-version"]')?.content || '';
window.APP_VERSION = APP_VERSION;

/** Há algo que um recarregamento atrapalharia? */
function appBusy() {
  if (document.querySelector('.modal-backdrop')) return true;
  if (typeof window.vairoBusy === 'function') {
    try { if (window.vairoBusy()) return true; } catch { return true; }
  }
  // campo visível em que a PESSOA digitou e que ainda tem texto (campos que
  // o próprio app preenche, como nome e telefone do perfil, não contam)
  for (const el of document.querySelectorAll('[data-typed]')) {
    if (el.value && el.offsetParent !== null) return true;
  }
  return false;
}
document.addEventListener('input', e => {
  const el = e.target;
  if (e.isTrusted && el?.matches?.('input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea')) {
    el.dataset.typed = '1';
  }
}, true);

function showUpdateBanner() {
  if (document.getElementById('update-banner')) return;
  const b = document.createElement('div');
  b.id = 'update-banner';
  b.className = 'update-banner';
  b.setAttribute('role', 'status');
  b.innerHTML = '<span>Nova versão disponível</span><button type="button">Atualizar</button>';
  b.querySelector('button').onclick = () => applyUpdate(true);
  document.body.appendChild(b);
}

let _updating = false;
async function applyUpdate(byUser = false) {
  if (_updating) return;
  _updating = true;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    reg?.waiting?.postMessage('skip-waiting');
  } catch { /* sem service worker: recarregar já basta */ }
  if (!byUser) sessionStorage.setItem('vairo-update-tried', _newVersion || '');
  location.reload();
}

let _newVersion = '';
let _checking = false;
async function checkForUpdate(reason) {
  if (!APP_VERSION || _checking || _updating || navigator.onLine === false) return;
  _checking = true;
  try {
    // pede ao navegador para conferir o sw.js agora (normalmente só confere ao abrir)
    navigator.serviceWorker?.getRegistration().then(r => r?.update()).catch(() => { });
    const r = await fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) return;
    const { version } = await r.json();
    if (!version || version === APP_VERSION) {
      sessionStorage.removeItem('vairo-update-tried');
      return;
    }
    _newVersion = version;
    // já tentou recarregar para esta versão e continuou na antiga: não insiste
    const triedBefore = sessionStorage.getItem('vairo-update-tried') === version;
    const quiet = document.visibilityState === 'hidden' || reason === 'foreground';
    if (quiet && !triedBefore && !appBusy()) {
      // dá um instante para o service worker novo terminar de instalar
      setTimeout(() => { if (!appBusy()) applyUpdate(); else showUpdateBanner(); }, 1500);
    } else {
      showUpdateBanner();
    }
  } catch { /* sem rede: tenta na próxima */ }
  finally { _checking = false; }
}

if (APP_VERSION) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate('foreground');
  });
  addEventListener('online', () => checkForUpdate('online'));
  setInterval(() => checkForUpdate('timer'), 10 * 60 * 1000);
  addEventListener('load', () => setTimeout(() => checkForUpdate('load'), 5000));
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
   MAPA — adaptador único para Google Maps, Mapbox GL JS e
   Leaflet/OpenStreetMap.
   O resto do aplicativo usa sempre a mesma API (makeMap, emojiMarker,
   drawRoute, accuracyCircle), sem saber qual provedor está ativo.
   Ordem: Google Maps quando há chave do navegador; senão Mapbox quando há
   token público; senão OpenStreetMap (mapa real, não simulado). Se um
   provedor falhar, o seguinte assume.
   ============================================================ */

// Versão fixa de propósito: uma versão nova só entra depois de testada aqui.
const MAPBOX_GL_VERSION = '3.33.0';
const MAPBOX_DEFAULT_STYLE = 'mapbox://styles/mapbox/streets-v12';

let _mapsProvider = 'osm';
let _mapsConfig = {};          // bloco "maps" de /api/config (chave e token públicos)
let _googleReady = null;
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

/**
 * O Google recusou a chave (inválida, API desativada, faturamento ou site
 * fora da restrição): passa para o Mapbox, se houver token, ou para o
 * OpenStreetMap, e manda as telas refazerem os mapas.
 */
async function googleFailed(message) {
  if (_mapsProvider !== 'google') return;
  _mapsProvider = 'osm';
  const next = await startMapbox(_mapsConfig, true) ? 'mapbox' : 'osm';
  toast(`${message} Usando ${next === 'mapbox' ? 'o Mapbox' : 'o OpenStreetMap'}.`, 'err');
  setTimeout(() => document.dispatchEvent(
    new CustomEvent('maps-provider-changed', { detail: next })), 0);
}
/** Chamado pelo próprio Google quando a chave não é aceita. */
window.gm_authFailure = () => {
  googleFailed('Chave do Google Maps recusada (confira a chave, as APIs ativadas e a restrição de site).');
};

/** Carrega a Maps JavaScript API uma única vez. */
function loadGoogleMaps(key) {
  if (_googleReady) return _googleReady;
  _googleReady = new Promise((resolve, reject) => {
    if (window.google?.maps?.Map) { resolve(window.google.maps); return; }
    window.__vairoGoogleMaps = async () => {
      try {
        const gm = window.google.maps;
        // com carregamento assíncrono, as classes chegam por biblioteca
        if (gm.importLibrary) await Promise.all([gm.importLibrary('core'), gm.importLibrary('maps')]);
        resolve(gm);
      } catch { reject(new Error('Google Maps carregou sem a biblioteca esperada.')); }
    };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`
      + '&v=weekly&language=pt-BR&region=BR&loading=async&callback=__vairoGoogleMaps';
    s.async = true;
    s.onerror = () => reject(new Error('Falha ao carregar o Google Maps.'));
    // rede lenta não pode travar a abertura do aplicativo
    setTimeout(() => reject(new Error('Google Maps demorou demais para responder.')), 9000);
    document.head.appendChild(s);
  });
  return _googleReady;
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

/** Liga o Mapbox, se houver token. Devolve true quando ele ficou ativo. */
async function startMapbox(maps, quiet = false) {
  const token = maps?.mapbox_token;
  if (!token) return false;
  try {
    const mb = await loadMapboxGL();
    mb.accessToken = token;
    _mapboxStyle = maps.style || MAPBOX_DEFAULT_STYLE;
    _mapsProvider = 'mapbox';
    return true;
  } catch {
    if (!quiet) toast('Mapbox indisponível — usando OpenStreetMap.', 'err');
    return false;
  }
}

/**
 * Prepara o provedor de mapas a partir de /api/config.
 * Se um provedor falhar (sem rede, biblioteca bloqueada), o seguinte assume
 * e o app avisa — nunca fica sem mapa silenciosamente.
 */
async function initMaps(config) {
  _mapsConfig = config?.maps || {};
  _mapsProvider = 'osm';
  if (_mapsConfig.google_key) {
    try {
      await loadGoogleMaps(_mapsConfig.google_key);
      _mapsProvider = 'google';
      return _mapsProvider;
    } catch {
      toast('Google Maps indisponível — usando o mapa de reserva.', 'err');
    }
  }
  await startMapbox(_mapsConfig);
  return _mapsProvider;
}

/* ---------- adaptador Google com a mesma interface do Leaflet ---------- */

function googleMapAdapter(el, center, zoom) {
  const gm = window.google.maps;
  const map = new gm.Map(el, {
    center: { lat: center.lat, lng: center.lng },
    zoom,
    disableDefaultUI: true,
    gestureHandling: 'greedy',     // um dedo arrasta o mapa, como nos outros provedores
    clickableIcons: false,         // o toque marca o ponto; não abre o balão do Google
    keyboardShortcuts: false,
  });
  const clickHandlers = new Map();
  return {
    _google: map,
    _provider: 'google',
    setView([lat, lng], z) { map.setCenter({ lat, lng }); if (z) map.setZoom(z); },
    fitBounds(bounds, opts = {}) {
      if (!bounds || bounds.isEmpty()) return;
      const pad = (opts.padding && opts.padding[0]) || 30;
      // trajeto curto não pode aproximar até o nível do telhado
      map.setOptions({ maxZoom: 17 });
      map.fitBounds(bounds, pad);
      gm.event.addListenerOnce(map, 'idle', () => map.setOptions({ maxZoom: null }));
    },
    invalidateSize() { gm.event.trigger(map, 'resize'); },
    on(evt, fn) {
      if (evt !== 'click') return;
      const l = map.addListener('click', e => {
        if (e.latLng) fn({ latlng: { lat: e.latLng.lat(), lng: e.latLng.lng() } });
      });
      clickHandlers.set(fn, l);
    },
    off(evt, fn) {
      const l = clickHandlers.get(fn);
      if (l) { l.remove(); clickHandlers.delete(fn); }
    },
    remove() { gm.event.clearInstanceListeners(map); el.replaceChildren(); },
  };
}

/**
 * Marcador de emoji no mapa do Google: o mesmo elemento HTML usado no
 * Leaflet e no Mapbox, posicionado por uma camada própria. Não recebe
 * toques — o toque passa para o mapa, que marca o ponto.
 */
let _GoogleEmojiOverlay = null;
function googleEmojiOverlay(lat, lng, emoji, title) {
  const gm = window.google.maps;
  if (!_GoogleEmojiOverlay) {
    _GoogleEmojiOverlay = class extends gm.OverlayView {
      constructor(pos, text, tip) {
        super();
        this.pos = pos;
        this.div = document.createElement('div');
        this.div.className = 'marker-moto';
        this.div.textContent = text;
        if (tip) this.div.title = tip;
        Object.assign(this.div.style, {
          position: 'absolute', transform: 'translate(-50%, -50%)',
          pointerEvents: 'none', whiteSpace: 'nowrap', lineHeight: '1',
        });
      }
      onAdd() { this.getPanes().markerLayer.appendChild(this.div); }
      draw() {
        const p = this.getProjection()?.fromLatLngToDivPixel(new gm.LatLng(this.pos.lat, this.pos.lng));
        if (!p) return;
        this.div.style.left = `${p.x}px`;
        this.div.style.top = `${p.y}px`;
      }
      onRemove() { this.div.remove(); }
    };
  }
  return new _GoogleEmojiOverlay({ lat, lng }, emoji, title);
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

  if (_mapsProvider === 'google' && window.google?.maps?.Map) {
    try { return googleMapAdapter(el, center, zoom); }
    catch { el.replaceChildren(); /* este mapa segue no Leaflet abaixo */ }
  }
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
  if (map._provider === 'google') {
    const overlay = googleEmojiOverlay(lat, lng, emoji, title);
    overlay.setMap(map._google);
    return {
      setLatLng([la, ln]) { overlay.pos = { lat: la, lng: ln }; overlay.draw(); return this; },
      remove() { overlay.setMap(null); },
      _google: overlay,
    };
  }
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
  if (map._provider === 'google') {
    const gm = window.google.maps;
    const path = geometry.map(([lng, lat]) => ({ lat, lng }));
    const base = { path, map: map._google, clickable: false };
    const lines = [
      // contorno claro: a rota continua visível sobre ruas escuras e satélite
      new gm.Polyline({ ...base, strokeColor: '#ffffff', strokeWeight: 8, strokeOpacity: .7, zIndex: 1 }),
      new gm.Polyline({ ...base, strokeColor: color, strokeWeight: 5, strokeOpacity: .85, zIndex: 2 }),
    ];
    const bounds = new gm.LatLngBounds();
    path.forEach(p => bounds.extend(p));
    return {
      getBounds() { return bounds; },
      remove() { lines.forEach(l => l.setMap(null)); },
    };
  }
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
  if (map._provider === 'google') {
    const c = new window.google.maps.Circle({
      map: map._google, center: { lat, lng }, radius, clickable: false,
      strokeColor: '#2563eb', strokeWeight: 1, fillColor: '#2563eb', fillOpacity: .08,
    });
    return {
      setLatLng([la, ln]) { c.setCenter({ lat: la, lng: ln }); return this; },
      setRadius(r) { c.setRadius(r); return this; },
      remove() { c.setMap(null); },
    };
  }
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
// "V" com estrada: vetorizado da imagem enviada pelo dono do app (ver tools/logo-shape.json).
const LOGO_MARK = `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
  <path fill="#fff" fill-rule="evenodd" d="M33.1 87.3C32.9 87.1 32.9 87.2 34.1 84.4C35.6 81.1 38.8 75.3 41.4 71.1C44.3 66.4 43.8 66.7 46.4 67.9C47.3 68.4 48.4 68.9 48.7 69.1C52 70.6 51.8 70.5 51.2 71.6C50.7 72.4 49.2 75 48.2 77C47.5 78.4 47 79.4 45.5 82.4C45.3 83 44.4 84.9 43.7 86.6C43.5 86.9 43.4 87.2 43.3 87.3L43.1 87.5L38.2 87.5L33.3 87.5L33.1 87.3ZM51.8 87.4C51.6 87.2 51.7 86.8 52.2 85.3C52.5 84.6 52.7 83.9 52.8 83.7C52.9 83.4 53.1 83 53.8 81.1C54.3 80 54.9 78.4 55.3 77.7C55.4 77.4 55.6 76.9 55.7 76.6C56.5 74.8 59.8 68.3 61.2 65.8C61.5 65.3 61.8 64.8 61.9 64.6C62 64.3 63.1 62.5 63.5 61.9C63.6 61.7 63.8 61.3 64 61C65 59.3 66.5 56.8 68 54.6C69.7 52 69.9 51.7 71.2 49.8C71.6 49.3 73.3 46.8 74 45.9C74.7 45 76.7 42.3 77.7 41C79.5 38.7 81.8 35.8 83 34.4C83.2 34.2 83.9 33.4 84.6 32.6C90.4 25.8 96.3 20.2 93.4 24.1C93.1 24.6 92.7 25 92.6 25.2C92.5 25.3 92.2 25.8 91.9 26.2C90.6 28 89.8 29.2 88 31.9C86.1 34.7 84.3 37.5 83.5 38.9C83.2 39.3 82.7 40.1 82.3 40.8C81.9 41.5 81.4 42.4 81.1 42.9C80.8 43.3 80.4 44 80.2 44.4C79.8 45.1 79 46.5 77.8 48.8C77.4 49.5 76.9 50.4 76.7 50.7C76.5 51.1 76.2 51.6 76 52C75.8 52.4 75.5 53.1 75.2 53.5C73.9 55.9 70.7 62.6 69.4 65.5C69.2 65.9 68.9 66.6 68.7 67.1C68.5 67.5 68.2 68.1 68.1 68.5C68 68.8 67.5 69.8 67.1 70.7C66.2 72.8 64.7 76.5 63.8 78.9C63.6 79.5 63.4 80.1 63.3 80.3C63.2 80.6 62.5 82.3 61.9 84.3C61.7 84.7 61.5 85.4 61.3 86C61 86.8 60.9 87 60.7 87.2L60.5 87.5L56.2 87.5C52.4 87.5 52 87.5 51.8 87.4ZM28.4 79C28.2 78.9 28.2 78.8 27.6 77.3C27.4 76.7 27.1 76 26.9 75.7C26.8 75.4 26.7 75 26.6 74.7C26.5 74.5 26.2 73.8 25.9 73.2C25.7 72.5 25.4 71.8 25.3 71.6C25.2 71.4 24.9 70.6 24.7 69.9C24.4 69.2 24 68.2 23.8 67.7C23.6 67.2 23.4 66.7 23.3 66.4C23.2 66.2 23 65.8 22.9 65.5C22.8 65.2 22.7 64.8 22.6 64.6C22.5 64.4 22.2 63.8 22 63.1C21.5 61.8 20.9 60.4 20.6 59.6C20.5 59.3 20.2 58.5 19.9 57.8C19.6 57.1 19.2 56 18.9 55.3C18.7 54.6 18.1 53.3 17.8 52.4C17.4 51.5 17 50.5 16.9 50.3C16.8 50 16.6 49.5 16.5 49.1C16.3 48.7 16.1 48.2 16.1 48C16 47.8 15.7 47.2 15.5 46.7C15.3 46.2 15 45.2 14.7 44.5C12.8 39.6 12.4 38.6 12 37.5C11.7 36.9 11.5 36.3 11.5 36.3C11.5 36.3 11.1 35.3 10.6 34.1C9.7 31.7 8.9 29.7 8.2 28C8 27.3 7.4 26 7 24.9C6.6 23.9 6.1 22.5 5.8 21.8C5.5 21.1 5.1 20 4.8 19.3C4.5 18.5 4.1 17.6 4 17.2C3.8 16.7 3.6 16.2 3.6 16.1C3.3 15.4 2.5 13.3 2.4 13.1C2.4 12.9 2.4 12.7 2.6 12.6C2.9 12.5 19.9 12.5 20.2 12.6C20.5 12.8 20.6 12.9 21.1 14.6C21.2 14.8 21.5 15.5 21.7 16C21.8 16.5 22.1 17.3 22.3 17.8C22.5 18.3 22.7 18.9 22.9 19.3C23 19.6 23.2 20.3 23.4 20.8C23.7 21.6 24.6 24 25.2 25.7C25.3 26.1 25.7 27 25.9 27.7C26.1 28.3 26.5 29.2 26.7 29.7C26.8 30.2 27.2 31.1 27.4 31.7C27.9 33 28.1 33.6 28.9 36C29.2 36.9 29.9 38.5 30.3 39.7C30.7 40.9 31.2 42.3 31.4 42.9C31.8 43.9 32 44.5 32.6 46C33.3 48 33.5 48.5 33.9 49.8C34.2 50.5 34.7 52 35.1 53C35.5 54 35.9 55.2 36 55.5C36.5 57 36.2 57.2 39.9 53.5C41.6 51.8 43.5 49.9 44.2 49.3C44.9 48.6 45.7 47.8 46.1 47.4C46.8 46.8 47.2 46.4 49 44.8C49.8 44.1 49.8 44.1 50.2 43C50.4 42.5 50.7 41.7 50.8 41.3C51 40.8 51.4 39.9 51.6 39.2C51.8 38.6 52.2 37.6 52.3 37.2C52.5 36.7 52.7 36.1 52.8 35.9C52.9 35.6 53.1 35.1 53.3 34.6C53.4 34.2 53.7 33.6 53.8 33.3C53.9 33 54.1 32.3 54.3 31.7C54.6 31.1 54.9 30.2 55.1 29.8C55.2 29.3 55.6 28.3 55.8 27.6C56.1 26.9 56.4 26 56.6 25.5C56.8 25 57.1 24.1 57.3 23.5C57.6 23 57.8 22.2 57.9 21.9C58.1 21.6 58.3 20.9 58.5 20.3C58.7 19.7 59 19 59.1 18.6C59.3 18.2 59.5 17.6 59.7 17.2C60.1 16 61 13.6 61.1 13.2C61.2 13 61.3 12.8 61.4 12.7L61.6 12.5L70 12.5C78.2 12.5 78.4 12.6 78.5 12.7C78.8 12.9 78.8 12.7 77.4 16.2C77.1 17.1 76.6 18.2 76.4 18.7C76.2 19.3 75.6 20.7 75.1 22C74.6 23.4 74.1 24.6 74 24.9C73.9 25.2 73.7 25.7 73.6 25.9C73.1 27.1 73.3 27 76.8 25.1C78.2 24.4 81.2 22.9 82.5 22.3C84.8 21.3 84.6 21.7 81.8 23.6C81 24.1 80.2 24.7 80 24.9C79.7 25.1 79.1 25.6 78.6 25.9C78.1 26.3 77.2 26.9 76.7 27.3C76.1 27.7 75.4 28.2 75.1 28.5C74.2 29.2 69.8 32.6 68.7 33.6C68.4 33.9 68 34.2 67.9 34.3C62.6 38.7 55 46 49.7 51.8C49.3 52.3 48.5 53.1 48.1 53.7C47.6 54.2 47.1 54.7 47 54.9C46.8 55 46.3 55.7 45.7 56.3C44.6 57.6 43.6 58.7 42.7 59.9C40.6 62.5 40 63.3 39.7 63.6C39.6 63.8 39.1 64.4 38.7 64.9C37.4 66.6 35.7 68.9 35 69.9C32.5 73.4 31.9 74.3 30.3 76.8C28.8 79.1 28.6 79.2 28.4 79ZM51.9 67.4C51.4 67.2 50.4 66.7 49.7 66.4C46.4 64.8 46 64.6 46.1 64.2C46.2 63.9 47.5 62.1 49.6 59.4C50.2 58.7 50.4 58.4 50.7 57.9C51.2 57.4 52.8 55.5 54.4 53.5C57 50.5 57.1 50.4 57.7 50.8C58.1 51.1 59.5 52.1 61.2 53.4C62.7 54.4 62.7 54.2 61.2 56.2C59.6 58.3 56.9 62.3 55.6 64.3C55.3 64.8 54.9 65.5 54.5 66C54.2 66.5 53.9 67 53.8 67.2C53.3 68 53.2 68 51.9 67.4ZM63.7 52.1C63.6 52.1 61.2 50.4 60.6 49.9C60.4 49.8 60 49.5 59.7 49.3C58.7 48.6 58.7 48.7 60.7 46.6C64.3 42.9 70 37.4 70.6 37.1C71 36.9 71 36.9 73.7 38.8C74.5 39.4 74.5 39.6 74 40.3C73.3 41 70.5 44.3 69.8 45.2C69.5 45.5 69.2 45.9 69 46.1C68.4 46.8 65.1 50.9 64.6 51.7C64.2 52.1 64.1 52.2 63.7 52.1ZM75.4 37.6C72 35.2 72 35.7 75.2 32.9C75.7 32.6 76.2 32.1 76.5 31.9C78.4 30.3 81.5 27.7 81.8 27.6C82.2 27.4 82.2 27.5 83.4 28.4C84.4 29.1 84.4 29.1 83 30.5C81.2 32.4 79.3 34.4 78.8 34.9C76.1 37.9 76 38 75.4 37.6ZM84.8 27.3C83.5 26.4 83.4 26.3 84.3 25.6C85.2 24.8 87.6 23.1 90.4 21.1C91.3 20.5 92.1 19.9 92.3 19.8C94 18.5 96.8 16.8 97 16.8C97.3 16.8 97.1 17.1 93.2 20.7C91 22.6 91 22.6 88.2 25.4C85.4 28.1 85.7 27.9 84.8 27.3Z"/></svg>`;
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
