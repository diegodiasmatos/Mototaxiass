/* VAIRO — painel do motorista */
'use strict';

const S = {
  config: null, user: null, driver: null,
  online: false, watchId: null, lastSent: 0,
  activeRide: null,
  files: { profile: null, cnh: null, crlv: null, selfie: null },
  maps: { drive: null }, driveLayers: [], meMarker: null,
  pendingTimer: null, offerModal: null,
};

// atualização automática do app espera a corrida/turno acabar (common.js)
window.vairoBusy = () => !!S.activeRide || !!S.online || !!S.offerModal;

init();

async function init() {
  renderBrand($('#brand'));
  S.config = await api('/api/config').catch(() => ({ city_name: 'Assis Chateaubriand - PR', center: { lat: -24.4156, lng: -53.5216 } }));
  $('#auth-logo').innerHTML = LOGO_MARK;

  bindAuth(); bindApply(); bindPanel(); bindProfile(); bindNav();
  bindScreenMenu();

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
  bindForgotPassword();
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
        body: { role: 'driver', name: f.get('name'), cpf: f.get('cpf'), phone: f.get('phone'), email: f.get('email'), password: f.get('password'), accept_terms: f.get('accept_terms') === 'on' },
      });
      S.user = r.user;
      toast('Conta criada! Agora envie seus documentos.', 'ok');
      await enterApp();
    } catch (err) { toast(err.message, 'err'); }
  };
}
function authTab(login) {
  $('#form-login').hidden = !login;
  $('#form-register').hidden = login;
  $('#auth-title').textContent = login ? 'Login Motorista VAIRO' : 'Cadastro Profissional';
  syncScreenMenu();
}

/* ================= submenu de telas (referência VAIRO) ================= */
function currentScreen() { return $$('.screen').find(s => !s.hidden)?.id; }

function bindScreenMenu() {
  const needLogin = 'Entre na sua conta de motorista para continuar.';
  const approved = () => S.driver?.status === 'approved';
  const notApproved = () => !S.driver
    ? 'Envie seu cadastro profissional primeiro.'
    : 'Seu cadastro ainda não foi aprovado.';
  const openPanel = () => {
    if (S.activeRide) { showScreen('screen-drive'); return 'Você tem uma corrida em andamento.'; }
    renderPanel(); showScreen('screen-panel');
  };

  setupScreenMenu([
    {
      label: 'Login Motorista',
      match: () => currentScreen() === 'screen-auth' && !$('#form-login').hidden,
      go: () => {
        if (S.user) return 'Você já entrou na sua conta.';
        showScreen('screen-auth'); authTab(true);
      },
    },
    {
      label: 'Cadastro Profissional & Termos',
      match: () => currentScreen() === 'screen-apply'
        || (currentScreen() === 'screen-auth' && $('#form-login').hidden),
      go: () => {
        if (!S.user) { showScreen('screen-auth'); authTab(false); return; }
        // sem cadastro, ou cadastro devolvido para correção: abre o formulário
        if (!S.driver || ['rejected', 'correction'].includes(S.driver.status)) { showScreen('screen-apply'); return; }
        return approved() ? 'Seu cadastro já está aprovado. ✅' : 'Seu cadastro já foi enviado e está em análise.';
      },
    },
    {
      label: 'Ficar online & corridas',
      match: () => currentScreen() === 'screen-panel',
      go: () => {
        if (!S.user) return needLogin;
        if (!approved()) return notApproved();
        return openPanel();
      },
    },
    {
      label: 'Alerta de Corrida & Detalhes',
      match: () => currentScreen() === 'screen-panel',
      go: () => {
        if (!S.user) return needLogin;
        if (!approved()) return notApproved();
        const msg = openPanel();
        if (!msg) $('#offers-list')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return msg;
      },
    },
    {
      label: 'Navegação ao Passageiro',
      match: () => currentScreen() === 'screen-drive',
      go: () => {
        if (!S.user) return needLogin;
        if (!S.activeRide) return 'Você não tem uma corrida em andamento agora.';
        showScreen('screen-drive');
      },
    },
    {
      label: 'Carteira, Ganhos & Saques',
      match: () => currentScreen() === 'screen-earnings',
      go: () => {
        if (!S.user) return needLogin;
        if (!approved()) return notApproved();
        showScreen('screen-earnings'); loadWallet(); loadEarnings(); loadDrvHistory();
      },
    },
    {
      label: 'Aprovação',
      match: () => currentScreen() === 'screen-pending',
      go: () => {
        if (!S.user) return needLogin;
        if (!S.driver) return 'Envie seu cadastro profissional primeiro.';
        if (approved()) return 'Seu cadastro já está aprovado. ✅';
        clearInterval(S.pendingTimer);
        renderPending(); showScreen('screen-pending');
      },
    },
  ], () => ({ 'screen-profile': 'Perfil' })[currentScreen()] || '');
}

