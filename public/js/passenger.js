/* Assis MotoTáxi — aplicativo do passageiro (V2) */
'use strict';

const S = {
  config: null, user: null,
  origin: null, dest: null,          // {lat,lng,text}
  originConfirmed: false, destConfirmed: false,
  quotes: [], quoteRoute: null, selectedQuote: null,
  payment: null, payMethods: [], testMode: false,
  activeRide: null,
  maps: { home: null, quote: null, ride: null },
  rideLayers: [], driverMarker: null, meMarker: null, accCircle: null,
  statsTimer: null, payTimer: null, confirmTimer: null,
  gps: { lat: null, lng: null, accuracy: null, at: 0, watchId: null, state: 'off' },
  moveAlertShown: false, pickingOnMap: null,
  serverSkew: 0,                     // diferença entre relógio do servidor e do aparelho
};

init();

async function init() {
  renderBrand($('#brand'));
  S.config = await api('/api/config').catch(() => ({
    city_name: 'Assis Chateaubriand - PR', center: { lat: -24.4156, lng: -53.5216 },
    welcome_message: 'Olá! Para onde vamos?',
  }));
  await initMaps(S.config);
  $('#auth-hero').innerHTML = `${LOGO_SVG}<h1>Assis MotoTáxi</h1>
    <p>Transporte rápido e seguro em ${escapeHtml(S.config.city_name)}</p>`;

  bindAuth(); bindHome(); bindQuote(); bindRide(); bindProfile(); bindNav();

  navigator.serviceWorker?.addEventListener('message', e => {
    if (e.data?.type === 'notification-click') refreshActiveRide();
  });

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
    await withLoading(e.target.querySelector('button[type=submit]'), async () => {
      const r = await api('/api/auth/login', {
        method: 'POST', body: { email: f.get('email'), password: f.get('password') },
      });
      if (r.user.role !== 'passenger') { location.href = r.user.role === 'admin' ? '/admin' : '/motorista'; return; }
      S.user = r.user; enterApp();
    }).catch(() => { });
  };
  $('#form-register').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    await withLoading(e.target.querySelector('button[type=submit]'), async () => {
      const r = await api('/api/auth/register', {
        method: 'POST',
        body: {
          role: 'passenger', name: f.get('name'), phone: f.get('phone'),
          email: f.get('email'), password: f.get('password'),
        },
      });
      S.user = r.user; toast('Conta criada! Bem-vindo(a) 🎉', 'ok'); enterApp();
    }).catch(() => { });
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
          const r = await api('/api/auth/google', {
            method: 'POST', body: { credential: resp.credential, role: 'passenger' },
          });
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
  $('#greeting').textContent = S.config.welcome_message;
  fillProfile();
  refreshPushSubscription();

  connectSSE({
    notification: n => { toast(n.title); browserNotify(n.title, n.body || ''); bumpBadge(); },
    ride_update: () => refreshActiveRide(),
    driver_location: d => onDriverLocation(d),
    ride_message: m => onChatMessage(m),
  });

  await loadPaymentMethods();
  await refreshActiveRide();
  if (!S.activeRide) showScreen('screen-home');
  initHomeMap();
  startGpsWatch();
  refreshStats();
  clearInterval(S.statsTimer);
  S.statsTimer = setInterval(refreshStats, 15000);
  loadFavorites();
}

async function loadPaymentMethods() {
  try {
    const f = await api('/api/public/fares');
    S.payMethods = f.payment_methods;
    S.testMode = f.test_mode;
    S.payment = (f.payment_methods.find(m => m.enabled) || {}).method || 'dinheiro';
  } catch { S.payMethods = []; }
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
    if (id === 'screen-profile') {
      fillProfile(); loadFavorites(); loadSupport();
      renderNotificationStatus($('#notif-status'));
    }
  });
}

/* ================= GPS contínuo ================= */
/**
 * O marcador do passageiro acompanha o aparelho de verdade: `watchPosition`
 * atualiza posição, precisão e horário. Posições inválidas, imprecisas demais
 * ou antigas não são tratadas como atuais.
 */
