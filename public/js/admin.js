/* VAIRO — central administrativa */
'use strict';

const S = { user: null, section: 'dashboard', testMode: false };
const main = () => $('#admin-main');

init();

async function init() {
  renderBrand($('#brand'), 'Central Administrativa');
  $('#auth-hero').innerHTML = `${LOGO_SVG}<h1>Central Administrativa</h1><p>VAIRO</p>`;

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
  audit: secAudit, support: secSupport, privacy: secPrivacy,
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
  if (on && S.testBlocked) {
    return `<div class="testbar">💵 SÓ DINHEIRO POR ENQUANTO — Pix e cartão ficam desligados no app publicado
      até o Mercado Pago ser configurado em 💳 Pagamentos.</div>`;
  }
  return on ? `<div class="testbar">🧪 PAGAMENTOS EM MODO DE TESTE — nenhum valor real é movimentado.
    Configure MP_ACCESS_TOKEN para operar de verdade.</div>` : '';
}

/* ============ dashboard ============ */
async function secDashboard() {
  const { totals: t, series } = await api('/api/admin/dashboard');
  S.testMode = t.test_mode;
  S.testBlocked = !!t.test_blocked;
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
    </p>
    ${driverChecklist(d)}
    <p class="muted small">
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
    <div class="row mt"><button class="btn btn-outline btn-sm" data-reset="${idd}">🔑 Link de nova senha</button></div>
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

  const rb = $('[data-reset]', m);
  if (rb) rb.onclick = () => resetLink(rb, idd);
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

/**
 * Link de nova senha: uso único, vale 60 min. Mostrado uma vez para a
 * central enviar pelo WhatsApp do titular, depois de conferir a identidade.
 */
async function resetLink(btn, userId) {
  const ok = await confirmModal('Gerar link de nova senha?',
    'Confira antes que é mesmo o titular da conta pedindo (por exemplo, ligando para o telefone cadastrado). '
    + 'O link vale por 60 minutos e só pode ser usado uma vez.', 'Gerar link');
  if (!ok) return;
  await withLoading(btn, async () => {
    const r = await api(`/api/admin/users/${userId}/reset-link`, { method: 'POST' });
    const phone = String(r.phone || '').replace(/\D/g, '');
    const wa = phone ? `https://wa.me/55${phone.replace(/^55/, '')}?text=${encodeURIComponent(
      `Olá, ${r.name.split(' ')[0]}! Para criar uma nova senha na VAIRO, abra este link (vale por 60 minutos): ${r.url}`)}` : '';
    const m = openModal(`
      <h3>Link de nova senha</h3>
      <p class="muted small mb">Para ${escapeHtml(r.name)} · vale até ${fmt.time(r.expires_at)} · uso único.
        Ele não aparece de novo depois de fechar esta janela.</p>
      <div class="pix-code" style="word-break:break-all">${escapeHtml(r.url)}</div>
      <button class="btn btn-outline btn-sm mt" data-copy>📋 Copiar link</button>
      ${wa ? `<a class="btn btn-green btn-sm mt" href="${wa}" target="_blank" rel="noopener">Enviar pelo WhatsApp</a>` : ''}`);
    m.querySelector('[data-copy]').onclick = async () => {
      try { await navigator.clipboard.writeText(r.url); toast('Link copiado.', 'ok'); }
      catch { toast('Copie o link manualmente.', 'err'); }
    };
  }).catch(() => { });
}

/** Conferência dos requisitos do condutor (o que ele informou x o que a foto da CNH mostra). */
function driverChecklist(d) {
  const years = iso => {
    if (!iso) return null;
    const b = new Date(iso + 'T00:00:00'), t = new Date();
    let y = t.getFullYear() - b.getFullYear();
    if (t < new Date(t.getFullYear(), b.getMonth(), b.getDate())) y--;
    return y;
  };
  const age = years(d.birth_date), cnhYears = years(d.cnh_first_date);
  const expired = d.cnh_expiry && new Date(d.cnh_expiry + 'T23:59:59') < new Date();
  const item = (ok, text) => `<li>${ok === null ? '❔' : ok ? '✅' : '❌'} ${text}</li>`;
  return `<div class="card" style="margin:10px 0">
    <b>Requisitos informados</b> <span class="muted small">— confira com a foto da CNH antes de aprovar</span>
    <ul class="small" style="list-style:none;padding:0;margin:8px 0 0;line-height:1.8">
      ${item(age === null ? null : age >= 21, `Idade: ${age ?? 'não informada'}${age !== null ? ' anos' : ''}`)}
      ${item(d.cnh_expiry ? !expired : null, `CNH válida até ${d.cnh_expiry ? escapeHtml(d.cnh_expiry.split('-').reverse().join('/')) : 'não informado'}`)}
      ${item(cnhYears === null ? null : cnhYears >= 2, `Habilitado há ${cnhYears ?? '?'} anos`)}
      ${item(d.decl_cat_a_ear == null ? null : !!d.decl_cat_a_ear, 'Declarou categoria A com EAR')}
      ${item(d.decl_course == null ? null : !!d.decl_course, 'Declarou ter o curso de mototaxista')}
    </ul></div>`;
}

/* ============ importação de planilha de locais ============ */

/** Lê CSV (; ou ,, com aspas) e devolve linhas como objetos pelo cabeçalho. */
function parseCsv(text) {
  text = text.replace(/^\ufeff/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x.trim())) rows.push(row);
  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
  const head = (rows.shift() || []).map(norm);
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** Converte uma linha da planilha no formato do servidor. */
function csvRowToPlace(o) {
  const pick = (...k) => { for (const x of k) if (o[x]) return o[x]; return ''; };
  const num = v => Number(String(v).replace(',', '.'));
  const street = pick('logradouro', 'endereco', 'rua');
  const number = pick('numero', 'n', 'num');
  const district = pick('bairro');
  const detail = pick('detail', 'detalhe') || [street && number ? `${street}, ${number}` : street, district]
    .filter(Boolean).join(' – ');
  return {
    name: pick('nome', 'name', 'nome_do_local'),
    tags: [pick('categoria', 'tipo_de_estabelecimento'), pick('palavras_chave', 'tags')].filter(Boolean).join(' ') || null,
    detail: detail || null,
    lat: num(pick('latitude', 'lat')), lng: num(pick('longitude', 'lng', 'lon')),
  };
}

async function importPlacesFile(file) {
  const box = $('#imp-preview');
  if (!file) return;
  let rows;
  try { rows = parseCsv(await file.text()).map(csvRowToPlace); }
  catch { box.innerHTML = '<p class="err-text">Não consegui ler o arquivo. Salve a planilha como CSV.</p>'; return; }
  if (!rows.length) { box.innerHTML = '<p class="err-text">A planilha está vazia.</p>'; return; }
  box.innerHTML = '<div class="spinner"></div>';
  const ST = {
    novo: ['green', 'novo'], ja_existe: ['gray', 'já existe'], possivel_duplicata: ['yellow', 'possível duplicata'],
    repetido_na_planilha: ['yellow', 'repetido na planilha'], fora_da_area: ['red', 'fora da área'], invalido: ['red', 'inválido'],
  };
  const render = (r, done) => {
    const s = r.summary;
    box.innerHTML = `
      <p><b>${done ? 'Importação concluída' : 'Prévia (nada foi gravado ainda)'}</b> — ${s.total} linha(s):
        <span class="pill green">${s.novos} ${done ? 'cadastrado(s)' : 'novo(s)'}</span>
        <span class="pill gray">${s.ja_existem} já existem</span>
        <span class="pill yellow">${s.possiveis_duplicatas + s.repetidos_na_planilha} possíveis duplicatas</span>
        <span class="pill red">${s.fora_da_area + s.invalidos} fora da área / inválidos</span></p>
      <div style="max-height:320px;overflow:auto">
        <table class="tbl"><thead><tr><th>Linha</th><th>Nome</th><th>Situação</th><th>Detalhe</th></tr></thead><tbody>
        ${r.results.map(x => `<tr><td>${x.line}</td><td>${escapeHtml(x.name)}</td>
          <td><span class="pill ${ST[x.status][0]}">${ST[x.status][1]}</span></td><td class="small">${escapeHtml(x.message)}</td></tr>`).join('')}
        </tbody></table></div>
      ${!done && s.novos ? `<button class="btn btn-primary mt" id="imp-go">Cadastrar os ${s.novos} novo(s)</button>` : ''}
      ${done ? '<button class="btn btn-outline btn-sm mt" id="imp-refresh">Atualizar a lista</button>' : ''}`;
    const go = $('#imp-go');
    if (go) go.onclick = () => withLoading(go, async () => {
      const r2 = await api('/api/admin/places/import', { method: 'POST', body: { rows, dry_run: false, source: file.name } });
      render(r2, true);
    }, { okMsg: 'Locais cadastrados. Já aparecem na busca dos passageiros.' }).catch(() => { });
    const rf = $('#imp-refresh');
    if (rf) rf.onclick = () => secMaps();
  };
  try {
    render(await api('/api/admin/places/import', { method: 'POST', body: { rows, dry_run: true } }), false);
  } catch (e) { box.innerHTML = `<p class="err-text">${escapeHtml(e.message)}</p>`; }
}

/* ============ privacidade (LGPD) ============ */
async function secPrivacy() {
  const [{ requests }, { backups }] = await Promise.all([
    api('/api/admin/deletion-requests'), api('/api/admin/backups')]);
  const ST = { pendente: 'yellow', concluido: 'green', cancelado: 'gray' };
  main().innerHTML = `
    <h2 class="mb">🔒 Privacidade (LGPD)</h2>
    <div class="card">
      <h3>Pedidos de exclusão de conta</h3>
      <p class="muted small mb">A anonimização apaga nome, e-mail, telefone, CPF, foto, documentos, mensagens,
        GPS e endereços. Corridas, pagamentos e livro-caixa ficam guardados sem identificar a pessoa.
        Antes, confira se não há valores a pagar ou receber. <b>Não pode ser desfeita.</b></p>
      ${requests.length ? requests.map(r => `
        <div class="list-item"><div class="li-main">
          <div class="li-title">${escapeHtml(r.user_name)} · ${r.user_role === 'driver' ? 'motorista' : 'passageiro'}
            <span class="pill ${ST[r.status]}">${r.status}</span>
            ${r.active_ride ? '<span class="pill red">corrida em andamento</span>' : ''}</div>
          <div class="li-sub">Pedido em ${fmt.dt(r.created_at)} · ${escapeHtml(r.user_email)} · ${escapeHtml(r.user_phone || '')}
            ${r.reason ? `<br>Motivo: ${escapeHtml(r.reason)}` : ''}</div></div>
          ${r.status === 'pendente' ? `<button class="btn btn-danger btn-sm" data-anon="${r.user_id}" ${r.active_ride ? 'disabled' : ''}>Anonimizar</button>` : ''}
        </div>`).join('') : '<div class="empty"><div class="eico">✅</div>Nenhum pedido de exclusão.</div>'}
    </div>
    <div class="card">
      <h3>💾 Cópias do banco</h3>
      <p class="muted small mb">Uma cópia por dia, no mesmo disco do servidor. <b>Baixe uma regularmente e guarde em
        outro lugar seguro</b> (ela contém dados pessoais): se o disco do servidor se perder, as cópias daqui vão junto.
        Cada download fica na auditoria.</p>
      ${backups.length ? backups.map(b => `<div class="list-item"><div class="li-main">
          <div class="li-title">${fmt.dt(b.at)}</div><div class="li-sub">${(b.size / 1048576).toFixed(1)} MB</div></div>
          <a class="btn btn-outline btn-sm" href="/api/admin/backups/${encodeURIComponent(b.name)}" download>Baixar</a></div>`).join('')
        : '<p class="muted small">Nenhuma cópia ainda (a primeira é feita 1 minuto depois de o servidor ligar).</p>'}
      <button class="btn btn-navy btn-sm mt" id="bk-now">Fazer uma cópia agora</button>
    </div>`;
  $('#bk-now').onclick = () => withLoading($('#bk-now'), async () => {
    await api('/api/admin/backups', { method: 'POST' });
    secPrivacy();
  }, { okMsg: 'Cópia feita.' }).catch(() => { });
  $$('[data-anon]').forEach(b => b.onclick = async () => {
    const word = await askText('Anonimizar conta (LGPD)', 'Esta ação NÃO pode ser desfeita. Digite ANONIMIZAR para confirmar');
    if (!word) return;
    if (word.trim() !== 'ANONIMIZAR') { toast('Confirmação incorreta. Nada foi alterado.', 'err'); return; }
    await withLoading(b, async () => {
      await api(`/api/admin/users/${b.dataset.anon}/anonymize`, { method: 'POST', body: { confirm: 'ANONIMIZAR' } });
      secPrivacy();
    }, { okMsg: 'Conta anonimizada e registrada na auditoria.' }).catch(() => { });
  });
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
          ${p.blocked ? 'Desbloquear' : 'Bloquear'}</button>
          <button class="btn btn-outline btn-sm" data-reset="${p.id}">🔑 Nova senha</button></td>
      </tr>`).join('') || '<tr><td class="muted center">Nenhum passageiro.</td></tr>'}
      </tbody></table>
    </div>`;
  $$('[data-reset]').forEach(b => b.onclick = () => resetLink(b, b.dataset.reset));
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

    ${r.status === 'accepted' ? `<div class="card mt">
      <b>Embarque</b> <span class="muted small">${r.arrived_at ? `mototaxista chegou às ${fmt.time(r.arrived_at)}` : 'mototaxista ainda a caminho'}</span>
      <p class="muted small">Use só se o passageiro não conseguir mostrar o código (sem bateria, sem internet),
        depois de falar com ele. Fica registrado quem confirmou e o motivo.</p>
      <button class="btn btn-outline btn-sm" data-board ${r.arrived_at ? '' : 'disabled'}>Confirmar embarque pela central</button>
    </div>` : ''}

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
  const board = $('[data-board]', m);
  if (board) board.onclick = async () => {
    const reason = await askText('Confirmar embarque pela central', 'Motivo (ex.: passageiro sem bateria, confirmado por ligação)');
    if (!reason) return;
    await withLoading(board, async () => {
      await api(`/api/admin/rides/${idd}/confirm-boarding`, { method: 'POST', body: { reason } });
      m.close(); openRide(idd);
    }, { okMsg: 'Embarque confirmado e registrado na auditoria.' }).catch(() => { });
  };
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
            <div class="li-title">${escapeHtml(i.kind === 'nao_embarquei' ? 'Não embarquei (contestação)' : i.kind)}
              <span class="pill ${i.status === 'aberta' ? 'red' : i.status === 'resolvida' ? 'green' : 'yellow'}">${i.status}</span>
              <span class="pill gray">${STATUS_PT[i.ride_status] || i.ride_status}</span></div>
            <div class="li-sub">
              ${escapeHtml(i.user_name)} · ${fmt.dt(i.created_at)}<br>
              ${escapeHtml(i.origin_text)} → ${escapeHtml(i.dest_text)} · ${fmt.money(i.price_cents)}
              · mototaxista: ${escapeHtml(i.driver_name || '—')}<br>
              ${i.boarding_confirmed_at ? `Embarque confirmado ${i.boarding_method === 'codigo' ? 'com o código do passageiro' : i.boarding_method === 'central' ? 'pela central' : ''}
                em ${fmt.dt(i.boarding_confirmed_at)} por ${escapeHtml(i.boarding_confirmed_by_name || '—')}
                ${i.boarding_dist_m != null ? `· mototaxista a ${i.boarding_dist_m} m do ponto de embarque` : '· sem GPS do mototaxista'}<br>` : ''}
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
        <li>Clique em <b>Criar aplicação</b> → nome "VAIRO" → produto <b>Pagamentos online</b> → modelo <b>Marketplace</b>.</li>
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
        : '<div class="testbar ok mt">✅ Operando com dinheiro real.</div>');
  });
}

