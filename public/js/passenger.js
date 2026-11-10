/* Assis MotoTáxi — aplicativo do passageiro */
'use strict';

const S = {
  config: null, user: null,
  origin: null, dest: null,          // {lat,lng,text}
  quotes: [], quoteRoute: null, selectedQuote: null, payment: 'dinheiro',
  activeRide: null,
  maps: { home: null, quote: null, ride: null },
  rideLayers: [], driverMarker: null,
  statsTimer: null, ratePromptFor: null,
};

init();

async function init() {
  renderBrand($('#brand'));
  S.config = await api('/api/config').catch(() => ({
    city_name: 'Assis Chateaubriand - PR', center: { lat: -24.4156, lng: -53.5216 }, welcome_message: 'Olá! Para onde vamos?',
  }));
  $('#auth-hero').innerHTML = `${LOGO_SVG}<h1>Assis MotoTáxi</h1>
    <p>Transporte rápido e seguro em ${escapeHtml(S.config.city_name)}</p>`;

  bindAuth(); bindHome(); bindQuote(); bindRide(); bindProfile(); bindNav();

  try {
    const me = await api('/api/me');
    if (me.user.role !== 'passenger') {
      location.href = me.user.role === 'admin' ? '/admin' : '/motorista';
      return;
    }
    S.user = me.user;
    setNotifBadge(me.unread);
    enterApp();
  } catch {
    showScreen('screen-auth');
    setupGoogleButton();
  }
}

/* ================= autenticação ================= */
function bindAuth() {
  $('#tab-login').onclick = () => authTab(true);
  $('#tab-register').onclick = () => authTab(false);
  $('#form-login').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
      if (r.user.role !== 'passenger') { location.href = r.user.role === 'admin' ? '/admin' : '/motorista'; return; }
      S.user = r.user; enterApp();
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#form-register').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api('/api/auth/register', {
        method: 'POST',
        body: { role: 'passenger', name: f.get('name'), phone: f.get('phone'), email: f.get('email'), password: f.get('password') },
      });
      S.user = r.user; toast('Conta criada! Bem-vindo(a) 🎉', 'ok'); enterApp();
    } catch (err) { toast(err.message, 'err'); }
  };
}
function authTab(login) {
  $('#tab-login').classList.toggle('active', login);
  $('#tab-register').classList.toggle('active', !login);
  $('#form-login').hidden = !login;
  $('#form-register').hidden = login;
}
function setupGoogleButton() {
  if (!S.config.google_client_id) return;
  const slot = $('#google-slot');
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({
      client_id: S.config.google_client_id,
      callback: async resp => {
        try {
          const r = await api('/api/auth/google', { method: 'POST', body: { credential: resp.credential, role: 'passenger' } });
          S.user = r.user; enterApp();
        } catch (err) { toast(err.message, 'err'); }
      },
    });
    google.accounts.id.renderButton(slot, { theme: 'outline', size: 'large', width: 280 });
  };
  document.head.appendChild(s);
}

/* ================= entrada no app ================= */
async function enterApp() {
  $('#bottomnav').hidden = false;
  $('#btn-notifs').hidden = false;
  $('#btn-notifs').onclick = openNotifications;
  $('#greeting').textContent = `${S.config.welcome_message} `;
  fillProfile();

  connectSSE({
    notification: n => { toast(n.title); browserNotify(n.title, n.body || ''); bumpBadge(); },
    ride_update: () => refreshActiveRide(),
    driver_location: d => onDriverLocation(d),
    ride_message: m => onChatMessage(m),
  });

  await refreshActiveRide();
  if (!S.activeRide) showScreen('screen-home');
  initHomeMap();
  refreshStats();
  clearInterval(S.statsTimer);
  S.statsTimer = setInterval(refreshStats, 15000);
  loadFavorites();
}

function bumpBadge() {
  const cur = Number($('#notif-badge')?.textContent || 0);
  setNotifBadge(cur + 1);
}

function bindNav() {
  $$('.bottomnav button').forEach(b => b.onclick = () => {
    const id = b.dataset.screen;
    if (id === 'screen-home' && S.activeRide) { showScreen('screen-ride'); return; }
    showScreen(id);
    if (id === 'screen-history') loadHistory();
    if (id === 'screen-profile') { fillProfile(); loadFavorites(); loadSupport(); }
  });
}

