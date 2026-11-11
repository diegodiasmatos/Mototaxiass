/* Assis MotoTáxi — central administrativa (V2) */
'use strict';

const S = { user: null, section: 'dashboard', testMode: false };
const main = () => $('#admin-main');

init();

async function init() {
  renderBrand($('#brand'), 'Central Administrativa');
  $('#auth-hero').innerHTML = `${LOGO_SVG}<h1>Central Administrativa</h1><p>Assis MotoTáxi</p>`;

  $('#form-login').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    await withLoading(e.target.querySelector('button[type=submit]'), async () => {
      const r = await api('/api/auth/login', {
        method: 'POST', body: { email: f.get('email'), password: f.get('password') },
      });
      if (r.user.role !== 'admin') throw new Error('Esta conta não é de administrador.');
      S.user = r.user;
      enter();
    }).catch(() => { });
  };

  try {
    const me = await api('/api/me');
    if (me.user.role !== 'admin') throw new Error();
    S.user = me.user;
    setNotifBadge(me.unread);
    enter();
  } catch {
    $('#login-wrap').hidden = false;
  }
}

function enter() {
  $('#login-wrap').hidden = true;
  $('#admin-wrap').hidden = false;
  $('#btn-notifs').hidden = false;
  $('#btn-logout').hidden = false;
  $('#btn-notifs').onclick = openNotifications;
  $('#btn-logout').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => { });
    location.reload();
  };

  $$('.sidebar button').forEach(b => b.onclick = () => {
    $$('.sidebar button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    go(b.dataset.sec);
  });

  connectSSE({
    notification: n => {
      toast(n.title); browserNotify(n.title, n.body || '');
      if (['dashboard', 'issues'].includes(S.section)) go(S.section);
    },
  });
  refreshPushSubscription();
  go('dashboard');
}

const SECTIONS = {
  dashboard: secDashboard, drivers: secDrivers, passengers: secPassengers,
  rides: secRides, finance: secFinance, issues: secIssues,
  payments: secPayments, maps: secMaps, settings: secSettings,
  audit: secAudit, support: secSupport,
};

function go(sec) {
  S.section = sec;
  main().innerHTML = '<div class="spinner"></div>';
  (SECTIONS[sec] || secDashboard)().catch(e => {
    main().innerHTML = `<div class="empty"><div class="eico">⚠️</div>${escapeHtml(e.message)}
      <br><button class="btn btn-outline btn-sm mt" onclick="go('${sec}')">Tentar de novo</button></div>`;
  });
}

function testBanner(on) {
  return on ? `<div class="testbar">🧪 PAGAMENTOS EM MODO DE TESTE — nenhum valor real é movimentado.
    Configure MP_ACCESS_TOKEN para operar de verdade.</div>` : '';
}

/* ============ dashboard ============ */
async function secDashboard() {
  const { totals: t, series } = await api('/api/admin/dashboard');
  S.testMode = t.test_mode;
  const stat = (v, l, cls = '') => `<div class="stat"><div class="sv ${cls}">${v}</div><div class="sl">${l}</div></div>`;
  const days = Object.entries(series);
  const maxRides = Math.max(1, ...days.map(([, d]) => d.rides));
  const maxGross = Math.max(1, ...days.map(([, d]) => d.gross));
  const bars = (key, max, money) => days.map(([k, d]) => `
    <div class="bar" title="${k}: ${money ? fmt.money(d[key]) : d[key]}">
      <i style="height:${Math.round(d[key] / max * 100)}%"></i><b>${k.slice(8)}</b>
    </div>`).join('');

  main().innerHTML = `
    ${testBanner(t.test_mode)}
    <h2 class="mb">📊 Visão geral</h2>

    <h3 class="mb">Operação de hoje</h3>
    <div class="stat-grid">
      ${stat(t.rides_today, 'Corridas solicitadas hoje')}
      ${stat(t.rides_today_completed, 'Concluídas hoje')}
      ${stat(t.rides_today_cancelled, 'Canceladas hoje')}
      ${stat(t.rides_active, 'Em andamento agora')}
      ${stat(t.rides_awaiting_payment, 'Aguardando pagamento')}
      ${stat(t.drivers_available, 'Mototaxistas disponíveis')}
      ${stat(t.drivers_on_ride, 'Em corrida')}
      ${stat(t.drivers_online, 'Online')}
    </div>

    <h3 class="mb mt">Cadastros</h3>
    <div class="stat-grid">
      ${stat(t.passengers, 'Passageiros')}
      ${stat(t.drivers, 'Mototaxistas')}
      ${stat(t.drivers_approved, 'Aprovados')}
      ${stat(t.drivers_pending, 'Aguardando aprovação',
    t.drivers_pending ? 'style="color:var(--red)"' : '')}
      ${stat(t.drivers_rejected, 'Reprovados / correção')}
    </div>

    <h3 class="mb mt">Financeiro acumulado</h3>
    <div class="fin-grid">
      <div class="fin-card in"><div class="fv">${fmt.money(t.gross_cents)}</div><div class="fl">Faturamento bruto</div></div>
      <div class="fin-card in"><div class="fv">${fmt.money(t.commission_cents)}</div><div class="fl">Comissão da plataforma</div></div>
      <div class="fin-card out"><div class="fv">${fmt.money(t.drivers_cents)}</div><div class="fl">Valores dos mototaxistas</div></div>
      <div class="fin-card warn"><div class="fv">${fmt.money(t.payout_pending_cents)}</div><div class="fl">A repassar agora</div></div>
      ${t.issues_open ? `<div class="fin-card bad"><div class="fv">${t.issues_open}</div><div class="fl">Ocorrências abertas</div></div>` : ''}
      ${t.rides_disputed ? `<div class="fin-card bad"><div class="fv">${t.rides_disputed}</div><div class="fl">Corridas em disputa</div></div>` : ''}
    </div>

    <div class="card mt"><h3>Corridas por dia (14 dias)</h3><div class="bars">${bars('rides', maxRides, false)}</div></div>
    <div class="card"><h3>Faturamento por dia</h3><div class="bars">${bars('gross', maxGross, true)}</div></div>`;
}

/* ============ mototaxistas ============ */
const DRV_STATUS_PT = { pending: 'Pendente', approved: 'Aprovado', rejected: 'Reprovado', correction: 'Correção' };
const DRV_PILL = { pending: 'yellow', approved: 'green', rejected: 'red', correction: 'blue' };

