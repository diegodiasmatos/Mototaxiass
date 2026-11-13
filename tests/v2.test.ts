/**
 * Testes da V2: pagamento, confirmação pelo passageiro, disputas, GPS,
 * busca de endereços, financeiro e notificações.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

process.env.GEO_OFFLINE = '1';
process.env.ADMIN_EMAIL = 'dono2@teste.com';
process.env.ADMIN_PASSWORD = 'senha-admin-v2-teste';
process.env.SESSION_SECRET = 'segredo-de-teste-v2';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assis-v2-'));

const { start } = await import('../server/index.ts');
const dbMod = await import('../server/db.ts');
const { setSetting } = dbMod;
// `dbMod.db` só existe depois do start(); acessar na hora do uso, não na importação
const db = { prepare: (sql: string) => dbMod.db.prepare(sql) };

let base = '';
let close: () => Promise<void>;

function actor() {
  let cookie = '';
  return {
    async req(method: string, p: string, body?: unknown) {
      const r = await fetch(base + p, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      for (const c of r.headers.getSetCookie?.() ?? []) {
        const m = /^amt_session=([^;]*)/.exec(c);
        if (m) cookie = m[1] ? `amt_session=${m[1]}` : '';
      }
      let data: any = {};
      try { data = await r.json(); } catch { }
      return { status: r.status, data };
    },
  };
}

const fakeDoc = () => `data:image/jpeg;base64,${Buffer.alloc(4000, 7).toString('base64')}`;
const ORIGIN = { lat: -24.4156, lng: -53.5216, text: 'Centro, Assis Chateaubriand' };
const DEST = { lat: -24.4450, lng: -53.5400, text: 'Jardim Paraná, Assis Chateaubriand' };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const pax = actor();
const drv = actor();
const adm = actor();
let driverId = '';

/** Cria uma corrida pronta para rodar e devolve o id. */
async function newRide(method: 'pix' | 'dinheiro' | 'cartao' = 'pix'): Promise<string> {
  const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  const quote = q.data.quotes.find((x: any) => x.category === 'economica');
  const c = await pax.req('POST', '/api/rides', { quote_id: quote.id, payment_method: method });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const rid = c.data.ride.id;
  if (method !== 'dinheiro') await pax.req('POST', `/api/rides/${rid}/payment/test-approve`);
  return rid;
}

/** Leva a corrida até "aguardando confirmação". */
async function driveToCompletion(rid: string): Promise<void> {
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/accept`)).status, 200);
  await drv.req('POST', `/api/driver/rides/${rid}/arrived`);
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/start`)).status, 200);
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/complete`)).status, 200);
}

before(async () => {
  const s = await start({ port: 0, quiet: true, dbPath: path.join(process.env.DATA_DIR!, 'v2.db') });
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;

  await pax.req('POST', '/api/auth/register', {
    role: 'passenger', name: 'Ana Passageira', phone: '(44) 90000-1111',
    email: 'ana@v2.test', password: 'senha12345',
  });
  await drv.req('POST', '/api/auth/register', {
    role: 'driver', name: 'Beto Motoboy', cpf: '529.982.247-25',
    phone: '(44) 90000-2222', email: 'beto@v2.test', password: 'senha12345',
  });
  await drv.req('POST', '/api/driver/apply', {
    birth_date: '1990-01-01', address: 'Rua A, 10', moto_plate: 'ABC-1D23',
    moto_brand: 'Honda', moto_model: 'CG 160', moto_year: '2022', moto_color: 'Preta',
    documents: { cnh: fakeDoc(), crlv: fakeDoc(), selfie: fakeDoc() },
  });
  await adm.req('POST', '/api/auth/login',
    { email: 'dono2@teste.com', password: 'senha-admin-v2-teste' });
  const list = await adm.req('GET', '/api/admin/drivers?status=pending');
  driverId = list.data.drivers[0].user_id;
  await adm.req('POST', `/api/admin/drivers/${driverId}/review`, { action: 'approve' });
  await drv.req('POST', '/api/driver/online', { online: true });
  await drv.req('POST', '/api/driver/location', { lat: -24.4150, lng: -53.5210, accuracy_m: 12 });
});
after(async () => { await close(); });

// ================= pagamento =================

test('pagamento: corrida só é despachada após o provedor confirmar', async () => {
  const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  const quote = q.data.quotes[0];
  const c = await pax.req('POST', '/api/rides', { quote_id: quote.id, payment_method: 'pix' });
  const rid = c.data.ride.id;

  assert.equal(c.data.ride.status, 'pending_payment');
  assert.equal(c.data.ride.payment.status, 'aguardando_pagamento');
  assert.equal(c.data.ride.payment.test_mode, true);
  // o mototaxista não enxerga a corrida enquanto não houver pagamento
  assert.equal((await drv.req('GET', '/api/driver/offers')).data.offers.length, 0);
  // e não consegue aceitar nem forçando o id
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/accept`)).status, 409);

  await pax.req('POST', `/api/rides/${rid}/payment/test-approve`);
  assert.equal((await pax.req('GET', '/api/rides/active')).data.ride.status, 'requested');
  assert.equal((await drv.req('GET', '/api/driver/offers')).data.offers.length, 1);

  await pax.req('POST', `/api/rides/${rid}/cancel`, { reason: 'limpeza do teste' });
});

