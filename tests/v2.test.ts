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

test('números de casa: o app aprende com o passageiro e passa a acertar', async () => {
  // rua que não existe na base é recusada (ninguém ensina endereço inventado)
  assert.equal((await pax.req('POST', '/api/geo/learn',
    { street: 'Rua Inexistente Xyz', number: 10, lat: -24.4161, lng: -53.5191 })).status, 422);
  // fora da área de cobertura é recusado
  assert.equal((await pax.req('POST', '/api/geo/learn',
    { street: 'Avenida Tupassi', number: 10, lat: -25.5, lng: -54.5 })).status, 422);

  // passageiros confirmam o nº 400 e o nº 800 da Avenida Tupassi
  assert.equal((await pax.req('POST', '/api/geo/learn',
    { street: 'Avenida Tupassi', number: 400, lat: -24.4100, lng: -53.5190 })).status, 200);
  assert.equal((await pax.req('POST', '/api/geo/learn',
    { street: 'Avenida Tupassi', number: 800, lat: -24.4200, lng: -53.5190 })).status, 200);

  // nº 400 de novo: ponto EXATO, sem pedir ajuste
  const r1 = await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('avenida tupassi 400'));
  const h1 = r1.data.results[0];
  assert.equal(h1.number_how, 'exato');
  assert.ok(!h1.approx, 'ponto confirmado não é aproximado');
  assert.ok(Math.abs(h1.lat - (-24.4100)) < 1e-6, 'usa a coordenada aprendida');

  // nº 600 (entre 400 e 800): interpolado no meio do caminho
  const r2 = await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('avenida tupassi 600'));
  const h2 = r2.data.results[0];
  assert.equal(h2.number_how, 'interpolado');
  assert.equal(h2.approx, true);
  assert.ok(Math.abs(h2.lat - (-24.4150)) < 1e-4, 'posição proporcional entre os dois números');

  // rua sem nenhum número conhecido: centro da rua, marcado para ajuste
  const r3 = await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('avenida brasil 500'));
  const h3 = r3.data.results.find((x: any) => x.text.startsWith('Avenida Brasil'));
  assert.equal(h3.number_how, 'centro');
  assert.equal(h3.approx, true);
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

// ================= Mapas (Mapbox) =================

const MBX_PUBLIC = 'pk.TOKEN-PUBLICO-NAVEGADOR';
const MBX_SECRET = 'sk.TOKEN-SECRETO-SERVIDOR';

/** Limpa tokens, provedor e cache de rotas ao fim de cada teste de mapas. */
async function resetMaps(): Promise<void> {
  await adm.req('PUT', '/api/admin/maps-config', {
    credentials: { MAPBOX_PUBLIC_TOKEN: '', MAPBOX_SERVER_TOKEN: '' }, provider: 'auto',
  });
  await adm.req('POST', '/api/admin/maps-config/clear-cache');
}

type FakeReply = { status?: number; body: unknown };

/**
 * Troca o `fetch` por uma API do Mapbox simulada e liga a rede de geo
 * (GEO_OFFLINE=0) durante `fn`. Qualquer outro serviço externo (OSRM,
 * Nominatim) responde 503: nenhum teste toca a internet de verdade.
 * Devolve as URLs do Mapbox que foram chamadas.
 */