async function secDrivers(filter = '') {
  const { drivers } = await api(`/api/admin/drivers${filter ? `?status=${filter}` : ''}`);
  main().innerHTML = `
    <h2 class="mb">🏍️ Mototaxistas</h2>
    <div class="seg mb" id="drv-filter" style="max-width:560px;overflow-x:auto">
      ${['', 'pending', 'approved', 'correction', 'rejected'].map(s =>
    `<button data-f="${s}" class="${s === filter ? 'active' : ''}">${s ? DRV_STATUS_PT[s] : 'Todos'}</button>`).join('')}
    </div>
    <div class="card">
      <table class="tbl"><thead><tr>
        <th>Nome</th><th>Moto</th><th>Status</th><th>Avaliação</th><th>Online</th><th></th>
      </tr></thead><tbody>
      ${drivers.map(d => `<tr>
        <td data-l="Nome"><span><b>${escapeHtml(d.name)}</b><br>
          <span class="muted small">${escapeHtml(d.email)}</span></span></td>
        <td data-l="Moto"><span>${escapeHtml([d.moto_brand, d.moto_model].filter(Boolean).join(' '))}<br>
          <span class="plate">${escapeHtml(d.moto_plate || '—')}</span></span></td>
        <td data-l="Status"><span><span class="pill ${DRV_PILL[d.status]}">${DRV_STATUS_PT[d.status]}</span>
          ${d.blocked ? ' <span class="pill red">bloqueado</span>' : ''}</span></td>
        <td data-l="Avaliação">${d.rating ? `★ ${d.rating}` : '—'} <span class="muted small">(${d.rides_count})</span></td>
        <td data-l="Online">${d.online ? '🟢 sim' : '⚪ não'}</td>
        <td><button class="btn btn-outline btn-sm" data-open="${d.user_id}">Analisar</button></td>
      </tr>`).join('') || '<tr><td class="muted center">Nenhum cadastro.</td></tr>'}
      </tbody></table>
    </div>`;
  $$('#drv-filter button').forEach(b => b.onclick = () => secDrivers(b.dataset.f));
  $$('[data-open]').forEach(b => b.onclick = () => openDriver(b.dataset.open));
}

async function openDriver(idd) {
  const { driver: d, documents, rides, ratings } = await api(`/api/admin/drivers/${idd}`);
  const DOC_PT = { cnh: 'CNH', crlv: 'CRLV', selfie: 'Selfie com CNH' };
  const m = openModal(`
    <h3>${escapeHtml(d.name)} <span class="pill ${DRV_PILL[d.status]}">${DRV_STATUS_PT[d.status]}</span></h3>
    <p class="muted small">
      CPF: ${escapeHtml(d.cpf || '—')} · Nasc.: ${escapeHtml(d.birth_date || '—')} · Tel.: ${escapeHtml(d.phone || '—')}<br>
      Endereço: ${escapeHtml(d.address || '—')}<br>
      Moto: <b>${escapeHtml([d.moto_brand, d.moto_model, d.moto_year].filter(Boolean).join(' '))}</b>,
      ${escapeHtml(d.moto_color || '')} · <span class="plate">${escapeHtml(d.moto_plate || '—')}</span><br>
      Enviado: ${d.submitted_at ? fmt.dt(d.submitted_at) : '—'} · Prazo: ${d.deadline_at ? fmt.dt(d.deadline_at) : '—'}
      ${d.review_reason ? `<br>Último parecer: ${escapeHtml(d.review_reason)}` : ''}
    </p>
    <h3 class="mt">Documentos <span class="muted small">(links expiram em 10 min)</span></h3>
    <div class="grid2">
      ${documents.map(doc => `
        <a class="doc-thumb" href="${doc.url}" target="_blank" rel="noopener">
          ${doc.mime.startsWith('image/') ? `<img src="${doc.url}" alt="${DOC_PT[doc.kind]}">` : `<div class="empty">📄 PDF</div>`}
          <div class="small center" style="padding:6px">${DOC_PT[doc.kind] || doc.kind} · ${fmt.dt(doc.uploaded_at)}</div>
        </a>`).join('') || '<p class="muted small">Sem documentos.</p>'}
    </div>
    ${d.status !== 'approved' ? `
      <div class="field mt"><label>Motivo (obrigatório para reprovar/corrigir)</label>
      <input class="input" id="rev-reason" placeholder="Ex.: CNH ilegível, reenvie a foto"></div>
      <div class="row" style="flex-wrap:wrap">
        <button class="btn btn-green btn-sm" data-act="approve">Aprovar ✓</button>
        <button class="btn btn-outline btn-sm" data-act="correction">Pedir correção</button>
        <button class="btn btn-danger btn-sm" data-act="reject">Reprovar</button>
      </div>` : `
      <div class="row mt">
        <button class="btn ${d.blocked ? 'btn-green' : 'btn-danger'} btn-sm" data-block="${d.blocked ? 0 : 1}">
          ${d.blocked ? 'Desbloquear conta' : 'Bloquear conta'}</button>
      </div>`}
    <h3 class="mt">Últimas corridas</h3>
    ${rides.map(r => `<div class="list-item"><div class="li-main">
      <div class="li-title">${escapeHtml(r.origin_text)} → ${escapeHtml(r.dest_text)}</div>
      <div class="li-sub">${fmt.dt(r.requested_at)} · ${fmt.money(r.price_cents)} · ${STATUS_PT[r.status] || r.status}</div>
    </div></div>`).join('') || '<p class="muted small">Nenhuma corrida.</p>'}
    <h3 class="mt">Avaliações</h3>
    ${ratings.map(r => `<div class="list-item"><div class="li-main">
      <div class="li-title">★ ${r.stars}</div><div class="li-sub">${escapeHtml(r.comment || 'Sem comentário')} · ${fmt.date(r.created_at)}</div>
    </div></div>`).join('') || '<p class="muted small">Nenhuma avaliação.</p>'}
  `);

  $$('[data-act]', m).forEach(b => b.onclick = async () => {
    const action = b.dataset.act;
    const reason = $('#rev-reason', m)?.value?.trim() || '';
    if (action !== 'approve' && !reason) { toast('Informe o motivo para o candidato.', 'err'); return; }
    const label = action === 'approve' ? 'Aprovar' : action === 'reject' ? 'Reprovar' : 'Pedir correção de';
    if (!await confirmModal(`${label} ${d.name}?`,
      action === 'approve' ? 'O parceiro poderá ficar online e receber corridas imediatamente.' : `Motivo: ${reason}`,
      'Confirmar', action === 'reject')) return;
    await withLoading(b, async () => {
      await api(`/api/admin/drivers/${idd}/review`, { method: 'POST', body: { action, reason } });
      m.close(); secDrivers();
    }, { okMsg: 'Decisão registrada e parceiro notificado.' }).catch(() => { });
  });

  const bb = $('[data-block]', m);
  if (bb) bb.onclick = async () => {
    const block = bb.dataset.block === '1';
    const reason = block ? await askText('Bloquear conta', 'Motivo do bloqueio') : '';
    if (block && !reason) return;
    await withLoading(bb, async () => {
      await api(`/api/admin/users/${idd}/block`, { method: 'POST', body: { blocked: block, reason } });
      m.close(); secDrivers();
    }, { okMsg: block ? 'Conta bloqueada.' : 'Conta desbloqueada.' }).catch(() => { });
  };
}

/** Caixa de texto em modal (substitui `prompt`, que é bloqueado em vários celulares). */
function askText(title, label, { value = '', multiline = false, type = 'text' } = {}) {
  return new Promise(resolve => {
    const m = openModal(`
      <h3>${escapeHtml(title)}</h3>
      <div class="field"><label>${escapeHtml(label)}</label>
        ${multiline
        ? `<textarea class="input" id="ask-v" maxlength="500">${escapeHtml(value)}</textarea>`
        : `<input class="input" id="ask-v" type="${type}" value="${escapeHtml(value)}">`}</div>
      <button class="btn btn-primary" data-ok>Confirmar</button>
      <button class="btn btn-outline mt" data-no>Cancelar</button>`,
      { onClose: () => resolve(null) });
    setTimeout(() => $('#ask-v', m)?.focus(), 80);
    $('[data-ok]', m).onclick = () => { const v = $('#ask-v', m).value.trim(); resolve(v); m.close(); };
    $('[data-no]', m).onclick = () => { resolve(null); m.close(); };
  });
}

