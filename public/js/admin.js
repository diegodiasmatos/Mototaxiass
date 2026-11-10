/* Assis MotoTáxi — central administrativa */
'use strict';

const S = { user: null, section: 'dashboard' };
const main = () => $('#admin-main');

init();

async function init() {
  renderBrand($('#brand'), 'Central Administrativa');
  $('#auth-hero').innerHTML = `${LOGO_SVG}<h1>Central Administrativa</h1><p>Assis MotoTáxi</p>`;

  $('#form-login').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
      if (r.user.role !== 'admin') { toast('Esta conta não é de administrador.', 'err'); return; }
      S.user = r.user;
      enter();
    } catch (err) { toast(err.message, 'err'); }
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
  $('#btn-logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => { }); location.reload(); };

  $$('.sidebar button').forEach(b => b.onclick = () => {
    $$('.sidebar button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    go(b.dataset.sec);
  });

  connectSSE({
    notification: n => { toast(n.title); browserNotify(n.title, n.body || ''); if (S.section === 'dashboard') secDashboard(); },
  });
  go('dashboard');
}

function go(sec) {
  S.section = sec;
  main().innerHTML = '<div class="spinner"></div>';
  ({ dashboard: secDashboard, drivers: secDrivers, passengers: secPassengers,
     rides: secRides, settings: secSettings, audit: secAudit, support: secSupport }[sec])().catch(e => {
    main().innerHTML = `<div class="empty"><div class="eico">⚠️</div>${escapeHtml(e.message)}</div>`;
  });
}

/* ============ dashboard ============ */
async function secDashboard() {
  const { totals: t, series } = await api('/api/admin/dashboard');
  const stat = (v, l) => `<div class="stat"><div class="sv">${v}</div><div class="sl">${l}</div></div>`;
  const days = Object.entries(series);
  const maxRides = Math.max(1, ...days.map(([, d]) => d.rides));
  const maxGross = Math.max(1, ...days.map(([, d]) => d.gross));
  const bars = (key, max, money) => days.map(([k, d]) => `
    <div class="bar" title="${k}: ${money ? fmt.money(d[key]) : d[key]}">
      <i style="height:${Math.round(d[key] / max * 100)}%"></i><b>${k.slice(8)}</b>
    </div>`).join('');

  main().innerHTML = `
    <h2 class="mb">📊 Visão geral</h2>
    <div class="stat-grid">
      ${stat(t.passengers, 'Passageiros')}
      ${stat(t.drivers, 'Mototaxistas cadastrados')}
      ${stat(t.drivers_approved, 'Aprovados')}
      ${stat(`<span style="color:${t.drivers_pending ? 'var(--red)' : 'inherit'}">${t.drivers_pending}</span>`, 'Aguardando análise')}
      ${stat(t.drivers_available, 'Disponíveis agora')}
      ${stat(t.drivers_on_ride, 'Em corrida')}
      ${stat(t.rides_today, 'Corridas hoje')}
      ${stat(t.rides_active, 'Corridas ativas')}
      ${stat(t.rides_completed, 'Concluídas (total)')}
      ${stat(t.rides_cancelled, 'Canceladas (total)')}
      ${stat(fmt.money(t.gross_cents), 'Faturamento bruto')}
      ${stat(fmt.money(t.commission_cents), 'Comissões da plataforma')}
      ${stat(fmt.money(t.drivers_cents), 'Repasse aos parceiros')}
    </div>
    <div class="card"><h3>Corridas por dia (últimos 14 dias)</h3><div class="bars">${bars('rides', maxRides, false)}</div></div>
    <div class="card"><h3>Faturamento por dia</h3><div class="bars">${bars('gross', maxGross, true)}</div></div>`;
}

/* ============ mototaxistas ============ */
const DRV_STATUS_PT = { pending: 'Pendente', approved: 'Aprovado', rejected: 'Reprovado', correction: 'Correção' };
const DRV_PILL = { pending: 'yellow', approved: 'green', rejected: 'red', correction: 'blue' };

async function secDrivers(filter = '') {
  const { drivers } = await api(`/api/admin/drivers${filter ? `?status=${filter}` : ''}`);
  main().innerHTML = `
    <h2 class="mb">🏍️ Mototaxistas</h2>
    <div class="seg mb" id="drv-filter" style="max-width:520px">
      ${['', 'pending', 'approved', 'correction', 'rejected'].map(s =>
        `<button data-f="${s}" class="${s === filter ? 'active' : ''}">${s ? DRV_STATUS_PT[s] : 'Todos'}</button>`).join('')}
    </div>
    <div class="card" style="overflow-x:auto">
      <table class="tbl"><thead><tr>
        <th>Nome</th><th>Moto</th><th>Status</th><th>Avaliação</th><th>Online</th><th></th>
      </tr></thead><tbody>
      ${drivers.map(d => `<tr>
        <td><b>${escapeHtml(d.name)}</b><br><span class="muted small">${escapeHtml(d.email)}</span></td>
        <td>${escapeHtml([d.moto_brand, d.moto_model].filter(Boolean).join(' '))}<br><span class="plate small">${escapeHtml(d.moto_plate || '—')}</span></td>
        <td><span class="pill ${DRV_PILL[d.status]}">${DRV_STATUS_PT[d.status]}</span>${d.blocked ? ' <span class="pill red">bloqueado</span>' : ''}</td>
        <td>${d.rating ? `★ ${d.rating}` : '—'} <span class="muted small">(${d.rides_count})</span></td>
        <td>${d.online ? '🟢' : '⚪'}</td>
        <td><button class="btn btn-outline btn-sm" data-open="${d.user_id}">Analisar</button></td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted center">Nenhum cadastro.</td></tr>'}
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
      <div class="row">
        <button class="btn btn-green" data-act="approve">Aprovar ✓</button>
        <button class="btn btn-outline" data-act="correction">Pedir correção</button>
        <button class="btn btn-danger" data-act="reject">Reprovar</button>
      </div>` : `
      <div class="row mt">
        <button class="btn ${d.blocked ? 'btn-green' : 'btn-danger'}" data-block="${d.blocked ? 0 : 1}">
          ${d.blocked ? 'Desbloquear conta' : 'Bloquear conta'}</button>
      </div>`}
    <h3 class="mt">Últimas corridas</h3>
    ${rides.map(r => `<div class="list-item"><div class="li-main">
      <div class="li-title">${escapeHtml(r.origin_text)} → ${escapeHtml(r.dest_text)}</div>
      <div class="li-sub">${fmt.dt(r.requested_at)} · ${fmt.money(r.price_cents)} · ${STATUS_PT[r.status]}</div>
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
    if (!await confirmModal(`${action === 'approve' ? 'Aprovar' : action === 'reject' ? 'Reprovar' : 'Pedir correção de'} ${d.name}?`,
      action === 'approve' ? 'O parceiro poderá ficar online e receber corridas imediatamente.' : `Motivo: ${reason}`,
      'Confirmar', action === 'reject')) return;
    try {
      await api(`/api/admin/drivers/${idd}/review`, { method: 'POST', body: { action, reason } });
      toast('Decisão registrada e parceiro notificado.', 'ok');
      m.close(); secDrivers();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('[data-block]', m) && ($('[data-block]', m).onclick = async () => {
    const block = $('[data-block]', m).dataset.block === '1';
    const reason = block ? prompt('Motivo do bloqueio:') : '';
    if (block && !reason) return;
    try {
      await api(`/api/admin/users/${idd}/block`, { method: 'POST', body: { blocked: block, reason } });
      toast(block ? 'Conta bloqueada.' : 'Conta desbloqueada.', 'ok');
      m.close(); secDrivers();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ============ passageiros ============ */
async function secPassengers() {
  const { passengers } = await api('/api/admin/passengers');
  main().innerHTML = `
    <h2 class="mb">👥 Passageiros</h2>
    <div class="card" style="overflow-x:auto">
      <table class="tbl"><thead><tr>
        <th>Nome</th><th>Contato</th><th>Corridas</th><th>Cancel.</th><th>Desde</th><th></th>
      </tr></thead><tbody>
      ${passengers.map(p => `<tr>
        <td><b>${escapeHtml(p.name)}</b>${p.blocked ? ' <span class="pill red">bloqueado</span>' : ''}</td>
        <td class="small">${escapeHtml(p.email)}<br>${escapeHtml(p.phone || '')}</td>
        <td>${p.rides_count}</td><td>${p.cancels_count}</td>
        <td class="small">${fmt.date(p.created_at)}</td>
        <td><button class="btn ${p.blocked ? 'btn-green' : 'btn-danger'} btn-sm" data-block="${p.id}" data-to="${p.blocked ? 0 : 1}">
          ${p.blocked ? 'Desbloquear' : 'Bloquear'}</button></td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted center">Nenhum passageiro.</td></tr>'}
      </tbody></table>
    </div>`;
  $$('[data-block]').forEach(b => b.onclick = async () => {
    const block = b.dataset.to === '1';
    const reason = block ? prompt('Motivo do bloqueio:') : '';
    if (block && !reason) return;
    try {
      await api(`/api/admin/users/${b.dataset.block}/block`, { method: 'POST', body: { blocked: block, reason } });
      toast('Atualizado.', 'ok'); secPassengers();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ============ corridas ============ */
async function secRides(filter = '') {
  const { rides } = await api(`/api/admin/rides${filter ? `?status=${filter}` : ''}`);
  main().innerHTML = `
    <h2 class="mb">🛣️ Corridas</h2>
    <div class="seg mb" id="ride-filter" style="max-width:620px">
      ${['', 'requested', 'accepted', 'in_progress', 'completed', 'cancelled'].map(s =>
        `<button data-f="${s}" class="${s === filter ? 'active' : ''}">${s ? STATUS_PT[s] : 'Todas'}</button>`).join('')}
    </div>
    <div class="card" style="overflow-x:auto">
      <table class="tbl"><thead><tr>
        <th>Quando</th><th>Trajeto</th><th>Passageiro</th><th>Mototaxista</th><th>Valor</th><th>Comissão</th><th>Status</th><th></th>
      </tr></thead><tbody>
      ${rides.map(r => `<tr>
        <td class="small">${fmt.dt(r.requested_at)}</td>
        <td class="small">${escapeHtml(r.origin_text)}<br>→ ${escapeHtml(r.dest_text)}<br>
          <span class="muted">${fmt.dist(r.distance_m)} · ${r.category}</span></td>
        <td class="small">${escapeHtml(r.passenger_name)}</td>
        <td class="small">${escapeHtml(r.driver_name || '—')}</td>
        <td><b>${fmt.money(r.price_cents)}</b></td>
        <td class="small">${r.commission_cents != null ? fmt.money(r.commission_cents) : '—'}</td>
        <td><span class="pill ${STATUS_PILL[r.status]}">${STATUS_PT[r.status]}</span></td>
        <td><button class="btn btn-outline btn-sm" data-ride="${r.id}">Detalhes</button></td>
      </tr>`).join('') || '<tr><td colspan="8" class="muted center">Nenhuma corrida.</td></tr>'}
      </tbody></table>
    </div>`;
  $$('#ride-filter button').forEach(b => b.onclick = () => secRides(b.dataset.f));
  $$('[data-ride]').forEach(b => b.onclick = () => openRide(b.dataset.ride));
}

async function openRide(idd) {
  const { ride: r, events, payment } = await api(`/api/admin/rides/${idd}`);
  openModal(`
    <h3>Corrida ${r.id.slice(-6)} <span class="pill ${STATUS_PILL[r.status]}">${STATUS_PT[r.status]}</span></h3>
    <p class="muted small">
      ${escapeHtml(r.origin_text)} → ${escapeHtml(r.dest_text)}<br>
      Passageiro: <b>${escapeHtml(r.passenger_name)}</b> · Mototaxista: <b>${escapeHtml(r.driver_name || '—')}</b><br>
      ${fmt.dist(r.distance_m)} · ${r.category} · ${PAY_PT[r.payment_method]} (${r.payment_status})<br>
      Valor: <b>${fmt.money(r.price_cents)}</b> · Comissão (${r.commission_pct}%):
      ${r.commission_cents != null ? fmt.money(r.commission_cents) : '—'} ·
      Parceiro: ${r.driver_cents != null ? fmt.money(r.driver_cents) : '—'}
      ${r.cancel_reason ? `<br>Cancelamento (${r.cancelled_by}): ${escapeHtml(r.cancel_reason)} — estado anterior: ${r.cancel_prev_status}` : ''}
    </p>
    <h3 class="mt">Linha do tempo</h3>
    ${events.map(e => `<div class="list-item"><div class="li-main">
      <div class="li-title">${escapeHtml(e.type)}</div>
      <div class="li-sub">${fmt.dt(e.at)} ${e.details ? `· ${escapeHtml(e.details)}` : ''}</div>
    </div></div>`).join('')}
  `);
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

  $('#st-save').onclick = async () => {
    try {
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
            welcome_message: $('#st-welcome').value,
          },
          fares: faresBody,
        },
      });
      toast('Configurações salvas e registradas na auditoria.', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  $('#calc-run').onclick = async () => {
    try {
      const r = await api('/api/admin/calc', {
        method: 'POST',
        body: { category: $('#calc-cat').value, distance_km: parseFloat($('#calc-km').value) },
      });
      $('#calc-out').innerHTML =
        `Passageiro paga: <b>${fmt.money(r.price_cents)}</b> ·
         Plataforma (${r.commission_pct}%): <b>${fmt.money(r.commission_cents)}</b> ·
         Mototaxista recebe: <b style="color:var(--green)">${fmt.money(r.driver_cents)}</b>`;
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ============ auditoria ============ */
async function secAudit() {
  const { logs } = await api('/api/admin/audit');
  main().innerHTML = `
    <h2 class="mb">📜 Auditoria</h2>
    <div class="card" style="overflow-x:auto">
      <table class="tbl"><thead><tr><th>Quando</th><th>Admin</th><th>Ação</th><th>Alvo</th><th>Detalhes</th></tr></thead><tbody>
      ${logs.map(l => `<tr>
        <td class="small">${fmt.dt(l.created_at)}</td>
        <td class="small">${escapeHtml(l.admin_name || l.admin_id)}</td>
        <td><b class="small">${escapeHtml(l.action)}</b></td>
        <td class="small">${escapeHtml(l.target_type || '')} ${escapeHtml((l.target_id || '').slice(-6))}</td>
        <td class="small">${escapeHtml(l.details || '')}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted center">Nenhum registro.</td></tr>'}
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
  $$('[data-reply]').forEach(b => b.onclick = () => {
    const m = openModal(`
      <h3>Responder</h3>
      <div class="field"><textarea class="input" id="rep-body" placeholder="Sua resposta…" maxlength="2000"></textarea></div>
      <button class="btn btn-primary" data-send>Enviar resposta</button>`);
    $('[data-send]', m).onclick = async () => {
      try {
        await api(`/api/admin/support/${b.dataset.reply}/reply`, { method: 'POST', body: { body: $('#rep-body', m).value } });
        toast('Resposta enviada.', 'ok'); m.close(); secSupport();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}