function startGpsWatch() {
  if (!navigator.geolocation) { setGpsState('off', 'GPS indisponível neste navegador'); return; }
  if (S.gps.watchId != null) return;
  setGpsState('wait', 'Obtendo sua localização…');
  S.gps.watchId = navigator.geolocation.watchPosition(
    pos => onGpsFix(pos),
    err => {
      setGpsState('off', err.code === 1
        ? 'Permissão de localização negada'
        : 'Sem sinal de GPS no momento');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
}

function onGpsFix(pos) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return;
  const maxAcc = 150;
  const prev = { lat: S.gps.lat, lng: S.gps.lng };
  S.gps = { ...S.gps, lat, lng, accuracy, at: Date.now() };
  setGpsState(accuracy > maxAcc ? 'weak' : 'ok',
    accuracy > maxAcc ? `Sinal fraco (±${Math.round(accuracy)} m)` : `GPS ativo (±${Math.round(accuracy)} m)`);

  drawMeOnMaps(lat, lng, accuracy);

  // durante a corrida, compartilha a posição com o mototaxista
  if (S.activeRide && ['requested', 'accepted', 'in_progress'].includes(S.activeRide.status)) {
    api(`/api/rides/${S.activeRide.id}/location`, {
      method: 'POST', body: { lat, lng, accuracy_m: accuracy },
    }).catch(() => { });
  }

  // avisa se o passageiro se afastou do ponto de embarque escolhido
  if (accuracy <= maxAcc) checkPickupDrift(lat, lng, prev);
}

function setGpsState(state, label) {
  S.gps.state = state;
  const cls = state === 'ok' ? '' : (state === 'weak' ? 'weak' : 'off');
  const icon = state === 'ok' ? '🛰️' : (state === 'weak' ? '📶' : '⚠️');
  $$('.gps-chip').forEach(el => {
    el.className = `gps-chip ${cls}`;
    el.textContent = `${icon} ${label}`;
  });
}

/** Mantém o marcador "você" e o círculo de precisão nos mapas visíveis. */
function drawMeOnMaps(lat, lng, accuracy) {
  for (const map of [S.maps.home, S.maps.ride]) {
    if (!map) continue;
    if (!map._meMarker) {
      map._meMarker = emojiMarker(map, lat, lng, '🔵', 'Você');
      map._accCircle = accuracyCircle(map, lat, lng, accuracy);
    } else {
      map._meMarker.setLatLng([lat, lng]);
      map._accCircle.setLatLng([lat, lng]).setRadius(accuracy);
    }
  }
}

/** Se a origem escolhida ficou longe de onde o passageiro está, pergunta. */
function checkPickupDrift(lat, lng, prev) {
  if (!S.origin || S.moveAlertShown) return;
  const ride = S.activeRide;
  if (ride && !['pending_payment', 'requested', 'accepted'].includes(ride.status)) return;
  const ref = ride ? ride.origin : S.origin;
  const dist = haversineClient(lat, lng, ref.lat, ref.lng);
  if (dist < 80) return;
  S.moveAlertShown = true;
  showMoveAlert(lat, lng, Math.round(dist));
}

function haversineClient(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = d => d * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLng = r(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function showMoveAlert(lat, lng, dist) {
  const rev = await api(`/api/geo/reverse?lat=${lat}&lng=${lng}`).catch(() => null);
  const text = rev?.text || `Ponto no mapa (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
  const m = openModal(`
    <h3>📍 Você mudou de localização</h3>
    <p class="muted mb">Percebemos que você está a cerca de <b>${fmt.dist(dist)}</b> do ponto
    de embarque escolhido. Deseja atualizar?</p>
    <div class="list-item"><div class="li-main">
      <div class="li-sub">Nova posição</div><div class="li-title">${escapeHtml(text)}</div></div></div>
    <button class="btn btn-primary mt" data-upd>Atualizar local de embarque</button>
    <button class="btn btn-outline mt" data-keep>Manter o local selecionado</button>`,
    { onClose: () => { setTimeout(() => { S.moveAlertShown = false; }, 60000); } });

  $('[data-upd]', m).onclick = () => withLoading($('[data-upd]', m), async () => {
    if (S.activeRide) {
      const r = await api(`/api/rides/${S.activeRide.id}/pickup`, {
        method: 'PATCH', body: { lat, lng, text },
      });
      toast(S.activeRide.driver
        ? `Embarque atualizado (${fmt.dist(r.moved_m)}). O mototaxista foi avisado.`
        : 'Ponto de embarque atualizado.', 'ok');
      await refreshActiveRide();
    } else {
      S.origin = { lat, lng, text };
      S.originConfirmed = true;
      $('#in-origin').value = text;
      placeHomePin(S.origin, 'origin');
      toast('Ponto de embarque atualizado.', 'ok');
    }
    m.close();
  });
  $('[data-keep]', m).onclick = () => m.close();
}

function centerOnMe(map) {
  if (S.gps.lat == null) { toast('Ainda estamos obtendo sua localização.', 'err'); return; }
  map?.setView([S.gps.lat, S.gps.lng], 16);
}

/* ================= tela inicial ================= */
let homeMarkers = [];
function initHomeMap() {
  if (S.maps.home) return;
  S.maps.home = makeMap('map-home', S.config.center, 14);
  addMapTools('map-home', S.maps.home, true);
}

// Se o Google for recusado em tempo de execução, refaz os mapas no OpenStreetMap
document.addEventListener('maps-provider-changed', () => {
  for (const k of ['home', 'quote', 'ride']) {
    const el = document.getElementById(`map-${k}`);
    if (el) el.innerHTML = '';
    S.maps[k] = null;
  }
  homeMarkers = []; S.rideLayers = []; S.driverMarker = null;
  initHomeMap();
  if (S.activeRide) renderRideMap();
  if (S.gps.lat != null) drawMeOnMaps(S.gps.lat, S.gps.lng, S.gps.accuracy || 30);
});

/** Botões sobre o mapa: centralizar em mim e escolher ponto tocando no mapa. */
function addMapTools(elId, map, allowPick) {
  if (!map) return;
  const host = document.getElementById(elId);
  const tools = document.createElement('div');
  tools.className = 'map-tools';
  tools.innerHTML = `<button title="Centralizar em mim" data-center>🎯</button>` +
    (allowPick ? `<button title="Escolher no mapa" data-pick>📌</button>` : '');
  host.appendChild(tools);
  $('[data-center]', tools).onclick = () => centerOnMe(map);
  if (allowPick) $('[data-pick]', tools).onclick = () => startMapPick(map, host);
}

/** Seleção manual do ponto tocando no mapa (pedido comum em bairros sem número). */
function startMapPick(map, host) {
  if (S.pickingOnMap) return;
  const which = S.origin && !S.dest ? 'dest' : 'origin';
  const hint = document.createElement('div');
  hint.className = 'map-hint';
  hint.textContent = which === 'origin'
    ? 'Toque no mapa para marcar o EMBARQUE' : 'Toque no mapa para marcar o DESTINO';
  host.appendChild(hint);
  S.pickingOnMap = which;

  const onClick = async e => {
    map.off('click', onClick);
    hint.remove();
    S.pickingOnMap = null;
    const { lat, lng } = e.latlng;
    const rev = await api(`/api/geo/reverse?lat=${lat}&lng=${lng}`).catch(() => null);
    if (rev && !rev.in_coverage) {
      toast('Esse ponto está fora da área de atendimento.', 'err');
      return;
    }
    const text = rev?.text || `Ponto no mapa (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
    const point = { lat, lng, text };
    if (which === 'origin') {
      S.origin = point; S.originConfirmed = true; $('#in-origin').value = text;
    } else {
      S.dest = point; S.destConfirmed = true; $('#in-dest').value = text;
    }
    placeHomePin(point, which);
    toast(`${which === 'origin' ? 'Embarque' : 'Destino'} marcado no mapa${rev?.exact ? '' : ' (endereço aproximado)'}.`, 'ok');
  };
  map.on('click', onClick);
}

/**
 * O número digitado não está mapeado: o pino foi para o centro da rua.
 * Pede ao passageiro o toque no ponto exato — e GRAVA a posição no servidor,
 * para a próxima busca desse endereço (de qualquer pessoa) acertar direto.
 */
function startNumberAdjust(which, p) {
  initHomeMap();
  const map = S.maps.home, host = document.getElementById('map-home');
  const finish = (lat, lng, adjusted) => {
    const point = { lat, lng, text: p.text };
    if (which === 'origin') { S.origin = point; S.originConfirmed = true; $('#in-origin').value = p.text; }
    else { S.dest = point; S.destConfirmed = true; $('#in-dest').value = p.text; }
    placeHomePin(point, which);
    if (adjusted && p.street && p.number) {
      api('/api/geo/learn', {
        method: 'POST',
        body: { street: p.street, number: Number(p.number), lat, lng },
      }).then(() => toast('Ponto exato salvo — a próxima busca desse endereço já acerta. 🎯', 'ok'))
        .catch(() => { });
    }
  };
  if (!map || !host) { finish(p.lat, p.lng, false); return; }

  // remove ajuste anterior pendente, se houver
  host.querySelector('.map-hint')?.remove();
  placeHomePin(p, which);
  map.setView([p.lat, p.lng], 17);
  host.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const hint = document.createElement('div');
  hint.className = 'map-hint';
  hint.innerHTML = `O nº ${escapeHtml(String(p.number))} não está no mapa ainda —
    toque no PONTO EXATO (portão/fachada)
    <button type="button" data-asis style="margin-left:6px;padding:2px 10px;border-radius:8px;
      border:1px solid rgba(255,255,255,.5);background:transparent;color:inherit;cursor:pointer">
      Usar assim mesmo</button>`;
  host.appendChild(hint);

  const done = (lat, lng, adjusted) => {
    map.off('click', onClick);
    hint.remove();
    finish(lat, lng, adjusted);
  };
  const onClick = e => done(e.latlng.lat, e.latlng.lng, true);
  map.on('click', onClick);
  hint.querySelector('[data-asis]').onclick = () => done(p.lat, p.lng, false);
}

async function refreshStats() {
  try {
    const st = await api('/api/public/stats');
    $('#online-chip').textContent = st.online_drivers === 0
      ? '🏍️ Nenhum mototaxista disponível agora'
      : `🏍️ ${st.online_drivers} mototaxista${st.online_drivers > 1 ? 's' : ''} disponíve${st.online_drivers > 1 ? 'is' : 'l'} agora`;
    if (S.maps.home) {
      homeMarkers.forEach(m => m.remove());
      homeMarkers = st.markers.map(m => emojiMarker(S.maps.home, m.lat, m.lng, '🏍️'));
    }
  } catch { /* silencioso */ }
}

function bindHome() {
  const pick = which => p => {
    // "rua + número" sem posição conhecida: o pino cai no centro da rua —
    // em vez de aceitar um ponto errado, pedimos o ajuste no mapa
    if (p.approx && p.number) { startNumberAdjust(which, p); return; }
    if (which === 'origin') { S.origin = p; S.originConfirmed = true; }
    else { S.dest = p; S.destConfirmed = true; }
    placeHomePin(p, which);
  };
  setupAutocomplete($('#in-origin'), $('#ac-origin'),
    pick('origin'), () => { S.originConfirmed = false; });
  setupAutocomplete($('#in-dest'), $('#ac-dest'),
    pick('dest'), () => { S.destConfirmed = false; });

  $('#btn-mylocation').onclick = () => withLoading($('#btn-mylocation'), async () => {
    const pos = S.gps.lat != null && Date.now() - S.gps.at < 30000
      ? { lat: S.gps.lat, lng: S.gps.lng }
      : await getPosition();
    const rev = await api(`/api/geo/reverse?lat=${pos.lat}&lng=${pos.lng}`)
      .catch(() => ({ text: 'Minha localização atual', in_coverage: true }));
    if (!rev.in_coverage) throw new Error('Você está fora da área de atendimento da cidade.');
    S.origin = { ...pos, text: rev.text };
    S.originConfirmed = true;
    $('#in-origin').value = rev.text;
    placeHomePin(S.origin, 'origin');
    if (S.maps.home) S.maps.home.setView([pos.lat, pos.lng], 16);
  });

  $('#btn-quote').onclick = () => withLoading($('#btn-quote'), async () => {
    if (!S.origin || !S.originConfirmed) {
      throw new Error('Escolha o local de embarque na lista de sugestões, no mapa ou use sua localização.');
    }
    if (!S.dest || !S.destConfirmed) {
      throw new Error('Escolha o destino na lista de sugestões ou marque no mapa.');
    }
    const r = await api('/api/quotes', { method: 'POST', body: { origin: S.origin, dest: S.dest } });
    S.quotes = r.quotes; S.quoteRoute = r.route; S.selectedQuote = null;
    S.payMethods = r.payment_methods; S.testMode = r.test_mode;
    renderQuotes(r);
    showScreen('screen-quote');
  });
}

const homePins = {};
function placeHomePin(p, kind) {
  if (!S.maps.home) return;
  homePins[kind]?.remove();
  homePins[kind] = emojiMarker(S.maps.home, p.lat, p.lng, kind === 'origin' ? '📍' : '🏁');
  S.maps.home.setView([p.lat, p.lng], 15);
}

/**
 * Autocomplete de endereços. Diferente da V1, digitar sem escolher da lista
 * invalida a seleção anterior — assim o texto nunca fica diferente do ponto
 * realmente usado no cálculo.
 */
/**
 * Autocomplete de endereços.
 *
 * Com o Google Places, a coordenada só é buscada quando o usuário ESCOLHE
 * um item (Place Details) — digitar não gera chamada cara, e o `session`
 * agrupa a digitação + a escolha numa única cobrança.
 * Digitar depois de escolher invalida a seleção: o texto nunca fica
 * diferente do ponto realmente usado no cálculo.
 */
function setupAutocomplete(input, list, onPick, onEdit) {
  let timer = null, lastQuery = '', session = null;
  const newSession = () => (session = (crypto.randomUUID?.() || String(Math.random()).slice(2)));

  input.addEventListener('input', () => {
    onEdit?.();
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { list.hidden = true; return; }
    if (q === lastQuery) return;
    lastQuery = q;
    if (!session) newSession();
    list.innerHTML = '<button type="button" disabled>Buscando…</button>';
    list.hidden = false;
    // espera o usuário parar de digitar: menos chamadas, menos custo
    timer = setTimeout(async () => {
      try {
        const { results } = await api(
          `/api/geo/search?q=${encodeURIComponent(q)}&session=${encodeURIComponent(session)}`);
        if (!results.length) {
          list.innerHTML = `<button type="button" disabled>
            Nada encontrado. Tente a rua + bairro, ou use 📌 para marcar no mapa.</button>`;
          return;
        }
        list.innerHTML = results.map((r, i) => {
          const num = r.number_how === 'exato' ? ' · nº confirmado ✅'
            : r.number_how === 'interpolado' ? ' · nº estimado'
              : r.number_how === 'centro' ? ' · ajuste o ponto no mapa' : '';
          const detalhe = r.needs_details
            ? (r.secondary ? `<span class="muted small">${escapeHtml(r.secondary)}</span>` : '')
            : `<span class="muted small">· ${fmt.dist(r.distance_m)} do centro${num}${r.in_coverage ? '' : ' · FORA DE ÁREA'}</span>`;
          return `<button type="button" data-i="${i}">${escapeHtml(r.text)}<br>${detalhe}</button>`;
        }).join('');

        $$('button[data-i]', list).forEach(b => b.onclick = async () => {
          let r = results[Number(b.dataset.i)];
          // sugestão do Google: resolve a coordenada agora
          if (r.needs_details && r.place_id) {
            b.textContent = 'Localizando…';
            try {
              const { place } = await api(
                `/api/geo/place?place_id=${encodeURIComponent(r.place_id)}&session=${encodeURIComponent(session)}`);
              r = place;
            } catch (e) { toast(e.message, 'err'); list.hidden = true; return; }
          }
          if (!r.in_coverage) {
            toast(`"${r.text}" está fora da área de atendimento (${fmt.dist(r.distance_m)} do centro).`, 'err');
            list.hidden = true;
            return;
          }
          input.value = r.text;
          list.hidden = true;
          session = null;                     // sessão encerrada na escolha
          onPick({
            lat: r.lat, lng: r.lng, text: r.text,
            approx: !!r.approx, street: r.street, number: r.number,
            number_how: r.number_how,
          });
        });
      } catch (e) {
        list.innerHTML = `<button type="button" disabled>${escapeHtml(e.message)}</button>`;
      }
    }, 450);
  });
  input.addEventListener('focus', () => { if (list.innerHTML && input.value.length >= 2) list.hidden = false; });
  document.addEventListener('click', e => {
    if (!list.contains(e.target) && e.target !== input) list.hidden = true;
  });
}

async function loadFavorites() {
  try {
    const { favorites } = await api('/api/favorites');
    $('#fav-chips').innerHTML = favorites.map(f =>
      `<button class="chip soft" data-id="${f.id}" title="${escapeHtml(f.text)}">⭐ ${escapeHtml(f.label)}</button>`).join('');
    $$('#fav-chips .chip').forEach(b => b.onclick = () => {
      const f = favorites.find(x => x.id === b.dataset.id);
      S.dest = { lat: f.lat, lng: f.lng, text: f.text };
      S.destConfirmed = true;
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

/* ================= cotação e pagamento ================= */
function bindQuote() {
  $('#btn-quote-back').onclick = () => showScreen('screen-home');
  $('#btn-request').onclick = () => requestRide($('#btn-request'));
}

function renderQuotes(r) {
  const q0 = S.quotes[0];
  // procedência da rota: o passageiro vê se é rota de moto, de carro ou estimativa
  const PROC = {
    two_wheeler: '<span class="pill green">rota de motocicleta</span>',
    drive: '<span class="pill blue">rota de carro</span>',
    estimativa: '<span class="pill yellow">distância estimada</span>',
  };
  const procedencia = PROC[r.route.mode] || '';
  const aviso = r.route.mode_fallback
    ? '<br><span class="muted small">⚠️ Rota de motocicleta indisponível neste trajeto; usamos a rota de carro.</span>'
    : '';

  $('#quote-summary').innerHTML =
    `📍 ${escapeHtml(S.origin.text)}<br>🏁 ${escapeHtml(S.dest.text)}<br>` +
    `Distância: <b>${fmt.dist(q0.distance_m)}</b> · Tempo estimado: <b>${fmt.dur(q0.duration_s)}</b>` +
    ` · ${procedencia}${aviso}` +
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
    updateRequestButton();
  });

  // formas de pagamento reais, vindas do servidor
  const ICONS = { pix: '⚡', cartao: '💳', dinheiro: '💵' };
  $('#pay-options').innerHTML = S.payMethods.map(m => `
    <button class="pay-option ${m.method === S.payment ? 'selected' : ''}"
            data-pay="${m.method}" ${m.enabled ? '' : 'disabled'}>
      <span class="pico">${ICONS[m.method]}</span>
      <span class="pinfo">
        <span class="pname">${escapeHtml(m.label)}</span>
        ${m.note ? `<br><span class="pnote">${escapeHtml(m.note)}</span>` : ''}
      </span>
      ${m.enabled ? '' : '<span class="pill gray">indisponível</span>'}
    </button>`).join('');
  $$('#pay-options .pay-option').forEach(b => b.onclick = () => {
    $$('#pay-options .pay-option').forEach(x => x.classList.remove('selected'));
    b.classList.add('selected');
    S.payment = b.dataset.pay;
    updateRequestButton();
  });

  $('#quote-testbar').hidden = !S.testMode;
  $('#quote-expire').textContent =
    `Preços válidos até ${fmt.time(q0.expires_at)}. O valor é calculado e conferido no servidor.`;
  updateRequestButton();

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

function updateRequestButton() {
  const btn = $('#btn-request');
  btn.disabled = !S.selectedQuote || !S.payment;
  if (!S.selectedQuote) { btn.textContent = 'Escolha a categoria'; return; }
  const label = { pix: 'Pagar com Pix', cartao: 'Pagar com cartão', dinheiro: 'Confirmar (pago em dinheiro)' };
  btn.textContent = `${label[S.payment] || 'Confirmar'} — ${fmt.money(S.selectedQuote.price_cents)}`;
}

async function requestRide(btn) {
  if (!S.selectedQuote) return;
  await withLoading(btn, async () => {
    const r = await api('/api/rides', {
      method: 'POST',
      body: { quote_id: S.selectedQuote.id, payment_method: S.payment },
    });
    S.activeRide = r.ride;
    enablePush();
    renderRide();
    showScreen('screen-ride');
  }).catch(e => {
    if (e.status === 410 || e.status === 409) showScreen('screen-home');
  });
}

/* ================= corrida ativa ================= */
function bindRide() {
  $('#btn-cancel-ride').onclick = async () => {
    if (!S.activeRide) return;
    const ok = await confirmModal('Cancelar corrida?',
      'O mototaxista será avisado e o valor pago será estornado.', 'Sim, cancelar', true);
    if (!ok) return;
    await withLoading($('#btn-cancel-ride'), async () => {
      await api(`/api/rides/${S.activeRide.id}/cancel`, {
        method: 'POST', body: { reason: 'Cancelada pelo passageiro no app' },
      });
      toast('Corrida cancelada.');
      S.activeRide = null;
      showScreen('screen-home');
    }).catch(() => { });
  };
  $('#chat-send').onclick = sendChat;
  $('#chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
}

async function refreshActiveRide() {
  try {
    const { ride, server_time } = await api('/api/rides/active');
    if (server_time) S.serverSkew = server_time - Date.now();
    const prev = S.activeRide;
    S.activeRide = ride;
    if (ride) {
      renderRide();
      if (!prev || ['screen-ride', 'screen-home'].includes(currentScreen())) showScreen('screen-ride');
    } else if (prev) {
      const final = await api(`/api/rides/${prev.id}`).catch(() => null);
      stopPaymentPolling();
      closeConfirmModal();
      if (final?.ride?.status === 'completed' && !final.ride.rated) promptRating(final.ride);
      else if (final?.ride?.status === 'cancelled') {
        toast(final.ride.cancelled_by === 'driver'
          ? 'O mototaxista cancelou a corrida.' : 'Corrida cancelada.');
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
    pending_payment: ['💳', 'Aguardando pagamento',
      r.payment_method === 'pix' ? 'Escaneie o Pix para liberar sua corrida.' : 'Confirmando seu pagamento…', true],
    requested: ['🔎', 'Procurando mototaxista…', 'Avisamos os parceiros próximos. Aguarde um instante.', true],
    accepted: ['🏍️', r.arrived_at ? 'Seu mototaxista chegou!' : 'Mototaxista a caminho!',
      r.eta_s && !r.arrived_at ? `Chegada em aproximadamente ${fmt.dur(r.eta_s)}` : 'Encontre-o no ponto de embarque.', !r.arrived_at],
    in_progress: ['🛣️', 'Corrida em andamento', r.eta_s ? `Chegada ao destino em ~${fmt.dur(r.eta_s)}` : 'Boa viagem!', false],
    awaiting_confirmation: ['✅', 'Confirme sua chegada', 'Seu mototaxista informou que a corrida terminou.', true],
    disputed: ['⚠️', 'Ocorrência em análise', 'Nossa equipe está avaliando o seu relato.', false],
  };
  const [ico, title, sub, pulse] = BANNERS[r.status] || ['ℹ️', r.status, '', false];
  $('#ride-banner').innerHTML =
    `<span class="sico ${pulse ? 'pulse' : ''}">${ico}</span><div><div class="stitle">${title}</div><div class="ssub">${sub}</div></div>`;

  renderPaymentBox(r);

  const dc = $('#ride-driver-card');
  if (r.driver) {
    dc.hidden = false;
    dc.innerHTML = `
      <p class="muted small mb" style="font-weight:700;letter-spacing:.5px">MOTOTAXISTA ${r.status === 'in_progress' ? 'CONDUZINDO VOCÊ' : 'A CAMINHO'}</p>
      <div class="driver-card">
        <div class="avatar">${r.driver.photo ? `<img src="${r.driver.photo}" alt="">` : fmt.initials(r.driver.name)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:800">${escapeHtml(r.driver.name)}</div>
          <div class="muted small">${escapeHtml([r.driver.moto.brand, r.driver.moto.model].filter(Boolean).join(' '))} · ${escapeHtml(r.driver.moto.color || '')}</div>
          <div style="margin-top:6px"><span class="plate">${escapeHtml(r.driver.moto.plate || '—')}</span></div>
        </div>
        <div class="center">
          <div class="star-sm">★ ${r.driver.rating ?? 'novo'}</div>
          <div class="muted small">${r.driver.rides_count} corridas</div>
        </div>
      </div>
      ${r.driver.loc_stale ? '<p class="muted small mt">📡 Localização do mototaxista desatualizada — pode estar sem sinal.</p>' : ''}`;
  } else dc.hidden = true;

  $('#ride-details').innerHTML = `
    <div class="list-item"><div class="li-main"><div class="li-sub">📍 Embarque</div>
      <div class="li-title">${escapeHtml(r.origin.text)}</div></div></div>
    <div class="list-item"><div class="li-main"><div class="li-sub">🏁 Destino</div>
      <div class="li-title">${escapeHtml(r.dest.text)}</div></div></div>
    <div class="row between mt" style="flex-wrap:wrap">
      <span class="chip soft">${fmt.dist(r.distance_m)}</span>
      <span class="chip soft">${PAY_PT[r.payment_method]}</span>
      <span class="chip yellow">${fmt.money(r.price_cents)}</span>
    </div>
    <div class="mt"><span class="gps-chip">🛰️ GPS</span></div>`;
  setGpsState(S.gps.state, S.gps.state === 'ok' ? `GPS ativo (±${Math.round(S.gps.accuracy || 0)} m)`
    : S.gps.state === 'weak' ? 'Sinal fraco' : 'GPS indisponível');

  $('#ride-chat').hidden = !['accepted', 'in_progress'].includes(r.status);
  if (!$('#ride-chat').hidden) loadChat();
  $('#btn-cancel-ride').hidden = !['pending_payment', 'requested', 'accepted'].includes(r.status);

  if (r.status === 'awaiting_confirmation') openConfirmModal(r); else closeConfirmModal();
  if (r.status === 'pending_payment') startPaymentPolling(); else stopPaymentPolling();

  renderRideMap();
}

/* ---------- pagamento ---------- */
function renderPaymentBox(r) {
  const box = $('#ride-payment');
  const p = r.payment;
  if (!p || r.status !== 'pending_payment') { box.hidden = true; return; }
  box.hidden = false;

  if (p.method === 'pix') {
    box.innerHTML = `
      ${p.test_mode ? '<div class="testbar">🧪 MODO DE TESTE — nenhum valor real será cobrado</div>' : ''}
      <h2>Pague com Pix para liberar a corrida</h2>
      <div class="pix-box">
        ${p.pix_qr_base64
        ? `<img src="data:image/png;base64,${p.pix_qr_base64}" alt="QR Code Pix">`
        : `<div class="qr-placeholder muted small">${p.test_mode
          ? '🧪 QR de teste<br>(sem valor real)'
          : 'QR Code indisponível<br>use o código abaixo'}</div>`}
        <div class="pix-code" id="pix-code">${escapeHtml(p.pix_qr_code || '')}</div>
        <button class="btn btn-outline btn-sm mt" id="btn-copy-pix">📋 Copiar código Pix</button>
      </div>
      <p class="muted small center mt">Assim que o pagamento cair, procuramos seu mototaxista automaticamente.
      ${p.pix_expires_at ? `<br>Expira às ${fmt.time(p.pix_expires_at)}.` : ''}</p>
      ${p.test_mode ? '<button class="btn btn-navy mt" id="btn-test-pay">Simular aprovação (modo de teste)</button>' : ''}`;
    $('#btn-copy-pix').onclick = async () => {
      try {
        await navigator.clipboard.writeText(p.pix_qr_code || '');
        toast('Código Pix copiado!', 'ok');
      } catch { toast('Copie o código manualmente.', 'err'); }
    };
  } else {
    box.innerHTML = `
      ${p.test_mode ? '<div class="testbar">🧪 MODO DE TESTE — nenhum valor real será cobrado</div>' : ''}
      <h2>Confirmando o pagamento</h2>
      <div class="spinner mt mb"></div>
      <p class="muted small center">Status: <b>${escapeHtml(p.status)}</b>
      ${p.failure_reason ? `<br>${escapeHtml(p.failure_reason)}` : ''}</p>
      ${p.test_mode ? '<button class="btn btn-navy mt" id="btn-test-pay">Simular aprovação (modo de teste)</button>' : ''}`;
  }

  const tp = $('#btn-test-pay');
  if (tp) tp.onclick = () => withLoading(tp, async () => {
    await api(`/api/rides/${r.id}/payment/test-approve`, { method: 'POST' });
    await refreshActiveRide();
  }, { okMsg: 'Pagamento de teste aprovado.' });
}

function startPaymentPolling() {
  if (S.payTimer) return;
  S.payTimer = setInterval(async () => {
    if (!S.activeRide) { stopPaymentPolling(); return; }
    try {
      const r = await api(`/api/rides/${S.activeRide.id}/payment`);
      if (r.ride_status !== 'pending_payment') { stopPaymentPolling(); refreshActiveRide(); }
    } catch { /* tenta de novo */ }
  }, 4000);
}
function stopPaymentPolling() { clearInterval(S.payTimer); S.payTimer = null; }

/* ---------- confirmação da conclusão (contagem do servidor) ---------- */
let confirmModalRef = null;
function openConfirmModal(r) {
  if (confirmModalRef) return;
  const total = Math.max(1000, (r.auto_confirm_at || 0) - (r.completion_requested_at || 0));
  confirmModalRef = openModal(`
    <h3>Seu mototaxista informou que a corrida foi concluída</h3>
    <p class="muted mb">Confirme se você chegou ao destino.</p>
    <div class="confirm-ring" id="cf-ring"><span id="cf-num">5</span></div>
    <p class="muted small center mb">Sem resposta, confirmamos automaticamente.</p>
    <button class="btn btn-green btn-lg" data-ok>Confirmar chegada ✓</button>
    <button class="btn btn-outline mt" data-issue>Informar um problema</button>`,
    { onClose: () => { confirmModalRef = null; clearInterval(S.confirmTimer); } });

  const tick = () => {
    const left = (r.auto_confirm_at || 0) - (Date.now() + S.serverSkew);
    const ring = $('#cf-ring', confirmModalRef);
    const num = $('#cf-num', confirmModalRef);
    if (!ring || !num) return;
    ring.style.setProperty('--p', Math.max(0, Math.min(1, left / total)));
    num.textContent = Math.max(0, Math.ceil(left / 1000));
    if (left <= 0) { clearInterval(S.confirmTimer); num.textContent = '✓'; }
  };
  tick();
  S.confirmTimer = setInterval(tick, 100);

  $('[data-ok]', confirmModalRef).onclick = () =>
    withLoading($('[data-ok]', confirmModalRef), async () => {
      await api(`/api/rides/${r.id}/confirm`, { method: 'POST' });
      closeConfirmModal();
      await refreshActiveRide();
    });
  $('[data-issue]', confirmModalRef).onclick = () => { closeConfirmModal(); openIssueModal(r); };
}
function closeConfirmModal() {
  clearInterval(S.confirmTimer);
  confirmModalRef?.close();
  confirmModalRef = null;
}

function openIssueModal(r) {
  const KINDS = [
    ['nao_cheguei_ao_destino', 'Não cheguei ao destino'],
    ['corrida_nao_realizada', 'A corrida não aconteceu'],
    ['cobranca_incorreta', 'Valor cobrado errado'],
    ['conduta_do_mototaxista', 'Problema de conduta'],
    ['seguranca', 'Me senti inseguro(a)'],
    ['outro', 'Outro motivo'],
  ];
  let kind = null;
  const m = openModal(`
    <h3>Informar um problema</h3>
    <p class="muted mb">Sua corrida fica em análise e o pagamento não é liberado até resolvermos.</p>
    <div id="issue-kinds">${KINDS.map(([k, l]) =>
    `<button class="btn btn-outline mb" data-k="${k}" style="text-align:left">${l}</button>`).join('')}</div>
    <div class="field"><textarea class="input" id="issue-desc" maxlength="1000"
      placeholder="Conte o que aconteceu (opcional)"></textarea></div>
    <button class="btn btn-danger" data-send disabled>Enviar para análise</button>`);
  $$('[data-k]', m).forEach(b => b.onclick = () => {
    $$('[data-k]', m).forEach(x => x.classList.remove('btn-navy'));
    b.classList.add('btn-navy');
    kind = b.dataset.k;
    $('[data-send]', m).disabled = false;
  });
  $('[data-send]', m).onclick = () => withLoading($('[data-send]', m), async () => {
    await api(`/api/rides/${r.id}/issue`, {
      method: 'POST', body: { kind, description: $('#issue-desc', m).value },
    });
    m.close();
    toast('Ocorrência registrada. Nossa equipe vai analisar.', 'ok');
    await refreshActiveRide();
  });
}

function renderRideMap() {
  const r = S.activeRide;
  setTimeout(() => {
    if (!S.maps.ride) {
      S.maps.ride = makeMap('map-ride', { lat: r.origin.lat, lng: r.origin.lng }, 14);
      addMapTools('map-ride', S.maps.ride, false);
    }
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
    if (S.gps.lat != null) drawMeOnMaps(S.gps.lat, S.gps.lng, S.gps.accuracy || 30);
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
      const dist = d.remaining_m != null ? ` · ${fmt.dist(d.remaining_m)}` : '';
      sub.textContent = S.activeRide.status === 'in_progress'
        ? `Chegada ao destino em ~${fmt.dur(d.eta_s)}${dist}`
        : `Chegada em aproximadamente ${fmt.dur(d.eta_s)}${dist}`;
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

/* ---------- avaliação detalhada ---------- */
let ratingModalFor = null;
function promptRating(ride) {
  // SSE e refresh manual podem chegar juntos: uma avaliação por corrida
  if (ratingModalFor === ride.id) return;
  ratingModalFor = ride.id;
  const CRITERIA = [
    ['atendimento', 'Atendimento'],
    ['pontualidade', 'Pontualidade'],
    ['educacao', 'Educação'],
    ['seguranca', 'Segurança na corrida'],
  ];
  const scores = {};
  let stars = 0;
  const m = openModal(`
    <h3>Como foi sua experiência com o mototaxista?</h3>
    <p class="muted small mb">${escapeHtml(ride.driver?.name || 'Mototaxista')} · ${fmt.money(ride.price_cents)}</p>
    <div class="stars mb" id="rate-stars">${[1, 2, 3, 4, 5].map(i => `<button data-s="${i}">⭐</button>`).join('')}</div>
    <div class="mb">${CRITERIA.map(([k, l]) => `
      <div class="rate-row">
        <span class="rl">${l}</span>
        <span class="rate-stars" data-c="${k}">${[1, 2, 3, 4, 5].map(i => `<button data-v="${i}">★</button>`).join('')}</span>
      </div>`).join('')}</div>
    <div class="field"><textarea class="input" id="rate-comment" maxlength="500"
      placeholder="Comentário (opcional)"></textarea></div>
    <button class="btn btn-primary" id="rate-send" disabled>Enviar avaliação</button>
    <button class="btn btn-outline mt" id="rate-issue">Tive um problema nesta corrida</button>
    <button class="btn btn-outline mt" id="rate-skip">Agora não</button>`,
    { onClose: () => { ratingModalFor = null; } });

  $$('#rate-stars button', m).forEach(b => b.onclick = () => {
    stars = Number(b.dataset.s);
    $$('#rate-stars button', m).forEach(x => x.classList.toggle('on', Number(x.dataset.s) <= stars));
    $('#rate-send', m).disabled = false;
  });
  $$('.rate-stars[data-c]', m).forEach(group => {
    $$('button', group).forEach(b => b.onclick = () => {
      const v = Number(b.dataset.v);
      scores[group.dataset.c] = v;
      $$('button', group).forEach(x => x.classList.toggle('on', Number(x.dataset.v) <= v));
    });
  });
  $('#rate-send', m).onclick = () => withLoading($('#rate-send', m), async () => {
    await api(`/api/rides/${ride.id}/rate`, {
      method: 'POST',
      body: { stars, comment: $('#rate-comment', m).value, ...scores },
    });
    m.close();
    loadHistory();
  }, { okMsg: 'Avaliação enviada. Obrigado! ⭐' });
  $('#rate-issue', m).onclick = () => { m.close(); openIssueModal(ride); };
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
          <div class="li-sub">${fmt.dt(r.requested_at)} · ${fmt.dist(r.distance_m)} · ${fmt.money(r.price_cents)}
            · ${PAY_PT[r.payment_method]}${r.payment?.test_mode ? ' <span class="pill yellow">teste</span>' : ''}</div>
        </div>
        <div class="center">
          <span class="pill ${STATUS_PILL[r.status] || 'gray'}">${STATUS_PT[r.status] || r.status}</span>
          ${r.status === 'completed' && !r.rated ? `<br><button class="btn btn-outline btn-sm mt" data-rate="${r.id}">Avaliar ⭐</button>` : ''}
          ${r.rated ? `<div class="star-sm">★ ${r.rated}</div>` : ''}
          ${r.issue ? `<div class="pill yellow">ocorrência ${escapeHtml(r.issue.status)}</div>` : ''}
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
    await withLoading(e.target.querySelector('button[type=submit]'), async () => {
      await api('/api/me', { method: 'PATCH', body: { name: f.get('name'), phone: f.get('phone') } });
      S.user.name = f.get('name'); S.user.phone = f.get('phone');
      fillProfile();
    }, { okMsg: 'Perfil atualizado!' }).catch(() => { });
  };
  $('#form-support').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    await withLoading(e.target.querySelector('button[type=submit]'), async () => {
      await api('/api/support', { method: 'POST', body: { subject: f.get('subject'), body: f.get('body') } });
      e.target.reset(); loadSupport();
    }, { okMsg: 'Mensagem enviada ao suporte!' }).catch(() => { });
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