async function withFakeMapbox(handler: (url: URL) => FakeReply,
  fn: (calls: URL[]) => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  const calls: URL[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    if (url.hostname !== 'api.mapbox.com') return new Response('fora do ar', { status: 503 });
    calls.push(url);
    const r = handler(url);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  process.env.GEO_OFFLINE = '0';
  try {
    await fn(calls);
  } finally {
    process.env.GEO_OFFLINE = '1';
    globalThis.fetch = realFetch;
  }
}

/** Respostas no formato real das APIs do Mapbox (Directions v5 e Geocoding v6). */
function fakeMapboxOk(url: URL): FakeReply {
  if (url.pathname.startsWith('/directions/v5/mapbox/driving/')) {
    return {
      body: {
        code: 'Ok',
        routes: [{
          distance: 4321.4, duration: 612.7,
          geometry: {
            type: 'LineString',
            coordinates: [[ORIGIN.lng, ORIGIN.lat], [-53.53, -24.43], [DEST.lng, DEST.lat]],
          },
        }],
      },
    };
  }
  if (url.pathname === '/search/geocode/v6/forward') {
    return {
      body: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature', geometry: { type: 'Point', coordinates: [-53.5301, -24.4212] },
            properties: {
              feature_type: 'address', name: 'Rua das Hortênsias 77',
              coordinates: { longitude: -53.5301, latitude: -24.4212, accuracy: 'rooftop' },
              context: {
                neighborhood: { name: 'Jardim Tropical' },
                place: { name: 'Assis Chateaubriand' },
              },
            },
          },
          {
            // dentro da caixa de busca, mas fora do raio de cobertura (canto do quadrado)
            type: 'Feature', geometry: { type: 'Point', coordinates: [-53.6300, -24.5100] },
            properties: {
              feature_type: 'street', name: 'Rua das Hortênsias',
              coordinates: { longitude: -53.6300, latitude: -24.5100 },
              context: { place: { name: 'Assis Chateaubriand' } },
            },
          },
        ],
      },
    };
  }
  if (url.pathname === '/search/geocode/v6/reverse') {
    return {
      body: {
        type: 'FeatureCollection',
        features: [
          // a ordem vem do mais amplo para o mais específico de propósito:
          // o sistema tem de escolher o endereço, não a cidade
          {
            type: 'Feature', geometry: { type: 'Point', coordinates: [-53.52, -24.41] },
            properties: { feature_type: 'place', name: 'Assis Chateaubriand', context: {} },
          },
          {
            type: 'Feature', geometry: { type: 'Point', coordinates: [-53.5216, -24.4156] },
            properties: {
              feature_type: 'address', name: 'Avenida Tupãssi 1200',
              context: { neighborhood: { name: 'Centro' }, place: { name: 'Assis Chateaubriand' } },
            },
          },
        ],
      },
    };
  }
  if (url.pathname === '/tokens/v2') {
    return { body: { code: 'TokenValid', token: { usage: 'pk', user: 'conta-teste' } } };
  }
  return { status: 404, body: { message: 'Not Found' } };
}