/* ================= tela inicial ================= */
let homeMarkers = [];
function initHomeMap() {
  if (S.maps.home) return;
  S.maps.home = makeMap('map-home', S.config.center, 14);
}
async function refreshStats() {
  try {
    const st = await api('/api/public/stats');
    $('#online-chip').textContent = st.online_drivers === 0
      ? '🏍️ Nenhum mototaxista online agora'
      : `🏍️ ${st.online_drivers} mototaxista${st.online_drivers > 1 ? 's' : ''} disponíve${st.online_drivers > 1 ? 'is' : 'l'} agora`;
    if (S.maps.home) {
      homeMarkers.forEach(m => m.remove());
      homeMarkers = st.markers.map(m => emojiMarker(S.maps.home, m.lat, m.lng, '🏍️'));
    }
  } catch { /* silencioso */ }
}

function bindHome() {
  setupAutocomplete($('#in-origin'), $('#ac-origin'), p => { S.origin = p; placeHomePin(p, 'origin'); });
  setupAutocomplete($('#in-dest'), $('#ac-dest'), p => { S.dest = p; placeHomePin(p, 'dest'); });

  $('#btn-mylocation').onclick = async () => {
    const btn = $('#btn-mylocation');
    btn.disabled = true; btn.textContent = '🧭 Localizando…';
    try {
      const pos = await getPosition();
      const { text } = await api(`/api/geo/reverse?lat=${pos.lat}&lng=${pos.lng}`).catch(() => ({ text: 'Minha localização atual' }));
      S.origin = { ...pos, text };
      $('#in-origin').value = text;
      placeHomePin(S.origin, 'origin');
      if (S.maps.home) S.maps.home.setView([pos.lat, pos.lng], 16);
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false; btn.textContent = '🧭 Usar minha localização atual';
  };

  $('#btn-quote').onclick = async () => {
    if (!S.origin) { toast('Informe o local de embarque (ou use sua localização).', 'err'); return; }
    if (!S.dest) { toast('Informe o destino.', 'err'); return; }
    const btn = $('#btn-quote');
    btn.disabled = true; btn.textContent = 'Calculando…';
    try {
      const r = await api('/api/quotes', { method: 'POST', body: { origin: S.origin, dest: S.dest } });
      S.quotes = r.quotes; S.quoteRoute = r.route; S.selectedQuote = null;
      renderQuotes(r);
      showScreen('screen-quote');
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false; btn.textContent = 'Ver preços e solicitar 🏍️';
  };
}

const homePins = {};
function placeHomePin(p, kind) {
  if (!S.maps.home) return;
  homePins[kind]?.remove();
  homePins[kind] = emojiMarker(S.maps.home, p.lat, p.lng, kind === 'origin' ? '📍' : '🏁');
}

function setupAutocomplete(input, list, onPick) {
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { list.hidden = true; return; }
    timer = setTimeout(async () => {
      try {
        const { results } = await api(`/api/geo/search?q=${encodeURIComponent(q)}`);
        list.innerHTML = results.length
          ? results.map((r, i) => `<button type="button" data-i="${i}">${escapeHtml(r.text)}${r.approx ? ' <span class="muted small">(aprox.)</span>' : ''}</button>`).join('')
          : '<button type="button" disabled>Nenhum endereço encontrado</button>';
        list.hidden = false;
        $$('button[data-i]', list).forEach(b => b.onclick = () => {
          const r = results[Number(b.dataset.i)];
          input.value = r.text;
          list.hidden = true;
          onPick({ lat: r.lat, lng: r.lng, text: r.text });
        });
      } catch { list.hidden = true; }
    }, 350);
  });
  document.addEventListener('click', e => { if (!list.contains(e.target) && e.target !== input) list.hidden = true; });
}

