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
  refreshPushSubscription();

  navigator.serviceWorker?.addEventListener('message', e => {
    if (e.data?.type === 'notification-click') refreshDriver();
  });

  connectSSE({
    notification: n => { toast(n.title); browserNotify(n.title, n.body || ''); },
    ride_offer: o => onOffer(o),
    ride_update: () => refreshActive(),
    passenger_location: p => onPassengerLocation(p),
  });
  await refreshDriver();
}

async function refreshDriver() {
  const me = await api('/api/driver/me').catch(() => ({ driver: null }));
  S.driver = me.driver;
  S.documents = me.documents || [];
  S.balance = me.balance;
  S.debtLimit = me.debt_limit_cents;
  if (me.server_time) S.serverSkew = me.server_time - Date.now();

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
    if (id === 'screen-profile') {
      fillDriverProfile(); loadDriverRatings(); loadMpConnect();
      renderNotificationStatus($('#notif-status'));
    }
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

  const warn = $('#drv-debt-warn');
  if (warn && S.balance && S.balance.debt_cents > (S.debtLimit ?? Infinity)) {
    warn.innerHTML = `<div class="testbar" style="background:#fee2e2;border-color:#fca5a5;color:#991b1b">
      ⛔ Comissão em aberto de ${fmt.money(S.balance.debt_cents)} (limite ${fmt.money(S.debtLimit)}).
      Quite com a plataforma para voltar a receber corridas.</div>`;
  } else if (warn) warn.innerHTML = '';

  refreshPanelStats();
  if (S.online) { startLocationWatch(); pollOffers(); }
  else setDriverGps('off', 'desligado');
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
      // exige localização real e precisa para entrar na fila
      const pos = await getPosition();
      await api('/api/driver/online', { method: 'POST', body: { online: true } });
      await api('/api/driver/location', { method: 'POST', body: pos });
      S.online = true;
      startLocationWatch();
      const push = await enablePush();
      if (!push.ok) toast(push.msg, 'err');
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
      const { latitude: lat, longitude: lng, accuracy } = p.coords;
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return;
      setDriverGps(accuracy > 150 ? 'weak' : 'ok', `±${Math.round(accuracy)} m`);
      if (S.meMarker && S.maps.drive) S.meMarker.setLatLng([lat, lng]);

      const t = Date.now();
      if (t - S.lastSent < 4000) return;        // envia no máximo a cada 4 s
      S.lastSent = t;
      api('/api/driver/location', { method: 'POST', body: { lat, lng, accuracy_m: accuracy } })
        .then(r => { if (!r.accuracy_ok) setDriverGps('weak', `impreciso (±${Math.round(accuracy)} m)`); })
        .catch(() => setDriverGps('off', 'sem conexão'));
    },
    err => {
      setDriverGps('off', err.code === 1 ? 'permissão negada' : 'sem sinal');
      toast('Sinal de GPS perdido — você pode parar de receber corridas.', 'err');
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}
function stopLocationWatch() {
  if (S.watchId != null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
  setDriverGps('off', 'desligado');
}
function setDriverGps(state, label) {
  S.gpsState = state;
  const cls = state === 'ok' ? '' : (state === 'weak' ? 'weak' : 'off');
  const icon = state === 'ok' ? '🛰️' : (state === 'weak' ? '📶' : '⚠️');
  $$('.gps-chip').forEach(el => { el.className = `gps-chip ${cls}`; el.textContent = `${icon} GPS ${label}`; });
}

function onPassengerLocation(p) {
  if (!S.activeRide || p.ride_id !== S.activeRide.id || !S.maps.drive) return;
  if (S.paxMarker) S.paxMarker.setLatLng([p.lat, p.lng]);
  else { S.paxMarker = emojiMarker(S.maps.drive, p.lat, p.lng, '🧍'); S.driveLayers.push(S.paxMarker); }
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

/** Uma única cadeia de polling por vez (a V1 criava uma a cada toque no botão). */
async function pollOffers() {
  clearTimeout(S.offersTimer);
  if (!S.online || S.activeRide) return;
  try {
    const { offers } = await api('/api/driver/offers');
    $('#offers-list').innerHTML = offers.length
      ? offers.map(offerHtml).join('')
      : '<div class="empty"><div class="eico">🔎</div>Nenhuma corrida aberta agora.<br>Você será avisado na hora!</div>';
    $$('#offers-list [data-accept]').forEach(b => b.onclick = () => acceptRide(b.dataset.accept, b));
  } catch { }
  S.offersTimer = setTimeout(pollOffers, 12000);
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

async function acceptRide(rideId, btn) {
  const run = async () => {
    const { ride } = await api(`/api/driver/rides/${rideId}/accept`, { method: 'POST' });
    S.activeRide = ride;
    toast('Corrida aceita! Vá até o passageiro. 🏍️', 'ok');
    renderDrive();
    showScreen('screen-drive');
  };
  try {
    if (btn) await withLoading(btn, run, { errToast: true });
    else await run();
  } catch { pollOffers(); }
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
  if (r.status === 'awaiting_confirmation') {
    $('#drive-banner').innerHTML = `<span class="sico pulse">⏳</span><div>
      <div class="stitle">Aguardando confirmação do passageiro</div>
      <div class="ssub">Se ele não responder, confirmamos automaticamente em instantes.</div></div>`;
  } else if (r.status === 'disputed') {
    $('#drive-banner').innerHTML = `<span class="sico">⚠️</span><div>
      <div class="stitle">Passageiro registrou uma ocorrência</div>
      <div class="ssub">A administração vai analisar antes de liberar o valor.</div></div>`;
  } else {
    $('#drive-banner').innerHTML = toPassenger
      ? `<span class="sico">📍</span><div><div class="stitle">Vá até o passageiro</div>
         <div class="ssub">${escapeHtml(r.passenger.name)} aguarda em: ${escapeHtml(r.origin.text)}</div></div>`
      : `<span class="sico">🛣️</span><div><div class="stitle">Corrida em andamento</div>
         <div class="ssub">Destino: ${escapeHtml(r.dest.text)}</div></div>`;
  }

  $('#drive-details').innerHTML = `
    <div class="driver-card mb">
      <div class="avatar sm">${r.passenger.photo ? `<img src="${r.passenger.photo}">` : fmt.initials(r.passenger.name)}</div>
      <div style="flex:1"><div style="font-weight:800">${escapeHtml(r.passenger.name)}</div>
      <div class="muted small">Passageiro</div></div>
      <span class="pill ${r.category === 'prioridade' ? 'yellow' : 'gray'}">${r.category}</span>
    </div>
    <div class="list-item"><div class="li-main"><div class="li-sub">📍 Embarque</div><div class="li-title">${escapeHtml(r.origin.text)}</div></div></div>
    <div class="list-item"><div class="li-main"><div class="li-sub">🏁 Destino</div><div class="li-title">${escapeHtml(r.dest.text)}</div></div></div>
    ${r.pickup_updated_at ? `<p class="muted small mt" style="color:#b45309">
      📍 O passageiro atualizou o ponto de embarque em ${fmt.time(r.pickup_updated_at)}.</p>` : ''}
    <div class="row between mt" style="flex-wrap:wrap;gap:8px">
      <span class="chip soft">${fmt.dist(r.distance_m)}</span>
      <span class="chip soft">${PAY_PT[r.payment_method]}</span>
      <span class="chip yellow">Você recebe ${fmt.money(r.driver_cents)}</span>
      <span class="gps-chip">🛰️ GPS</span>
    </div>
    ${r.paid_upfront
      ? `<p class="muted small mt">✅ <b>Já pago pela plataforma</b> — não cobre nada do passageiro.
         ${fmt.money(r.driver_cents)} entram no seu saldo após a confirmação.</p>`
      : `<p class="muted small mt">💵 <b>Receba ${fmt.money(r.collect_cash_cents)} em dinheiro</b> do passageiro.
         A comissão de ${fmt.money(r.commission_cents)} fica registrada como sua dívida com a plataforma.</p>`}
    <p class="muted small">Valor da corrida: ${fmt.money(r.price_cents)} · Taxa da plataforma: ${fmt.money(r.commission_cents)}</p>`;

  const navTarget = toPassenger ? r.origin : r.dest;
  const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${navTarget.lat},${navTarget.lng}&travelmode=driving`;
  let actions = '';
  if (['accepted', 'in_progress'].includes(r.status)) {
    actions += `<a class="btn btn-navy mb" href="${gmaps}" target="_blank" rel="noopener">
      🧭 Navegar até ${toPassenger ? 'o passageiro' : 'o destino'}</a>`;
  }
  if (r.status === 'accepted' && !r.arrived_at) {
    actions += `<button class="btn btn-primary btn-lg" id="act-arrived">Cheguei ao passageiro 📍</button>`;
  } else if (r.status === 'accepted') {
    actions += `<button class="btn btn-primary btn-lg" id="act-start">Iniciar corrida ▶</button>`;
  } else if (r.status === 'in_progress') {
    actions += `<button class="btn btn-green btn-lg" id="act-complete">Finalizar corrida ✓</button>`;
  } else if (r.status === 'awaiting_confirmation') {
    actions += `<div class="card center" style="margin:0">
      <div class="spinner mb"></div>
      <p class="muted small">Aguardando o passageiro confirmar a chegada.
      A corrida fecha sozinha em poucos segundos.</p></div>`;
  }
  if (r.status === 'accepted' || r.status === 'in_progress') {
    actions += `<button class="btn btn-danger mt" id="act-cancel">Cancelar corrida</button>`;
  }
  $('#drive-actions').innerHTML = actions;

  $('#act-arrived') && ($('#act-arrived').onclick = () =>
    withLoading($('#act-arrived'), () => rideAction('arrived')));
  $('#act-start') && ($('#act-start').onclick = async () => {
    if (await confirmModal('Iniciar corrida?', 'O passageiro embarcou na moto?', 'Sim, iniciar')) {
      await withLoading($('#act-start'), () => rideAction('start'));
    }
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

/**
 * O mototaxista declara a conclusão; o passageiro confirma (ou o servidor
 * confirma sozinho ao fim do prazo). Nada de marcar pagamento por aqui.
 */
async function completeFlow() {
  const r = S.activeRide;
  const m = openModal(`
    <h3>Finalizar corrida</h3>
    ${r.paid_upfront
      ? `<p class="muted mb">Corrida <b>já paga pela plataforma</b> (${PAY_PT[r.payment_method]}).
         Não cobre nada do passageiro.<br>
         Você recebe <b style="font-size:1.15rem;color:var(--green)">${fmt.money(r.driver_cents)}</b>.</p>`
      : `<p class="muted mb">Receba <b style="font-size:1.2rem">${fmt.money(r.collect_cash_cents)}</b>
         em dinheiro do passageiro.<br>
         A comissão de ${fmt.money(r.commission_cents)} fica registrada como sua dívida.</p>`}
    <p class="muted small mb">O passageiro vai confirmar a chegada. Sem resposta dele,
    confirmamos automaticamente em poucos segundos.</p>
    <button class="btn btn-green btn-lg" data-ok>Declarar conclusão ✓</button>
    <button class="btn btn-outline mt" data-no>Voltar</button>`);
  $('[data-ok]', m).onclick = () => withLoading($('[data-ok]', m), async () => {
    await rideAction('complete');
    m.close();
    toast('Aguardando a confirmação do passageiro…');
  });
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
    S.balance = e.balance;
    const row = (label, a) => `
      <div class="list-item">
        <div class="li-main"><div class="li-title">${label}</div>
        <div class="li-sub">${a.rides} corrida(s) · bruto ${fmt.money(a.gross)} · comissão ${fmt.money(a.commission)}</div></div>
        <b style="color:var(--green)">${fmt.money(a.net)}</b>
      </div>`;
    const debtWarn = e.debt_cents > e.debt_limit_cents;
    $('#earnings-box').innerHTML = `
      <div class="fin-grid mb">
        <div class="fin-card in"><div class="fv">${fmt.money(e.balance.pending_cents)}</div>
          <div class="fl">A receber da plataforma</div></div>
        <div class="fin-card out"><div class="fv">${fmt.money(e.balance.paid_cents)}</div>
          <div class="fl">Já repassado a você</div></div>
        <div class="fin-card ${debtWarn ? 'bad' : 'warn'}"><div class="fv">${fmt.money(e.debt_cents)}</div>
          <div class="fl">Comissão a pagar (corridas em dinheiro)</div></div>
      </div>
      ${debtWarn ? `<div class="testbar" style="background:#fee2e2;border-color:#fca5a5;color:#991b1b">
        ⛔ Sua dívida passou do limite de ${fmt.money(e.debt_limit_cents)} — você não recebe novas corridas
        até quitar com a plataforma.</div>` : ''}
      ${row('Hoje', e.day) + row('Esta semana', e.week) + row('Este mês', e.month) + row('Total', e.total)}
      <h3 class="mt">Repasses recebidos</h3>
      ${e.payouts.length ? e.payouts.map(p => `
        <div class="list-item"><div class="li-main">
          <div class="li-title">${fmt.money(p.amount_cents)} · ${escapeHtml(p.method || 'pix')}</div>
          <div class="li-sub">${fmt.dt(p.created_at)}${p.reference ? ` · ${escapeHtml(p.reference)}` : ''}</div>
        </div><span class="pill ${p.status === 'pago' ? 'green' : 'yellow'}">${p.status}</span></div>`).join('')
        : '<p class="muted small">Nenhum repasse registrado ainda.</p>'}
      <p class="muted small mt">Só corridas concluídas entram nos ganhos. Pix e cartão são recebidos
      pela plataforma e repassados a você; em dinheiro você recebe na hora e fica devendo a comissão.</p>`;
  } catch (err) { $('#earnings-box').innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`; }
}

/** Conexão da conta Mercado Pago do parceiro (recebimento direto). */
async function loadMpConnect() {
  const box = $('#mp-connect');
  if (!box) return;
  try {
    const s = await api('/api/driver/mp/status');
    if (!s.available || !s.configured) {
      box.innerHTML = `
        <div class="list-item"><span style="font-size:1.2rem">💵</span>
          <div class="li-main"><div class="li-title">Você recebe por repasse da plataforma</div>
            <div class="li-sub">Pix e cartão são recebidos pela plataforma e repassados a você;
            corridas em dinheiro você recebe na hora e a comissão fica registrada.</div></div></div>
        <p class="muted small mt">O recebimento direto na sua conta ainda não foi liberado pela administração.</p>`;
      return;
    }
    if (s.connected) {
      box.innerHTML = `
        <div class="list-item"><span style="font-size:1.2rem">✅</span>
          <div class="li-main"><div class="li-title">Recebendo direto na sua conta Mercado Pago</div>
            <div class="li-sub">${escapeHtml(s.nickname || 'Conta conectada')} · desde ${fmt.dt(s.connected_at)}<br>
            O valor da corrida cai na sua conta na hora e a comissão da plataforma
            é descontada automaticamente.</div></div></div>
        <button class="btn btn-outline btn-sm mt" id="mp-off">Desconectar conta</button>`;
      $('#mp-off').onclick = async () => {
        if (!await confirmModal('Desconectar a conta?',
          'Você voltará a receber por repasse da plataforma.', 'Desconectar', true)) return;
        await api('/api/driver/mp/disconnect', { method: 'POST' });
        toast('Conta desconectada.');
        loadMpConnect();
      };
      return;
    }
    box.innerHTML = `
      <div class="list-item"><span style="font-size:1.2rem">⚡</span>
        <div class="li-main"><div class="li-title">Receba direto na sua conta Mercado Pago</div>
          <div class="li-sub">Conectando sua conta, o valor das corridas pagas por Pix e cartão
          cai na hora para você — sem esperar repasse. A comissão da plataforma é
          descontada automaticamente.</div></div></div>
      <button class="btn btn-primary mt" id="mp-on">Conectar minha conta Mercado Pago</button>
      <p class="muted small mt">Você será levado ao site do Mercado Pago para autorizar.
      A plataforma nunca vê sua senha.</p>`;
    $('#mp-on').onclick = () => withLoading($('#mp-on'), async () => {
      const { url } = await api('/api/driver/mp/connect-url');
      location.href = url;
    });
  } catch (e) {
    box.innerHTML = `<p class="muted small">${escapeHtml(e.message)}</p>`;
  }
}

async function loadDriverRatings() {
  try {
    const { ratings, averages } = await api('/api/driver/ratings');
    const avg = v => v ? `★ ${Number(v).toFixed(1)}` : '—';
    $('#drv-ratings').innerHTML = `
      <div class="fin-grid mb">
        <div class="fin-card in"><div class="fv">${avg(averages.stars)}</div>
          <div class="fl">Nota geral (${averages.total} avaliações)</div></div>
        <div class="fin-card"><div class="fv">${avg(averages.atendimento)}</div><div class="fl">Atendimento</div></div>
        <div class="fin-card"><div class="fv">${avg(averages.pontualidade)}</div><div class="fl">Pontualidade</div></div>
        <div class="fin-card"><div class="fv">${avg(averages.educacao)}</div><div class="fl">Educação</div></div>
        <div class="fin-card"><div class="fv">${avg(averages.seguranca)}</div><div class="fl">Segurança</div></div>
      </div>
      ${ratings.length ? ratings.map(r => `
        <div class="list-item"><div class="li-main">
          <div class="li-title">${'★'.repeat(r.stars)}${'☆'.repeat(5 - r.stars)}</div>
          <div class="li-sub">${escapeHtml(r.comment || 'Sem comentário')} · ${fmt.date(r.created_at)}</div>
        </div></div>`).join('')
        : '<div class="empty"><div class="eico">⭐</div>Você ainda não recebeu avaliações.</div>'}`;
  } catch { }
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
  $('#btn-notif-perm')?.remove();   // substituído pelo diagnóstico completo
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