/* ============ passageiros ============ */
async function secPassengers() {
  const { passengers } = await api('/api/admin/passengers');
  main().innerHTML = `
    <h2 class="mb">👥 Passageiros</h2>
    <div class="card">
      <table class="tbl"><thead><tr>
        <th>Nome</th><th>Contato</th><th>Corridas</th><th>Cancel.</th><th>Desde</th><th></th>
      </tr></thead><tbody>
      ${passengers.map(p => `<tr>
        <td data-l="Nome"><span><b>${escapeHtml(p.name)}</b>${p.blocked ? ' <span class="pill red">bloqueado</span>' : ''}</span></td>
        <td data-l="Contato"><span class="small">${escapeHtml(p.email)}<br>${escapeHtml(p.phone || '')}</span></td>
        <td data-l="Corridas">${p.rides_count}</td>
        <td data-l="Cancelamentos">${p.cancels_count}</td>
        <td data-l="Desde" class="small">${fmt.date(p.created_at)}</td>
        <td><button class="btn ${p.blocked ? 'btn-green' : 'btn-danger'} btn-sm" data-block="${p.id}" data-to="${p.blocked ? 0 : 1}">
          ${p.blocked ? 'Desbloquear' : 'Bloquear'}</button></td>
      </tr>`).join('') || '<tr><td class="muted center">Nenhum passageiro.</td></tr>'}
      </tbody></table>
    </div>`;
  $$('[data-block]').forEach(b => b.onclick = async () => {
    const block = b.dataset.to === '1';
    const reason = block ? await askText('Bloquear passageiro', 'Motivo do bloqueio') : '';
    if (block && !reason) return;
    await withLoading(b, async () => {
      await api(`/api/admin/users/${b.dataset.block}/block`, { method: 'POST', body: { blocked: block, reason } });
      secPassengers();
    }, { okMsg: 'Atualizado.' }).catch(() => { });
  });
}

/* ============ corridas ============ */
async function secRides(filter = '') {
  const { rides } = await api(`/api/admin/rides${filter ? `?status=${filter}` : ''}`);
  const FILTERS = ['', 'pending_payment', 'requested', 'accepted', 'in_progress',
    'awaiting_confirmation', 'completed', 'cancelled', 'disputed'];
  main().innerHTML = `
    <h2 class="mb">🛣️ Corridas</h2>
    <div class="seg mb" style="overflow-x:auto" id="ride-filter">
      ${FILTERS.map(s => `<button data-f="${s}" class="${s === filter ? 'active' : ''}"
        style="white-space:nowrap">${s ? (STATUS_PT[s] || s) : 'Todas'}</button>`).join('')}
    </div>
    <div class="card">
      <table class="tbl"><thead><tr>
        <th>Quando</th><th>Trajeto</th><th>Passageiro</th><th>Mototaxista</th>
        <th>Valor</th><th>Comissão</th><th>Pagamento</th><th>Status</th><th></th>
      </tr></thead><tbody>
      ${rides.map(r => `<tr>
        <td data-l="Quando" class="small">${fmt.dt(r.requested_at)}</td>
        <td data-l="Trajeto"><span class="small">${escapeHtml(r.origin_text)}<br>→ ${escapeHtml(r.dest_text)}<br>
          <span class="muted">${fmt.dist(r.distance_m)} · ${r.category}</span></span></td>
        <td data-l="Passageiro" class="small">${escapeHtml(r.passenger_name)}</td>
        <td data-l="Mototaxista" class="small">${escapeHtml(r.driver_name || '—')}</td>
        <td data-l="Valor"><b>${fmt.money(r.price_cents)}</b></td>
        <td data-l="Comissão" class="small">${r.commission_cents != null ? fmt.money(r.commission_cents) : '—'}</td>
        <td data-l="Pagamento" class="small">${PAY_PT[r.payment_method]}<br>
          <span class="muted">${PAYMENT_STATUS_PT[r.payment_status] || r.payment_status}</span></td>
        <td data-l="Status"><span class="pill ${STATUS_PILL[r.status] || 'gray'}">${STATUS_PT[r.status] || r.status}</span></td>
        <td><button class="btn btn-outline btn-sm" data-ride="${r.id}">Detalhes</button></td>
      </tr>`).join('') || '<tr><td class="muted center">Nenhuma corrida.</td></tr>'}
      </tbody></table>
    </div>`;
  $$('#ride-filter button').forEach(b => b.onclick = () => secRides(b.dataset.f));
  $$('[data-ride]').forEach(b => b.onclick = () => openRide(b.dataset.ride));
}

async function openRide(idd) {
  const { ride: r, events, payment, locations } = await api(`/api/admin/rides/${idd}`);
  const m = openModal(`
    <h3>Corrida ${r.id.slice(-6)} <span class="pill ${STATUS_PILL[r.status] || 'gray'}">${STATUS_PT[r.status] || r.status}</span></h3>
    <p class="muted small">
      ${escapeHtml(r.origin_text)} → ${escapeHtml(r.dest_text)}<br>
      Passageiro: <b>${escapeHtml(r.passenger_name)}</b> · Mototaxista: <b>${escapeHtml(r.driver_name || '—')}</b><br>
      ${fmt.dist(r.distance_m)} · ${r.category}<br>
      Valor: <b>${fmt.money(r.price_cents)}</b> · Comissão (${r.commission_pct}%):
      ${r.commission_cents != null ? fmt.money(r.commission_cents) : '—'} ·
      Parceiro: ${r.driver_cents != null ? fmt.money(r.driver_cents) : '—'}<br>
      ${r.confirmed_by ? `Conclusão confirmada por: <b>${escapeHtml(r.confirmed_by)}</b><br>` : ''}
      ${r.cancel_reason ? `Cancelamento (${r.cancelled_by}): ${escapeHtml(r.cancel_reason)} — estado anterior: ${r.cancel_prev_status}<br>` : ''}
      Últimas posições registradas: ${locations?.length || 0}
    </p>

    <h3 class="mt">Pagamento</h3>
    ${payment ? `
      <div class="list-item"><div class="li-main">
        <div class="li-title">${PAY_PT[payment.method]} · ${fmt.money(payment.amount_cents)}
          ${payment.test_mode ? '<span class="pill yellow">teste</span>' : ''}</div>
        <div class="li-sub">Provedor: ${escapeHtml(payment.provider)}
          ${payment.provider_payment_id ? `· id ${escapeHtml(payment.provider_payment_id)}` : ''}<br>
          ${payment.paid_at ? `Pago em ${fmt.dt(payment.paid_at)}` : 'Sem data de pagamento'}
          ${payment.provider_fee_cents ? ` · taxa do provedor ${fmt.money(payment.provider_fee_cents)}` : ''}</div>
      </div><span class="pill ${payment.status === 'pago' || payment.status === 'dinheiro_recebido' ? 'green'
      : payment.status === 'estornado' || payment.status === 'recusado' ? 'red' : 'yellow'}">
        ${PAYMENT_STATUS_PT[payment.status] || payment.status}</span></div>
      <div class="row mt" style="flex-wrap:wrap">
        <button class="btn btn-outline btn-sm" data-sync>Sincronizar com o provedor</button>
        ${['pago', 'autorizado', 'aguardando_pagamento'].includes(payment.status)
      ? '<button class="btn btn-danger btn-sm" data-refund>Estornar</button>' : ''}
      </div>` : '<p class="muted small">Sem cobrança registrada.</p>'}

    <h3 class="mt">Linha do tempo</h3>
    <div class="timeline">
      ${events.map(e => `<div class="tev"><b>${escapeHtml(e.type)}</b>
        <div class="muted small">${fmt.dt(e.at)}${e.details ? ` · ${escapeHtml(e.details)}` : ''}</div></div>`).join('')}
    </div>`);

  const sync = $('[data-sync]', m);
  if (sync) sync.onclick = () => withLoading(sync, async () => {
    const r2 = await api(`/api/admin/rides/${idd}/sync-payment`, { method: 'POST' });
    toast(`Status no provedor: ${r2.status}`, 'ok');
    m.close(); openRide(idd);
  });
  const ref = $('[data-refund]', m);
  if (ref) ref.onclick = async () => {
    const reason = await askText('Estornar pagamento', 'Motivo do estorno (fica na auditoria)');
    if (!reason) return;
    await withLoading(ref, async () => {
      await api(`/api/admin/rides/${idd}/refund`, { method: 'POST', body: { reason } });
      m.close(); secRides();
    }, { okMsg: 'Estorno solicitado ao provedor.' }).catch(() => { });
  };
}