async function loadFavorites() {
  try {
    const { favorites } = await api('/api/favorites');
    $('#fav-chips').innerHTML = favorites.map(f =>
      `<button class="chip soft" data-id="${f.id}" title="${escapeHtml(f.text)}">⭐ ${escapeHtml(f.label)}</button>`).join('');
    $$('#fav-chips .chip').forEach(b => b.onclick = () => {
      const f = favorites.find(x => x.id === b.dataset.id);
      S.dest = { lat: f.lat, lng: f.lng, text: f.text };
      $('#in-dest').value = f.text;
      placeHomePin(S.dest, 'dest');
    });
    $('#fav-list').innerHTML = favorites.length ? favorites.map(f => `
      <div class="list-item">
        <div class="li-main"><div class="li-title">⭐ ${escapeHtml(f.label)}</div><div class="li-sub">${escapeHtml(f.text)}</div></div>
        <button class="btn btn-danger btn-sm" data-del="${f.id}">Remover</button>
      </div>`).join('') : '<p class="muted small">Nenhum favorito salvo.</p>';
    $$('#fav-list [data-del]').forEach(b => b.onclick = async () => {
      await api(`/api/favorites/${b.dataset.del}`, { method: 'DELETE' });
      loadFavorites();
    });
  } catch { /* sem favoritos */ }
}