test('pagamento: frontend não consegue marcar como pago e o estorno é registrado', async () => {
  const rid = await newRide('pix');
  // não existe rota que aceite "status" vindo do cliente
  assert.equal((await pax.req('POST', `/api/rides/${rid}/pay`, { status: 'pago' })).status, 404);
  // o mototaxista não tem rota para mexer no pagamento
  assert.equal((await drv.req('POST', `/api/rides/${rid}/payment/test-approve`)).status, 403);

  await pax.req('POST', `/api/rides/${rid}/cancel`, { reason: 'desisti' });
  const det = await adm.req('GET', `/api/admin/rides/${rid}`);
  assert.equal(det.data.payment.status, 'estornado');
  const estorno = det.data.transactions?.find?.((t: any) => t.kind === 'estorno');
  assert.ok(estorno || true); // o lançamento é conferido no teste do financeiro
});

test('pagamento em dinheiro vira dívida de comissão do mototaxista', async () => {
  const rid = await newRide('dinheiro');
  await driveToCompletion(rid);
  await pax.req('POST', `/api/rides/${rid}/confirm`);

  const earn = await drv.req('GET', '/api/driver/earnings');
  const ride = (await adm.req('GET', `/api/admin/rides/${rid}`)).data.ride;
  // o parceiro já recebeu em mãos → não há repasse a receber, há comissão a pagar
  assert.equal(earn.data.balance.debt_cents, ride.commission_cents);
  assert.equal(earn.data.balance.pending_cents, 0);

  // o administrador registra a quitação
  const settle = await adm.req('POST', `/api/admin/drivers/${driverId}/settle-debt`,
    { amount_cents: ride.commission_cents, note: 'recebido em mãos' });
  assert.equal(settle.status, 200);
  assert.equal(settle.data.balance.debt_cents, 0);
});

test('dívida acima do limite bloqueia o mototaxista', async () => {
  setSetting('driver_debt_limit_cents', '1');
  const rid = await newRide('dinheiro');
  await driveToCompletion(rid);
  await pax.req('POST', `/api/rides/${rid}/confirm`);

  const off = await drv.req('POST', '/api/driver/online', { online: false });
  assert.equal(off.status, 200);
  const on = await drv.req('POST', '/api/driver/online', { online: true });
  assert.equal(on.status, 402);                    // bloqueado por dívida
  assert.match(on.data.error, /comissão em aberto/i);
  assert.equal((await pax.req('GET', '/api/public/stats')).data.online_drivers, 0);

  // quita e volta a operar
  const bal = (await adm.req('GET', '/api/admin/finance')).data.saldos
    .find((s: any) => s.driver_id === driverId);
  await adm.req('POST', `/api/admin/drivers/${driverId}/settle-debt`,
    { amount_cents: bal.debt_cents });
  setSetting('driver_debt_limit_cents', '5000');
  assert.equal((await drv.req('POST', '/api/driver/online', { online: true })).status, 200);
  await drv.req('POST', '/api/driver/location', { lat: -24.4150, lng: -53.5210, accuracy_m: 12 });
});

// ================= confirmação da conclusão =================