/* ============ financeiro ============ */
async function secFinance() {
  const f = await api('/api/admin/finance');
  const t = f.totals;
  main().innerHTML = `
    ${testBanner(f.test_mode)}
    <h2 class="mb">💰 Financeiro</h2>
    <p class="muted small mb">Provedor: <b>${escapeHtml(f.provider)}</b> ·
      todos os valores vêm do livro-caixa (somente inserção, nunca editado).</p>

    <div class="fin-grid mb">
      <div class="fin-card in"><div class="fv">${fmt.money(t.cobrado)}</div><div class="fl">Total cobrado</div></div>
      <div class="fin-card in"><div class="fv">${fmt.money(t.comissao)}</div><div class="fl">Comissão da plataforma</div></div>
      <div class="fin-card out"><div class="fv">${fmt.money(t.repasse_devido)}</div><div class="fl">Repasses devidos</div></div>
      <div class="fin-card out"><div class="fv">${fmt.money(t.repasse_pago)}</div><div class="fl">Repasses pagos</div></div>
      <div class="fin-card warn"><div class="fv">${fmt.money(t.repasse_devido - t.repasse_pago)}</div><div class="fl">A repassar</div></div>
      <div class="fin-card warn"><div class="fv">${fmt.money(t.divida_motoboys)}</div><div class="fl">Comissão a receber (dinheiro)</div></div>
      <div class="fin-card bad"><div class="fv">${fmt.money(t.estornos)}</div><div class="fl">Estornos</div></div>
      <div class="fin-card"><div class="fv">${fmt.money(t.taxas_provedor)}</div><div class="fl">Taxas do provedor</div></div>
    </div>

    <div class="card">
      <h3>Pagamentos por situação</h3>
      <table class="tbl"><thead><tr><th>Situação</th><th>Qtd.</th><th>Total</th></tr></thead><tbody>
        ${f.porStatusPagamento.map(s => `<tr>
          <td data-l="Situação">${PAYMENT_STATUS_PT[s.status] || s.status}</td>
          <td data-l="Qtd.">${s.qtd}</td>
          <td data-l="Total">${fmt.money(s.total)}</td></tr>`).join('') ||
    '<tr><td class="muted">Nenhum pagamento.</td></tr>'}
      </tbody></table>
    </div>

    <div class="card">
      <h3>Saldos dos mototaxistas</h3>
      <table class="tbl"><thead><tr>
        <th>Mototaxista</th><th>Ganhou</th><th>Já recebeu</th><th>A receber</th><th>Deve (comissão)</th><th></th>
      </tr></thead><tbody>
      ${f.saldos.map(s => `<tr>
        <td data-l="Mototaxista"><b>${escapeHtml(s.name)}</b></td>
        <td data-l="Ganhou">${fmt.money(s.earned_cents)}</td>
        <td data-l="Já recebeu">${fmt.money(s.paid_cents)}</td>
        <td data-l="A receber"><b style="color:var(--green)">${fmt.money(s.pending_cents)}</b></td>
        <td data-l="Deve"><b style="color:${s.debt_cents ? 'var(--red)' : 'inherit'}">${fmt.money(s.debt_cents)}</b></td>
        <td><span style="display:flex;gap:6px;flex-wrap:wrap">
          ${s.pending_cents > 0 ? `<button class="btn btn-green btn-sm" data-pay="${s.driver_id}" data-max="${s.pending_cents}" data-name="${escapeHtml(s.name)}">Repassar</button>` : ''}
          ${s.debt_cents > 0 ? `<button class="btn btn-outline btn-sm" data-settle="${s.driver_id}" data-max="${s.debt_cents}">Quitar</button>` : ''}
        </span></td>
      </tr>`).join('') || '<tr><td class="muted center">Nenhum saldo em aberto.</td></tr>'}
      </tbody></table>
    </div>

    <div class="card">
      <h3>Histórico de transações</h3>
      <table class="tbl"><thead><tr><th>Data</th><th>Tipo</th><th>Mototaxista</th><th>Valor</th><th>Descrição</th></tr></thead><tbody>
      ${f.transacoes.slice(0, 80).map(x => `<tr>
        <td data-l="Data" class="small">${fmt.dt(x.created_at)}</td>
        <td data-l="Tipo"><span class="pill ${x.kind === 'comissao' ? 'green'
      : x.kind === 'estorno' ? 'red' : x.kind.startsWith('repasse') ? 'blue' : 'gray'}">${x.kind}</span>
          ${x.test_mode ? '<span class="pill yellow">teste</span>' : ''}</td>
        <td data-l="Mototaxista" class="small">${escapeHtml(x.driver_name || '—')}</td>
        <td data-l="Valor"><b>${fmt.money(x.amount_cents)}</b></td>
        <td data-l="Descrição" class="small">${escapeHtml(x.description || '')}</td>
      </tr>`).join('') || '<tr><td class="muted center">Nenhuma transação.</td></tr>'}
      </tbody></table>
    </div>`;

  $$('[data-pay]').forEach(b => b.onclick = async () => {
    const max = Number(b.dataset.max);
    const v = await askText(`Repassar para ${b.dataset.name}`,
      `Valor em reais (máximo ${fmt.money(max)})`, { value: (max / 100).toFixed(2) });
    if (v === null) return;
    const cents = Math.round(parseFloat(v.replace(',', '.')) * 100);
    if (!Number.isFinite(cents) || cents <= 0) { toast('Valor inválido.', 'err'); return; }
    const ref = await askText('Comprovante', 'Identificação do Pix/transferência (opcional)');
    await withLoading(b, async () => {
      await api('/api/admin/payouts', {
        method: 'POST',
        body: { driver_id: b.dataset.pay, amount_cents: cents, method: 'pix', reference: ref || null },
      });
      secFinance();
    }, { okMsg: 'Repasse registrado e parceiro notificado.' }).catch(() => { });
  });

  $$('[data-settle]').forEach(b => b.onclick = async () => {
    const max = Number(b.dataset.max);
    const v = await askText('Quitar comissão',
      `Valor recebido do mototaxista em reais (máximo ${fmt.money(max)})`,
      { value: (max / 100).toFixed(2) });
    if (v === null) return;
    const cents = Math.round(parseFloat(v.replace(',', '.')) * 100);
    await withLoading(b, async () => {
      await api(`/api/admin/drivers/${b.dataset.settle}/settle-debt`, {
        method: 'POST', body: { amount_cents: cents },
      });
      secFinance();
    }, { okMsg: 'Quitação registrada.' }).catch(() => { });
  });
}