/* ============ mapas (Mapbox) ============ */
async function secMaps() {
  const m = await api('/api/admin/maps-config');
  const { places, hidden = [] } = await api('/api/admin/places');
  const cred = (k, label, help) => {
    const v = m.credentials[k];
    const origem = v.source === 'banco' ? '<span class="pill green">salva aqui</span>'
      : v.source === 'ambiente' ? '<span class="pill blue">vem do .env</span>'
        : '<span class="pill gray">não configurada</span>';
    const remover = v.source === 'banco'
      ? ` <button class="btn btn-outline btn-sm" data-mk-clear="${k}" type="button"
            style="padding:2px 8px;font-size:.75rem">Remover</button>` : '';
    return `<div class="field">
      <label>${label} ${origem}${remover}</label>
      <input class="input" data-mk="${k}" type="password" autocomplete="off"
        placeholder="${v.filled ? escapeHtml(v.value) : 'cole aqui'}">
      <p class="muted small" style="margin-top:4px">${help}</p>
    </div>`;
  };
  const cacheRows = m.cache.length
    ? m.cache.map(c => `<tr>
        <td data-l="Tipo">${c.kind === 'rota_mapbox' ? 'Rotas (Mapbox)'
        : c.kind === 'rota_google' ? 'Rotas (Google)' : escapeHtml(c.kind)}</td>
        <td data-l="Entradas">${c.entradas}</td>
        <td data-l="Chamadas evitadas"><b style="color:var(--green)">${c.acertos}</b></td>
      </tr>`).join('')
    : '<tr><td class="muted center">Nada em cache ainda.</td></tr>';

  const NOMES = { google: 'Google Maps', mapbox: 'Mapbox', osrm: 'OSRM', osm: 'OpenStreetMap' };
  const pago = p => p === 'google' || p === 'mapbox';
  main().innerHTML = `
    <h2 class="mb">🗺️ Mapas</h2>
    <div class="fin-grid mb">
      <div class="fin-card ${pago(m.active_routing) ? 'in' : 'warn'}">
        <div class="fv">${NOMES[m.active_routing]}</div>
        <div class="fl">Rotas, busca e endereços (backend)</div></div>
      <div class="fin-card ${pago(m.active_visual) ? 'in' : 'warn'}">
        <div class="fv">${NOMES[m.active_visual]}</div>
        <div class="fl">Mapa visual (aplicativos)</div></div>
    </div>
    ${!pago(m.active_routing) ? `<div class="testbar">
      🗺️ ${m.provider === 'osm' && (m.has_server_token || m.has_google_key)
      ? 'OpenStreetMap forçado: as chaves salvas não são usadas.'
      : 'Sem chave do Google nem token do Mapbox: o sistema usa OpenStreetMap/OSRM — mapa real e gratuito.'}
      Baixe a base local de endereços abaixo para a busca ficar completa e instantânea.</div>` : ''}
    ${m.active_routing === 'google' ? `<div class="testbar ok">
      🔎 Busca por nome ligada: passageiros encontram lojas e locais do Google Maps
      dentro da área atendida, além das ruas da base local.</div>` : ''}

    <div class="card">
      <h3>📍 Base local de endereços <span class="pill ${m.address_base.total ? 'green' : 'gray'}">
        ${m.address_base.total ? m.address_base.total + ' endereços' : 'não baixada'}</span></h3>
      <p class="muted small mb">Baixa <b>todas as ruas, bairros e estabelecimentos</b> da cidade
        do OpenStreetMap e guarda no banco. A busca de endereços passa a ser instantânea e
        completa, <b>sem chave de API e sem custo</b>. Refaça de vez em quando (ex.: a cada
        6 meses) para pegar ruas novas.</p>
      ${m.address_base.total ? `<div class="fin-grid mb">
        <div class="fin-card in"><div class="fv">${m.address_base.ruas}</div><div class="fl">Ruas</div></div>
        <div class="fin-card in"><div class="fv">${m.address_base.bairros}</div><div class="fl">Bairros</div></div>
        <div class="fin-card in"><div class="fv">${m.address_base.locais}</div><div class="fl">Locais</div></div>
      </div>
      <p class="muted small mb">Última atualização: ${m.address_base.updated_at
      ? new Date(m.address_base.updated_at).toLocaleString('pt-BR') : '—'}</p>` : ''}
      <button class="btn btn-primary" id="mp-import-base">
        ${m.address_base.total ? 'Atualizar base de endereços' : 'Baixar base de endereços agora'}</button>
      <div id="mp-base-result" class="mt"></div>
    </div>

    <div class="card">
      <h3>🏠 Endereços oficiais do IBGE (CNEFE) <span class="pill ${m.address_base.ibge_updated_at ? 'green' : 'gray'}">
        ${m.address_base.numeros} números de casa</span></h3>
      <p class="muted small mb">O Cadastro Nacional de Endereços do IBGE (Censo 2022, dados abertos) tem
        <b>cada endereço da cidade, número por número, com coordenadas</b>. Importar faz "Rua X, 123" cair na casa
        certa e acrescenta as ruas e bairros que o OpenStreetMap não tem. Casas <b>não</b> viram locais com nome.
        Nada que já existe é sobrescrito, e "Atualizar base" (OpenStreetMap) não apaga o que veio do IBGE.</p>
      <ol class="muted small mb" style="padding-left:18px;line-height:1.7">
        <li>Baixe o arquivo do município no site do IBGE:
          <a href="https://ftp.ibge.gov.br/Cadastro_Nacional_de_Enderecos_para_Fins_Estatisticos/Censo_Demografico_2022/Arquivos_CNEFE/CSV/Municipio/41_PR/4102000_ASSIS_CHATEAUBRIAND.zip" target="_blank" rel="noopener">4102000_ASSIS_CHATEAUBRIAND.zip</a>
          e descompacte.</li>
        <li>Escolha o arquivo <b>.csv</b> abaixo. Primeiro aparece só a prévia.</li>
      </ol>
      <input type="file" id="cnefe-file" accept=".csv,text/csv" class="input">
      <div id="cnefe-result" class="mt"></div>
      ${m.address_base.ibge_updated_at ? `<p class="muted small mt">Última importação do IBGE: ${new Date(m.address_base.ibge_updated_at).toLocaleString('pt-BR')}</p>` : ''}
    </div>

    <div class="card">
      <h3>🏪 Estabelecimentos cadastrados à mão
        <span class="pill ${places.length ? 'green' : 'gray'}">${places.length}</span></h3>
      <p class="muted small mb">O OpenStreetMap não conhece todo comércio da cidade. Cadastre aqui
        o que faltar — <b>Mercado Lorena, Advocacia Fulano, Mecânica do João…</b> — e o local
        aparece na busca dos passageiros na mesma hora. Sobrevive às atualizações da base.</p>
      ${places.length ? places.map(p => `
        <div class="list-item">
          <span style="font-size:1.1rem">📌</span>
          <div class="li-main"><div class="li-title">${escapeHtml(p.name)}</div>
            <div class="li-sub">${escapeHtml(p.tags || '')}${p.detail ? ' · ' + escapeHtml(p.detail) : ''}</div></div>
          <button class="btn btn-outline btn-sm" data-pl-del="${p.id}">Remover</button>
        </div>`).join('') : ''}
      <h3 class="mt">Adicionar local</h3>
      <div class="field"><label>Nome do estabelecimento</label>
        <input class="input" id="pl-name" placeholder="ex.: Mercado Lorena"></div>
      <div class="field"><label>Palavras-chave (como as pessoas procuram)</label>
        <input class="input" id="pl-tags" placeholder="ex.: mercado supermercado mercadinho"></div>
      <div class="field"><label>Onde fica (endereço, ou cole coordenadas "lat, lng")</label>
        <input class="input" id="pl-ref" placeholder="ex.: Avenida Tupassi 450 — ou -24.4156, -53.5216"></div>
      <button class="btn btn-navy btn-sm" id="pl-locate">1 · Localizar no mapa</button>
      <div id="pl-options" class="mt"></div>
      <button class="btn btn-primary mt" id="pl-save" disabled>2 · Salvar local</button>
    </div>

    <div class="card">
      <h3>📥 Importar planilha de locais</h3>
      <p class="muted small mb">Arquivo CSV (separado por ; ou ,) com cabeçalho. Colunas reconhecidas:
        <b>nome</b>, <b>latitude</b>, <b>longitude</b> (obrigatórias) e, se houver, categoria, palavras_chave,
        logradouro, numero, bairro, fonte. Primeiro o sistema <b>só confere</b> e mostra o que aconteceria;
        nada é gravado até você confirmar. Locais que já existem ou parecem duplicados (nome parecido a menos de
        80 m) <b>não</b> são importados nem sobrescritos.</p>
      <input type="file" id="imp-file" accept=".csv,text/csv" class="input">
      <div id="imp-preview" class="mt"></div>
    </div>

    ${hidden.length ? `<div class="card">
      <h3>🙈 Ocultos da busca dos passageiros <span class="pill gray">${hidden.length}</span></h3>
      <p class="muted small mb">Registros do OpenStreetMap com nome vago (“Escola”, “Trilha”) ou com cara
        de casa particular (“Casa do Fulano”). Continuam na base, só não aparecem na busca. Se algum
        for um lugar real e útil, cadastre-o acima com o nome completo.</p>
      ${hidden.map(h => `<div class="list-item"><div class="li-main">
        <div class="li-title">${escapeHtml(h.name)}</div>
        <div class="li-sub">${escapeHtml(h.reason)}${h.detail ? ' · ' + escapeHtml(h.detail) : ''}</div></div></div>`).join('')}
    </div>` : ''}

    <div class="card">
      <h3>Google Maps · mapa, rotas de moto e busca de lojas pelo nome</h3>
      <ol class="muted small" style="padding-left:18px;line-height:1.9">
        <li>Entre em <a href="https://console.cloud.google.com/google/maps-apis" target="_blank" rel="noopener">console.cloud.google.com</a>,
          crie um projeto e <b>ative o faturamento</b> (o Google exige cartão; há franquia gratuita mensal —
          confira os limites e preços atuais na página de preços da Google Maps Platform).</li>
        <li>Em <b>APIs e serviços → Biblioteca</b>, ative: <b>Maps JavaScript API</b>, <b>Routes API</b>,
          <b>Places API (New)</b> e <b>Geocoding API</b>.</li>
        <li>Em <b>Credenciais</b>, crie uma chave de API. Para começar, uma chave só basta: cole-a em
          "Chave do navegador" abaixo.</li>
        <li>Recomendado antes de divulgar: restrinja essa chave ao endereço do seu site
          (<b>Sites</b> → <i>https://seudominio.com.br/*</i>) e crie uma <b>segunda chave</b>, sem restrição de site
          e limitada às APIs Routes, Places e Geocoding, para colar em "Chave de servidor".</li>
        <li>Defina um <b>limite de gastos/alerta de orçamento</b> no Google Cloud para não ter surpresa na fatura.</li>
      </ol>
      ${cred('GOOGLE_MAPS_BROWSER_KEY', 'Chave do navegador (Google Maps)',
    'Desenha o mapa nos aplicativos — vai para o navegador, é pública por natureza. Sem chave de servidor, também calcula rotas e faz as buscas.')}
      ${cred('GOOGLE_MAPS_SERVER_KEY', 'Chave de servidor (Google, opcional)',
    'Só é necessária se a chave do navegador tiver restrição de site. Usada apenas pelo backend; <b>nunca</b> vai para o navegador.')}
      <p class="muted small mb">Com a chave salva e o provedor em "Automático" ou "Google Maps", o mapa, as rotas
        (em modo motocicleta) e a busca passam para o Google. O Mapbox e o OpenStreetMap ficam de reserva
        se o Google falhar. Depois de salvar, use "Testar agora" mais abaixo.</p>
      <button class="btn btn-primary" id="mp-save-google" type="button">Salvar chaves do Google</button>
    </div>

    <div class="card">
      <h3>Passo 1 · Criar a conta e o token no Mapbox</h3>
      <ol class="muted small" style="padding-left:18px;line-height:1.9">
        <li>Crie a conta em <a href="https://account.mapbox.com/" target="_blank" rel="noopener">account.mapbox.com</a>
          (há franquia gratuita mensal de mapas, rotas e buscas — confira os limites atuais na página de preços).</li>
        <li>Na página <b>Tokens</b>, copie o <b>Default public token</b> ou crie um novo. Ele começa com <b>pk.</b></li>
        <li>Recomendado: em <b>URL restrictions</b> do token, informe o endereço do seu site
          (ex.: <i>https://seudominio.com.br</i>). Assim ninguém usa o seu token em outro site.</li>
        <li>Se você restringir por URL, crie um <b>segundo token sem restrição</b> para o servidor
          (rotas e busca de endereços são chamadas pelo backend, que não tem URL) e cole-o no campo
          "Token de servidor" abaixo.</li>
      </ol>
    </div>

    <div class="card">
      <h3>Passo 2 · Colar o token</h3>
      <p class="muted small mb">Fica cifrado no banco. Campos em branco não alteram o que já está salvo.</p>
      ${cred('MAPBOX_PUBLIC_TOKEN', 'Token público (pk.)',
    'Desenha o mapa nos aplicativos — vai para o navegador, é público por natureza. Sem token de servidor, também calcula rotas e busca endereços.')}
      ${cred('MAPBOX_SERVER_TOKEN', 'Token de servidor (opcional)',
    'Só é necessário se o token público tiver restrição de URL. Usado apenas pelo backend; <b>nunca</b> vai para o navegador.')}
      ${cred('GOOGLE_GEOCODING_KEY', 'Chave do Google para números de casa (opcional)',
    'Só para quem usa o Mapbox como provedor: faz "rua + número" cair na casa certa. Com o Google Maps configurado acima, deixe em branco — a mesma chave já faz isso. Crie em console.cloud.google.com uma chave com a <b>Geocoding API</b> ativada (exige faturamento ativo no Google Cloud). Usada só pelo backend; <b>nunca</b> vai para o navegador.')}
      <div class="field">
        <label>Provedor de mapas</label>
        <select class="input" id="mp-provider">
          <option value="auto" ${m.provider === 'auto' ? 'selected' : ''}>Automático — Google Maps se houver chave; senão Mapbox; senão OpenStreetMap</option>
          <option value="google" ${m.provider === 'google' ? 'selected' : ''}>Google Maps (Mapbox e OpenStreetMap de reserva)</option>
          <option value="mapbox" ${m.provider === 'mapbox' ? 'selected' : ''}>Mapbox (não usa o Google)</option>
          <option value="osm" ${m.provider === 'osm' ? 'selected' : ''}>Forçar OpenStreetMap (sem custo)</option>
        </select>
      </div>
      <div class="field">
        <label>Estilo do mapa (Mapbox)</label>
        <select class="input" id="mp-style">
          ${Object.entries(m.styles).map(([url, nome]) =>
    `<option value="${escapeHtml(url)}" ${m.style === url ? 'selected' : ''}>${escapeHtml(nome)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Validade do cache de rotas (horas)</label>
        <input class="input" id="ch-route" type="number" min="0" max="8760" value="${m.cache_hours.route}">
        <p class="muted small" style="margin-top:4px">A mesma rota não é pedida duas vezes ao provedor
          dentro desse prazo (no Google, no máximo 30 dias). Use 0 para desligar.</p></div>
      <button class="btn btn-primary" id="mp-save">Salvar configuração de mapas</button>
    </div>

    <div class="card">
      <h3>Passo 3 · Testar em ${escapeHtml(m.city_name)}</h3>
      <p class="muted small mb">Confere as chaves e faz uma chamada real de rota, de busca e de
        endereço por GPS em cada provedor configurado, usando o centro da cidade como referência.
        Faça antes de divulgar o app.</p>
      <button class="btn btn-navy btn-sm" id="mp-test">Testar agora</button>
      <div id="mp-result" class="mt"></div>
    </div>

    <div class="card">
      <h3>Economia por cache de rotas</h3>
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
      : u.mode === 'drive' ? '🛣️ por ruas' : '📏 estimativa'}</td>
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
        credentials, provider: $('#mp-provider').value, style: $('#mp-style').value,
        cache_hours: { route: $('#ch-route').value },
      },
    });
    secMaps();
  }, { okMsg: 'Configuração de mapas salva.' }).catch(() => { });

  $('#mp-save-google').onclick = () => $('#mp-save').click();

  // -------- estabelecimentos manuais --------
  let plCoord = null;
  $('#pl-locate').onclick = () => withLoading($('#pl-locate'), async () => {
    const ref = $('#pl-ref').value.trim();
    if (!ref) { toast('Informe o endereço ou as coordenadas.', 'err'); return; }
    const coordMatch = ref.match(/^(-?\d{1,2}[.,]\d+)\s*[,;]\s*(-?\d{1,3}[.,]\d+)$/);
    const box = $('#pl-options');
    if (coordMatch) {
      plCoord = { lat: Number(coordMatch[1].replace(',', '.')), lng: Number(coordMatch[2].replace(',', '.')) };
      box.innerHTML = `<div class="testbar">📍 Coordenada definida: ${plCoord.lat.toFixed(5)}, ${plCoord.lng.toFixed(5)}</div>`;
      $('#pl-save').disabled = false;
      return;
    }
    const r = await api('/api/geo/search?q=' + encodeURIComponent(ref));
    if (!r.results.length) {
      box.innerHTML = '<div class="testbar">Nada encontrado — tente outro endereço ou cole as coordenadas (no Google Maps do celular: toque e segure no ponto → os números aparecem em cima).</div>';
      $('#pl-save').disabled = true; plCoord = null;
      return;
    }
    box.innerHTML = '<p class="muted small">Escolha o ponto de referência:</p>' +
      r.results.slice(0, 5).map((x, i) => `
      <label class="list-item" style="cursor:pointer">
        <input type="radio" name="pl-opt" value="${i}">
        <div class="li-main"><div class="li-title">${escapeHtml(x.text)}</div>
          <div class="li-sub">${x.needs_details ? escapeHtml(x.secondary || 'Google Maps')
        : (x.distance_m / 1000).toFixed(1) + ' km do centro'}</div></div>
      </label>`).join('');
    box.querySelectorAll('input[name="pl-opt"]').forEach(inp => {
      inp.onchange = async () => {
        let x = r.results[Number(inp.value)];
        // sugestão do Google: a posição é buscada na escolha
        if (x.needs_details && x.place_id) {
          $('#pl-save').disabled = true; plCoord = null;
          try {
            x = (await api(`/api/geo/place?place_id=${encodeURIComponent(x.place_id)}&text=${encodeURIComponent(x.text)}`)).place;
          } catch (e) { toast(e.message, 'err'); return; }
          if (!inp.checked) return;                  // outra opção foi escolhida no meio do caminho
        }
        plCoord = { lat: x.lat, lng: x.lng };
        $('#pl-save').disabled = false;
      };
    });
  }).catch(() => { });

  $('#pl-save').onclick = () => withLoading($('#pl-save'), async () => {
    const name = $('#pl-name').value.trim();
    if (!name) { toast('Informe o nome do estabelecimento.', 'err'); return; }
    if (!plCoord) { toast('Localize o ponto primeiro.', 'err'); return; }
    const body = { name, tags: $('#pl-tags').value.trim() || null, detail: $('#pl-ref').value.trim() || null,
      lat: plCoord.lat, lng: plCoord.lng };
    try {
      await api('/api/admin/places', { method: 'POST', body });
    } catch (e) {
      if (e.status !== 409) throw e;
      // já existe: só grava se a central confirmar que é para substituir / que é outro lugar
      const ok = await confirmModal('Local parecido já cadastrado', `${e.message} Gravar mesmo assim?`, 'Gravar mesmo assim');
      if (!ok) throw new Error('Nada foi gravado.');
      await api('/api/admin/places', { method: 'POST', body: { ...body, replace: true } });
    }
    secMaps();
  }, { okMsg: 'Local salvo! Já aparece na busca dos passageiros.' }).catch(() => { });

  $('#cnefe-file').onchange = async () => {
    const f = $('#cnefe-file').files[0];
    $('#cnefe-file').value = '';
    if (!f) return;
    const box = $('#cnefe-result');
    box.innerHTML = '<div class="spinner"></div>';
    // o arquivo do IBGE vem em Latin-1 (acentos)
    const csv = new TextDecoder('windows-1252').decode(await f.arrayBuffer());
    const show = (r, done) => {
      box.innerHTML = `<p><b>${done ? 'Importação concluída' : 'Prévia (nada foi gravado ainda)'}</b> — ${r.linhas} endereços no arquivo, ${r.usadas} usados.</p>
        <div class="fin-grid mb">
          <div class="fin-card in"><div class="fv">${r.numeros.novos}</div><div class="fl">Números de casa ${done ? 'gravados' : 'novos'}</div></div>
          <div class="fin-card in"><div class="fv">${r.ruas.novas}</div><div class="fl">Ruas ${done ? 'gravadas' : 'novas'}</div></div>
          <div class="fin-card in"><div class="fv">${r.localidades.novas}</div><div class="fl">Bairros/loteamentos ${done ? 'gravados' : 'novos'}</div></div>
        </div>
        <p class="muted small">Já existiam: ${r.ruas.ja_existem} ruas, ${r.localidades.ja_existem} bairros, ${r.numeros.ja_existem} números.
          Ignorados: ${r.ignoradas.fora_da_area} fora da área atendida (distritos), ${r.ignoradas.coordenada_imprecisa} com posição imprecisa,
          ${r.ignoradas.tipo_de_logradouro_invalido} com tipo de logradouro inválido, ${r.ruas.poucos_enderecos} ruas com menos de 3 endereços,
          ${r.localidades.nome_ambiguo + r.localidades.poucos_enderecos} localidades com nome ambíguo ou poucos endereços.</p>
        ${r.exemplos.localidades_novas.length ? `<p class="small">Bairros/loteamentos: ${r.exemplos.localidades_novas.map(escapeHtml).join(', ')}</p>` : ''}
        ${r.exemplos.ruas_novas.length ? `<p class="small">Algumas ruas: ${r.exemplos.ruas_novas.map(escapeHtml).join(', ')}…</p>` : ''}
        ${!done ? '<button class="btn btn-primary mt" id="cnefe-go">Importar</button>' : ''}`;
      const go = $('#cnefe-go');
      if (go) go.onclick = () => withLoading(go, async () => {
        show(await api('/api/admin/cnefe/import', { method: 'POST', body: { csv, dry_run: false } }), true);
      }, { okMsg: 'Endereços do IBGE importados.' }).catch(() => { });
    };
    try { show(await api('/api/admin/cnefe/import', { method: 'POST', body: { csv, dry_run: true } }), false); }
    catch (e) { box.innerHTML = `<p class="err-text">${escapeHtml(e.message)}</p>`; }
  };

  $('#imp-file').onchange = () => {
    const f = $('#imp-file').files[0];
    $('#imp-file').value = '';          // permite escolher o mesmo arquivo de novo (nova conferência)
    importPlacesFile(f);
  };

  $$('[data-pl-del]').forEach(btn => {
    btn.onclick = async () => {
      if (!await confirmModal('Remover local', 'Remover este estabelecimento da busca?')) return;
      await api('/api/admin/places/' + btn.dataset.plDel, { method: 'DELETE' });
      toast('Local removido.', 'ok');
      secMaps();
    };
  });

  $$('[data-mk-clear]').forEach(btn => {
    btn.onclick = async () => {
      const k = btn.dataset.mkClear;
      const nome = k.includes('GOOGLE') ? 'chave do Google' : k.includes('PUBLIC') ? 'token público' : 'token de servidor';
      const efeito = k === 'GOOGLE_GEOCODING_KEY'
        ? 'Os números de casa voltam a depender do Mapbox ou do ajuste do pino.'
        : k.includes('GOOGLE') ? 'Sem ela, o Google Maps deixa de ser usado nessa parte e o sistema volta para o Mapbox ou o OpenStreetMap.'
          : 'Sem token, o sistema volta a usar o OpenStreetMap.';
      if (!await confirmModal('Remover credencial', `Remover ${k.includes('GOOGLE') ? 'a' : 'o'} ${nome} salv${k.includes('GOOGLE') ? 'a' : 'o'}? ${efeito}`)) return;
      await api('/api/admin/maps-config', { method: 'PUT', body: { credentials: { [k]: '' } } });
      toast('Credencial removida.', 'ok');
      secMaps();
    };
  });

  $('#mp-import-base').onclick = () => withLoading($('#mp-import-base'), async () => {
    $('#mp-base-result').innerHTML =
      '<p class="muted small">Baixando do OpenStreetMap… pode levar até 2 minutos.</p>';
    try {
      const r = await api('/api/admin/maps-config/import-base', { method: 'POST' });
      toast(`Base baixada: ${r.ruas} ruas, ${r.bairros} bairros, ${r.locais} locais.`, 'ok');
      secMaps();
    } catch (e) {
      $('#mp-base-result').innerHTML = '';
      throw e;
    }
  }).catch(() => { });

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
    <div class="card">
      <h3>📄 Empresa nos Termos e na Política de Privacidade</h3>
      <p class="muted small mb">Aparecem nas páginas <a href="/termos" target="_blank">Termos de Uso</a> e
        <a href="/privacidade" target="_blank">Política de Privacidade</a>. Enquanto um advogado não revisar os textos,
        as páginas mostram o aviso de versão preliminar.</p>
      <div class="grid2">
        <div class="field"><label>Responsável: nome (pessoa física) ou razão social</label><input class="input" id="lg-name" value="${escapeHtml(st.company_name || '')}"></div>
        <div class="field"><label>CNPJ (deixe vazio se for pessoa física)</label><input class="input" id="lg-cnpj" value="${escapeHtml(st.company_cnpj || '')}"></div>
        <div class="field"><label>Endereço</label><input class="input" id="lg-addr" value="${escapeHtml(st.company_address || '')}"></div>
        <div class="field"><label>Contato (e-mail ou WhatsApp)</label><input class="input" id="lg-contact" value="${escapeHtml(st.company_contact || '')}"></div>
        <div class="field"><label>Encarregado de dados (LGPD): nome e contato</label><input class="input" id="lg-dpo" value="${escapeHtml(st.dpo_contact || '')}"></div>
        <div class="field"><label>Corrida sem aceite: cancelar após (min, 0 = nunca)</label><input class="input" id="st-reqto" type="number" min="0" max="240" value="${st.request_timeout_min ?? 15}"></div>
      </div>
      <label class="check-row"><input type="checkbox" id="lg-reviewed" ${st.legal_reviewed === '1' ? 'checked' : ''}>
        <span>Os textos foram revisados por um advogado (tira o aviso de versão preliminar).</span></label>
    </div>
    <div class="card">
      <h3>🤖 App Android (Google Play)</h3>
      <p class="muted small mb">Liga o app da Play Store a este site (<a href="/.well-known/assetlinks.json" target="_blank">assetlinks.json</a>).
        Depois do primeiro envio, copie em Play Console → <i>Integridade do app → Assinatura de apps</i> a
        <b>impressão digital SHA-256 da chave de assinatura do app</b> e cole aqui (separe várias por vírgula).
        Sem ela, o app abre com a barra de endereço do navegador.</p>
      <div class="field"><label>Pacote</label><input class="input" id="an-pkg" value="${escapeHtml(st.android_package || 'br.com.vairo.app')}" readonly></div>
      <div class="field"><label>Impressões digitais SHA-256 adicionais</label>
        <textarea class="input" id="an-fps" rows="2" placeholder="AB:CD:…">${escapeHtml(st.android_cert_fingerprints || '')}</textarea></div>
    </div>
    <div class="card">
      <h3>🗂️ Guarda de dados e requisitos do mototaxista</h3>
      <p class="muted small mb">Prazos em dias. <b>0 = não apagar</b> (padrão). Ao ligar, o GPS e o chat de corridas
        encerradas há mais tempo que o prazo são apagados de vez; corridas com ocorrência aberta ficam guardadas.
        Defina os prazos com o advogado e escreva-os na Política de Privacidade.</p>
      <div class="grid2">
        <div class="field"><label>Apagar GPS de corridas encerradas após (dias)</label><input class="input" id="rt-gps" type="number" min="0" max="3650" value="${st.gps_retention_days ?? 0}"></div>
        <div class="field"><label>Apagar chat de corridas encerradas após (dias)</label><input class="input" id="rt-msg" type="number" min="0" max="3650" value="${st.messages_retention_days ?? 0}"></div>
        <div class="field"><label>Cópias diárias do banco guardadas</label><input class="input" id="rt-bkp" type="number" min="1" max="60" value="${st.backup_keep ?? 7}"></div>
        <div class="field"><label>Idade mínima do mototaxista (0 = não confere)</label><input class="input" id="rq-age" type="number" min="0" max="99" value="${st.min_driver_age ?? 21}"></div>
        <div class="field"><label>Anos mínimos de habilitação (0 = não confere)</label><input class="input" id="rq-cnh" type="number" min="0" max="50" value="${st.min_cnh_years ?? 2}"></div>
      </div>
    </div>
    <button class="btn btn-primary" id="st-save" style="max-width:340px">Salvar configurações</button>
    <p class="muted small mt">Versão do app publicada: <b>${escapeHtml(window.APP_VERSION || '—')}</b>.
      Quem já tem o app instalado recebe a versão nova ao abrir ou voltar para o app.</p>

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
          company_name: $('#lg-name').value, company_cnpj: $('#lg-cnpj').value,
          company_address: $('#lg-addr').value, company_contact: $('#lg-contact').value,
          dpo_contact: $('#lg-dpo').value, legal_reviewed: $('#lg-reviewed').checked ? '1' : '0',
          request_timeout_min: $('#st-reqto').value,
          android_cert_fingerprints: $('#an-fps').value.trim(),
          gps_retention_days: $('#rt-gps').value, messages_retention_days: $('#rt-msg').value,
          backup_keep: $('#rt-bkp').value, min_driver_age: $('#rq-age').value, min_cnh_years: $('#rq-cnh').value,
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