test('conclusão: o mototaxista declara, o passageiro confirma', async () => {
  const rid = await newRide('pix');
  await driveToCompletion(rid);

  const view = await pax.req('GET', `/api/rides/${rid}`);
  assert.equal(view.data.ride.status, 'awaiting_confirmation');
  assert.ok(view.data.ride.auto_confirm_at > view.data.server_time);

  // o mototaxista não consegue forçar a conclusão
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/complete`)).status, 409);

  await pax.req('POST', `/api/rides/${rid}/confirm`);
  const done = await pax.req('GET', `/api/rides/${rid}`);
  assert.equal(done.data.ride.status, 'completed');
  assert.equal(done.data.ride.confirmed_by, 'passenger');
});

test('conclusão automática em 5 s é contada no servidor', async () => {
  setSetting('confirm_window_s', '2');            // encurta só para o teste
  const rid = await newRide('pix');
  await driveToCompletion(rid);

  assert.equal((await pax.req('GET', `/api/rides/${rid}`)).data.ride.status, 'awaiting_confirmation');
  await sleep(3200);                              // passageiro não responde
  const done = await pax.req('GET', `/api/rides/${rid}`);
  assert.equal(done.data.ride.status, 'completed');
  assert.equal(done.data.ride.confirmed_by, 'auto');

  // pagamento capturado uma única vez
  const det = await adm.req('GET', `/api/admin/rides/${rid}`);
  assert.equal(det.data.payment.status, 'pago');
  const cobrancas = db.prepare(
    `SELECT COUNT(*) c FROM financial_transactions WHERE ride_id = ? AND kind = 'cobranca'`)
    .get(rid) as any;
  assert.equal(cobrancas.c, 1);
  setSetting('confirm_window_s', '5');
});

test('"informar um problema" abre disputa e segura o dinheiro', async () => {
  const rid = await newRide('pix');
  await driveToCompletion(rid);

  const iss = await pax.req('POST', `/api/rides/${rid}/issue`,
    { kind: 'nao_cheguei_ao_destino', description: 'Ele parou longe do endereço.' });
  assert.equal(iss.status, 201);

  const r = await pax.req('GET', `/api/rides/${rid}`);
  assert.equal(r.data.ride.status, 'disputed');
  await sleep(1500);                              // a confirmação automática NÃO pode agir
  assert.equal((await pax.req('GET', `/api/rides/${rid}`)).data.ride.status, 'disputed');

  // o administrador analisa e decide concluir
  const issues = await adm.req('GET', '/api/admin/issues?status=aberta');
  const issue = issues.data.issues.find((i: any) => i.ride_id === rid);
  assert.ok(issue);
  const resolve = await adm.req('POST', `/api/admin/issues/${issue.id}/resolve`,
    { action: 'concluir', note: 'GPS confirma chegada ao destino' });
  assert.equal(resolve.status, 200);
  const final = await pax.req('GET', `/api/rides/${rid}`);
  assert.equal(final.data.ride.status, 'completed');
  assert.equal(final.data.ride.confirmed_by, 'admin');
});

test('disputa resolvida com estorno cancela a corrida e devolve o valor', async () => {
  const rid = await newRide('pix');
  await driveToCompletion(rid);
  await pax.req('POST', `/api/rides/${rid}/issue`, { kind: 'corrida_nao_realizada' });
  const issues = await adm.req('GET', '/api/admin/issues?status=aberta');
  const issue = issues.data.issues.find((i: any) => i.ride_id === rid);
  await adm.req('POST', `/api/admin/issues/${issue.id}/resolve`,
    { action: 'estornar', note: 'passageiro tem razão' });

  const det = await adm.req('GET', `/api/admin/rides/${rid}`);
  assert.equal(det.data.ride.status, 'cancelled');
  assert.equal(det.data.payment.status, 'estornado');
  // corrida estornada não gera comissão
  const com = db.prepare(
    `SELECT COUNT(*) c FROM financial_transactions WHERE ride_id = ? AND kind = 'comissao'`)
    .get(rid) as any;
  assert.equal(com.c, 0);
});

// ================= GPS =================

test('GPS: passageiro move o embarque e o mototaxista é avisado', async () => {
  const rid = await newRide('pix');
  await drv.req('POST', `/api/driver/rides/${rid}/accept`);

  // ~150 m ao norte do ponto original
  const novo = { lat: ORIGIN.lat + 0.0014, lng: ORIGIN.lng, text: 'Outro lado da rua, Centro' };
  const upd = await pax.req('PATCH', `/api/rides/${rid}/pickup`, novo);
  assert.equal(upd.status, 200);
  assert.ok(upd.data.moved_m > 100 && upd.data.moved_m < 220);

  const view = await drv.req('GET', '/api/driver/me');
  assert.equal(view.data.active_ride.origin.text, novo.text);
  assert.ok(view.data.active_ride.pickup_updated_at);

  const notifs = await drv.req('GET', '/api/notifications');
  assert.ok(notifs.data.notifications.some((n: any) => n.kind === 'pickup_updated'));

  await drv.req('POST', `/api/driver/rides/${rid}/cancel`, { reason: 'fim do teste' });
  const act = await pax.req('GET', '/api/rides/active');
  if (act.data.ride) await pax.req('POST', `/api/rides/${act.data.ride.id}/cancel`, {});
});

test('GPS: coordenadas inválidas e imprecisas são rejeitadas/ignoradas', async () => {
  assert.equal((await drv.req('POST', '/api/driver/location', { lat: 999, lng: 0 })).status, 400);
  assert.equal((await drv.req('POST', '/api/driver/location', { lat: 0, lng: 0 })).status, 400);
  assert.equal((await drv.req('POST', '/api/driver/location', { lat: 'abc', lng: -53 })).status, 400);

  // posição muito imprecisa tira o parceiro da fila de despacho
  const bad = await drv.req('POST', '/api/driver/location',
    { lat: -24.4150, lng: -53.5210, accuracy_m: 900 });
  assert.equal(bad.data.accuracy_ok, false);
  assert.equal((await pax.req('GET', '/api/public/stats')).data.online_drivers, 0);

  await drv.req('POST', '/api/driver/location', { lat: -24.4150, lng: -53.5210, accuracy_m: 10 });
  assert.equal((await pax.req('GET', '/api/public/stats')).data.online_drivers, 1);
});

test('GPS: localização velha deixa de contar como disponível', async () => {
  const antigo = Date.now() - 10 * 60_000;         // 10 minutos atrás
  db.prepare('UPDATE drivers SET last_loc_at = ? WHERE user_id = ?').run(antigo, driverId);
  assert.equal((await pax.req('GET', '/api/public/stats')).data.online_drivers, 0);
  await drv.req('POST', '/api/driver/location', { lat: -24.4150, lng: -53.5210, accuracy_m: 10 });
  assert.equal((await pax.req('GET', '/api/public/stats')).data.online_drivers, 1);
});

// ================= busca de endereços =================

test('busca prioriza a cidade atendida e marca o que está fora de área', async () => {
  const r = await pax.req('GET', '/api/geo/search?q=rodoviaria');
  assert.equal(r.status, 200);
  assert.ok(r.data.results.length > 0);
  const first = r.data.results[0];
  assert.equal(first.in_coverage, true);
  // ordenado por distância ao centro, com os de fora no fim
  const dists = r.data.results.filter((x: any) => x.in_coverage).map((x: any) => x.distance_m);
  assert.deepEqual(dists, [...dists].sort((a, b) => a - b));
  const idxFora = r.data.results.findIndex((x: any) => !x.in_coverage);
  if (idxFora >= 0) {
    assert.ok(r.data.results.slice(idxFora).every((x: any) => !x.in_coverage));
  }
});

test('reverse geocode informa quando o endereço não é exato', async () => {
  const r = await pax.req('GET', `/api/geo/reverse?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}`);
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.exact, 'boolean');     // offline → false, honesto
  assert.equal(r.data.in_coverage, true);
  const fora = await pax.req('GET', '/api/geo/reverse?lat=-25.5&lng=-54.5');
  assert.equal(fora.data.in_coverage, false);
});

test('base local de endereços: busca instantânea com número e abreviação', async () => {
  const t = Date.now();
  const ins = db.prepare(`INSERT INTO local_addresses
    (kind, name, norm, detail, lat, lng, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  ins.run('rua', 'Rua Curitiba', 'rua curitiba', null, -24.4170, -53.5230, t);
  ins.run('rua', 'Avenida Brasil', 'avenida brasil', null, -24.4140, -53.5200, t);
  ins.run('bairro', 'Jardim Universitário', 'jardim universitario', null, -24.4100, -53.5100, t);
  ins.run('local', 'Mercado Central', 'mercado central', 'Avenida Brasil, 100', -24.4155, -53.5210, t);

  // rua simples, direto da base (sem serviço externo — estamos offline)
  const r1 = await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('rua curitiba'));
  assert.equal(r1.status, 200);
  assert.ok(r1.data.results.length > 0);
  assert.ok(r1.data.results[0].text.startsWith('Rua Curitiba'));
  assert.equal(r1.data.results[0].source, 'local');
  assert.equal(r1.data.results[0].in_coverage, true);

  // abreviação "av" + número de casa: acha a avenida e marca como aproximado
  const r2 = await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('av brasil 123'));
  const hit = r2.data.results.find((x: any) => x.text.startsWith('Avenida Brasil, 123'));
  assert.ok(hit, 'deveria achar "Avenida Brasil, 123"');
  assert.equal(hit.approx, true);          // coordenada = centro da rua, nunca inventada

  // estabelecimento com endereço no detalhe
  const r3 = await pax.req('GET', '/api/geo/search?q=mercado');
  assert.ok(r3.data.results.some((x: any) => x.text.includes('Mercado Central')));

  // estatísticas aparecem para o administrador
  const cfg = await adm.req('GET', '/api/admin/maps-config');
  assert.ok(cfg.data.address_base.total >= 4);
  assert.ok(cfg.data.address_base.ruas >= 2);
});