/* ============ ocorrências ============ */
async function secIssues(filter = '') {
  const { issues } = await api(`/api/admin/issues${filter ? `?status=${filter}` : ''}`);
  main().innerHTML = `
    <h2 class="mb">⚠️ Ocorrências</h2>
    <div class="seg mb" id="iss-filter" style="max-width:520px">
      ${['', 'aberta', 'em_analise', 'resolvida', 'rejeitada'].map(s =>
    `<button data-f="${s}" class="${s === filter ? 'active' : ''}">${s || 'Todas'}</button>`).join('')}
    </div>
    <div class="card">
      ${issues.length ? issues.map(i => `
        <div class="list-item">
          <div class="li-main">
            <div class="li-title">${escapeHtml(i.kind)}
              <span class="pill ${i.status === 'aberta' ? 'red' : i.status === 'resolvida' ? 'green' : 'yellow'}">${i.status}</span>
              <span class="pill gray">${STATUS_PT[i.ride_status] || i.ride_status}</span></div>
            <div class="li-sub">
              ${escapeHtml(i.user_name)} · ${fmt.dt(i.created_at)}<br>
              ${escapeHtml(i.origin_text)} → ${escapeHtml(i.dest_text)} · ${fmt.money(i.price_cents)}
              · mototaxista: ${escapeHtml(i.driver_name || '—')}<br>
              ${i.description ? `"${escapeHtml(i.description)}"` : '<i>sem descrição</i>'}
              ${i.resolution ? `<br><b>Resolução:</b> ${escapeHtml(i.resolution)}` : ''}
            </div>
          </div>
          ${['aberta', 'em_analise'].includes(i.status)
      ? `<button class="btn btn-navy btn-sm" data-res="${i.id}">Analisar</button>` : ''}
        </div>`).join('')
      : '<div class="empty"><div class="eico">✅</div>Nenhuma ocorrência registrada.</div>'}
    </div>`;
  $$('#iss-filter button').forEach(b => b.onclick = () => secIssues(b.dataset.f));
  $$('[data-res]').forEach(b => b.onclick = () => resolveIssue(b.dataset.res));
}

function resolveIssue(issueId) {
  const m = openModal(`
    <h3>Analisar ocorrência</h3>
    <p class="muted mb">Escolha o destino do dinheiro desta corrida. A decisão fica na auditoria.</p>
    <div class="field"><label>Parecer (vai para o passageiro e o mototaxista)</label>
      <textarea class="input" id="res-note" maxlength="500" placeholder="Ex.: GPS confirma a chegada ao destino"></textarea></div>
    <button class="btn btn-green" data-a="concluir">Concluir corrida (libera comissão e repasse)</button>
    <button class="btn btn-danger mt" data-a="estornar">Estornar ao passageiro (cancela a corrida)</button>
    <button class="btn btn-outline mt" data-a="rejeitar">Rejeitar ocorrência (sem mudança financeira)</button>`);
  $$('[data-a]', m).forEach(b => b.onclick = async () => {
    const note = $('#res-note', m).value.trim();
    if (!note) { toast('Escreva o parecer.', 'err'); return; }
    await withLoading(b, async () => {
      await api(`/api/admin/issues/${issueId}/resolve`, {
        method: 'POST', body: { action: b.dataset.a, note },
      });
      m.close(); secIssues();
    }, { okMsg: 'Ocorrência encerrada.' }).catch(() => { });
  });
}