/* ================= cotação ================= */
function bindQuote() {
  $('#btn-quote-back').onclick = () => showScreen('screen-home');
  $$('#pay-seg button').forEach(b => b.onclick = () => {
    $$('#pay-seg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    S.payment = b.dataset.pay;
  });
  $('#btn-request').onclick = requestRide;
}

function renderQuotes(r) {
  const q0 = S.quotes[0];
  $('#quote-summary').innerHTML =
    `📍 ${escapeHtml(S.origin.text)} → 🏁 ${escapeHtml(S.dest.text)}<br>` +
    `Distância: <b>${fmt.dist(q0.distance_m)}</b> · Tempo estimado: <b>${fmt.dur(q0.duration_s)}</b>` +
    (r.route.estimated ? ' · <span class="pill yellow">distância estimada</span>' : '') +
    `<br>🏍️ ${r.online_drivers} mototaxista(s) próximos disponíveis`;

  const DESC = {
    economica: 'Para o dia a dia, o menor preço',
    prioridade: 'Despacho com prioridade, chega mais rápido',
  };
  const ICON = { economica: '🛵', prioridade: '⚡' };
  $('#quote-cards').innerHTML = S.quotes.map(q => `
    <button class="cat-card" data-id="${q.id}">
      <span class="cico">${ICON[q.category] || '🏍️'}</span>
      <span class="cinfo">
        <span class="cname">${escapeHtml(q.label)}</span><br>
        <span class="cdesc">${DESC[q.category] || ''}</span>
      </span>
      <span class="cprice">${fmt.money(q.price_cents)}</span>
    </button>`).join('');
  $$('#quote-cards .cat-card').forEach(c => c.onclick = () => {
    $$('#quote-cards .cat-card').forEach(x => x.classList.remove('selected'));
    c.classList.add('selected');
    S.selectedQuote = S.quotes.find(q => q.id === c.dataset.id);
    $('#btn-request').disabled = false;
    $('#btn-request').textContent = `Confirmar corrida ${escapeHtml(S.selectedQuote.label)} — ${fmt.money(S.selectedQuote.price_cents)}`;
  });
  $('#quote-expire').textContent = `Preços válidos até ${fmt.time(q0.expires_at)}. O valor pode variar se o trajeto mudar.`;

  // mapa da cotação
  setTimeout(() => {
    if (S.maps.quote) { S.maps.quote.remove(); S.maps.quote = null; }
    S.maps.quote = makeMap('map-quote', S.origin, 14);
    if (S.maps.quote) {
      emojiMarker(S.maps.quote, S.origin.lat, S.origin.lng, '📍');
      emojiMarker(S.maps.quote, S.dest.lat, S.dest.lng, '🏁');
      const line = drawRoute(S.maps.quote, r.route.geometry);
      S.maps.quote.fitBounds(line.getBounds(), { padding: [30, 30] });
    }
  }, 60);
}

async function requestRide() {
  if (!S.selectedQuote) return;
  const btn = $('#btn-request');
  btn.disabled = true; btn.textContent = 'Solicitando…';
  try {
    const r = await api('/api/rides', {
      method: 'POST',
      body: { quote_id: S.selectedQuote.id, payment_method: S.payment },
    });
    S.activeRide = r.ride;
    askNotifPermission();
    toast(r.notified_drivers > 0
      ? `Corrida solicitada! ${r.notified_drivers} mototaxista(s) avisados.`
      : 'Corrida solicitada! Aguardando mototaxistas ficarem disponíveis…', 'ok');
    renderRide();
    showScreen('screen-ride');
  } catch (e) {
    toast(e.message, 'err');
    if (e.status === 410 || e.status === 409) showScreen('screen-home');
  }
  btn.disabled = false;
}

/* ================= corrida ativa ================= */
function bindRide() {
  $('#btn-cancel-ride').onclick = async () => {
    if (!S.activeRide) return;
    const ok = await confirmModal('Cancelar corrida?',
      'O mototaxista será avisado. Cancelamentos frequentes podem limitar sua conta.', 'Sim, cancelar', true);
    if (!ok) return;
    try {
      await api(`/api/rides/${S.activeRide.id}/cancel`, { method: 'POST', body: { reason: 'Cancelada pelo passageiro no app' } });
      toast('Corrida cancelada.');
      S.activeRide = null;
      showScreen('screen-home');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#chat-send').onclick = sendChat;
  $('#chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
}

async function refreshActiveRide() {
  try {
    const { ride } = await api('/api/rides/active');
    const prev = S.activeRide;
    S.activeRide = ride;
    if (ride) {
      renderRide();
      if (!prev || ['screen-ride', 'screen-home'].includes(currentScreen())) showScreen('screen-ride');
    } else if (prev) {
      // corrida terminou — buscar estado final para avaliar/cancelamento
      const final = await api(`/api/rides/${prev.id}`).catch(() => null);
      if (final?.ride?.status === 'completed' && !final.ride.rated) promptRating(final.ride);
      else if (final?.ride?.status === 'cancelled') {
        toast(final.ride.cancelled_by === 'driver' ? 'O mototaxista cancelou a corrida.' : 'Corrida cancelada.');
      }
      showScreen('screen-home');
      refreshStats();
    }
  } catch { /* mantém estado */ }
}
function currentScreen() { return $$('.screen').find(s => !s.hidden)?.id; }

function renderRide() {
  const r = S.activeRide;
  if (!r) return;
  const BANNERS = {
    requested: ['🔎', 'Procurando mototaxista…', 'Avisamos os parceiros próximos. Aguarde um instante.', true],
    accepted: ['🏍️', r.arrived_at ? 'Seu mototaxista chegou!' : 'Mototaxista a caminho!',
      r.eta_s && !r.arrived_at ? `Chegada em aproximadamente ${fmt.dur(r.eta_s)}` : 'Encontre-o no ponto de embarque.', !r.arrived_at],
    in_progress: ['🛣️', 'Corrida em andamento', r.eta_s ? `Chegada ao destino em ~${fmt.dur(r.eta_s)}` : 'Boa viagem!', false],
  };
  const [ico, title, sub, pulse] = BANNERS[r.status] || ['ℹ️', STATUS_PT[r.status], '', false];
  $('#ride-banner').innerHTML =
    `<span class="sico ${pulse ? 'pulse' : ''}">${ico}</span><div><div class="stitle">${title}</div><div class="ssub">${sub}</div></div>`;

  // cartão do mototaxista
  const dc = $('#ride-driver-card');
  if (r.driver) {
    dc.hidden = false;
    dc.innerHTML = `
      <p class="muted small mb" style="font-weight:700;letter-spacing:.5px">MOTOTAXISTA ${r.status === 'in_progress' ? 'CONDUZINDO VOCÊ' : 'A CAMINHO'}</p>
      <div class="driver-card">
        <div class="avatar">${r.driver.photo ? `<img src="${r.driver.photo}" alt="">` : fmt.initials(r.driver.name)}</div>
        <div style="flex:1">
          <div style="font-weight:800">${escapeHtml(r.driver.name)}</div>
          <div class="muted small">${escapeHtml([r.driver.moto.brand, r.driver.moto.model].filter(Boolean).join(' '))} · ${escapeHtml(r.driver.moto.color || '')}</div>
          <div class="mt" style="margin-top:6px"><span class="plate">${escapeHtml(r.driver.moto.plate || '—')}</span></div>
        </div>
        <div class="center">
          <div class="star-sm">★ ${r.driver.rating ?? 'novo'}</div>
          <div class="muted small">${r.driver.rides_count} corridas</div>
        </div>
      </div>`;
  } else dc.hidden = true;

  $('#ride-details').innerHTML = `
    <div class="list-item"><div class="li-main"><div class="li-sub">📍 Embarque</div><div class="li-title">${escapeHtml(r.origin.text)}</div></div></div>
    <div class="list-item"><div class="li-main"><div class="li-sub">🏁 Destino</div><div class="li-title">${escapeHtml(r.dest.text)}</div></div></div>
    <div class="row between mt">
      <span class="chip soft">${fmt.dist(r.distance_m)}</span>
      <span class="chip soft">${PAY_PT[r.payment_method]}</span>
      <span class="chip yellow">${fmt.money(r.price_cents)}</span>
    </div>`;

  $('#ride-chat').hidden = !(r.status === 'accepted' || r.status === 'in_progress');
  if (!$('#ride-chat').hidden) loadChat();
  $('#btn-cancel-ride').hidden = !(r.status === 'requested' || r.status === 'accepted');

  renderRideMap();
}

function renderRideMap() {
  const r = S.activeRide;
  setTimeout(() => {
    if (!S.maps.ride) S.maps.ride = makeMap('map-ride', { lat: r.origin.lat, lng: r.origin.lng }, 14);
    const map = S.maps.ride;
    if (!map) return;
    S.rideLayers.forEach(l => l.remove()); S.rideLayers = [];
    S.rideLayers.push(emojiMarker(map, r.origin.lat, r.origin.lng, '📍'));
    S.rideLayers.push(emojiMarker(map, r.dest.lat, r.dest.lng, '🏁'));
    if (r.route_geojson) {
      const line = drawRoute(map, r.route_geojson);
      S.rideLayers.push(line);
      map.fitBounds(line.getBounds(), { padding: [30, 30] });
    }
    if (r.driver?.last_lat != null) {
      S.driverMarker = emojiMarker(map, r.driver.last_lat, r.driver.last_lng, '🏍️');
      S.rideLayers.push(S.driverMarker);
    } else S.driverMarker = null;
    map.invalidateSize();
  }, 80);
}

function onDriverLocation(d) {
  if (!S.activeRide || d.ride_id !== S.activeRide.id) return;
  if (S.maps.ride) {
    if (S.driverMarker) S.driverMarker.setLatLng([d.lat, d.lng]);
    else { S.driverMarker = emojiMarker(S.maps.ride, d.lat, d.lng, '🏍️'); S.rideLayers.push(S.driverMarker); }
  }
  if (d.eta_s != null && S.activeRide.status !== 'requested') {
    const sub = $('#ride-banner .ssub');
    if (sub && !S.activeRide.arrived_at) {
      sub.textContent = S.activeRide.status === 'in_progress'
        ? `Chegada ao destino em ~${fmt.dur(d.eta_s)}`
        : `Chegada em aproximadamente ${fmt.dur(d.eta_s)}`;
    }
  }
}

/* ---------- chat ---------- */
async function loadChat() {
  if (!S.activeRide) return;
  try {
    const { messages } = await api(`/api/rides/${S.activeRide.id}/messages`);
    $('#chat-box').innerHTML = messages.map(m =>
      `<div class="chat-msg ${m.sender_id === S.user.id ? 'me' : 'other'}">${escapeHtml(m.body)}</div>`).join('');
    $('#chat-box').scrollTop = 1e6;
  } catch { }
}
async function sendChat() {
  const input = $('#chat-input');
  const body = input.value.trim();
  if (!body || !S.activeRide) return;
  input.value = '';
  try {
    await api(`/api/rides/${S.activeRide.id}/messages`, { method: 'POST', body: { body } });
    loadChat();
  } catch (e) { toast(e.message, 'err'); }
}
function onChatMessage(m) {
  if (S.activeRide && m.ride_id === S.activeRide.id) { loadChat(); toast(`💬 ${m.sender_name}: ${m.body}`); }
}

/* ---------- avaliação ---------- */
function promptRating(ride) {
  let stars = 0;
  const m = openModal(`
    <h3>Como foi sua corrida?</h3>
    <p class="muted small mb">${escapeHtml(ride.driver?.name || 'Mototaxista')} · ${fmt.money(ride.price_cents)}</p>
    <div class="stars mb" id="rate-stars">${[1, 2, 3, 4, 5].map(i => `<button data-s="${i}">⭐</button>`).join('')}</div>
    <div class="field"><textarea class="input" id="rate-comment" placeholder="Comentário (opcional)" maxlength="500"></textarea></div>
    <button class="btn btn-primary" id="rate-send" disabled>Enviar avaliação</button>
    <button class="btn btn-outline mt" id="rate-skip">Agora não</button>`);
  $$('#rate-stars button', m).forEach(b => b.onclick = () => {
    stars = Number(b.dataset.s);
    $$('#rate-stars button', m).forEach(x => x.classList.toggle('on', Number(x.dataset.s) <= stars));
    $('#rate-send', m).disabled = false;
  });
  $('#rate-send', m).onclick = async () => {
    try {
      await api(`/api/rides/${ride.id}/rate`, { method: 'POST', body: { stars, comment: $('#rate-comment', m).value } });
      toast('Avaliação enviada. Obrigado! ⭐', 'ok');
      m.close();
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#rate-skip', m).onclick = () => m.close();
}

/* ================= histórico ================= */
async function loadHistory() {
  const box = $('#history-list');
  box.innerHTML = '<div class="spinner"></div>';
  try {
    const { rides } = await api('/api/rides');
    if (!rides.length) {
      box.innerHTML = '<div class="empty"><div class="eico">🛵</div>Você ainda não fez nenhuma corrida.<br>Peça a primeira na tela inicial!</div>';
      return;
    }
    box.innerHTML = rides.map(r => `
      <div class="list-item">
        <div class="li-main">
          <div class="li-title">${escapeHtml(r.origin.text)} → ${escapeHtml(r.dest.text)}</div>
          <div class="li-sub">${fmt.dt(r.requested_at)} · ${fmt.dist(r.distance_m)} · ${fmt.money(r.price_cents)}</div>
        </div>
        <div class="center">
          <span class="pill ${STATUS_PILL[r.status]}">${STATUS_PT[r.status]}</span>
          ${r.status === 'completed' && !r.rated ? `<br><button class="btn btn-outline btn-sm mt" data-rate="${r.id}">Avaliar ⭐</button>` : ''}
          ${r.rated ? `<div class="star-sm">★ ${r.rated}</div>` : ''}
        </div>
      </div>`).join('');
    $$('[data-rate]', box).forEach(b => b.onclick = () => {
      promptRating(rides.find(r => r.id === b.dataset.rate));
    });
  } catch (e) {
    box.innerHTML = `<div class="empty"><div class="eico">⚠️</div>${escapeHtml(e.message)}</div>`;
  }
}

/* ================= perfil ================= */
function bindProfile() {
  $('#form-profile').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/api/me', { method: 'PATCH', body: { name: f.get('name'), phone: f.get('phone') } });
      S.user.name = f.get('name'); S.user.phone = f.get('phone');
      toast('Perfil atualizado!', 'ok'); fillProfile();
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#form-support').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/api/support', { method: 'POST', body: { subject: f.get('subject'), body: f.get('body') } });
      toast('Mensagem enviada ao suporte!', 'ok');
      e.target.reset(); loadSupport();
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#btn-notif-perm').onclick = async () => {
    toast(await askNotifPermission() ? 'Notificações ativadas! 🔔' : 'Notificações não autorizadas pelo navegador.', 'ok');
  };
  $('#btn-logout').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => { });
    location.reload();
  };
}
function fillProfile() {
  if (!S.user) return;
  $('#profile-avatar').innerHTML = S.user.photo ? `<img src="${S.user.photo}">` : fmt.initials(S.user.name);
  $('#profile-name').textContent = S.user.name;
  $('#profile-email').textContent = S.user.email;
  $('#form-profile [name=name]').value = S.user.name;
  $('#form-profile [name=phone]').value = S.user.phone || '';
}
async function loadSupport() {
  try {
    const { messages, replies } = await api('/api/support');
    $('#support-list').innerHTML = messages.length ? messages.map(msg => {
      const reps = replies.filter(r => r.message_id === msg.id);
      return `<div class="list-item"><div class="li-main">
        <div class="li-title">${escapeHtml(msg.subject)} <span class="pill ${msg.status === 'respondido' ? 'green' : 'gray'}">${msg.status}</span></div>
        <div class="li-sub">${escapeHtml(msg.body)}</div>
        ${reps.map(r => `<div class="li-sub mt" style="color:var(--green)">↳ Suporte: ${escapeHtml(r.body)}</div>`).join('')}
      </div></div>`;
    }).join('') : '';
  } catch { }
}