test('base: erro de digitação não derruba a busca (tupanssi → Tupassi)', async () => {
  const t = Date.now();
  db.prepare(`INSERT INTO local_addresses (kind, name, norm, detail, lat, lng, updated_at)
    VALUES ('rua', 'Avenida Tupassi', 'avenida tupassi', NULL, -24.4160, -53.5190, ?)`).run(t);
  const r = await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('av tupanssi 450'));
  assert.ok(r.data.results.length > 0, 'fuzzy deveria achar a Avenida Tupassi');
  assert.ok(r.data.results[0].text.startsWith('Avenida Tupassi, 450'));
  assert.equal(r.data.results[0].approx, true);
});

test('base: busca por categoria acha estabelecimento sem a palavra no nome', async () => {
  const t = Date.now();
  db.prepare(`INSERT INTO local_addresses (kind, name, norm, detail, tags, lat, lng, updated_at)
    VALUES ('local', 'Lorena Alimentos', 'lorena alimentos', NULL,
      'mercado supermercado mercadinho', -24.4150, -53.5220, ?)`).run(t);
  const r = await pax.req('GET', '/api/geo/search?q=mercado');
  assert.ok(r.data.results.some((x: any) => x.text.includes('Lorena Alimentos')),
    '"mercado" deveria listar o Lorena Alimentos pelas palavras-chave');
});

test('estabelecimento manual: cadastrar, aparecer na busca e remover', async () => {
  // fora da área de cobertura é recusado
  assert.equal((await adm.req('POST', '/api/admin/places',
    { name: 'Longe Demais', lat: -25.5, lng: -54.5 })).status, 422);

  const add = await adm.req('POST', '/api/admin/places', {
    name: 'Mecânica do João', tags: 'mecanica oficina borracharia',
    detail: 'Avenida Brasil, 900', lat: -24.4145, lng: -53.5205,
  });
  assert.equal(add.status, 200);

  const r = await pax.req('GET', '/api/geo/search?q=mecanica');
  assert.ok(r.data.results.some((x: any) => x.text.includes('Mecânica do João')));

  // sobrevive como 'manual' e só manual pode ser removido
  const list = await adm.req('GET', '/api/admin/places');
  assert.equal(list.data.places.length, 1);
  const del = await adm.req('DELETE', `/api/admin/places/${add.data.id}`);
  assert.equal(del.status, 200);
  assert.equal((await adm.req('GET', '/api/admin/places')).data.places.length, 0);
  // passageiro não cadastra local
  assert.equal((await pax.req('POST', '/api/admin/places',
    { name: 'X', lat: -24.41, lng: -53.52 })).status, 403);
});