/* ================= roteamento pós-login ================= */
async function enterApp() {
  await initMaps(S.config);       // só depois do login (a tela de entrada fica leve)
  ensureTermsAccepted();
  renderAccountCard($('#account-card'));
  $('#btn-notifs').hidden = false;
  $('#btn-notifs').onclick = openNotifications;
  refreshPushSubscription();

  navigator.serviceWorker?.addEventListener('message', e => {
    if (e.data?.type === 'notification-click') refreshDriver();
  });

  connectSSE({
    notification: n => {
      toast(n.title); browserNotify(n.title, n.body || '');
      if (n.category === 'financeiro' && currentScreen() === 'screen-earnings') loadWallet();
    },
    ride_offer: o => onOffer(o),
    ride_update: () => refreshActive(),
    passenger_location: p => onPassengerLocation(p),
  });
  await refreshDriver();
  handleInitialNotificationLink();
}

/** Destino de uma notificação tocada (ver openNotificationLink em common.js). */
window.vairoLinkHandler = async hash => {
  if (hash === 'ganhos' || hash === 'corridas') {
    if (!S.driver || S.driver.status !== 'approved') { await refreshDriver(); return; }
    showScreen('screen-earnings'); loadWallet(); loadEarnings(); loadDrvHistory();
  } else if (hash === 'perfil' || hash === 'suporte') showScreen('screen-profile');
  else if (hash === 'notificacoes') openNotifications();
  else await refreshDriver();   // corrida, cadastro: a tela certa sai do estado atual
};

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
    if (id === 'screen-earnings') { loadWallet(); loadEarnings(); loadDrvHistory(); }
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
    if (!$('#ap-cnh-exp').value || !$('#ap-cnh-first').value) { toast('Informe a validade da CNH e a data da 1ª habilitação.', 'err'); return; }
    if (!$('#ap-decl-ear').checked) { toast('Confirme que sua CNH é categoria A com EAR.', 'err'); return; }
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
          cnh_expiry: $('#ap-cnh-exp').value, cnh_first_date: $('#ap-cnh-first').value,
          decl_cat_a_ear: $('#ap-decl-ear').checked, decl_course: $('#ap-decl-course').checked,
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
    warn.innerHTML = `<div class="testbar danger">
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
    ? 'Compartilhando localização · mantenha a tela ligada'
    : 'Toque para ficar online e receber corridas';
}

async function toggleOnline() {
  try {
    if (!S.online) {
      // consentimento: explica antes de o navegador pedir; bloqueada, ensina a liberar
      const st = await locationPermission();
      if (st === 'denied' || st === 'unsupported') { showLocationHelp(); return; }
      if (st === 'prompt' && !await askLocationConsent('driver', { force: true })) {
        toast('Sem localização não dá para receber corridas. Você pode ativar quando quiser.');
        return;
      }
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

/**
 * Tela ligada enquanto o motorista está online. Pelo navegador, o celular
 * para de mandar o GPS quando a tela apaga, e o servidor só oferece corridas
 * a quem mandou a posição nos últimos 2 minutos.
 */
let _wakeLock = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return false;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', () => { _wakeLock = null; });
    return true;
  } catch { return false; }
}
function releaseWakeLock() { _wakeLock?.release().catch(() => { }); _wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  // o sistema solta a trava quando o app sai da tela; pega de novo na volta
  if (document.visibilityState === 'visible' && S.online && !_wakeLock) requestWakeLock();
});

function startLocationWatch() {
  stopLocationWatch();
  requestWakeLock().then(ok => {
    if (!ok) toast('Deixe a tela ligada e o app aberto enquanto estiver online: com a tela apagada o GPS para e você deixa de receber corridas.');
  });
  if (!navigator.geolocation) { toast('GPS indisponível neste navegador.', 'err'); return; }
  S.watchId = navigator.geolocation.watchPosition(
    p => {
      const { latitude: lat, longitude: lng, accuracy } = p.coords;
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return;
      setDriverGps(accuracy > 150 ? 'weak' : 'ok', `±${Math.round(accuracy)} m`);
      if (S.meMarker && S.maps.drive) moveMarkerSmooth(S.meMarker, lat, lng);
      S.myPos = { lat, lng, at: Date.now() };
      updatePickupDistance();

      // envio adaptativo: em corrida, a cada 4 s se andou (ou 15 s parado);
      // só online, a cada 30 m andados ou 30 s — parado não gasta bateria nem dados
      const t = Date.now(), last = S.lastSentPos;
      const inRide = !!S.activeRide && ['accepted', 'in_progress'].includes(S.activeRide.status);
      const moved = last ? haversineM2(lat, lng, last.lat, last.lng) : Infinity;
      const minGap = inRide ? 4000 : 8000;
      if (t - S.lastSent < minGap) return;
      if (inRide ? (moved < 8 && t - S.lastSent < 15000) : (moved < 30 && t - S.lastSent < 30000)) return;
      S.lastSent = t;
      S.lastSentPos = { lat, lng };
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
  releaseWakeLock();
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
  S.paxPos = { lat: p.lat, lng: p.lng, at: Date.now() };
  if (S.paxMarker) moveMarkerSmooth(S.paxMarker, p.lat, p.lng);
  else { S.paxMarker = placeMarker(S.maps.drive, p.lat, p.lng, MARK.passenger, 'Passageiro'); S.driveLayers.push(S.paxMarker); }
  updatePickupDistance();
}

/** Distância até o embarque (e até o passageiro, se ele compartilha), em linha reta. */
function updatePickupDistance() {
  const el = $('#drv-dist');
  const r = S.activeRide;
  if (!el) return;
  if (!r || r.status !== 'accepted' || !S.myPos || Date.now() - S.myPos.at > 60_000) { el.hidden = true; return; }
  const toPickup = haversineM2(S.myPos.lat, S.myPos.lng, r.origin.lat, r.origin.lng);
  const pax = S.paxPos && Date.now() - S.paxPos.at < 90_000
    ? ` · passageiro a ${fmt.dist(haversineM2(S.myPos.lat, S.myPos.lng, S.paxPos.lat, S.paxPos.lng))}` : '';
  el.hidden = false;
  el.textContent = `📏 Embarque a ${fmt.dist(toPickup)} (linha reta)${pax}`;
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
    ${r.pickup_updated_at ? `<p class="muted small mt warn-text">
      📍 O passageiro atualizou o ponto de embarque em ${fmt.time(r.pickup_updated_at)}.</p>` : ''}
    <div class="row between mt" style="flex-wrap:wrap;gap:8px">
      <span class="chip soft">${fmt.dist(r.distance_m)}</span>
      <span class="chip soft">${PAY_PT[r.payment_method]}</span>
      <span class="chip yellow">Você recebe ${fmt.money(r.driver_cents)}</span>
      <span class="gps-chip">🛰️ GPS</span>
      <span class="chip soft" id="drv-dist" hidden></span>
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
    actions += `<button class="btn btn-primary btn-lg" id="act-start">Confirmar embarque 🔑</button>
      <p class="muted small mt">Peça ao passageiro o código de 4 dígitos que aparece no app dele.
      A viagem só começa com o código certo.</p>`;
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
  $('#act-start') && ($('#act-start').onclick = boardingFlow);
  $('#act-complete') && ($('#act-complete').onclick = completeFlow);
  $('#act-cancel') && ($('#act-cancel').onclick = cancelFlow);

  $('#dchat-send').onclick = sendDChat;
  $('#dchat-input').onkeydown = e => { if (e.key === 'Enter') sendDChat(); };
  loadDChat();
  renderDriveMap();
}

/**
 * Confirmação de embarque: o mototaxista digita o código que aparece no app
 * do passageiro. Código errado mostra o erro e deixa tentar de novo; o
 * servidor conta os erros e impõe uma espera depois de vários.
 */
function boardingFlow() {
  const r = S.activeRide;
  const m = openModal(`
    <h3>Confirmar embarque</h3>
    <p class="muted mb">Com o passageiro <b>junto da moto</b>, peça o código de 4 dígitos que aparece no app dele.</p>
    <div class="field"><input class="input boarding-input" id="bd-code" inputmode="numeric" autocomplete="one-time-code"
      pattern="[0-9]*" maxlength="4" placeholder="0000" aria-label="Código de embarque"></div>
    <p class="err-text small" id="bd-err" hidden></p>
    <button class="btn btn-primary btn-lg" data-ok>Confirmar e iniciar viagem ▶</button>
    <p class="muted small mt">Só confirme com o passageiro presente. Data, hora e local da confirmação ficam registrados.</p>`);
  const input = $('#bd-code', m), err = $('#bd-err', m), ok = $('[data-ok]', m);
  const showErr = msg => { err.textContent = msg; err.hidden = false; };
  if (r.boarding_locked_until && r.boarding_locked_until > Date.now()) {
    showErr('Muitos códigos errados. Aguarde um pouco e confira o código no app do passageiro.');
  }
  input.focus();
  input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 4); err.hidden = true; });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') ok.click(); });
  ok.onclick = async () => {
    if (input.value.length !== 4) { showErr('Digite os 4 dígitos do código.'); return; }
    ok.disabled = true;
    try {
      await api(`/api/driver/rides/${r.id}/start`, { method: 'POST', body: { code: input.value } });
      m.close();
      toast('Embarque confirmado. Boa viagem!', 'ok');
      await refreshActive();
    } catch (e) {
      showErr(e.message);
      input.value = '';
      input.focus();
      if (e.status === 409 || e.status === 402) await refreshActive();
    } finally { ok.disabled = false; }
  };
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
    S.meMarker = null; S.paxMarker = null; S.paxPos = null;   // foram removidos junto com as camadas
    map.invalidateSize();        // a tela acabou de aparecer: mede antes de enquadrar
    S.driveLayers.push(placeMarker(map, r.origin.lat, r.origin.lng, MARK.origin, 'Embarque'));
    S.driveLayers.push(placeMarker(map, r.dest.lat, r.dest.lng, MARK.dest, 'Destino'));
    if (r.route_geojson) {
      const line = drawRoute(map, r.route_geojson);
      S.driveLayers.push(line);
      map.fitBounds(line.getBounds(), { padding: [30, 30] });
    }
    navigator.geolocation?.getCurrentPosition(p => {
      if (S.maps.drive !== map) return;      // o mapa foi refeito enquanto o GPS respondia
      S.meMarker?.remove();
      S.meMarker = placeMarker(map, p.coords.latitude, p.coords.longitude, MARK.moto, 'Você');
      S.driveLayers.push(S.meMarker);
    }, () => { });
  }, 80);
}

// Se o Mapbox for recusado em tempo de execução, refaz o mapa no OpenStreetMap
document.addEventListener('maps-provider-changed', () => {
  try { S.maps.drive?.remove(); } catch { /* já destruído */ }
  const el = document.getElementById('map-drive');
  if (el) el.innerHTML = '';
  S.maps.drive = null; S.driveLayers = []; S.meMarker = null; S.paxMarker = null;
  if (S.activeRide) renderDriveMap();
});

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
      ${debtWarn ? `<div class="testbar danger">
        ⛔ Sua comissão pendente passou do limite de ${fmt.money(e.debt_limit_cents)} — você não recebe novas corridas
        até ela ser descontada num saque ou quitada com a central.</div>` : ''}
      ${row('Hoje', e.day) + row('Esta semana', e.week) + row('Este mês', e.month) + row('Total', e.total)}
      <p class="muted small mt">Só corridas concluídas entram. Pix e cartão: a VAIRO recebe e credita ${100 - (S.wallet?.commission_pct ?? 15)}% na sua carteira.
      Dinheiro: você recebe tudo na hora e a comissão é descontada do próximo saque.</p>`;
  } catch (err) { $('#earnings-box').innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`; }
}

/* ================= carteira: saldo, comissão, saques ================= */
const WD_PILL = { aguardando_aprovacao: 'yellow', aprovado: 'blue', em_processamento: 'blue', pago: 'green', rejeitado: 'red', cancelado: 'gray' };
const PIX_PT = { cpf: 'CPF', telefone: 'Telefone', email: 'E-mail', aleatoria: 'Chave aleatória' };

async function loadWallet() {
  const box = $('#wallet-box');
  if (!box) return;
  try {
    const w = await api('/api/driver/wallet');
    S.wallet = w;
    const pct = w.commission_pct;
    const nextTxt = w.next_withdrawal_at ? fmt.dt(w.next_withdrawal_at) : 'Agora';
    box.innerHTML = `
      <div class="wallet-hero">
        <div class="muted small">Disponível para saque</div>
        <div class="wallet-amount">${fmt.money(w.withdrawable_cents)}</div>
        <div class="muted small">Saldo ${fmt.money(w.available_cents)} − comissão pendente ${fmt.money(w.pending_commission_cents)}</div>
      </div>
      <button class="btn btn-primary btn-lg mt" id="btn-withdraw" ${w.can_withdraw ? '' : 'disabled'}>SOLICITAR SAQUE</button>
      ${w.blocked_reason ? `<p class="muted small center mt">${escapeHtml(w.blocked_reason)}</p>` : ''}
      ${w.open ? `<div class="list-item mt"><div class="li-main"><div class="li-title">Saque em andamento: ${fmt.money(w.open.amount_cents)}</div>
        <div class="li-sub">Pedido em ${fmt.dt(w.open.created_at)}</div></div>
        <span class="pill ${WD_PILL[w.open.status]}">${escapeHtml(w.open.status_label)}</span></div>
        ${w.open.status === 'aguardando_aprovacao' ? '<button class="btn btn-outline btn-sm mt" id="btn-wd-cancel">Cancelar pedido</button>' : ''}` : ''}
      <div class="fin-grid mt">
        <div class="fin-card in"><div class="fv">${fmt.money(w.available_cents)}</div><div class="fl">Saldo (corridas digitais, ${100 - pct}%)</div></div>
        <div class="fin-card ${w.pending_commission_cents ? 'warn' : ''}"><div class="fv">${fmt.money(w.pending_commission_cents)}</div><div class="fl">Comissão pendente (dinheiro)</div></div>
        <div class="fin-card out"><div class="fv">${w.last_paid ? fmt.money(w.last_paid.amount_cents) : '—'}</div><div class="fl">Último saque${w.last_paid ? ` · ${fmt.date(w.last_paid.paid_at)}` : ''}</div></div>
        <div class="fin-card"><div class="fv">${escapeHtml(nextTxt)}</div><div class="fl">Próximo saque permitido</div></div>
      </div>
      <div class="list-item mt"><div class="li-main"><div class="li-title">Ganhos totais (${w.totals.rides} corrida${w.totals.rides === 1 ? '' : 's'})</div>
        <div class="li-sub">Valor das corridas ${fmt.money(w.totals.gross_cents)} · digitais ${fmt.money(w.totals.digital_gross_cents)} · dinheiro ${fmt.money(w.totals.cash_gross_cents)}</div></div>
        <b>${fmt.money(w.totals.net_cents)}</b></div>
      <div class="list-item"><div class="li-main"><div class="li-title">Comissão VAIRO (${pct}%)</div>
        <div class="li-sub">Digital: já descontada no saldo · Dinheiro: descontada do próximo saque</div></div>
        <b>${fmt.money(w.totals.commission_cents)}</b></div>
      <div class="list-item"><div class="li-main"><div class="li-title">💠 Chave Pix para saque</div>
        <div class="li-sub">${w.pix ? `${PIX_PT[w.pix.type]} ${escapeHtml(w.pix.masked)} · ${escapeHtml(w.pix.holder)}` : 'Não cadastrada'}</div></div>
        <button class="btn btn-outline btn-sm" id="btn-pix">${w.pix ? 'Alterar' : 'Cadastrar'}</button></div>
      <h3 class="mt">Saques</h3>
      ${w.history.length ? w.history.map(p => `<div class="list-item"><div class="li-main">
          <div class="li-title">${fmt.money(p.amount_cents)}${p.debt_cents ? ` <span class="muted small">(+ ${fmt.money(p.debt_cents)} de comissão descontada)</span>` : ''}</div>
          <div class="li-sub">${p.origin === 'central' ? 'Repasse da central' : 'Saque'} · ${fmt.dt(p.created_at)}${p.paid_at ? ` · pago ${fmt.dt(p.paid_at)}` : ''}${p.reason ? ` · ${escapeHtml(p.reason)}` : ''}</div>
        </div><span class="pill ${WD_PILL[p.status] || 'gray'}">${escapeHtml(p.status_label)}</span></div>`).join('')
        : '<p class="muted small">Nenhum saque ainda.</p>'}
      <p class="muted small mt">Saques a cada ${w.interval_hours} horas, por Pix, aprovados pela central. Pedido recusado ou cancelado devolve o valor e não conta para o prazo. Sem taxas de saque.</p>`;
    $('#btn-withdraw')?.addEventListener('click', openWithdrawModal);
    $('#btn-pix').onclick = openPixModal;
    const cancel = $('#btn-wd-cancel');
    if (cancel) cancel.onclick = async () => {
      if (!await confirmModal('Cancelar o pedido de saque?', 'O valor volta para a sua carteira.', 'Cancelar pedido', true)) return;
      await withLoading(cancel, async () => { await api(`/api/driver/withdrawals/${w.open.id}/cancel`, { method: 'POST' }); loadWallet(); loadStatement(); },
        { okMsg: 'Pedido cancelado; valor devolvido.' }).catch(() => { });
    };
  } catch (e) { box.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`; }
  loadStatement();
}