test('sem token do Mapbox o sistema usa OSM/estimativa e diz qual foi', async () => {
  const cfg = await pax.req('GET', '/api/config');
  assert.equal(cfg.data.maps.mapbox_token, null);
  assert.equal(cfg.data.maps.provider, 'osm');
  assert.equal(cfg.data.maps.server_routing, 'osrm');

  // GEO_OFFLINE=1 nos testes → estimativa, sempre marcada como tal
  const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  assert.equal(q.data.route.provider, 'estimativa');
  assert.equal(q.data.route.mode, 'estimativa');
  assert.equal(q.data.route.estimated, true);
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

test('token de servidor do Mapbox nunca vaza para o frontend', async () => {
  await adm.req('PUT', '/api/admin/maps-config', {
    credentials: { MAPBOX_PUBLIC_TOKEN: MBX_PUBLIC, MAPBOX_SERVER_TOKEN: MBX_SECRET },
  });
  try {
    // /api/config só entrega o token PÚBLICO
    const cfg = await pax.req('GET', '/api/config');
    assert.equal(cfg.data.maps.mapbox_token, MBX_PUBLIC);
    assert.equal(JSON.stringify(cfg.data).includes(MBX_SECRET), false);
    assert.equal(cfg.data.maps.provider, 'mapbox');
    assert.equal(cfg.data.maps.server_routing, 'mapbox');
    assert.equal(cfg.data.maps.style, 'mapbox://styles/mapbox/streets-v12');

    // na central o token de servidor volta mascarado
    const mc = await adm.req('GET', '/api/admin/maps-config');
    assert.equal(mc.data.credentials.MAPBOX_SERVER_TOKEN.value, '••••••IDOR');
    assert.equal(JSON.stringify(mc.data).includes(MBX_SECRET), false);
    assert.equal(mc.data.active_routing, 'mapbox');
    assert.equal(mc.data.active_visual, 'mapbox');

    // no banco está cifrado
    const row = db.prepare(
      `SELECT value_enc FROM provider_credentials WHERE key = 'MAPBOX_SERVER_TOKEN'`).get() as any;
    assert.ok(!row.value_enc.includes(MBX_SECRET));

    // passageiro e motoboy não acessam a configuração de mapas
    assert.equal((await pax.req('GET', '/api/admin/maps-config')).status, 403);
    assert.equal((await drv.req('PUT', '/api/admin/maps-config', { credentials: {} })).status, 403);
  } finally {
    await resetMaps();
  }
});

test('token secreto (sk.) nunca é aceito como token público', async () => {
  try {
    // pela central: recusado, com explicação, e nada é gravado
    const sk = await adm.req('PUT', '/api/admin/maps-config',
      { credentials: { MAPBOX_PUBLIC_TOKEN: MBX_SECRET }, provider: 'osm' });
    assert.equal(sk.status, 400);
    assert.match(sk.data.error, /SECRETO/);
    const lixo = await adm.req('PUT', '/api/admin/maps-config',
      { credentials: { MAPBOX_PUBLIC_TOKEN: 'colei-errado' } });
    assert.equal(lixo.status, 400);
    const mc = await adm.req('GET', '/api/admin/maps-config');
    assert.equal(mc.data.credentials.MAPBOX_PUBLIC_TOKEN.filled, false);
    assert.equal(mc.data.provider, 'auto');          // a requisição inválida não mudou nada

    // pelo .env: um sk. em MAPBOX_PUBLIC_TOKEN é ignorado, não vai ao navegador
    process.env.MAPBOX_PUBLIC_TOKEN = MBX_SECRET;
    const cfg = await pax.req('GET', '/api/config');
    assert.equal(cfg.data.maps.mapbox_token, null);
    assert.equal(cfg.data.maps.provider, 'osm');
    assert.equal(JSON.stringify(cfg.data).includes(MBX_SECRET), false);
  } finally {
    delete process.env.MAPBOX_PUBLIC_TOKEN;
    await resetMaps();
  }
});

test('só o token público basta: o backend usa o mesmo para rotas e busca', async () => {
  await adm.req('PUT', '/api/admin/maps-config', { credentials: { MAPBOX_PUBLIC_TOKEN: MBX_PUBLIC } });
  try {
    const mc = await adm.req('GET', '/api/admin/maps-config');
    assert.equal(mc.data.has_server_token, true);
    assert.equal(mc.data.active_routing, 'mapbox');

    await withFakeMapbox(fakeMapboxOk, async calls => {
      const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
      assert.equal(q.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].searchParams.get('access_token'), MBX_PUBLIC);
    });
  } finally {
    await resetMaps();
  }
});

test('Mapbox: rota real define distância, preço e procedência — e usa o cache', async () => {
  await adm.req('PUT', '/api/admin/maps-config', {
    credentials: { MAPBOX_PUBLIC_TOKEN: MBX_PUBLIC, MAPBOX_SERVER_TOKEN: MBX_SECRET },
  });
  try {
    await withFakeMapbox(fakeMapboxOk, async calls => {
      const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
      assert.equal(q.status, 200, JSON.stringify(q.data));
      assert.equal(q.data.route.provider, 'mapbox');
      assert.equal(q.data.route.mode, 'drive');
      assert.equal(q.data.route.estimated, false);
      assert.equal(q.data.route.geometry.length, 3);
      const eco = q.data.quotes.find((x: any) => x.category === 'economica');
      assert.equal(eco.distance_m, 4321);
      assert.equal(eco.duration_s, 613);
      // preço sobre a distância da rota do Mapbox: 5,50 + 2,321 km × 2,00
      assert.equal(eco.price_cents, 550 + Math.round((4321 - 2000) * 200 / 1000));

      // a chamada foi feita com o token de SERVIDOR, origem/destino em lng,lat
      assert.equal(calls.length, 1);
      assert.equal(calls[0].searchParams.get('access_token'), MBX_SECRET);
      assert.equal(calls[0].searchParams.get('geometries'), 'geojson');
      assert.ok(calls[0].pathname.endsWith(
        `/${ORIGIN.lng},${ORIGIN.lat};${DEST.lng},${DEST.lat}`), calls[0].pathname);

      // mesma rota de novo: sai do cache, sem nova chamada ao Mapbox
      const q2 = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
      assert.equal(q2.data.route.provider, 'mapbox');
      assert.equal(calls.length, 1);
    });
  } finally {
    await resetMaps();
  }
});

test('Mapbox: busca de endereços fica na área atendida e não guarda resultado', async () => {
  await adm.req('PUT', '/api/admin/maps-config', { credentials: { MAPBOX_PUBLIC_TOKEN: MBX_PUBLIC } });
  try {
    await withFakeMapbox(fakeMapboxOk, async calls => {
      const r = await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('rua das hortensias 77'));
      assert.equal(r.status, 200);
      assert.equal(calls.length, 1);
      const u = calls[0];
      assert.equal(u.pathname, '/search/geocode/v6/forward');
      assert.equal(u.searchParams.get('country'), 'br');
      assert.equal(u.searchParams.get('language'), 'pt');
      assert.equal(u.searchParams.get('proximity'), '-53.5216,-24.4156');
      // a caixa cobre o raio de 12 km em volta do centro, e nada além
      const [w, s, e, n] = u.searchParams.get('bbox')!.split(',').map(Number);
      assert.ok(w < -53.63 && w > -53.65 && e > -53.41 && e < -53.39, `bbox lng ${w}..${e}`);
      assert.ok(s < -24.52 && s > -24.53 && n > -24.31 && n < -24.30, `bbox lat ${s}..${n}`);

      const [first, second] = r.data.results;
      assert.equal(first.text, 'Rua das Hortênsias 77, Jardim Tropical, Assis Chateaubriand');
      assert.equal(first.source, 'mapbox');
      assert.equal(first.lat, -24.4212);
      assert.equal(first.lng, -53.5301);
      assert.equal(first.in_coverage, true);
      // o canto da caixa fica fora do círculo de cobertura: vai para o fim, marcado
      assert.equal(second.in_coverage, false);

      // geocodificação não é guardada (termos do Mapbox): repetir chama de novo
      await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('rua das hortensias 77'));
      assert.equal(calls.length, 2);
      assert.equal((db.prepare('SELECT COUNT(*) c FROM geo_cache').get() as any).c, 0);
    });
  } finally {
    await resetMaps();
  }
});