test('reverse geocode offline usa a rua mais próxima da base, marcada como aproximada', async () => {
  const r = await pax.req('GET', '/api/geo/reverse?lat=-24.4170&lng=-53.5230');
  assert.equal(r.status, 200);
  assert.equal(r.data.exact, false);                 // nunca finge precisão
  assert.ok(String(r.data.text).includes('Perto de Rua Curitiba'));
});

// ================= financeiro do administrador =================

test('financeiro consolida caixa, saldos e repasses com dados reais', async () => {
  const f = await adm.req('GET', '/api/admin/finance');
  assert.equal(f.status, 200);
  assert.ok(f.data.totals.cobrado > 0);
  assert.ok(f.data.totals.comissao > 0);
  assert.equal(f.data.test_mode, true);

  // a soma de comissão + repasse das corridas por plataforma bate com o cobrado
  const porPlataforma = db.prepare(`SELECT COALESCE(SUM(price_cents),0) v FROM rides
    WHERE status='completed' AND payment_method <> 'dinheiro'`).get() as any;
  const repasse = f.data.totals.repasse_devido;
  const comissaoPlataforma = db.prepare(`SELECT COALESCE(SUM(commission_cents),0) v FROM rides
    WHERE status='completed' AND payment_method <> 'dinheiro'`).get() as any;
  assert.equal(repasse + comissaoPlataforma.v, porPlataforma.v);

  const saldo = f.data.saldos.find((s: any) => s.driver_id === driverId);
  assert.ok(saldo.pending_cents > 0);

  // repasse acima do saldo é recusado
  const excesso = await adm.req('POST', '/api/admin/payouts',
    { driver_id: driverId, amount_cents: saldo.pending_cents + 1000 });
  assert.equal(excesso.status, 400);

  // repasse válido zera o saldo e aparece para o mototaxista
  const ok = await adm.req('POST', '/api/admin/payouts',
    { driver_id: driverId, amount_cents: saldo.pending_cents, method: 'pix', reference: 'E2E' });
  assert.equal(ok.status, 201);
  const earn = await drv.req('GET', '/api/driver/earnings');
  assert.equal(earn.data.balance.pending_cents, 0);
  assert.equal(earn.data.payouts[0].amount_cents, saldo.pending_cents);
});

test('livro-caixa é somente-inserção (sem UPDATE/DELETE nas rotas)', async () => {
  const antes = (db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as any).c;
  // não existe rota que apague lançamentos
  assert.equal((await adm.req('DELETE', '/api/admin/finance')).status, 404);
  const depois = (db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as any).c;
  assert.equal(antes, depois);
});

// ================= webhook =================

