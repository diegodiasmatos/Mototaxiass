/* Assis MotoTáxi — painel do mototaxista */
'use strict';

const S = {
  config: null, user: null, driver: null,
  online: false, watchId: null, lastSent: 0,
  activeRide: null,
  files: { profile: null, cnh: null, crlv: null, selfie: null },
  maps: { drive: null }, driveLayers: [], meMarker: null,
  pendingTimer: null, offerModal: null,
};

init();

async function init() {
  renderBrand($('#brand'), 'Parceiro');
  S.config = await api('/api/config').catch(() => ({ city_name: 'Assis Chateaubriand - PR', center: { lat: -24.4156, lng: -53.5216 } }));
  $('#auth-hero').innerHTML = `${LOGO_SVG}<h1>Seja parceiro</h1>
    <p>Ganhe dinheiro com sua moto em ${escapeHtml(S.config.city_name)} — 85% de cada corrida é seu</p>`;

  bindAuth(); bindApply(); bindPanel(); bindProfile(); bindNav();

  try {
    const me = await api('/api/me');
    if (me.user.role !== 'driver') { location.href = me.user.role === 'admin' ? '/admin' : '/'; return; }
    S.user = me.user;
    setNotifBadge(me.unread);
    await enterApp();
  } catch {
    showScreen('screen-auth');
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
      if (r.user.role !== 'driver') { location.href = r.user.role === 'admin' ? '/admin' : '/'; return; }
      S.user = r.user; await enterApp();
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#form-register').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api('/api/auth/register', {
        method: 'POST',
        body: { role: 'driver', name: f.get('name'), cpf: f.get('cpf'), phone: f.get('phone'), email: f.get('email'), password: f.get('password') },
      });
      S.user = r.user;
      toast('Conta criada! Agora envie seus documentos.', 'ok');
      await enterApp();
    } catch (err) { toast(err.message, 'err'); }
  };
}
function authTab(login) {
  $('#tab-login').classList.toggle('active', login);
  $('#tab-register').classList.toggle('active', !login);
  $('#form-login').hidden = !login;
  $('#form-register').hidden = login;
}

/* ================= roteamento pós-login ================= */
async function enterApp() {
  $('#btn-notifs').hidden = false;
  $('#btn-notifs').onclick = openNotifications;

  connectSSE({
    notification: n => { toast(n.title); browserNotify(n.title, n.body || ''); refreshDriver(); },
    ride_offer: o => onOffer(o),
    ride_update: () => refreshActive(),
  });
  await refreshDriver();
}

async function refreshDriver() {
  const me = await api('/api/driver/me').catch(() => ({ driver: null }));
  S.driver = me.driver;
  S.documents = me.documents || [];

  clearInterval(S.pendingTimer);
  if (!S.driver) { showScreen('screen-apply'); return; }

  if (S.driver.status === 'approved') {
    $('#bottomnav').hidden = false;
    S.activeRide = me.active_ride;
    if (S.activeRide) { renderDrive(); showScreen('screen-drive'); }
    else { renderPanel(); showScreen('screen-panel'); }
    loadEarnings();
  } else {
    renderPending();
    showScreen('screen-pending');
  }
}

function bindNav() {
  $$('.bottomnav button').forEach(b => b.onclick = () => {
    const id = b.dataset.screen;
    if (id === 'screen-panel' && S.activeRide) { showScreen('screen-drive'); return; }
    showScreen(id);
    if (id === 'screen-earnings') { loadEarnings(); loadDrvHistory(); }
    if (id === 'screen-profile') fillDriverProfile();
  });
}