/* ============ pagamentos (credenciais do provedor) ============ */
async function secPayments() {
  const c = await api('/api/admin/payment-config');
  const sp = await api('/api/admin/split-drivers');
  const f = (k, label, help, type = 'password') => {
    const v = c.credentials[k];
    const origem = v.source === 'banco' ? '<span class="pill green">salva aqui</span>'
      : v.source === 'ambiente' ? '<span class="pill blue">vem do .env</span>'
        : '<span class="pill gray">não configurada</span>';
    return `<div class="field">
      <label>${label} ${origem}</label>
      <input class="input" data-cred="${k}" type="${type}" autocomplete="off"
        placeholder="${v.filled ? escapeHtml(v.value || '••••••') : 'cole aqui'}"
        value="${k === 'PUBLIC_URL' ? escapeHtml(v.value || '') : ''}">
      <p class="muted small" style="margin-top:4px">${help}</p>
    </div>`;
  };

  main().innerHTML = `
    ${testBanner(c.test_mode)}
    <h2 class="mb">💳 Pagamentos</h2>

    <div class="card">
      <h3>Passo 1 · Criar o aplicativo no Mercado Pago</h3>
      <ol class="muted small" style="padding-left:18px;line-height:1.9">
        <li>Entre em <a href="https://www.mercadopago.com.br/developers/panel/app" target="_blank" rel="noopener">mercadopago.com.br/developers</a> com a conta <b>da empresa</b>.</li>
        <li>Clique em <b>Criar aplicação</b> → nome "Assis MotoTáxi" → produto <b>Pagamentos online</b> → modelo <b>Marketplace</b>.</li>
        <li>Na aplicação criada, abra <b>Credenciais de produção</b> e copie o <b>Access token</b> e a <b>Public key</b>.</li>
        <li>Em <b>Webhooks</b>, cadastre a URL abaixo, marque o evento <b>Pagamentos</b> e copie a <b>Assinatura secreta</b>.</li>
      </ol>
      <div class="field mt">
        <label>URL do webhook (cadastre no Mercado Pago)</label>
        <div class="row">
          <input class="input" id="wh-url" readonly value="${escapeHtml(c.webhook_url || 'defina a URL pública abaixo')}">
          <button class="btn btn-outline btn-sm" id="wh-copy">Copiar</button>
        </div>
      </div>
      <div class="field">
        <label>URL de retorno do OAuth (cadastre em "Redirect URIs")</label>
        <div class="row">
          <input class="input" id="rd-url" readonly value="${escapeHtml(c.oauth_redirect_uri || 'defina a URL pública abaixo')}">
          <button class="btn btn-outline btn-sm" id="rd-copy">Copiar</button>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>Passo 2 · Colar as credenciais</h3>
      <p class="muted small mb">Ficam cifradas no banco. Campos em branco não alteram o que já está salvo.</p>
      ${f('PUBLIC_URL', 'URL pública do sistema', 'Ex.: https://assis-mototaxi.fly.dev — usada no webhook e no OAuth.', 'text')}
      ${f('MP_ACCESS_TOKEN', 'Access token (produção)', 'Começa com APP_USR-. É o segredo mais importante: nunca compartilhe.')}
      ${f('MP_PUBLIC_KEY', 'Public key', 'Necessária para cobrar no cartão. Sem ela, só Pix.')}
      ${f('MP_WEBHOOK_SECRET', 'Assinatura secreta do webhook', 'Sem ela, eventos do provedor não são aplicados (só registrados).')}
      <h3 class="mt">Recebimento direto (split)</h3>
      ${f('MP_CLIENT_ID', 'Client ID do aplicativo', 'Permite que cada mototaxista conecte a conta dele e receba direto.')}
      ${f('MP_CLIENT_SECRET', 'Client Secret do aplicativo', 'Fica só no servidor, cifrado.')}
      <div class="field">
        <label>Quando cobrar o passageiro</label>
        <select class="input" id="charge-timing">
          <option value="antes" ${c.charge_timing === 'antes' ? 'selected' : ''}>
            Antes de chamar o mototaxista — dinheiro garantido, repasse manual
          </option>
          <option value="apos_aceite" ${c.charge_timing === 'apos_aceite' ? 'selected' : ''}>
            Depois do aceite — permite o split automático na conta do parceiro
          </option>
        </select>
        <p class="muted small" style="margin-top:4px">
          O split só funciona cobrando depois do aceite, porque o Mercado Pago precisa
          saber de quem é a conta que recebe. Nesse modo a corrida não inicia enquanto
          o pagamento não é confirmado.
        </p>
      </div>
      <button class="btn btn-primary" id="pc-save">Salvar credenciais</button>
    </div>

    <div class="card">
      <h3>Passo 3 · Testar a conexão</h3>
      <button class="btn btn-navy btn-sm" id="pc-test">Testar agora</button>
      <div id="pc-result" class="mt"></div>
    </div>

    <div class="card">
      <h3>Passo 4 · Contas dos mototaxistas ${c.split_available
      ? '<span class="pill green">liberado</span>' : '<span class="pill gray">aguardando Client ID/Secret</span>'}</h3>
      <p class="muted small mb">Cada parceiro conecta a conta dele pelo próprio aplicativo,
        em Perfil → "Receber direto na minha conta". ${c.connected_drivers} conectado(s).</p>
      <table class="tbl"><thead><tr><th>Mototaxista</th><th>Conta</th><th>Desde</th></tr></thead><tbody>
      ${sp.drivers.map(d => `<tr>
        <td data-l="Mototaxista"><b>${escapeHtml(d.name)}</b></td>
        <td data-l="Conta">${d.connected
        ? `<span class="pill green">conectada</span> ${escapeHtml(d.mp_nickname || '')}`
        : '<span class="pill gray">recebe via repasse</span>'}</td>
        <td data-l="Desde" class="small">${d.mp_connected_at ? fmt.dt(d.mp_connected_at) : '—'}</td>
      </tr>`).join('') || '<tr><td class="muted center">Nenhum parceiro aprovado.</td></tr>'}
      </tbody></table>
    </div>`;

  const copy = async (sel, btn) => {
    try { await navigator.clipboard.writeText($(sel).value); toast('Copiado!', 'ok'); }
    catch { toast('Copie manualmente.', 'err'); }
  };
  $('#wh-copy').onclick = () => copy('#wh-url');
  $('#rd-copy').onclick = () => copy('#rd-url');

  $('#pc-save').onclick = () => withLoading($('#pc-save'), async () => {
    const credentials = {};
    $$('[data-cred]').forEach(i => { if (i.value.trim()) credentials[i.dataset.cred] = i.value.trim(); });
    await api('/api/admin/payment-config', {
      method: 'PUT', body: { credentials, charge_timing: $('#charge-timing').value },
    });
    secPayments();
  }, { okMsg: 'Credenciais salvas (cifradas).' }).catch(() => { });

  $('#pc-test').onclick = () => withLoading($('#pc-test'), async () => {
    const r = await api('/api/admin/payment-config/test', { method: 'POST' });
    $('#pc-result').innerHTML = r.checks.map(c2 => `
      <div class="list-item">
        <span style="font-size:1.2rem">${c2.ok ? '✅' : '⚠️'}</span>
        <div class="li-main"><div class="li-title">${escapeHtml(c2.item)}</div>
          <div class="li-sub">${escapeHtml(c2.detail)}</div></div>
      </div>`).join('') +
      (r.test_mode ? '<div class="testbar mt">Ainda em modo de teste: nenhum valor real é movimentado.</div>'
        : '<div class="testbar mt" style="background:#dcfce7;border-color:#86efac;color:#166534">✅ Operando com dinheiro real.</div>');
  });
}