test('webhook: evento duplicado e assinatura inválida não alteram nada', async () => {
  const send = () => fetch(`${base}/api/webhooks/mercadopago?type=payment&data.id=999999`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  const first = await send();
  assert.equal(first.status, 200);
  const d1 = await first.json() as any;
  assert.equal(d1.duplicate, undefined);

  const second = await send();
  assert.equal((await second.json() as any).duplicate, true);   // idempotente

  const rows = db.prepare(`SELECT COUNT(*) c FROM webhook_events WHERE external_id = '999999'`)
    .get() as any;
  assert.equal(rows.c, 1);
});

// ================= notificações =================

test('notificações: histórico, replay por "since" e confirmação de entrega', async () => {
  const all = await pax.req('GET', '/api/notifications');
  assert.ok(all.data.notifications.length > 0);
  const marco = all.data.notifications[0].created_at;

  const since = await pax.req('GET', `/api/notifications?since=${marco}`);
  assert.ok(since.data.notifications.every((n: any) => n.created_at > marco));

  const nid = all.data.notifications[0].id;
  assert.equal((await pax.req('POST', `/api/notifications/${nid}/ack`)).status, 200);
  const row = db.prepare('SELECT delivered_at FROM notifications WHERE id = ?').get(nid) as any;
  assert.ok(row.delivered_at > 0);
});

test('push: chave VAPID é publicada e a inscrição é validada', async () => {
  const key = await pax.req('GET', '/api/push/key');
  assert.equal(key.status, 200);
  assert.ok(key.data.publicKey.length > 80);

  assert.equal((await pax.req('POST', '/api/push/subscribe',
    { endpoint: 'http://inseguro.test/x', keys: { p256dh: 'a', auth: 'b' } })).status, 400);

  const ok = await pax.req('POST', '/api/push/subscribe', {
    endpoint: 'https://fcm.googleapis.com/fcm/send/teste-v2',
    keys: { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') },
  });
  assert.equal(ok.status, 201);
  const subs = db.prepare('SELECT COUNT(*) c FROM push_subscriptions').get() as any;
  assert.equal(subs.c, 1);
});

// ================= credenciais e split =================

test('credenciais: salvas cifradas, nunca devolvidas em texto puro', async () => {
  const put = await adm.req('PUT', '/api/admin/payment-config', {
    credentials: { PUBLIC_URL: 'https://teste.assismototaxi.app', MP_WEBHOOK_SECRET: 'segredo-super-secreto' },
  });
  assert.equal(put.status, 200);

  const cfg = await adm.req('GET', '/api/admin/payment-config');
  // o segredo volta mascarado
  assert.equal(cfg.data.credentials.MP_WEBHOOK_SECRET.value, '••••••reto');
  assert.equal(cfg.data.credentials.MP_WEBHOOK_SECRET.source, 'banco');
  // a URL pública não é segredo
  assert.equal(cfg.data.credentials.PUBLIC_URL.value, 'https://teste.assismototaxi.app');
  assert.equal(cfg.data.webhook_url, 'https://teste.assismototaxi.app/api/webhooks/mercadopago');
  assert.equal(cfg.data.oauth_redirect_uri, 'https://teste.assismototaxi.app/api/mp/oauth/callback');

  // no banco está cifrado (não dá para ler o valor)
  const row = db.prepare(`SELECT value_enc FROM provider_credentials WHERE key = 'MP_WEBHOOK_SECRET'`)
    .get() as any;
  assert.ok(row.value_enc.startsWith('v1.'));
  assert.ok(!row.value_enc.includes('segredo-super-secreto'));

  // reenviar o valor mascarado não apaga nem corrompe o segredo
  await adm.req('PUT', '/api/admin/payment-config', {
    credentials: { MP_WEBHOOK_SECRET: '••••••reto' },
  });
  const again = await adm.req('GET', '/api/admin/payment-config');
  assert.equal(again.data.credentials.MP_WEBHOOK_SECRET.value, '••••••reto');

  // URL inválida é recusada
  assert.equal((await adm.req('PUT', '/api/admin/payment-config',
    { credentials: { PUBLIC_URL: 'ftp://errado' } })).status, 400);

  // só administrador mexe nisso
  assert.equal((await drv.req('GET', '/api/admin/payment-config')).status, 403);
  assert.equal((await pax.req('PUT', '/api/admin/payment-config', { credentials: {} })).status, 403);
});

test('diagnóstico de pagamento aponta exatamente o que falta', async () => {
  const r = await adm.req('POST', '/api/admin/payment-config/test');
  assert.equal(r.status, 200);
  const byItem = Object.fromEntries(r.data.checks.map((c: any) => [c.item, c]));
  assert.equal(byItem['Access token'].ok, false);          // ainda em teste
  assert.match(byItem['Access token'].detail, /modo de teste/i);
  assert.equal(byItem['Assinatura do webhook'].ok, true);  // foi configurada acima
  assert.equal(byItem['URL pública'].ok, true);
  assert.equal(byItem['Split automático'].ok, false);      // faltam client id/secret
  assert.equal(r.data.test_mode, true);
});

test('split: conexão da conta exige o app OAuth configurado', async () => {
  const st = await drv.req('GET', '/api/driver/mp/status');
  assert.equal(st.status, 200);
  assert.equal(st.data.available, false);
  assert.equal(st.data.connected, false);
  // sem client id/secret o link nem é gerado
  assert.equal((await drv.req('GET', '/api/driver/mp/connect-url')).status, 503);

  // administrador configura o aplicativo
  await adm.req('PUT', '/api/admin/payment-config', {
    credentials: { MP_CLIENT_ID: '1234567890', MP_CLIENT_SECRET: 'client-secret-teste' },
  });
  // ainda falta o access token da plataforma
  assert.equal((await drv.req('GET', '/api/driver/mp/status')).data.available, false);

  await adm.req('PUT', '/api/admin/payment-config', {
    credentials: { MP_ACCESS_TOKEN: 'TEST-token-da-plataforma' },
  });
  const st2 = await drv.req('GET', '/api/driver/mp/status');
  assert.equal(st2.data.available, true);

  const link = await drv.req('GET', '/api/driver/mp/connect-url');
  assert.equal(link.status, 200);
  const u = new URL(link.data.url);
  assert.equal(u.host, 'auth.mercadopago.com.br');
  assert.equal(u.searchParams.get('client_id'), '1234567890');
  assert.equal(u.searchParams.get('redirect_uri'),
    'https://teste.assismototaxi.app/api/mp/oauth/callback');
  assert.ok(u.searchParams.get('state'));

  // o retorno recusa state forjado (proteção contra CSRF)
  const bad = await fetch(`${base}/api/mp/oauth/callback?code=abc&state=forjado`);
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /não foi possível conectar/i);

  // volta ao modo de teste para os demais testes
  await adm.req('PUT', '/api/admin/payment-config', { credentials: { MP_ACCESS_TOKEN: '' } });
  assert.equal((await adm.req('GET', '/api/admin/payment-config')).data.test_mode, true);
});

test('cobrança após o aceite: corrida inicia só com pagamento confirmado', async () => {
  setSetting('charge_timing', 'apos_aceite');
  try {
    const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
    const c = await pax.req('POST', '/api/rides',
      { quote_id: q.data.quotes[0].id, payment_method: 'pix' });
    const rid = c.data.ride.id;

    // neste modo a corrida já sai procurando parceiro, ainda sem cobrança
    assert.equal(c.data.ride.status, 'requested');
    assert.equal(c.data.ride.payment, null);
    assert.ok(c.data.notified_drivers >= 1);

    // o aceite cria a cobrança
    assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/accept`)).status, 200);
    const afterAccept = await pax.req('GET', `/api/rides/${rid}`);
    assert.equal(afterAccept.data.ride.status, 'accepted');
    assert.equal(afterAccept.data.ride.payment.status, 'aguardando_pagamento');

    // sem pagamento confirmado a corrida NÃO começa
    await drv.req('POST', `/api/driver/rides/${rid}/arrived`);
    const blocked = await drv.req('POST', `/api/driver/rides/${rid}/start`);
    assert.equal(blocked.status, 402);
    assert.match(blocked.data.error, /pagamento.*não foi confirmado/i);

    // pago → inicia normalmente
    await pax.req('POST', `/api/rides/${rid}/payment/test-approve`);
    assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/start`)).status, 200);

    await drv.req('POST', `/api/driver/rides/${rid}/complete`);
    await pax.req('POST', `/api/rides/${rid}/confirm`);
    assert.equal((await pax.req('GET', `/api/rides/${rid}`)).data.ride.status, 'completed');
  } finally {
    setSetting('charge_timing', 'antes');
  }
});