/* ================= wizard de cadastro ================= */
function bindApply() {
  const steps = [1, 2, 3];
  const show = n => {
    steps.forEach(i => $(`#apply-step-${i}`).hidden = i !== n);
    $$('#apply-progress span').forEach((s, i) => s.classList.toggle('done', i < n));
  };
  show(1);

  const slots = [['profile', 'slot-profile', 'file-profile'], ['cnh', 'slot-cnh', 'file-cnh'],
    ['crlv', 'slot-crlv', 'file-crlv'], ['selfie', 'slot-selfie', 'file-selfie']];
  for (const [kind, slotId, fileId] of slots) {
    const slot = $(`#${slotId}`), input = $(`#${fileId}`);
    slot.onclick = () => input.click();
    input.onchange = async () => {
      if (!input.files[0]) return;
      try {
        S.files[kind] = await fileToDataUrl(input.files[0]);
        slot.classList.add('ok');
        slot.querySelector('.usub').textContent = `✓ ${input.files[0].name}`;
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  $('#ap-next-1').onclick = () => {
    if (!$('#ap-birth').value || !$('#ap-address').value.trim()) { toast('Preencha todos os campos.', 'err'); return; }
    if (!S.files.profile) { toast('Envie sua foto de perfil.', 'err'); return; }
    show(2);
  };
  $('#ap-back-2').onclick = () => show(1);
  $('#ap-next-2').onclick = () => {
    for (const id of ['ap-brand', 'ap-model', 'ap-year', 'ap-color', 'ap-plate']) {
      if (!$(`#${id}`).value.trim()) { toast('Preencha todos os dados da moto.', 'err'); return; }
    }
    show(3);
  };
  $('#ap-back-3').onclick = () => show(2);

  $('#ap-submit').onclick = async () => {
    for (const k of ['cnh', 'crlv', 'selfie']) {
      if (!S.files[k]) { toast(`Documento pendente: ${k.toUpperCase()}.`, 'err'); return; }
    }
    const btn = $('#ap-submit');
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      // foto de perfil vai para o cadastro do usuário
      await api('/api/me', { method: 'PATCH', body: { photo: S.files.profile } }).catch(() => { });
      await api('/api/driver/apply', {
        method: 'POST',
        body: {
          birth_date: $('#ap-birth').value,
          address: $('#ap-address').value.trim(),
          moto_brand: $('#ap-brand').value.trim(),
          moto_model: $('#ap-model').value.trim(),
          moto_year: $('#ap-year').value.trim(),
          moto_color: $('#ap-color').value.trim(),
          moto_plate: $('#ap-plate').value.trim().toUpperCase(),
          documents: { cnh: S.files.cnh, crlv: S.files.crlv, selfie: S.files.selfie },
        },
      });
      toast('Cadastro enviado para análise! 🎉', 'ok');
      await refreshDriver();
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false; btn.textContent = 'Enviar para análise ✓';
  };
}

/* ================= aguardando análise ================= */
function renderPending() {
  const d = S.driver;
  const card = $('#pending-card');
  if (d.status === 'pending') {
    const render = () => {
      const left = Math.max(0, d.deadline_at - Date.now());
      const h = Math.floor(left / 3600000), m = Math.floor(left % 3600000 / 60000);
      card.innerHTML = `
        <div style="font-size:3rem">⏳</div>
        <h2 class="mt">Cadastro em análise</h2>
        <p class="muted mt">Recebemos seus documentos em ${fmt.dt(d.submitted_at)}.<br>
        Nossa equipe analisará em até <b>${left > 0 ? `${h}h ${m}min` : 'breve'}</b>.</p>
        <p class="muted small mt">Você será notificado aqui e poderá começar a trabalhar assim que for aprovado.</p>
        <button class="btn btn-outline mt" onclick="location.reload()">Atualizar</button>
        <button class="btn btn-danger mt" id="pending-logout">Sair</button>`;
      $('#pending-logout').onclick = logout;
    };
    render();
    S.pendingTimer = setInterval(render, 30000);
  } else {
    const rejected = d.status === 'rejected';
    card.innerHTML = `
      <div style="font-size:3rem">${rejected ? '❌' : '📝'}</div>
      <h2 class="mt">${rejected ? 'Cadastro não aprovado' : 'Correção necessária'}</h2>
      <p class="muted mt"><b>Motivo:</b> ${escapeHtml(d.review_reason || 'Não informado')}</p>
      <p class="muted small mt">Você pode corrigir e reenviar seus documentos sem criar outra conta.</p>
      <button class="btn btn-primary mt" id="pending-retry">Corrigir e reenviar</button>
      <button class="btn btn-danger mt" id="pending-logout">Sair</button>`;
    $('#pending-retry').onclick = () => showScreen('screen-apply');
    $('#pending-logout').onclick = logout;
  }
}

async function logout() {
  stopLocationWatch();
  await api('/api/auth/logout', { method: 'POST' }).catch(() => { });
  location.reload();
}

/* ================= painel ================= */
function bindPanel() {
  $('#online-toggle').onclick = toggleOnline;
}

function renderPanel() {
  const d = S.driver;
  S.online = !!d.online;
  $('#drv-greeting').textContent = `Olá, ${S.user.name.split(' ')[0]}! 👋`;
  paintToggle();
  $('#stat-rides').textContent = d.rides_count;
  refreshPanelStats();
  if (S.online) { startLocationWatch(); pollOffers(); }
}

function paintToggle() {
  const t = $('#online-toggle');
  t.classList.toggle('on', S.online);
  t.querySelector('.ot-label').textContent = S.online ? 'Você está ONLINE' : 'Você está offline';
  t.querySelector('.ot-sub').textContent = S.online
    ? 'Compartilhando localização · aguardando corridas'
    : 'Toque para ficar online e receber corridas';
}

async function toggleOnline() {
  try {
    if (!S.online) {
      // exige localização para ficar online
      const pos = await getPosition();
      await api('/api/driver/online', { method: 'POST', body: { online: true } });
      await api('/api/driver/location', { method: 'POST', body: pos });
      S.online = true;
      startLocationWatch();
      askNotifPermission();
      pollOffers();
      toast('Você está online! Boas corridas 🏍️', 'ok');
    } else {
      await api('/api/driver/online', { method: 'POST', body: { online: false } });
      S.online = false;
      stopLocationWatch();
      $('#offers-list').innerHTML = '<div class="empty"><div class="eico">😴</div>Fique online para receber chamadas.</div>';
      toast('Você ficou offline.');
    }
    paintToggle();
  } catch (e) { toast(e.message, 'err'); }
}

function startLocationWatch() {
  stopLocationWatch();
  if (!navigator.geolocation) { toast('GPS indisponível neste navegador.', 'err'); return; }
  S.watchId = navigator.geolocation.watchPosition(
    p => {
      const t = Date.now();
      if (t - S.lastSent < 4000) return; // envia no máx a cada 4s
      S.lastSent = t;
      api('/api/driver/location', {
        method: 'POST',
        body: { lat: p.coords.latitude, lng: p.coords.longitude },
      }).catch(() => { });
      if (S.meMarker && S.maps.drive) S.meMarker.setLatLng([p.coords.latitude, p.coords.longitude]);
    },
    () => toast('Sinal de GPS perdido. Verifique a permissão de localização.', 'err'),
    { enableHighAccuracy: true, maximumAge: 5000 });
}
function stopLocationWatch() {
  if (S.watchId != null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
}

async function refreshPanelStats() {
  try {
    const st = await api('/api/public/stats');
    $('#drv-online-chip').textContent = `🏍️ ${st.online_drivers} parceiro(s) disponíveis na cidade`;
  } catch { }
  try {
    const e = await api('/api/driver/earnings');
    $('#stat-today').textContent = fmt.money(e.day.net);
  } catch { }
}

/* ================= ofertas ================= */
function offerHtml(o) {
  return `
    <div class="list-item" data-offer="${o.id}">
      <span style="font-size:1.5rem">${o.category === 'prioridade' ? '⚡' : '🛵'}</span>
      <div class="li-main">
        <div class="li-title">${escapeHtml(o.origin_text)} → ${escapeHtml(o.dest_text)}</div>
        <div class="li-sub">${fmt.dist(o.distance_m)} · você recebe <b>${fmt.money(o.driver_cents)}</b>
          ${o.pickup_dist_m != null ? ` · embarque a ${fmt.dist(o.pickup_dist_m)}` : ''}</div>
      </div>
      <button class="btn btn-green btn-sm" data-accept="${o.id}">Aceitar</button>
    </div>`;
}

async function pollOffers() {
  if (!S.online || S.activeRide) return;
  try {
    const { offers } = await api('/api/driver/offers');
    $('#offers-list').innerHTML = offers.length
      ? offers.map(offerHtml).join('')
      : '<div class="empty"><div class="eico">🔎</div>Nenhuma corrida aberta agora.<br>Você será avisado na hora!</div>';
    $$('#offers-list [data-accept]').forEach(b => b.onclick = () => acceptRide(b.dataset.accept));
  } catch { }
  setTimeout(pollOffers, 12000);
}

function onOffer(o) {
  if (!S.online || S.activeRide) return;
  browserNotify('Nova corrida disponível! 🏍️', `${o.origin_text} → ${o.dest_text} · ${fmt.money(o.driver_cents)}`);
  if (S.offerModal) S.offerModal.close();
  S.offerModal = openModal(`
    <h3>${o.category === 'prioridade' ? '⚡ Corrida PRIORIDADE' : '🛵 Nova corrida'}</h3>
    <div class="list-item"><div class="li-main"><div class="li-sub">📍 Embarque</div><div class="li-title">${escapeHtml(o.origin_text)}</div></div></div>
    <div class="list-item"><div class="li-main"><div class="li-sub">🏁 Destino</div><div class="li-title">${escapeHtml(o.dest_text)}</div></div></div>
    <div class="row between mt mb">
      <span class="chip soft">${fmt.dist(o.distance_m)}</span>
      <span class="chip yellow">Você recebe ${fmt.money(o.driver_cents)}</span>
    </div>
    <button class="btn btn-green btn-lg" data-ok>Aceitar corrida ✓</button>
    <button class="btn btn-outline mt" data-no>Recusar</button>
    <p class="muted small center mt" data-timer></p>`,
    { onClose: () => { S.offerModal = null; } });
  const m = S.offerModal;
  let left = 25;
  const timer = setInterval(() => {
    left--;
    const el = $('[data-timer]', m);
    if (el) el.textContent = `A oferta expira em ${left}s`;
    if (left <= 0) { clearInterval(timer); m.close(); }
  }, 1000);
  $('[data-ok]', m).onclick = () => { clearInterval(timer); m.close(); acceptRide(o.id); };
  $('[data-no]', m).onclick = () => { clearInterval(timer); m.close(); };
}

async function acceptRide(rideId) {
  try {
    const { ride } = await api(`/api/driver/rides/${rideId}/accept`, { method: 'POST' });
    S.activeRide = ride;
    toast('Corrida aceita! Vá até o passageiro. 🏍️', 'ok');
    renderDrive();
    showScreen('screen-drive');
  } catch (e) { toast(e.message, 'err'); pollOffers(); }
}

/* ================= corrida ativa ================= */
async function refreshActive() {
  const me = await api('/api/driver/me').catch(() => null);
  if (!me) return;
  const prev = S.activeRide;
  S.activeRide = me.active_ride;
  S.driver = me.driver;
  if (S.activeRide) { renderDrive(); showScreen('screen-drive'); }
  else if (prev) {
    toast('Corrida encerrada.');
    renderPanel(); showScreen('screen-panel'); pollOffers();
  }
}

function renderDrive() {
  const r = S.activeRide;
  if (!r) return;
  const toPassenger = r.status === 'accepted';
  $('#drive-banner').innerHTML = toPassenger
    ? `<span class="sico">📍</span><div><div class="stitle">Vá até o passageiro</div>
       <div class="ssub">${escapeHtml(r.passenger.name)} aguarda em: ${escapeHtml(r.origin.text)}</div></div>`
    : `<span class="sico">🛣️</span><div><div class="stitle">Corrida em andamento</div>
       <div class="ssub">Destino: ${escapeHtml(r.dest.text)}</div></div>`;

  $('#drive-details').innerHTML = `
    <div class="driver-card mb">
      <div class="avatar sm">${r.passenger.photo ? `<img src="${r.passenger.photo}">` : fmt.initials(r.passenger.name)}</div>
      <div style="flex:1"><div style="font-weight:800">${escapeHtml(r.passenger.name)}</div>
      <div class="muted small">Passageiro</div></div>
      <span class="pill ${r.category === 'prioridade' ? 'yellow' : 'gray'}">${r.category}</span>
    </div>
    <div class="list-item"><div class="li-main"><div class="li-sub">📍 Embarque</div><div class="li-title">${escapeHtml(r.origin.text)}</div></div></div>
    <div class="list-item"><div class="li-main"><div class="li-sub">🏁 Destino</div><div class="li-title">${escapeHtml(r.dest.text)}</div></div></div>
    <div class="row between mt">
      <span class="chip soft">${fmt.dist(r.distance_m)}</span>
      <span class="chip soft">${PAY_PT[r.payment_method]}</span>
      <span class="chip yellow">Você recebe ${fmt.money(r.driver_cents)}</span>
    </div>
    <p class="muted small mt">Valor da corrida: ${fmt.money(r.price_cents)} · Taxa da plataforma: ${fmt.money(r.commission_cents)}</p>`;

  const navTarget = toPassenger ? r.origin : r.dest;
  const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${navTarget.lat},${navTarget.lng}&travelmode=driving`;
  let actions = `<a class="btn btn-navy mb" href="${gmaps}" target="_blank" rel="noopener">🧭 Abrir navegação (Google Maps)</a>`;
  if (r.status === 'accepted' && !r.arrived_at) {
    actions += `<button class="btn btn-primary btn-lg" id="act-arrived">Cheguei ao passageiro 📍</button>`;
  } else if (r.status === 'accepted') {
    actions += `<button class="btn btn-primary btn-lg" id="act-start">Iniciar corrida ▶</button>`;
  } else if (r.status === 'in_progress') {
    actions += `<button class="btn btn-green btn-lg" id="act-complete">Finalizar corrida ✓</button>`;
  }
  if (r.status === 'accepted' || r.status === 'in_progress') {
    actions += `<button class="btn btn-danger mt" id="act-cancel">Cancelar corrida</button>`;
  }
  $('#drive-actions').innerHTML = actions;

  $('#act-arrived') && ($('#act-arrived').onclick = () => rideAction('arrived'));
  $('#act-start') && ($('#act-start').onclick = async () => {
    if (await confirmModal('Iniciar corrida?', 'O passageiro embarcou na moto?', 'Sim, iniciar')) rideAction('start');
  });
  $('#act-complete') && ($('#act-complete').onclick = completeFlow);
  $('#act-cancel') && ($('#act-cancel').onclick = cancelFlow);

  $('#dchat-send').onclick = sendDChat;
  $('#dchat-input').onkeydown = e => { if (e.key === 'Enter') sendDChat(); };
  loadDChat();
  renderDriveMap();
}

async function rideAction(action, body = {}) {
  try {
    await api(`/api/driver/rides/${S.activeRide.id}/${action}`, { method: 'POST', body });
    await refreshActive();
  } catch (e) { toast(e.message, 'err'); }
}

async function completeFlow() {
  const r = S.activeRide;
  const m = openModal(`
    <h3>Finalizar corrida</h3>
    <p class="muted mb">Cobre do passageiro: <b style="font-size:1.2rem">${fmt.money(r.price_cents)}</b> (${PAY_PT[r.payment_method]})</p>
    <label class="row mb" style="gap:8px"><input type="checkbox" id="pay-ok" checked> Recebi o pagamento</label>
    <button class="btn btn-green btn-lg" data-ok>Confirmar e finalizar ✓</button>
    <button class="btn btn-outline mt" data-no>Voltar</button>`);
  $('[data-ok]', m).onclick = async () => {
    const received = $('#pay-ok', m).checked;
    m.close();
    await rideAction('complete', { payment_received: received });
    toast(`Corrida finalizada! Você recebe ${fmt.money(r.driver_cents)} 💰`, 'ok');
  };
  $('[data-no]', m).onclick = () => m.close();
}

async function cancelFlow() {
  const ok = await confirmModal('Cancelar esta corrida?',
    S.activeRide.status === 'accepted'
      ? 'A corrida voltará para a fila e outro parceiro poderá aceitá-la. Cancelamentos frequentes afetam sua conta.'
      : 'A corrida em andamento será cancelada. Use apenas em caso de real necessidade.',
    'Sim, cancelar', true);
  if (!ok) return;
  await rideAction('cancel', { reason: 'Cancelada pelo mototaxista no app' });
}

function renderDriveMap() {
  const r = S.activeRide;
  setTimeout(() => {
    if (!S.maps.drive) S.maps.drive = makeMap('map-drive', { lat: r.origin.lat, lng: r.origin.lng }, 14);
    const map = S.maps.drive;
    if (!map) return;
    S.driveLayers.forEach(l => l.remove()); S.driveLayers = [];
    S.driveLayers.push(emojiMarker(map, r.origin.lat, r.origin.lng, '📍'));
    S.driveLayers.push(emojiMarker(map, r.dest.lat, r.dest.lng, '🏁'));
    if (r.route_geojson) {
      const line = drawRoute(map, r.route_geojson);
      S.driveLayers.push(line);
      map.fitBounds(line.getBounds(), { padding: [30, 30] });
    }
    navigator.geolocation?.getCurrentPosition(p => {
      S.meMarker = emojiMarker(map, p.coords.latitude, p.coords.longitude, '🏍️');
      S.driveLayers.push(S.meMarker);
    }, () => { });
    map.invalidateSize();
  }, 80);
}

/* ---------- chat ---------- */
async function loadDChat() {
  if (!S.activeRide) return;
  try {
    const { messages } = await api(`/api/rides/${S.activeRide.id}/messages`);
    $('#dchat-box').innerHTML = messages.map(m =>
      `<div class="chat-msg ${m.sender_id === S.user.id ? 'me' : 'other'}">${escapeHtml(m.body)}</div>`).join('');
    $('#dchat-box').scrollTop = 1e6;
  } catch { }
}
async function sendDChat() {
  const input = $('#dchat-input');
  const body = input.value.trim();
  if (!body || !S.activeRide) return;
  input.value = '';
  try {
    await api(`/api/rides/${S.activeRide.id}/messages`, { method: 'POST', body: { body } });
    loadDChat();
  } catch (e) { toast(e.message, 'err'); }
}

/* ================= ganhos ================= */
async function loadEarnings() {
  try {
    const e = await api('/api/driver/earnings');
    const row = (label, a) => `
      <div class="list-item">
        <div class="li-main"><div class="li-title">${label}</div>
        <div class="li-sub">${a.rides} corrida(s) · bruto ${fmt.money(a.gross)} · comissão ${fmt.money(a.commission)}</div></div>
        <b style="color:var(--green)">${fmt.money(a.net)}</b>
      </div>`;
    $('#earnings-box').innerHTML =
      row('Hoje', e.day) + row('Esta semana', e.week) + row('Este mês', e.month) + row('Total', e.total) +
      `<div class="row between mt">
        <span class="pill yellow">A receber: ${fmt.money(e.pending_cents)}</span>
        <span class="pill green">Já recebido: ${fmt.money(e.received_cents)}</span>
      </div>
      <p class="muted small mt">Apenas corridas concluídas entram nos ganhos. Valores "a receber" são pagamentos em dinheiro/Pix ainda não confirmados por você.</p>`;
  } catch (err) { $('#earnings-box').innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`; }
}

async function loadDrvHistory() {
  try {
    const { rides } = await api('/api/driver/rides');
    $('#drv-history').innerHTML = rides.length ? rides.map(r => `
      <div class="list-item">
        <div class="li-main">
          <div class="li-title">${escapeHtml(r.origin.text)} → ${escapeHtml(r.dest.text)}</div>
          <div class="li-sub">${fmt.dt(r.requested_at)} · ${fmt.dist(r.distance_m)}</div>
        </div>
        <div class="center">
          <span class="pill ${STATUS_PILL[r.status]}">${STATUS_PT[r.status]}</span>
          ${r.status === 'completed' ? `<div style="font-weight:700;color:var(--green)">${fmt.money(r.driver_cents)}</div>` : ''}
        </div>
      </div>`).join('')
      : '<div class="empty"><div class="eico">🛵</div>Nenhuma corrida ainda.</div>';
  } catch { }
}

/* ================= perfil ================= */
function bindProfile() {
  $('#form-support').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/api/support', { method: 'POST', body: { subject: f.get('subject'), body: f.get('body') } });
      toast('Mensagem enviada!', 'ok'); e.target.reset();
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#btn-notif-perm').onclick = async () => {
    toast(await askNotifPermission() ? 'Notificações ativadas! 🔔' : 'Não autorizado pelo navegador.');
  };
  $('#btn-logout').onclick = logout;
}

function fillDriverProfile() {
  const d = S.driver;
  $('#dprofile-avatar').innerHTML = S.user.photo ? `<img src="${S.user.photo}">` : fmt.initials(S.user.name);
  $('#dprofile-name').textContent = S.user.name;
  $('#dprofile-email').textContent = S.user.email;
  $('#dprofile-rating').textContent = d.rating ? `★ ${d.rating}` : '★ novo';
  $('#dprofile-rides').textContent = `${d.rides_count} corridas`;
  $('#dprofile-moto').innerHTML =
    `🏍️ ${escapeHtml([d.moto_brand, d.moto_model, d.moto_year].filter(Boolean).join(' '))} · ${escapeHtml(d.moto_color || '')}
     · <span class="plate">${escapeHtml(d.moto_plate || '')}</span>`;
  $('#dprofile-docs').innerHTML = (S.documents || []).map(doc => `
    <div class="list-item">
      <div class="li-main"><div class="li-title">${{ cnh: '🪪 CNH', crlv: '📄 CRLV', selfie: '🤳 Selfie' }[doc.kind] || doc.kind}</div>
      <div class="li-sub">Enviado em ${fmt.dt(doc.uploaded_at)}</div></div>
      <span class="pill green">enviado</span>
    </div>`).join('') || '<p class="muted small">Nenhum documento.</p>';
}