function openWithdrawModal() {
  const w = S.wallet;
  if (!w?.can_withdraw) return;
  const key = (crypto.randomUUID?.() || `${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
  const m = openModal(`
    <h3>💸 Solicitar saque</h3>
    <div class="list-item"><div class="li-main"><div class="li-sub">Mototaxista</div><div class="li-title">${escapeHtml(S.user?.name || '')}</div></div></div>
    <div class="wd-preview">
      <div><span>Valor bruto</span><b>${fmt.money(w.available_cents)}</b></div>
      <div><span>Comissão pendente</span><b>− ${fmt.money(w.pending_commission_cents)}</b></div>
      <div><span>Taxas adicionais</span><b>${fmt.money(0)}</b></div>
      <div class="total"><span>Valor líquido</span><b>${fmt.money(w.withdrawable_cents)}</b></div>
    </div>
    <div class="list-item"><div class="li-main"><div class="li-sub">Forma de recebimento</div>
      <div class="li-title">Pix · ${PIX_PT[w.pix.type]} ${escapeHtml(w.pix.masked)}</div>
      <div class="li-sub">Titular: ${escapeHtml(w.pix.holder)}</div></div></div>
    <p class="muted small mt">A central confere a titularidade da conta antes de transferir. O próximo saque fica liberado ${w.interval_hours} horas depois deste pedido.</p>
    <button class="btn btn-primary btn-lg mt" data-ok>CONFIRMAR SAQUE</button>
    <button class="btn btn-outline mt" data-no>Voltar</button>`);
  $('[data-no]', m).onclick = () => m.close();
  $('[data-ok]', m).onclick = () => withLoading($('[data-ok]', m), async () => {
    // a mesma chave em todas as tentativas deste pedido: repetir não duplica
    await api('/api/driver/withdrawals', { method: 'POST', body: { idempotency_key: key } });
    m.close();
    loadWallet();
  }, { okMsg: 'Saque solicitado! Você será avisado quando for pago.' }).catch(() => { });
}

function openPixModal() {
  const cur = S.wallet?.pix;
  const m = openModal(`
    <h3>💠 Chave Pix para saque</h3>
    <p class="muted small mb">A conta precisa estar no seu nome. Chave CPF: use o mesmo CPF do seu cadastro.</p>
    <div class="field"><label for="pix-type">Tipo de chave</label>
      <select class="input" id="pix-type">${Object.entries(PIX_PT).map(([k, v]) => `<option value="${k}" ${cur?.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="field"><label for="pix-key">Chave</label><input class="input" id="pix-key" autocomplete="off" maxlength="80"></div>
    <div class="field"><label for="pix-holder">Nome completo do titular</label><input class="input" id="pix-holder" maxlength="120" value="${escapeHtml(cur?.holder || S.user?.name || '')}"></div>
    <button class="btn btn-primary" data-ok>Salvar chave</button>`);
  $('[data-ok]', m).onclick = () => withLoading($('[data-ok]', m), async () => {
    await api('/api/driver/wallet/pix', { method: 'PUT', body: { type: $('#pix-type', m).value, key: $('#pix-key', m).value, holder_name: $('#pix-holder', m).value } });
    m.close(); loadWallet();
  }, { okMsg: 'Chave Pix salva.' }).catch(() => { });
}

async function loadStatement(more = false) {
  const box = $('#wallet-statement');
  if (!box) return;
  try {
    const before = more && S.stmtLast ? `&before=${S.stmtLast}` : '';
    const r = await api(`/api/driver/wallet/statement?limit=30${before}`);
    const PAY = { dinheiro: 'dinheiro', pix: 'Pix', cartao: 'cartão' };
    const html = r.entries.map(e => {
      const sign = e.effect.saldo > 0 ? '+' : e.effect.saldo < 0 ? '−' : '';
      const cls = e.effect.saldo > 0 ? 'green' : e.effect.saldo < 0 ? 'red' : '';
      const amount = Math.abs(e.amount_cents);
      return `<div class="list-item stmt"><div class="li-main">
        <div class="li-title">${escapeHtml(e.label)}</div>
        <div class="li-sub">${fmt.dt(e.created_at)}${e.ride ? ` · corrida de ${fmt.money(e.ride.price_cents)} (${PAY[e.ride.payment_method] || e.ride.payment_method})` : ''}${e.payout_id ? ` · saque ${escapeHtml(e.payout_id.slice(-6))}` : ''}
          <br><span class="mono">${escapeHtml(e.id)}</span></div></div>
        <b class="${cls ? `txt-${cls}` : 'muted'}">${sign}${fmt.money(amount)}</b></div>`;
    }).join('');
    if (more) box.querySelector('[data-more]')?.remove();
    if (more) box.insertAdjacentHTML('beforeend', html); else box.innerHTML = html || '<p class="muted small">Sem lançamentos ainda.</p>';
    if (r.entries.length) S.stmtLast = r.entries[r.entries.length - 1].created_at;
    if (r.has_more) {
      box.insertAdjacentHTML('beforeend', '<button class="btn btn-outline btn-sm mt" data-more>Ver mais</button>');
      box.querySelector('[data-more]').onclick = () => loadStatement(true);
    }
  } catch (e) { box.innerHTML = `<p class="muted">${escapeHtml(e.message)}</p>`; }
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