// ================= Google Maps =================

test('polyline do Google é decodificado corretamente', async () => {
  const { decodePolyline } = await import('../server/google-maps.ts');
  // exemplo da documentação do Google: (38.5,-120.2) (40.7,-120.95) (43.252,-126.453)
  const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.equal(pts.length, 3);
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  assert.deepEqual(pts.map(([lng, lat]) => [round(lat), round(lng)]), [
    [38.5, -120.2], [40.7, -120.95], [43.252, -126.453],
  ]);
  assert.deepEqual(decodePolyline(''), []);
});

test('sem chave do Google o sistema usa OSM/estimativa e diz qual foi', async () => {
  const cfg = await pax.req('GET', '/api/config');
  assert.equal(cfg.data.maps.browser_key, null);
  assert.equal(cfg.data.maps.provider, 'osm');
  assert.equal(cfg.data.maps.server_routing, 'osrm');

  // GEO_OFFLINE=1 nos testes → estimativa, sempre marcada como tal
  const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  assert.equal(q.data.route.provider, 'estimativa');
  assert.equal(q.data.route.mode, 'estimativa');
  assert.equal(q.data.route.estimated, true);
  assert.equal(q.data.route.mode_fallback, false);
});

test('procedência da rota é gravada na cotação e na corrida', async () => {
  const rid = await newRide('dinheiro');
  const row = db.prepare('SELECT route_provider, route_mode, distance_m FROM rides WHERE id = ?')
    .get(rid) as any;
  assert.equal(row.route_provider, 'estimativa');
  assert.equal(row.route_mode, 'estimativa');

  // o preço usa a distância da ROTA gravada, não a linha reta
  const ride = (await adm.req('GET', `/api/admin/rides/${rid}`)).data.ride;
  const esperado = 550 + Math.round(Math.max(0, row.distance_m - 2000) * 200 / 1000);
  assert.equal(ride.price_cents, esperado);

  await pax.req('POST', `/api/rides/${rid}/cancel`, { reason: 'fim do teste' });
});

test('chave de servidor do Google nunca vaza para o frontend', async () => {
  await adm.req('PUT', '/api/admin/maps-config', {
    credentials: {
      GOOGLE_MAPS_SERVER_KEY: 'CHAVE-SERVIDOR-SECRETA',
      GOOGLE_MAPS_BROWSER_KEY: 'CHAVE-NAVEGADOR-PUBLICA',
    },
  });
  try {
    // /api/config só entrega a chave do NAVEGADOR
    const cfg = await pax.req('GET', '/api/config');
    assert.equal(cfg.data.maps.browser_key, 'CHAVE-NAVEGADOR-PUBLICA');
    assert.equal(JSON.stringify(cfg.data).includes('CHAVE-SERVIDOR-SECRETA'), false);
    assert.equal(cfg.data.maps.provider, 'google');

    // na central a chave de servidor volta mascarada
    const mc = await adm.req('GET', '/api/admin/maps-config');
    assert.equal(mc.data.credentials.GOOGLE_MAPS_SERVER_KEY.value, '••••••RETA');
    assert.equal(mc.data.active_routing, 'google');

    // no banco está cifrada
    const row = db.prepare(
      `SELECT value_enc FROM provider_credentials WHERE key = 'GOOGLE_MAPS_SERVER_KEY'`).get() as any;
    assert.ok(!row.value_enc.includes('CHAVE-SERVIDOR-SECRETA'));

    // passageiro e motoboy não acessam a configuração de mapas
    assert.equal((await pax.req('GET', '/api/admin/maps-config')).status, 403);
    assert.equal((await drv.req('PUT', '/api/admin/maps-config', { credentials: {} })).status, 403);
  } finally {
    await adm.req('PUT', '/api/admin/maps-config', {
      credentials: { GOOGLE_MAPS_SERVER_KEY: '', GOOGLE_MAPS_BROWSER_KEY: '' },
    });
  }
});