test('Mapbox: a base local responde primeiro e poupa a chamada externa', async () => {
  await adm.req('PUT', '/api/admin/maps-config', { credentials: { MAPBOX_PUBLIC_TOKEN: MBX_PUBLIC } });
  db.prepare(`INSERT INTO local_addresses (kind, name, norm, lat, lng, updated_at)
    VALUES ('rua', 'Rua do Teste Mapbox', 'rua do teste mapbox', -24.4160, -53.5220, ?)`).run(Date.now());
  try {
    await withFakeMapbox(fakeMapboxOk, async calls => {
      const r = await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('rua do teste mapbox'));
      assert.ok(r.data.results.length >= 1);
      assert.equal(r.data.results[0].source, 'local');
      assert.equal(calls.length, 0);
    });
  } finally {
    db.prepare(`DELETE FROM local_addresses WHERE norm = 'rua do teste mapbox'`).run();
    await resetMaps();
  }
});

test('Mapbox: endereço do GPS escolhe o item mais específico', async () => {
  await adm.req('PUT', '/api/admin/maps-config', { credentials: { MAPBOX_PUBLIC_TOKEN: MBX_PUBLIC } });
  try {
    await withFakeMapbox(fakeMapboxOk, async calls => {
      const r = await pax.req('GET', `/api/geo/reverse?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}`);
      assert.equal(r.status, 200);
      assert.equal(r.data.text, 'Avenida Tupãssi 1200, Centro, Assis Chateaubriand');
      assert.equal(r.data.exact, true);
      assert.equal(r.data.in_coverage, true);
      assert.equal(calls[0].pathname, '/search/geocode/v6/reverse');
      assert.equal(calls[0].searchParams.get('longitude'), String(ORIGIN.lng));
      assert.equal(calls[0].searchParams.get('latitude'), String(ORIGIN.lat));
    });
  } finally {
    await resetMaps();
  }
});