/* ============ mapas (Google Maps Platform) ============ */
async function secMaps() {
  const m = await api('/api/admin/maps-config');
  const cred = (k, label, help) => {
    const v = m.credentials[k];
    const origem = v.source === 'banco' ? '<span class="pill green">salva aqui</span>'
      : v.source === 'ambiente' ? '<span class="pill blue">vem do .env</span>'
        : '<span class="pill gray">não configurada</span>';
    return `<div class="field">
      <label>${label} ${origem}</label>
      <input class="input" data-mk="${k}" type="password" autocomplete="off"
        placeholder="${v.filled ? escapeHtml(v.value) : 'cole aqui'}">
      <p class="muted small" style="margin-top:4px">${help}</p>
    </div>`;
  };
  const cacheRows = m.cache.length
    ? m.cache.map(c => `<tr>
        <td data-l="Tipo">${escapeHtml(c.kind)}</td>
        <td data-l="Entradas">${c.entradas}</td>
        <td data-l="Chamadas evitadas"><b style="color:var(--green)">${c.acertos}</b></td>
      </tr>`).join('')
    : '<tr><td class="muted center">Nada em cache ainda.</td></tr>';

  main().innerHTML = `
    <h2 class="mb">🗺️ Mapas</h2>
    <div class="fin-grid mb">
      <div class="fin-card ${m.active_routing === 'google' ? 'in' : 'warn'}">
        <div class="fv">${m.active_routing === 'google' ? 'Google' : 'OSRM'}</div>
        <div class="fl">Rotas e distâncias (backend)</div></div>
      <div class="fin-card ${m.active_visual === 'google' ? 'in' : 'warn'}">
        <div class="fv">${m.active_visual === 'google' ? 'Google' : 'OpenStreetMap'}</div>
        <div class="fl">Mapa visual (aplicativos)</div></div>
    </div>
    ${m.active_routing !== 'google' ? `<div class="testbar">
      🗺️ Sem chave do Google: o sistema usa OpenStreetMap/OSRM — mapa real e gratuito,
      porém com endereços menos completos e sem modo de motocicleta.</div>` : ''}

    <div class="card">
      <h3>Passo 1 · Criar as chaves no Google Cloud</h3>
      <ol class="muted small" style="padding-left:18px;line-height:1.9">
        <li>Acesse <a href="https://console.cloud.google.com/google/maps-apis/credentials" target="_blank" rel="noopener">console.cloud.google.com</a>, crie um projeto e <b>ative o faturamento</b> (o Google exige cartão; há US$ 200/mês de crédito gratuito).</li>
        <li>Em <b>APIs e serviços</b>, ative: <b>Maps JavaScript API</b>, <b>Places API (New)</b>, <b>Geocoding API</b> e <b>Routes API</b>.</li>
        <li>Crie <b>duas</b> chaves em Credenciais:
          <ul>
            <li><b>Chave do navegador</b> → restrição <i>Referenciadores HTTP</i> com o seu domínio, e restrita à <i>Maps JavaScript API</i>.</li>
            <li><b>Chave de servidor</b> → restrição por <i>endereço IP</i> (o do servidor), restrita a <i>Places (New)</i>, <i>Geocoding</i> e <i>Routes</i>.</li>
          </ul>
        </li>
        <li>Em <b>Cotas</b>, defina um teto diário por API e crie um <b>alerta de orçamento</b> para não ter surpresa na fatura.</li>
      </ol>
    </div>

    <div class="card">
      <h3>Passo 2 · Colar as chaves</h3>
      <p class="muted small mb">Ficam cifradas no banco. Campos em branco não alteram o que já está salvo.</p>
      ${cred('GOOGLE_MAPS_SERVER_KEY', 'Chave de servidor',
    'Usada só pelo backend (Routes, Places, Geocoding). <b>Nunca</b> vai para o navegador.')}
      ${cred('GOOGLE_MAPS_BROWSER_KEY', 'Chave do navegador',
    'Vai para o aplicativo (é pública por natureza) — por isso restrinja por domínio no Google Cloud.')}
      <div class="field">
        <label>Provedor de mapas</label>
        <select class="input" id="mp-provider">
          <option value="auto" ${m.provider === 'auto' ? 'selected' : ''}>Automático — Google quando houver chave</option>
          <option value="osm" ${m.provider === 'osm' ? 'selected' : ''}>Forçar OpenStreetMap (sem custo)</option>
        </select>
      </div>
      <h3 class="mt">Validade do cache (corta chamadas pagas)</h3>
      <div class="grid2">
        <div class="field"><label>Rotas (horas)</label>
          <input class="input" id="ch-route" type="number" min="0" max="8760" value="${m.cache_hours.route}"></div>
        <div class="field"><label>Endereços/Places (horas)</label>
          <input class="input" id="ch-places" type="number" min="0" max="8760" value="${m.cache_hours.places}"></div>
        <div class="field"><label>Geocodificação (horas)</label>
          <input class="input" id="ch-geo" type="number" min="0" max="8760" value="${m.cache_hours.geocode}"></div>
      </div>
      <button class="btn btn-primary" id="mp-save">Salvar configuração de mapas</button>
    </div>

    <div class="card">
      <h3>Passo 3 · Testar as APIs</h3>
      <p class="muted small mb">Faz uma chamada real a cada API, usando Assis Chateaubriand como referência.</p>
      <button class="btn btn-navy btn-sm" id="mp-test">Testar agora</button>
      <div id="mp-result" class="mt"></div>
    </div>

    <div class="card">
      <h3>Economia por cache</h3>
      <table class="tbl"><thead><tr><th>Tipo</th><th>Entradas</th><th>Chamadas evitadas</th></tr></thead>
        <tbody>${cacheRows}</tbody></table>
      <button class="btn btn-outline btn-sm mt" id="mp-clear">Limpar cache</button>
    </div>

    <div class="card">
      <h3>Rotas calculadas por procedência</h3>
      <table class="tbl"><thead><tr><th>Provedor</th><th>Modo</th><th>Corridas</th></tr></thead><tbody>
      ${m.usage.length ? m.usage.map(u => `<tr>
        <td data-l="Provedor">${escapeHtml(u.provider)}</td>
        <td data-l="Modo">${u.mode === 'two_wheeler' ? '🏍️ motocicleta'
      : u.mode === 'drive' ? '🚗 carro' : '📏 estimativa'}</td>
        <td data-l="Corridas">${u.qtd}</td></tr>`).join('')
      : '<tr><td class="muted center">Nenhuma corrida registrada ainda.</td></tr>'}
      </tbody></table>
    </div>`;

  $('#mp-save').onclick = () => withLoading($('#mp-save'), async () => {
    const credentials = {};
    $$('[data-mk]').forEach(i => { if (i.value.trim()) credentials[i.dataset.mk] = i.value.trim(); });
    await api('/api/admin/maps-config', {
      method: 'PUT',
      body: {
        credentials, provider: $('#mp-provider').value,
        cache_hours: {
          route: $('#ch-route').value, places: $('#ch-places').value, geocode: $('#ch-geo').value,
        },
      },
    });
    secMaps();
  }, { okMsg: 'Configuração de mapas salva.' }).catch(() => { });

  $('#mp-test').onclick = () => withLoading($('#mp-test'), async () => {
    const r = await api('/api/admin/maps-config/test', { method: 'POST' });
    $('#mp-result').innerHTML = r.checks.map(c => `
      <div class="list-item">
        <span style="font-size:1.2rem">${c.ok ? '✅' : '⚠️'}</span>
        <div class="li-main"><div class="li-title">${escapeHtml(c.item)}</div>
          <div class="li-sub">${escapeHtml(c.detail)}</div></div>
      </div>`).join('');
  });

  $('#mp-clear').onclick = () => withLoading($('#mp-clear'), async () => {
    const r = await api('/api/admin/maps-config/clear-cache', { method: 'POST' });
    toast(`${r.removed} entrada(s) removida(s).`, 'ok');
    secMaps();
  });
}