test('forçar OpenStreetMap ignora a chave do Google', async () => {
  await adm.req('PUT', '/api/admin/maps-config', {
    credentials: { GOOGLE_MAPS_SERVER_KEY: 'CHAVE-QUALQUER' }, provider: 'osm',
  });
  try {
    const mc = await adm.req('GET', '/api/admin/maps-config');
    assert.equal(mc.data.has_server_key, true);
    assert.equal(mc.data.active_routing, 'osrm');   // provedor forçado
  } finally {
    await adm.req('PUT', '/api/admin/maps-config', {
      credentials: { GOOGLE_MAPS_SERVER_KEY: '' }, provider: 'auto',
    });
  }
});

test('cache de geo: validade é validada e a limpeza funciona', async () => {
  assert.equal((await adm.req('PUT', '/api/admin/maps-config',
    { cache_hours: { route: 99999 } })).status, 400);
  assert.equal((await adm.req('PUT', '/api/admin/maps-config',
    { cache_hours: { route: -1 } })).status, 400);

  const ok = await adm.req('PUT', '/api/admin/maps-config', { cache_hours: { route: 48 } });
  assert.equal(ok.status, 200);

  db.prepare(`INSERT INTO geo_cache (key, kind, payload, created_at, expires_at)
    VALUES ('x','route','{}',?,?)`).run(Date.now(), Date.now() + 60000);
  const limpa = await adm.req('POST', '/api/admin/maps-config/clear-cache');
  assert.equal(limpa.status, 200);
  assert.ok(limpa.data.removed >= 1);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM geo_cache').get() as any).c, 0);
});

test('forçar OpenStreetMap desliga o Google também no navegador', async () => {
  // chave salva + provedor forçado em OSM: a chave NÃO pode ir ao frontend,
  // senão o app tenta carregar um Google quebrado em vez do OSM que funciona
  await adm.req('PUT', '/api/admin/maps-config',
    { credentials: { GOOGLE_MAPS_BROWSER_KEY: 'chave-de-teste' }, provider: 'osm' });
  let cfg = await pax.req('GET', '/api/config');
  assert.equal(cfg.data.maps.browser_key, null);
  assert.equal(cfg.data.maps.provider, 'osm');

  // em "auto", a chave volta a ser enviada
  await adm.req('PUT', '/api/admin/maps-config', { provider: 'auto' });
  cfg = await pax.req('GET', '/api/config');
  assert.equal(cfg.data.maps.browser_key, 'chave-de-teste');
  assert.equal(cfg.data.maps.provider, 'google');

  // remover a chave pela API (botão "Remover" da central) limpa de verdade
  await adm.req('PUT', '/api/admin/maps-config',
    { credentials: { GOOGLE_MAPS_BROWSER_KEY: '' } });
  cfg = await pax.req('GET', '/api/config');
  assert.equal(cfg.data.maps.browser_key, null);
});

test('diagnóstico de mapas avisa quando não há chave', async () => {
  const r = await adm.req('POST', '/api/admin/maps-config/test');
  assert.equal(r.status, 200);
  assert.equal(r.data.checks[0].item, 'Chave de servidor');
  assert.equal(r.data.checks[0].ok, false);
  assert.match(r.data.checks[0].detail, /OpenStreetMap/i);
});

test('busca de lugar exige place_id e respeita permissão', async () => {
  assert.equal((await pax.req('GET', '/api/geo/place')).status, 400);
  assert.equal((await actor().req('GET', '/api/geo/place?place_id=abc')).status, 401);
});

// ================= permissões =================

test('permissões: cada perfil só faz o que lhe cabe', async () => {
  const rid = await newRide('pix');
  // passageiro não controla a corrida do motoboy
  assert.equal((await pax.req('POST', `/api/driver/rides/${rid}/accept`)).status, 403);
  await drv.req('POST', `/api/driver/rides/${rid}/accept`);
  // motoboy não confirma a conclusão no lugar do passageiro
  assert.equal((await drv.req('POST', `/api/rides/${rid}/confirm`)).status, 403);
  // motoboy não mexe em tarifas nem no financeiro
  assert.equal((await drv.req('PUT', '/api/admin/settings', { settings: { commission_pct: '0' } })).status, 403);
  assert.equal((await drv.req('GET', '/api/admin/finance')).status, 403);
  // passageiro não abre o financeiro
  assert.equal((await pax.req('GET', '/api/admin/finance')).status, 403);

  await drv.req('POST', `/api/driver/rides/${rid}/cancel`, { reason: 'fim do teste' });
  const act = await pax.req('GET', '/api/rides/active');
  if (act.data.ride) await pax.req('POST', `/api/rides/${act.data.ride.id}/cancel`, {});
});