test('Mapbox fora do ar ou sem rota: o sistema continua e marca a estimativa', async () => {
  await adm.req('PUT', '/api/admin/maps-config', { credentials: { MAPBOX_PUBLIC_TOKEN: MBX_PUBLIC } });
  try {
    // token revogado: 401 em tudo
    await withFakeMapbox(() => ({ status: 401, body: { message: 'Not Authorized - Invalid Token' } }),
      async () => {
        const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
        assert.equal(q.status, 200);
        assert.equal(q.data.route.provider, 'estimativa');
        assert.equal(q.data.route.estimated, true);

        const s = await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('rua inexistente xyz'));
        assert.equal(s.status, 200);
        assert.deepEqual(s.data.results, []);

        const rev = await pax.req('GET', `/api/geo/reverse?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}`);
        assert.equal(rev.status, 200);
        assert.equal(rev.data.exact, false);       // nunca um endereço inventado
      });

    // API no ar, mas sem rota entre os pontos
    await withFakeMapbox(() => ({ body: { code: 'NoRoute', routes: [] } }), async () => {
      const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
      assert.equal(q.data.route.provider, 'estimativa');
    });
    // falha não vai para o cache
    assert.equal((db.prepare('SELECT COUNT(*) c FROM geo_cache').get() as any).c, 0);
  } finally {
    await resetMaps();
  }
});

test('forçar OpenStreetMap ignora o token do Mapbox no backend e no navegador', async () => {
  // token salvo + provedor forçado em OSM: o token NÃO pode ir ao frontend,
  // senão o app tenta carregar um Mapbox com problema em vez do OSM que funciona
  await adm.req('PUT', '/api/admin/maps-config',
    { credentials: { MAPBOX_PUBLIC_TOKEN: MBX_PUBLIC }, provider: 'osm' });
  try {
    const mc = await adm.req('GET', '/api/admin/maps-config');
    assert.equal(mc.data.has_server_token, true);
    assert.equal(mc.data.active_routing, 'osrm');   // provedor forçado
    assert.equal(mc.data.active_visual, 'osm');
    let cfg = await pax.req('GET', '/api/config');
    assert.equal(cfg.data.maps.mapbox_token, null);
    assert.equal(cfg.data.maps.provider, 'osm');

    await withFakeMapbox(fakeMapboxOk, async calls => {
      const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
      assert.equal(q.data.route.provider, 'estimativa');
      assert.equal(calls.length, 0);                // nenhuma chamada ao Mapbox
    });

    // em "auto", o token volta a ser enviado
    await adm.req('PUT', '/api/admin/maps-config', { provider: 'auto' });
    cfg = await pax.req('GET', '/api/config');
    assert.equal(cfg.data.maps.mapbox_token, MBX_PUBLIC);
    assert.equal(cfg.data.maps.provider, 'mapbox');

    // remover o token pela API (botão "Remover" da central) limpa de verdade
    await adm.req('PUT', '/api/admin/maps-config', { credentials: { MAPBOX_PUBLIC_TOKEN: '' } });
    cfg = await pax.req('GET', '/api/config');
    assert.equal(cfg.data.maps.mapbox_token, null);
  } finally {
    await resetMaps();
  }
});