/* ============ configurações ============ */
async function secSettings() {
  const { settings: st, fares } = await api('/api/admin/settings');
  const fareRow = f => `
    <div class="card" data-fare="${f.category}">
      <h3>${f.label} ${f.category === 'prioridade' ? '⚡' : '🛵'}</h3>
      <div class="grid2">
        <div class="field"><label>Tarifa base (R$)</label>
          <input class="input" data-k="base" type="number" step="0.01" min="0" value="${(f.base_cents / 100).toFixed(2)}"></div>
        <div class="field"><label>Km inclusos na base</label>
          <input class="input" data-k="included" type="number" step="0.1" min="0" value="${(f.included_m / 1000).toFixed(1)}"></div>
        <div class="field"><label>R$ por km adicional</label>
          <input class="input" data-k="perkm" type="number" step="0.01" min="0" value="${(f.per_km_cents / 100).toFixed(2)}"></div>
      </div>
    </div>`;

  main().innerHTML = `
    <h2 class="mb">⚙️ Configurações</h2>
    <div class="card">
      <h3>Plataforma</h3>
      <div class="grid2">
        <div class="field"><label>Cidade atendida</label><input class="input" id="st-city" value="${escapeHtml(st.city_name)}"></div>
        <div class="field"><label>Comissão da plataforma (%)</label><input class="input" id="st-comm" type="number" min="0" max="50" step="0.5" value="${st.commission_pct}"></div>
        <div class="field"><label>Centro — latitude</label><input class="input" id="st-lat" value="${st.center_lat}"></div>
        <div class="field"><label>Centro — longitude</label><input class="input" id="st-lng" value="${st.center_lng}"></div>
        <div class="field"><label>Raio de cobertura (km)</label><input class="input" id="st-radius" type="number" min="1" value="${st.coverage_radius_km}"></div>
        <div class="field"><label>Raio de despacho (km)</label><input class="input" id="st-dispatch" type="number" min="1" value="${st.dispatch_radius_km}"></div>
        <div class="field"><label>Validade da cotação (min)</label><input class="input" id="st-ttl" type="number" min="1" value="${st.quote_ttl_min}"></div>
        <div class="field"><label>Prazo de análise de cadastro (h)</label><input class="input" id="st-sla" type="number" min="1" value="${st.review_sla_hours}"></div>
        <div class="field"><label>Confirmação do passageiro (s)</label><input class="input" id="st-confirm" type="number" min="1" max="120" value="${st.confirm_window_s}"></div>
        <div class="field"><label>Limite de dívida do mototaxista (R$)</label><input class="input" id="st-debt" type="number" min="0" step="0.01" value="${(Number(st.driver_debt_limit_cents) / 100).toFixed(2)}"></div>
        <div class="field"><label>GPS: precisão máxima aceita (m)</label><input class="input" id="st-acc" type="number" min="10" value="${st.gps_max_accuracy_m}"></div>
        <div class="field"><label>Localização considerada recente (s)</label><input class="input" id="st-fresh" type="number" min="30" value="${st.loc_fresh_s}"></div>
      </div>
      <div class="field"><label>Mensagem de boas-vindas</label><input class="input" id="st-welcome" value="${escapeHtml(st.welcome_message)}"></div>
      <p class="muted small">Alterações de tarifa e comissão valem apenas para corridas novas — o histórico financeiro é preservado.</p>
    </div>
    ${fares.map(fareRow).join('')}
    <button class="btn btn-primary" id="st-save" style="max-width:340px">Salvar configurações</button>

    <div class="card mt">
      <h3>🧮 Calculadora de corrida</h3>
      <div class="grid2">
        <div class="field"><label>Categoria</label>
          <select class="input" id="calc-cat">${fares.map(f => `<option value="${f.category}">${f.label}</option>`).join('')}</select></div>
        <div class="field"><label>Distância (km)</label><input class="input" id="calc-km" type="number" step="0.1" min="0" value="5"></div>
      </div>
      <button class="btn btn-navy btn-sm" id="calc-run">Calcular</button>
      <p class="mt" id="calc-out"></p>
    </div>`;

  $('#st-save').onclick = () => withLoading($('#st-save'), async () => {
    const faresBody = $$('[data-fare]').map(card => ({
      category: card.dataset.fare,
      base_cents: Math.round(parseFloat($('[data-k=base]', card).value) * 100),
      included_m: Math.round(parseFloat($('[data-k=included]', card).value) * 1000),
      per_km_cents: Math.round(parseFloat($('[data-k=perkm]', card).value) * 100),
    }));
    await api('/api/admin/settings', {
      method: 'PUT',
      body: {
        settings: {
          city_name: $('#st-city').value, commission_pct: $('#st-comm').value,
          center_lat: $('#st-lat').value, center_lng: $('#st-lng').value,
          coverage_radius_km: $('#st-radius').value, dispatch_radius_km: $('#st-dispatch').value,
          quote_ttl_min: $('#st-ttl').value, review_sla_hours: $('#st-sla').value,
          confirm_window_s: $('#st-confirm').value,
          driver_debt_limit_cents: String(Math.round(parseFloat($('#st-debt').value) * 100)),
          gps_max_accuracy_m: $('#st-acc').value, loc_fresh_s: $('#st-fresh').value,
          welcome_message: $('#st-welcome').value,
        },
        fares: faresBody,
      },
    });
  }, { okMsg: 'Configurações salvas e registradas na auditoria.' }).catch(() => { });

  $('#calc-run').onclick = () => withLoading($('#calc-run'), async () => {
    const r = await api('/api/admin/calc', {
      method: 'POST',
      body: { category: $('#calc-cat').value, distance_km: parseFloat($('#calc-km').value) },
    });
    $('#calc-out').innerHTML =
      `Passageiro paga: <b>${fmt.money(r.price_cents)}</b> ·
       Plataforma (${r.commission_pct}%): <b>${fmt.money(r.commission_cents)}</b> ·
       Mototaxista recebe: <b style="color:var(--green)">${fmt.money(r.driver_cents)}</b>`;
  });
}

/* ============ auditoria ============ */
async function secAudit() {
  const { logs } = await api('/api/admin/audit');
  main().innerHTML = `
    <h2 class="mb">📜 Auditoria</h2>
    <div class="card">
      <table class="tbl"><thead><tr><th>Quando</th><th>Admin</th><th>Ação</th><th>Alvo</th><th>Detalhes</th></tr></thead><tbody>
      ${logs.map(l => `<tr>
        <td data-l="Quando" class="small">${fmt.dt(l.created_at)}</td>
        <td data-l="Admin" class="small">${escapeHtml(l.admin_name || l.admin_id)}</td>
        <td data-l="Ação"><b class="small">${escapeHtml(l.action)}</b></td>
        <td data-l="Alvo" class="small">${escapeHtml(l.target_type || '')} ${escapeHtml((l.target_id || '').slice(-6))}</td>
        <td data-l="Detalhes" class="small">${escapeHtml(l.details || '')}</td>
      </tr>`).join('') || '<tr><td class="muted center">Nenhum registro.</td></tr>'}
      </tbody></table>
    </div>`;
}

/* ============ suporte ============ */
async function secSupport() {
  const { messages } = await api('/api/admin/support');
  main().innerHTML = `
    <h2 class="mb">🛟 Suporte</h2>
    <div class="card">
      ${messages.map(msg => `
        <div class="list-item">
          <div class="li-main">
            <div class="li-title">${escapeHtml(msg.subject)}
              <span class="pill ${msg.status === 'aberto' ? 'yellow' : 'green'}">${msg.status}</span></div>
            <div class="li-sub">${escapeHtml(msg.user_name)} (${msg.user_role}) · ${fmt.dt(msg.created_at)}<br>${escapeHtml(msg.body)}</div>
          </div>
          <button class="btn btn-outline btn-sm" data-reply="${msg.id}">Responder</button>
        </div>`).join('') || '<div class="empty"><div class="eico">🛟</div>Nenhuma mensagem de suporte.</div>'}
    </div>`;
  $$('[data-reply]').forEach(b => b.onclick = async () => {
    const body = await askText('Responder ao usuário', 'Sua resposta', { multiline: true });
    if (!body) return;
    await withLoading(b, async () => {
      await api(`/api/admin/support/${b.dataset.reply}/reply`, { method: 'POST', body: { body } });
      secSupport();
    }, { okMsg: 'Resposta enviada.' }).catch(() => { });
  });
}