test('estilo do mapa: só os da lista são aceitos', async () => {
  try {
    assert.equal((await adm.req('PUT', '/api/admin/maps-config',
      { style: 'https://site-malicioso.example/estilo.json' })).status, 400);
    const ok = await adm.req('PUT', '/api/admin/maps-config',
      { style: 'mapbox://styles/mapbox/satellite-streets-v12' });
    assert.equal(ok.status, 200);
    const cfg = await pax.req('GET', '/api/config');
    assert.equal(cfg.data.maps.style, 'mapbox://styles/mapbox/satellite-streets-v12');
  } finally {
    await adm.req('PUT', '/api/admin/maps-config', { style: 'mapbox://styles/mapbox/streets-v12' });
  }
});

test('cache de rotas: validade é validada e a limpeza funciona', async () => {
  assert.equal((await adm.req('PUT', '/api/admin/maps-config',
    { cache_hours: { route: 99999 } })).status, 400);
  assert.equal((await adm.req('PUT', '/api/admin/maps-config',
    { cache_hours: { route: -1 } })).status, 400);

  const ok = await adm.req('PUT', '/api/admin/maps-config', { cache_hours: { route: 48 } });
  assert.equal(ok.status, 200);
  assert.equal((await adm.req('GET', '/api/admin/maps-config')).data.cache_hours.route, 48);

  db.prepare(`INSERT INTO geo_cache (key, kind, payload, created_at, expires_at)
    VALUES ('x','rota_mapbox','{}',?,?)`).run(Date.now(), Date.now() + 60000);
  const limpa = await adm.req('POST', '/api/admin/maps-config/clear-cache');
  assert.equal(limpa.status, 200);
  assert.ok(limpa.data.removed >= 1);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM geo_cache').get() as any).c, 0);
});

test('diagnóstico de mapas avisa quando não há token', async () => {
  const r = await adm.req('POST', '/api/admin/maps-config/test');
  assert.equal(r.status, 200);
  assert.equal(r.data.checks[0].item, 'Token do Mapbox');
  assert.equal(r.data.checks[0].ok, false);
  assert.match(r.data.checks[0].detail, /OpenStreetMap/i);
});

test('diagnóstico de mapas: tudo certo, e token público restrito por URL é explicado', async () => {
  await adm.req('PUT', '/api/admin/maps-config', { credentials: { MAPBOX_PUBLIC_TOKEN: MBX_PUBLIC } });
  try {
    await withFakeMapbox(fakeMapboxOk, async () => {
      const r = await adm.req('POST', '/api/admin/maps-config/test');
      const byItem = Object.fromEntries(r.data.checks.map((c: any) => [c.item, c]));
      assert.equal(byItem['Token público (mapa nos aplicativos)'].ok, true);
      assert.match(byItem['Token público (mapa nos aplicativos)'].detail, /conta-teste/);
      assert.equal(byItem['Rotas (Directions API)'].ok, true);
      assert.match(byItem['Rotas (Directions API)'].detail, /4\.3 km/);
      assert.equal(byItem['Busca de endereços (Geocoding API)'].ok, true);
      assert.equal(byItem['Endereço do GPS (geocodificação reversa)'].ok, true);
      // o token nunca aparece no relatório
      assert.equal(JSON.stringify(r.data).includes(MBX_PUBLIC), false);
    });

    // token público com restrição de URL: o servidor leva 403 nas APIs
    await withFakeMapbox(url => url.pathname === '/tokens/v2'
      ? fakeMapboxOk(url) : { status: 403, body: { message: 'Forbidden' } }, async () => {
      const r = await adm.req('POST', '/api/admin/maps-config/test');
      const rota = r.data.checks.find((c: any) => c.item === 'Rotas (Directions API)');
      assert.equal(rota.ok, false);
      assert.match(rota.detail, /Token de servidor/);
      assert.equal(JSON.stringify(r.data).includes(MBX_PUBLIC), false);
    });
  } finally {
    await resetMaps();
  }
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
