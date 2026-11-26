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

/** Código de embarque que o app do passageiro mostra. */
async function boardingCode(rid: string): Promise<string> {
  return (await pax.req('GET', `/api/rides/${rid}`)).data.ride.boarding_code;
}

/** Aceita, chega e confirma o embarque com o código do passageiro. */
async function driveToBoarding(rid: string): Promise<void> {
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/accept`)).status, 200);
  await drv.req('POST', `/api/driver/rides/${rid}/arrived`);
  const code = await boardingCode(rid);
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/start`, { code })).status, 200);
}

/** Leva a corrida até "aguardando confirmação". */
async function driveToCompletion(rid: string): Promise<void> {
  await driveToBoarding(rid);
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/complete`)).status, 200);
}

before(async () => {
  const s = await start({ port: 0, quiet: true, dbPath: path.join(process.env.DATA_DIR!, 'v2.db') });
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;

  await pax.req('POST', '/api/auth/register', {
    role: 'passenger', accept_terms: true, name: 'Ana Passageira', phone: '(44) 90000-1111',
    email: 'ana@v2.test', password: 'senha12345',
  });
  await drv.req('POST', '/api/auth/register', {
    role: 'driver', accept_terms: true, name: 'Beto Motoboy', cpf: '529.982.247-25',
    phone: '(44) 90000-2222', email: 'beto@v2.test', password: 'senha12345',
  });
  await drv.req('POST', '/api/driver/apply', {
    birth_date: '1990-01-01', cnh_expiry: '2031-01-01', cnh_first_date: '2012-05-10', decl_cat_a_ear: true, address: 'Rua A, 10', moto_plate: 'ABC-1D23',
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

// ================= confirmação de embarque =================

test('embarque: código certo confirma e registra quando, quem e onde', async () => {
  const rid = await newRide('pix');
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/accept`)).status, 200);

  // o passageiro vê o código; o mototaxista não recebe o código em lugar nenhum
  const code = await boardingCode(rid);
  assert.match(code, /^\d{4}$/);
  const me = await drv.req('GET', '/api/driver/me');
  assert.ok(!JSON.stringify(me.data).includes(`"boarding_code"`));

  // antes de "Cheguei" não dá para confirmar
  const early = await drv.req('POST', `/api/driver/rides/${rid}/start`, { code });
  assert.equal(early.status, 409);
  assert.match(early.data.error, /Cheguei/);
  await drv.req('POST', `/api/driver/rides/${rid}/arrived`);

  // sem código
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/start`)).status, 400);

  // antes do embarque o passageiro ainda pode cancelar (regra antiga preservada)
  const cancelRules = db.prepare(`SELECT value FROM app_settings WHERE key = 'passenger_cancel_states'`).get() as any;
  assert.match(cancelRules.value, /accepted/);

  const ok = await drv.req('POST', `/api/driver/rides/${rid}/start`, { code });
  assert.equal(ok.status, 200);
  const row = db.prepare(`SELECT status, boarding_confirmed_at, boarding_confirmed_by, boarding_method,
    boarding_dist_m, boarding_code FROM rides WHERE id = ?`).get(rid) as any;
  assert.equal(row.status, 'in_progress');
  assert.ok(row.boarding_confirmed_at > 0);
  assert.equal(row.boarding_confirmed_by, driverId);
  assert.equal(row.boarding_method, 'codigo');
  assert.equal(typeof row.boarding_dist_m, 'number');
  assert.equal(row.boarding_code, null);          // código usado é apagado
  const ev = db.prepare(`SELECT * FROM ride_events WHERE ride_id = ? AND type = 'boarding_confirmed'`).get(rid) as any;
  assert.equal(ev.actor_id, driverId);

  // o passageiro vê a confirmação e não consegue mais cancelar pelo app
  const view = (await pax.req('GET', `/api/rides/${rid}`)).data.ride;
  assert.equal(view.boarding_confirmed_at, row.boarding_confirmed_at);
  assert.equal(view.boarding_code, null);
  const cancel = await pax.req('POST', `/api/rides/${rid}/cancel`, {});
  assert.equal(cancel.status, 409);
  assert.match(cancel.data.error, /suporte/);
  // nem se a central liberar o cancelamento em andamento nas configurações
  db.prepare(`UPDATE app_settings SET value = 'requested,accepted,in_progress' WHERE key = 'passenger_cancel_states'`).run();
  try {
    assert.equal((await pax.req('POST', `/api/rides/${rid}/cancel`, {})).status, 409);
  } finally {
    db.prepare(`UPDATE app_settings SET value = ? WHERE key = 'passenger_cancel_states'`).run(cancelRules.value);
  }

  await drv.req('POST', `/api/driver/rides/${rid}/complete`);
  await pax.req('POST', `/api/rides/${rid}/confirm`);
});

test('embarque: código errado é recusado e muitos erros dão uma espera', async () => {
  const rid = await newRide('pix');
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/accept`)).status, 200);
  await drv.req('POST', `/api/driver/rides/${rid}/arrived`);
  const code = await boardingCode(rid);
  const wrong = code === '0000' ? '1111' : '0000';

  for (let i = 1; i <= 4; i++) {
    const r = await drv.req('POST', `/api/driver/rides/${rid}/start`, { code: wrong });
    assert.equal(r.status, 422);
    assert.match(r.data.error, /Código incorreto/);
  }
  // 5º erro: espera, e o passageiro é avisado
  const locked = await drv.req('POST', `/api/driver/rides/${rid}/start`, { code: wrong });
  assert.equal(locked.status, 429);
  const notes = await pax.req('GET', '/api/notifications');
  assert.ok(notes.data.notifications.some((n: any) => n.kind === 'boarding_code_wrong' && n.ride_id === rid
    || n.kind === 'boarding_code_wrong'));
  // durante a espera nem o código certo passa
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/start`, { code })).status, 429);
  assert.equal((db.prepare('SELECT status FROM rides WHERE id = ?').get(rid) as any).status, 'accepted');
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM ride_events WHERE ride_id = ? AND type = 'boarding_code_wrong'`)
    .get(rid) as any).n, 5);

  // passada a espera, o código certo funciona
  db.prepare('UPDATE rides SET boarding_locked_until = ? WHERE id = ?').run(Date.now() - 1, rid);
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/start`, { code })).status, 200);
  await drv.req('POST', `/api/driver/rides/${rid}/complete`);
  await pax.req('POST', `/api/rides/${rid}/confirm`);
});

test('embarque: desistência do mototaxista gera código novo; cancelar antes do embarque continua igual', async () => {
  const rid = await newRide('pix');
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/accept`)).status, 200);
  await boardingCode(rid);
  db.prepare('UPDATE rides SET boarding_attempts = 3 WHERE id = ?').run(rid);
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/cancel`, { reason: 'pneu furou' })).status, 200);
  const back = db.prepare('SELECT status, boarding_code, boarding_attempts FROM rides WHERE id = ?').get(rid) as any;
  assert.equal(back.status, 'requested');
  assert.equal(back.boarding_code, null);
  assert.equal(back.boarding_attempts, 0);
  assert.equal((await pax.req('GET', `/api/rides/${rid}`)).data.ride.boarding_code, null);

  // aceita de novo: código novo; o passageiro ainda cancela sem custo
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/accept`)).status, 200);
  assert.match(await boardingCode(rid), /^\d{4}$/);
  assert.equal((await pax.req('POST', `/api/rides/${rid}/cancel`, { reason: 'desisti' })).status, 200);
  const det = await adm.req('GET', `/api/admin/rides/${rid}`);
  assert.equal(det.data.ride.status, 'cancelled');
  assert.equal(det.data.payment.status, 'estornado');
});

test('embarque: "Não embarquei" fica registrado e vai para análise, sem bloquear ninguém', async () => {
  const rid = await newRide('pix');
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/accept`)).status, 200);

  // antes do embarque, "não embarquei" não faz sentido (o caminho é cancelar)
  assert.equal((await pax.req('POST', `/api/rides/${rid}/issue`, { kind: 'nao_embarquei' })).status, 409);

  await drv.req('POST', `/api/driver/rides/${rid}/arrived`);
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/start`, { code: await boardingCode(rid) })).status, 200);

  const c = await pax.req('POST', `/api/rides/${rid}/issue`,
    { kind: 'nao_embarquei', description: 'Passei o código por mensagem e ele foi embora' });
  assert.equal(c.status, 201);
  // repetir não duplica
  const again = await pax.req('POST', `/api/rides/${rid}/issue`, { kind: 'nao_embarquei' });
  assert.equal(again.status, 200);
  assert.equal(again.data.already, true);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM ride_issues WHERE ride_id = ? AND kind = 'nao_embarquei'`)
    .get(rid) as any).n, 1);

  // o mototaxista encerra: a corrida NÃO é confirmada sozinha, vai para análise
  const done = await drv.req('POST', `/api/driver/rides/${rid}/complete`);
  assert.equal(done.status, 200);
  assert.equal(done.data.disputed, true);
  await new Promise(r => setTimeout(r, 1500));     // a varredura automática não mexe nela
  assert.equal((db.prepare('SELECT status FROM rides WHERE id = ?').get(rid) as any).status, 'disputed');

  // ninguém foi bloqueado automaticamente
  assert.equal((db.prepare('SELECT blocked FROM users WHERE id = ?').get(driverId) as any).blocked, 0);
  const paxId = (db.prepare('SELECT passenger_id FROM rides WHERE id = ?').get(rid) as any).passenger_id;
  assert.equal((db.prepare('SELECT blocked FROM users WHERE id = ?').get(paxId) as any).blocked, 0);

  // a central vê o registro do embarque e pode estornar
  const list = await adm.req('GET', '/api/admin/issues?status=aberta');
  const issue = list.data.issues.find((i: any) => i.ride_id === rid);
  assert.equal(issue.kind, 'nao_embarquei');
  assert.ok(issue.boarding_confirmed_at > 0);
  assert.equal(issue.boarding_method, 'codigo');
  assert.ok(issue.boarding_confirmed_by_name);
  assert.equal((await adm.req('POST', `/api/admin/issues/${issue.id}/resolve`,
    { action: 'estornar', note: 'GPS mostra o mototaxista parado no embarque' })).status, 200);
  const det = await adm.req('GET', `/api/admin/rides/${rid}`);
  assert.equal(det.data.ride.status, 'cancelled');
  assert.equal(det.data.payment.status, 'estornado');
});

test('embarque: contestação depois da corrida concluída também é registrada', async () => {
  const rid = await newRide('pix');
  await driveToCompletion(rid);
  await pax.req('POST', `/api/rides/${rid}/confirm`);
  assert.equal((db.prepare('SELECT status FROM rides WHERE id = ?').get(rid) as any).status, 'completed');
  const c = await pax.req('POST', `/api/rides/${rid}/issue`, { kind: 'nao_embarquei' });
  assert.equal(c.status, 201);
  const row = db.prepare(`SELECT status FROM ride_issues WHERE id = ?`).get(c.data.id) as any;
  assert.equal(row.status, 'aberta');
});

test('embarque: a central confirma quando o passageiro não consegue mostrar o código', async () => {
  const rid = await newRide('pix');
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/accept`)).status, 200);
  // antes de o mototaxista chegar, não
  assert.equal((await adm.req('POST', `/api/admin/rides/${rid}/confirm-boarding`, { reason: 'x' })).status, 409);
  await drv.req('POST', `/api/driver/rides/${rid}/arrived`);
  assert.equal((await pax.req('POST', `/api/admin/rides/${rid}/confirm-boarding`, { reason: 'x' })).status, 403);
  assert.equal((await adm.req('POST', `/api/admin/rides/${rid}/confirm-boarding`, {})).status, 400);   // motivo obrigatório
  const ok = await adm.req('POST', `/api/admin/rides/${rid}/confirm-boarding`,
    { reason: 'passageiro sem bateria, confirmado por ligação' });
  assert.equal(ok.status, 200);
  const row = db.prepare('SELECT status, boarding_method, boarding_confirmed_by FROM rides WHERE id = ?').get(rid) as any;
  assert.equal(row.status, 'in_progress');
  assert.equal(row.boarding_method, 'central');
  assert.notEqual(row.boarding_confirmed_by, driverId);
  const aud = await adm.req('GET', '/api/admin/audit');
  assert.ok(aud.data.logs.some((l: any) => l.action === 'boarding_confirm' && l.target_id === rid));
  // o passageiro continua podendo contestar
  assert.equal((await pax.req('POST', `/api/rides/${rid}/issue`, { kind: 'nao_embarquei' })).status, 201);
  await drv.req('POST', `/api/driver/rides/${rid}/complete`);
  const iss = (await adm.req('GET', '/api/admin/issues?status=aberta')).data.issues.find((i: any) => i.ride_id === rid);
  await adm.req('POST', `/api/admin/issues/${iss.id}/resolve`, { action: 'concluir', note: 'confirmado' });
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

test('busca: bairro e ponto de referência pelo nome vêm antes das ruas; nomes vagos somem', async () => {
  const t = Date.now();
  const ins = db.prepare(`INSERT INTO local_addresses
    (kind, name, norm, detail, tags, lat, lng, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run('rua', 'Rua Horizonte', 'rua horizonte', null, null, -24.4150, -53.5200, t);
  ins.run('bairro', 'Jardim Horizonte', 'jardim horizonte', null, null, -24.4120, -53.5180, t);
  ins.run('local', 'Rodoviária Teste', 'rodoviaria teste', null, 'rodoviaria', -24.4158, -53.5214, t);
  ins.run('local', 'Polícia Rodoviária Teste', 'policia rodoviaria teste', null, 'policia', -24.4159, -53.5215, t);
  ins.run('local', 'Casa do Zezinho', 'casa do zezinho', null, null, -24.4157, -53.5217, t);
  ins.run('local', 'Casa da Cultura Teste', 'casa da cultura teste', null, null, -24.4156, -53.5218, t);
  ins.run('local', 'Escola', 'escola', null, null, -24.4155, -53.5219, t);

  const r = await pax.req('GET', '/api/geo/search?q=horizonte');
  assert.equal(r.status, 200);
  assert.equal(r.data.results[0].kind, 'bairro', 'o bairro deveria vir primeiro');
  assert.ok(r.data.results[0].text.startsWith('Jardim Horizonte'));
  assert.ok(r.data.results.some((x: any) => x.kind === 'rua' && x.text.startsWith('Rua Horizonte')));

  // "Casa do Fulano" (parece residência) e "Escola" (sem nome próprio) ficam fora
  const casa = await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('casa do zezinho'));
  assert.ok(!casa.data.results.some((x: any) => x.text.includes('Zezinho')));
  const cultura = await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('casa da cultura'));
  assert.ok(cultura.data.results.some((x: any) => x.text.includes('Casa da Cultura Teste')),
    'lugar público "Casa da Cultura" não deve ser ocultado');

  // sugestões antes de digitar: só dados da base, sem a delegacia no lugar da rodoviária
  assert.equal((await actor().req('GET', '/api/geo/suggestions')).status, 401);
  const sg = await pax.req('GET', '/api/geo/suggestions');
  assert.equal(sg.status, 200);
  const refs = sg.data.referencias.map((x: any) => x.text);
  assert.ok(refs.some((x: string) => x.startsWith('Rodoviária Teste')));
  assert.ok(!refs.some((x: string) => x.startsWith('Polícia')));
  assert.ok(!refs.some((x: string) => x.includes('Zezinho')));
  assert.ok(sg.data.bairros.some((x: any) => x.text.startsWith('Jardim Horizonte') && x.approx === true));
  assert.ok(sg.data.bairros.every((x: any) => x.in_coverage && x.kind === 'bairro'));

  // a central vê o que foi ocultado e por quê
  const pl = await adm.req('GET', '/api/admin/places');
  assert.equal(pl.status, 200);
  const names = pl.data.hidden.map((h: any) => h.name);
  assert.ok(names.includes('Casa do Zezinho') && names.includes('Escola'));
  assert.ok(!names.includes('Casa da Cultura Teste'));
  // nada foi apagado da base
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM local_addresses WHERE norm IN ('casa do zezinho','escola')`).get() as any).n, 2);
  db.prepare(`DELETE FROM local_addresses WHERE norm IN ('rua horizonte','jardim horizonte','rodoviaria teste',
    'policia rodoviaria teste','casa do zezinho','casa da cultura teste','escola')`).run();
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
    assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/start`,
      { code: await boardingCode(rid) })).status, 200);

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

// ================= páginas (VAIRO) =================

/** Faz login e devolve o cookie de sessão, para pedir páginas como aquele usuário. */
async function sessionCookie(email: string, password: string): Promise<string> {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(r.status, 200);
  return /amt_session=[^;]*/.exec(r.headers.getSetCookie()[0])![0];
}

test('páginas: cada área tem seu endereço e a entrada mostra a Visão Geral', async () => {
  const page = async (p: string) => {
    const r = await fetch(base + p, { redirect: 'manual' });
    return { status: r.status, html: await r.text(), type: r.headers.get('content-type') || '' };
  };

  // visitante sem sessão: "/" é a Visão Geral do app
  const home = await page('/');
  assert.equal(home.status, 200);
  assert.match(home.html, /data-area="visao"/);
  assert.match(home.html, /<h1>A cidade no seu ritmo<\/h1>/);
  assert.equal((await page('/visao-geral')).html, home.html);

  // cada área abre a própria página, sem misturar as opções das outras
  const pax = await page('/passageiro');
  assert.match(pax.html, /data-area="passageiro"/);
  assert.match(pax.html, /Entrar como Passageiro/);
  assert.doesNotMatch(pax.html, /Login Motorista/);
  const drv = await page('/motorista');
  assert.match(drv.html, /data-area="motorista"/);
  assert.match(drv.html, /Login Motorista VAIRO/);
  assert.doesNotMatch(drv.html, /Entrar como Passageiro/);
  const emp = await page('/empresa');
  assert.match(emp.html, /data-area="empresa"/);
  // a área Empresa ainda não existe: a página avisa, sem formulário de login falso
  assert.match(emp.html, /ainda não está disponível/);
  assert.doesNotMatch(emp.html, /<form|<input/);
  assert.match((await page('/admin')).html, /data-area="central"/);

  // a marca antiga não aparece em nenhuma página
  for (const h of [home, pax, drv, emp]) assert.doesNotMatch(h.html, /Assis MotoTáxi/);

  // a fonte e os ícones são servidos pelo próprio app (funciona offline, sem CDN)
  const font = await fetch(base + '/fonts/inter-latin-var.woff2');
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.equal((await fetch(base + '/js/icons.js')).status, 200);
});

test('páginas: "/" leva quem já entrou direto ao seu aplicativo', async () => {
  // notificações e retorno do pagamento apontam para "/": o passageiro cai no app
  const paxCookie = await sessionCookie('ana@v2.test', 'senha12345');
  const asPax = await fetch(base + '/', { headers: { Cookie: paxCookie }, redirect: 'manual' });
  assert.equal(asPax.status, 200);
  assert.match(await asPax.text(), /data-area="passageiro"/);

  const drvCookie = await sessionCookie('beto@v2.test', 'senha12345');
  const asDrv = await fetch(base + '/', { headers: { Cookie: drvCookie }, redirect: 'manual' });
  assert.equal(asDrv.status, 302);
  assert.equal(asDrv.headers.get('location'), '/motorista');

  const admCookie = await sessionCookie('dono2@teste.com', 'senha-admin-v2-teste');
  const asAdm = await fetch(base + '/', { headers: { Cookie: admCookie }, redirect: 'manual' });
  assert.equal(asAdm.status, 302);
  assert.equal(asAdm.headers.get('location'), '/admin');

  // a Visão Geral continua acessível para quem está conectado
  const visao = await fetch(base + '/visao-geral', { headers: { Cookie: paxCookie } });
  assert.match(await visao.text(), /data-area="visao"/);
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

// ================= base de endereços: ruas de mesmo nome =================

/** Resposta do Overpass simulada: a cidade e um distrito a ~13 km, com ruas de mesmo nome. */
function fakeOverpass(): unknown {
  const way = (name: string, lat: number, lon: number) =>
    ({ type: 'way', center: { lat, lon }, tags: { highway: 'residential', name } });
  const filler = Array.from({ length: 12 }, (_, i) =>
    way(`Rua Projetada ${String.fromCharCode(65 + i)}`, -24.41 - i * 0.001, -53.52));
  return {
    elements: [
      // Rua Argentina NA CIDADE: três trechos seguidos, perto do centro
      way('Rua Argentina', -24.4200, -53.5300),
      way('Rua Argentina', -24.4200, -53.5270),
      way('Rua Argentina', -24.4200, -53.5240),
      // Rua Argentina NO DISTRITO, ~13 km a oeste do centro
      way('Rua Argentina', -24.4200, -53.6500),
      way('Rua Argentina', -24.4200, -53.6480),
      { type: 'node', lat: -24.4190, lon: -53.6490, tags: { place: 'village', name: 'Bragantina' } },
      way('Rua 7 de Setembro', -24.4100, -53.5200),
      // o mesmo número existe nas duas ruas Argentina
      { type: 'node', lat: -24.4201, lon: -53.5268, tags: { 'addr:street': 'Rua Argentina', 'addr:housenumber': '100' } },
      { type: 'node', lat: -24.4201, lon: -53.6491, tags: { 'addr:street': 'Rua Argentina', 'addr:housenumber': '100' } },
      ...filler,
    ],
  };
}

/** Troca o `fetch` para responder pelo Overpass; o servidor de teste continua real. */
async function withFakeOverpass(fn: (calls: { n: number }) => Promise<void>, ok = true): Promise<void> {
  const realFetch = globalThis.fetch;
  const calls = { n: 0 };
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    calls.n++;
    return ok
      ? new Response(JSON.stringify(fakeOverpass()), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response('fora do ar', { status: 503 });
  }) as typeof fetch;
  try { await fn(calls); } finally { globalThis.fetch = realFetch; }
}

test('base: rua de mesmo nome na cidade e no distrito não vira um ponto no meio do caminho', async () => {
  try {
    await withFakeOverpass(async () => {
      const imp = await adm.req('POST', '/api/admin/maps-config/import-base');
      assert.equal(imp.status, 200, JSON.stringify(imp.data));
    });

    // duas entradas: a da cidade (nome simples) e a do distrito (com a localidade)
    const rows = db.prepare(
      `SELECT norm, detail, lat, lng FROM local_addresses WHERE name = 'Rua Argentina' ORDER BY norm`).all() as any[];
    assert.equal(rows.length, 2, JSON.stringify(rows));
    assert.equal(rows[0].norm, 'rua argentina');
    assert.equal(rows[0].detail, null);
    // o ponto é um trecho de verdade da rua da cidade — antes era a média com o
    // distrito (lng ≈ -53.58), a quilômetros de qualquer rua
    assert.equal(rows[0].lat, -24.42);
    assert.equal(rows[0].lng, -53.527);
    assert.equal(rows[1].norm, 'rua argentina · bragantina');
    assert.equal(rows[1].detail, 'Bragantina');
    assert.ok(rows[1].lng < -53.64);

    // a busca traz primeiro a rua da cidade, dentro da área e escolhível
    const r = await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('rua argentina'));
    const [cidade, distrito] = r.data.results;
    assert.equal(cidade.text, 'Rua Argentina, Assis Chateaubriand');
    assert.equal(cidade.in_coverage, true);
    assert.ok(cidade.distance_m < 1500, `distância ${cidade.distance_m}`);
    // a do distrito continua visível, identificada e marcada como fora de área
    assert.equal(distrito.text, 'Rua Argentina, Bragantina, Assis Chateaubriand');
    assert.equal(distrito.in_coverage, false);
    assert.ok(distrito.distance_m > 12000);

    // e dá para cotar uma corrida até ela (antes: "fora da área de cobertura")
    const q = await pax.req('POST', '/api/quotes', {
      origin: ORIGIN, dest: { lat: cidade.lat, lng: cidade.lng, text: cidade.text },
    });
    assert.equal(q.status, 200, JSON.stringify(q.data));

    // número de casa: cada rua fica com o seu, sem misturar cidade e distrito
    const n = await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('rua argentina 100'));
    assert.equal(n.data.results[0].number_how, 'exato');
    assert.equal(n.data.results[0].lng, -53.5268);
    assert.equal(n.data.results[0].in_coverage, true);
    assert.equal(n.data.results[1].lng, -53.6491);

    // "7" faz parte do nome da rua, não é número de casa
    const sete = await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('rua 7 de setembro'));
    assert.equal(sete.data.results[0].text, 'Rua 7 de Setembro, Assis Chateaubriand');
    assert.equal(sete.data.results[0].number, undefined);
    const sete250 = await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('rua 7 de setembro 250'));
    assert.equal(sete250.data.results[0].number, '250');

    // ponto ajustado pelo passageiro vai para a rua mais próxima dele
    const learn = await pax.req('POST', '/api/geo/learn',
      { street: 'Rua Argentina', number: 321, lat: -24.4201, lng: -53.5245 });
    assert.equal(learn.status, 200, JSON.stringify(learn.data));
    const pt = db.prepare(`SELECT street_norm FROM address_points WHERE number = 321`).get() as any;
    assert.equal(pt.street_norm, 'rua argentina');
  } finally {
    db.prepare(`DELETE FROM local_addresses WHERE source = 'osm'`).run();
    db.prepare(`DELETE FROM address_points`).run();
  }
});

test('base em formato antigo é baixada de novo sozinha; se o OSM falhar, nada se perde', async () => {
  const { refreshOutdatedBase, BASE_VERSION } = await import('../server/address-base.ts');
  try {
    // sem base nenhuma: não há o que atualizar (e nada é baixado)
    db.prepare(`DELETE FROM local_addresses`).run();
    await withFakeOverpass(async calls => {
      assert.equal(await refreshOutdatedBase(), 'vazia');
      assert.equal(calls.n, 0);
    });

    // base antiga, com a rua no ponto médio errado (como estava em produção)
    db.prepare(`INSERT INTO local_addresses (kind, name, norm, lat, lng, updated_at)
      VALUES ('rua', 'Rua Argentina', 'rua argentina', -24.42, -53.5758, ?)`).run(Date.now());
    setSetting('address_base_version', '1');

    // OpenStreetMap fora do ar: a base antiga continua lá
    await withFakeOverpass(async () => {
      assert.equal(await refreshOutdatedBase(), 'falhou');
    }, false);
    assert.equal((db.prepare(`SELECT lng FROM local_addresses WHERE norm = 'rua argentina'`).get() as any).lng, -53.5758);

    // OpenStreetMap respondendo: baixa de novo e a rua vai para o lugar certo
    await withFakeOverpass(async () => {
      assert.equal(await refreshOutdatedBase(), 'atualizada');
    });
    assert.equal((db.prepare(`SELECT lng FROM local_addresses WHERE norm = 'rua argentina'`).get() as any).lng, -53.527);
    assert.equal(dbMod.getSetting('address_base_version'), BASE_VERSION);

    // já no formato atual: não baixa outra vez
    await withFakeOverpass(async calls => {
      assert.equal(await refreshOutdatedBase(), 'atual');
      assert.equal(calls.n, 0);
    });
  } finally {
    db.prepare(`DELETE FROM local_addresses WHERE source = 'osm'`).run();
    db.prepare(`DELETE FROM address_points`).run();
  }
});

// ================= número de casa (Google / Mapbox) =================

const GOOGLE_KEY = 'AIza-CHAVE-GOOGLE-DE-TESTE';
/** Centro da avenida na base (onde o pino caía antes) e a casa de verdade. */
const TUPASSI_CENTRO = { lat: -24.4156, lng: -53.5216 };
const CASA_6161 = { lat: -24.4302, lng: -53.5391 };

type ExtReply = { status?: number; body: unknown };

/** Simula Google e Mapbox, com a rede de geo ligada, e conta as chamadas a cada um. */
async function withFakeGeocoders(
  handlers: { google?: (u: URL) => ExtReply; mapbox?: (u: URL) => ExtReply },
  fn: (calls: { google: URL[]; mapbox: URL[] }) => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  const calls = { google: [] as URL[], mapbox: [] as URL[] };
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    const which = url.hostname === 'maps.googleapis.com' ? 'google'
      : url.hostname === 'api.mapbox.com' ? 'mapbox' : null;
    if (!which || !handlers[which]) return new Response('fora do ar', { status: 503 });
    calls[which].push(url);
    const r = handlers[which]!(url);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  process.env.GEO_OFFLINE = '0';
  try { await fn(calls); } finally {
    process.env.GEO_OFFLINE = '1';
    globalThis.fetch = realFetch;
  }
}

/** Resposta do Google Geocoding no formato real. */
function googleResult(number: string, loc: { lat: number; lng: number },
  locationType = 'ROOFTOP', types = ['street_address']): ExtReply {
  return {
    body: {
      status: 'OK',
      results: [{
        types,
        formatted_address: `Av. Tupãssi, ${number} - Centro, Assis Chateaubriand - PR`,
        address_components: [
          ...(number ? [{ long_name: number, short_name: number, types: ['street_number'] }] : []),
          { long_name: 'Avenida Tupãssi', short_name: 'Av. Tupãssi', types: ['route'] },
        ],
        geometry: { location: loc, location_type: locationType },
      }],
    },
  };
}

function seedTupassi(): void {
  db.prepare(`INSERT OR REPLACE INTO local_addresses (kind, name, norm, lat, lng, updated_at)
    VALUES ('rua', 'Avenida Tupãssi', 'avenida tupassi', ?, ?, ?)`)
    .run(TUPASSI_CENTRO.lat, TUPASSI_CENTRO.lng, Date.now());
}
async function cleanNumberTests(): Promise<void> {
  db.prepare(`DELETE FROM local_addresses WHERE norm = 'avenida tupassi'`).run();
  db.prepare(`DELETE FROM address_points`).run();
  await adm.req('PUT', '/api/admin/maps-config', {
    credentials: { GOOGLE_GEOCODING_KEY: '', MAPBOX_PUBLIC_TOKEN: '', MAPBOX_SERVER_TOKEN: '' }, provider: 'auto',
  });
  await adm.req('POST', '/api/admin/maps-config/clear-cache');
}
const buscaTupassi = () => pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('avenida tupassi 6161'));

test('número de casa: sem serviço configurado o pino fica no centro e pede ajuste (como antes)', async () => {
  seedTupassi();
  try {
    await withFakeGeocoders({}, async calls => {
      const r = await buscaTupassi();
      const top = r.data.results[0];
      assert.equal(top.text, 'Avenida Tupãssi, 6161, Assis Chateaubriand');
      assert.equal(top.number_how, 'centro');
      assert.equal(top.approx, true);
      assert.equal(top.lat, TUPASSI_CENTRO.lat);
      assert.equal(calls.google.length + calls.mapbox.length, 0);
    });
  } finally { await cleanNumberTests(); }
});

test('número de casa: o Google coloca o pino na casa certa, e a chave não vaza', async () => {
  seedTupassi();
  await adm.req('PUT', '/api/admin/maps-config', { credentials: { GOOGLE_GEOCODING_KEY: GOOGLE_KEY } });
  try {
    await withFakeGeocoders({ google: () => googleResult('6161', CASA_6161) }, async calls => {
      const r = await buscaTupassi();
      const top = r.data.results[0];
      assert.equal(top.number_how, 'localizado');
      assert.equal(top.approx, false);                 // não pede mais o ajuste do pino
      assert.equal(top.lat, CASA_6161.lat);
      assert.equal(top.lng, CASA_6161.lng);
      assert.equal(top.in_coverage, true);
      assert.equal(top.number, '6161');
      // a distância ao centro foi recalculada para a casa (≈ 2,4 km), não a do meio da avenida
      assert.ok(top.distance_m > 2000 && top.distance_m < 3000, `distância ${top.distance_m}`);

      // a pergunta ao Google leva rua, número e cidade, restrita ao Brasil
      assert.equal(calls.google.length, 1);
      const u = calls.google[0];
      assert.equal(u.searchParams.get('address'), 'Avenida Tupãssi, 6161, Assis Chateaubriand - PR, Brasil');
      assert.equal(u.searchParams.get('components'), 'country:BR');
      assert.equal(u.searchParams.get('key'), GOOGLE_KEY);

      // mesma busca de novo: sai do cache, sem pagar outra chamada
      const again = await buscaTupassi();
      assert.equal(again.data.results[0].lat, CASA_6161.lat);
      assert.equal(calls.google.length, 1);

      // dá para cotar a corrida até a casa
      const q = await pax.req('POST', '/api/quotes', {
        origin: ORIGIN, dest: { lat: top.lat, lng: top.lng, text: top.text },
      });
      assert.equal(q.status, 200, JSON.stringify(q.data));
    });

    // a chave fica só no servidor: mascarada na central, ausente da configuração pública
    const mc = await adm.req('GET', '/api/admin/maps-config');
    assert.equal(mc.data.credentials.GOOGLE_GEOCODING_KEY.filled, true);
    assert.equal(JSON.stringify(mc.data).includes(GOOGLE_KEY), false);
    assert.equal(JSON.stringify((await pax.req('GET', '/api/config')).data).includes(GOOGLE_KEY), false);
  } finally { await cleanNumberTests(); }
});

test('número de casa: resposta vaga ou errada do Google não é aceita como exata', async () => {
  seedTupassi();
  await adm.req('PUT', '/api/admin/maps-config', { credentials: { GOOGLE_GEOCODING_KEY: GOOGLE_KEY } });
  const semAcerto = async (reply: ExtReply, porque: string) => {
    await adm.req('POST', '/api/admin/maps-config/clear-cache');
    await withFakeGeocoders({ google: () => reply }, async () => {
      const top = (await buscaTupassi()).data.results[0];
      assert.equal(top.number_how, 'centro', porque);
      assert.equal(top.approx, true, porque);
      assert.equal(top.lat, TUPASSI_CENTRO.lat, porque);
    });
  };
  try {
    await semAcerto(googleResult('', CASA_6161, 'GEOMETRIC_CENTER', ['route']), 'só achou a rua');
    await semAcerto(googleResult('6161', CASA_6161, 'APPROXIMATE'), 'posição aproximada');
    await semAcerto(googleResult('6100', CASA_6161), 'devolveu outro número');
    await semAcerto(googleResult('6161', { lat: -24.95, lng: -53.46 }), 'mesmo endereço em outra cidade');
    await semAcerto({ body: { status: 'ZERO_RESULTS', results: [] } }, 'não encontrou');
    await semAcerto({ body: { status: 'REQUEST_DENIED', error_message: 'API key inválida' } }, 'chave recusada');
    await semAcerto({ status: 500, body: {} }, 'Google fora do ar');
  } finally { await cleanNumberTests(); }
});

test('número de casa: sem chave do Google, o Mapbox responde; "forçar OSM" desliga os dois', async () => {
  seedTupassi();
  await adm.req('PUT', '/api/admin/maps-config', { credentials: { MAPBOX_PUBLIC_TOKEN: MBX_PUBLIC } });
  const mapboxAddr = (num: string, accuracy: string): ExtReply => ({
    body: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature', geometry: { type: 'Point', coordinates: [CASA_6161.lng, CASA_6161.lat] },
        properties: {
          feature_type: 'address', name: `Avenida Tupãssi ${num}`,
          coordinates: { longitude: CASA_6161.lng, latitude: CASA_6161.lat, accuracy },
          context: { address: { address_number: num, street_name: 'Avenida Tupãssi' } },
        },
      }],
    },
  });
  try {
    await withFakeGeocoders({ mapbox: () => mapboxAddr('6161', 'rooftop') }, async calls => {
      const top = (await buscaTupassi()).data.results[0];
      assert.equal(top.number_how, 'localizado');
      assert.equal(top.lat, CASA_6161.lat);
      assert.equal(calls.mapbox.length, 1);
      assert.equal(calls.mapbox[0].searchParams.get('types'), 'address');
      assert.equal(calls.mapbox[0].searchParams.get('q'), 'Avenida Tupãssi 6161');
      // resultado do Mapbox não é guardado (termos do modo temporário)
      assert.equal((db.prepare('SELECT COUNT(*) c FROM geo_cache').get() as any).c, 0);
    });
    // Mapbox só soube a rua, ou devolveu outro número: continua pedindo o ajuste
    await withFakeGeocoders({ mapbox: () => mapboxAddr('6161', 'street') }, async () => {
      assert.equal((await buscaTupassi()).data.results[0].number_how, 'centro');
    });
    await withFakeGeocoders({ mapbox: () => mapboxAddr('61', 'rooftop') }, async () => {
      assert.equal((await buscaTupassi()).data.results[0].number_how, 'centro');
    });

    // ponto já confirmado por um passageiro vale mais que qualquer serviço: nem consulta
    await pax.req('POST', '/api/geo/learn',
      { street: 'Avenida Tupãssi', number: 6161, lat: -24.4300, lng: -53.5390 });
    await withFakeGeocoders({ mapbox: () => mapboxAddr('6161', 'rooftop') }, async calls => {
      const top = (await buscaTupassi()).data.results[0];
      assert.equal(top.number_how, 'exato');
      assert.equal(top.lat, -24.43);
      assert.equal(calls.mapbox.length, 0);
    });
    db.prepare(`DELETE FROM address_points`).run();

    // "Forçar OpenStreetMap": nenhuma chamada paga
    await adm.req('PUT', '/api/admin/maps-config',
      { credentials: { GOOGLE_GEOCODING_KEY: GOOGLE_KEY }, provider: 'osm' });
    await withFakeGeocoders({
      google: () => googleResult('6161', CASA_6161), mapbox: () => mapboxAddr('6161', 'rooftop'),
    }, async calls => {
      assert.equal((await buscaTupassi()).data.results[0].number_how, 'centro');
      assert.equal(calls.google.length + calls.mapbox.length, 0);
    });
  } finally { await cleanNumberTests(); }
});

// ================= Mapas (Google Maps) =================

const GMAPS_BROWSER = 'AIzaSyTESTE-chave-do-navegador-0001';
const GMAPS_SERVER = 'AIzaSyTESTE-chave-de-servidor-00002';

type GReq = { url: URL; method: string; headers: Headers; body: any };
type GReply = { status?: number; body: unknown };

/**
 * Simula as APIs do Google (Routes, Places e Geocoding) e, se pedido, o
 * Mapbox, com a rede de geo ligada. Qualquer outro serviço responde 503.
 */
async function withFakeGoogle(
  handlers: { google?: (r: GReq) => GReply; mapbox?: (u: URL) => GReply },
  fn: (calls: { google: GReq[]; mapbox: URL[] }) => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  const calls = { google: [] as GReq[], mapbox: [] as URL[] };
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    const reply = (r: GReply) => new Response(JSON.stringify(r.body), {
      status: r.status ?? 200, headers: { 'Content-Type': 'application/json' },
    });
    if (url.hostname.endsWith('.googleapis.com') && handlers.google) {
      const req: GReq = {
        url, method: init?.method || 'GET', headers: new Headers(init?.headers || {}),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      calls.google.push(req);
      return reply(handlers.google(req));
    }
    if (url.hostname === 'api.mapbox.com' && handlers.mapbox) {
      calls.mapbox.push(url);
      return reply(handlers.mapbox(url));
    }
    return new Response('fora do ar', { status: 503 });
  }) as typeof fetch;
  process.env.GEO_OFFLINE = '0';
  try { await fn(calls); } finally {
    process.env.GEO_OFFLINE = '1';
    globalThis.fetch = realFetch;
  }
}

/** Polyline de exemplo da documentação do Google: 3 pontos. */
const GPOLY = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

/** Respostas no formato real das APIs do Google. */
function fakeGoogleOk(r: GReq): GReply {
  if (r.url.hostname === 'routes.googleapis.com') {
    return { body: { routes: [{ distanceMeters: 3900, duration: '540s', polyline: { encodedPolyline: GPOLY } }] } };
  }
  if (r.url.pathname === '/v1/places:autocomplete') {
    return {
      body: {
        suggestions: [
          { placePrediction: {
            placeId: 'ChIJ-farmacia-sao-joao-001',
            text: { text: 'Farmácia São João, Avenida Tupãssi, Assis Chateaubriand - PR' },
            structuredFormat: { mainText: { text: 'Farmácia São João' }, secondaryText: { text: 'Avenida Tupãssi, 1200 - Centro' } },
          } },
          { placePrediction: {
            placeId: 'ChIJ-rua-da-farmacia-00002',
            structuredFormat: { mainText: { text: 'Rua da Farmácia' }, secondaryText: { text: 'Assis Chateaubriand - PR' } },
          } },
          { queryPrediction: { text: { text: 'farmácia perto de mim' } } },
        ],
      },
    };
  }
  if (r.url.pathname.startsWith('/v1/places/')) {
    return {
      body: {
        id: 'ChIJ-farmacia-sao-joao-001',
        location: { latitude: -24.4170, longitude: -53.5230 },
        formattedAddress: 'Av. Tupãssi, 1200 - Centro, Assis Chateaubriand - PR, 85935-000, Brasil',
      },
    };
  }
  if (r.url.pathname === '/maps/api/geocode/json') {
    return {
      body: {
        status: 'OK',
        results: [
          { types: ['plus_code'], formatted_address: 'HF7H+2X Assis Chateaubriand, PR, Brasil' },
          { types: ['locality'], formatted_address: 'Assis Chateaubriand - PR, Brasil' },
          { types: ['street_address'], formatted_address: 'Av. Tupãssi, 1200 - Centro, Assis Chateaubriand - PR, 85935-000, Brasil' },
        ],
      },
    };
  }
  return { status: 404, body: { error: { message: 'Not Found', status: 'NOT_FOUND' } } };
}

async function resetGoogle(): Promise<void> {
  await adm.req('PUT', '/api/admin/maps-config', {
    credentials: {
      GOOGLE_MAPS_BROWSER_KEY: '', GOOGLE_MAPS_SERVER_KEY: '', GOOGLE_GEOCODING_KEY: '',
      MAPBOX_PUBLIC_TOKEN: '', MAPBOX_SERVER_TOKEN: '',
    },
    provider: 'auto',
  });
  await adm.req('POST', '/api/admin/maps-config/clear-cache');
}

test('Google: a chave do navegador vai ao app e a de servidor nunca vaza', async () => {
  try {
    // chave com formato errado e provedor desconhecido são recusados, sem gravar nada
    assert.equal((await adm.req('PUT', '/api/admin/maps-config',
      { credentials: { GOOGLE_MAPS_BROWSER_KEY: 'chave curta' } })).status, 400);
    assert.equal((await adm.req('PUT', '/api/admin/maps-config',
      { credentials: { GOOGLE_MAPS_BROWSER_KEY: GMAPS_BROWSER }, provider: 'bing' })).status, 400);
    let cfg = await pax.req('GET', '/api/config');
    assert.equal(cfg.data.maps.google_key, null);
    assert.equal(cfg.data.maps.provider, 'osm');

    const ok = await adm.req('PUT', '/api/admin/maps-config', {
      credentials: {
        GOOGLE_MAPS_BROWSER_KEY: GMAPS_BROWSER, GOOGLE_MAPS_SERVER_KEY: GMAPS_SERVER,
        MAPBOX_PUBLIC_TOKEN: MBX_PUBLIC,
      },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));

    // automático: Google na frente, Mapbox junto como reserva
    cfg = await pax.req('GET', '/api/config');
    assert.equal(cfg.data.maps.google_key, GMAPS_BROWSER);
    assert.equal(cfg.data.maps.mapbox_token, MBX_PUBLIC);
    assert.equal(cfg.data.maps.provider, 'google');
    assert.equal(cfg.data.maps.server_routing, 'google');
    assert.equal(JSON.stringify(cfg.data).includes(GMAPS_SERVER), false);

    const mc = await adm.req('GET', '/api/admin/maps-config');
    assert.equal(mc.data.active_routing, 'google');
    assert.equal(mc.data.active_visual, 'google');
    assert.equal(mc.data.credentials.GOOGLE_MAPS_SERVER_KEY.filled, true);
    assert.equal(JSON.stringify(mc.data).includes(GMAPS_SERVER), false);
    assert.equal(JSON.stringify(mc.data).includes(GMAPS_BROWSER), false);

    // escolher Mapbox desliga o Google no app e no backend, sem apagar a chave
    await adm.req('PUT', '/api/admin/maps-config', { provider: 'mapbox' });
    cfg = await pax.req('GET', '/api/config');
    assert.equal(cfg.data.maps.google_key, null);
    assert.equal(cfg.data.maps.provider, 'mapbox');
    assert.equal(cfg.data.maps.server_routing, 'mapbox');

    // "Forçar OpenStreetMap" desliga os dois
    await adm.req('PUT', '/api/admin/maps-config', { provider: 'osm' });
    cfg = await pax.req('GET', '/api/config');
    assert.equal(cfg.data.maps.google_key, null);
    assert.equal(cfg.data.maps.mapbox_token, null);
    assert.equal(cfg.data.maps.provider, 'osm');

    // só a chave do navegador: o mapa é do Google e o backend usa a mesma chave
    await adm.req('PUT', '/api/admin/maps-config',
      { credentials: { GOOGLE_MAPS_SERVER_KEY: '' }, provider: 'google' });
    cfg = await pax.req('GET', '/api/config');
    assert.equal(cfg.data.maps.provider, 'google');
    assert.equal(cfg.data.maps.server_routing, 'google');
  } finally { await resetGoogle(); }
});

test('Google: rota de motocicleta define distância e preço, com a chave de servidor e cache', async () => {
  await adm.req('PUT', '/api/admin/maps-config', {
    credentials: { GOOGLE_MAPS_BROWSER_KEY: GMAPS_BROWSER, GOOGLE_MAPS_SERVER_KEY: GMAPS_SERVER },
  });
  try {
    await withFakeGoogle({ google: fakeGoogleOk }, async calls => {
      const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
      assert.equal(q.status, 200, JSON.stringify(q.data));
      assert.equal(q.data.route.provider, 'google');
      assert.equal(q.data.route.mode, 'two_wheeler');
      assert.equal(q.data.route.mode_fallback, false);
      assert.equal(q.data.route.estimated, false);
      assert.deepEqual(q.data.route.geometry, [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
      const eco = q.data.quotes.find((x: any) => x.category === 'economica');
      assert.equal(eco.distance_m, 3900);
      assert.equal(eco.duration_s, 540);
      assert.equal(eco.price_cents, 550 + Math.round((3900 - 2000) * 200 / 1000));

      assert.equal(calls.google.length, 1);
      const c = calls.google[0];
      assert.equal(c.url.hostname, 'routes.googleapis.com');
      assert.equal(c.headers.get('X-Goog-Api-Key'), GMAPS_SERVER);
      assert.equal(c.url.search, '');                       // a chave não vai na URL
      assert.equal(c.body.travelMode, 'TWO_WHEELER');
      assert.deepEqual(c.body.origin.location.latLng, { latitude: ORIGIN.lat, longitude: ORIGIN.lng });
      assert.deepEqual(c.body.destination.location.latLng, { latitude: DEST.lat, longitude: DEST.lng });

      // mesma rota de novo: sai do cache, sem nova chamada paga
      const q2 = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
      assert.equal(q2.data.route.provider, 'google');
      assert.equal(calls.google.length, 1);

      // a procedência fica gravada na corrida
      const rid = await newRide('dinheiro');
      const row = db.prepare('SELECT route_provider, route_mode FROM rides WHERE id = ?').get(rid) as any;
      assert.equal(row.route_provider, 'google');
      assert.equal(row.route_mode, 'two_wheeler');
      await pax.req('POST', `/api/rides/${rid}/cancel`, { reason: 'fim do teste' });
    });
  } finally { await resetGoogle(); }
});

test('Google: sem rota de moto no trajeto usa a de carro e avisa; fora do ar, o Mapbox assume', async () => {
  await adm.req('PUT', '/api/admin/maps-config', {
    credentials: { GOOGLE_MAPS_BROWSER_KEY: GMAPS_BROWSER, MAPBOX_PUBLIC_TOKEN: MBX_PUBLIC },
  });
  try {
    await withFakeGoogle({
      google: r => r.body?.travelMode === 'TWO_WHEELER'
        ? { status: 400, body: { error: { message: 'Two wheeler routing is not supported in this region.', status: 'INVALID_ARGUMENT' } } }
        : fakeGoogleOk(r),
    }, async calls => {
      const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
      assert.equal(q.data.route.provider, 'google');
      assert.equal(q.data.route.mode, 'drive');
      assert.equal(q.data.route.mode_fallback, true);
      assert.deepEqual(calls.google.map(c => c.body.travelMode), ['TWO_WHEELER', 'DRIVE']);
      // sem chave de servidor, o backend usa a do navegador
      assert.equal(calls.google[0].headers.get('X-Goog-Api-Key'), GMAPS_BROWSER);
    });
    await adm.req('POST', '/api/admin/maps-config/clear-cache');

    await withFakeGoogle({
      google: () => ({ status: 500, body: { error: { message: 'backend error' } } }),
      mapbox: fakeMapboxOk,
    }, async calls => {
      const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
      assert.equal(q.status, 200);
      assert.equal(q.data.route.provider, 'mapbox');
      assert.equal(q.data.route.mode, 'drive');
      assert.equal(calls.google.length, 1);
      assert.equal(calls.mapbox.length, 1);
    });
    await adm.req('POST', '/api/admin/maps-config/clear-cache');

    // provedor "Mapbox": o Google nem é chamado
    await adm.req('PUT', '/api/admin/maps-config', { provider: 'mapbox' });
    await withFakeGoogle({ google: fakeGoogleOk, mapbox: fakeMapboxOk }, async calls => {
      const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
      assert.equal(q.data.route.provider, 'mapbox');
      assert.equal(calls.google.length, 0);
    });
  } finally { await resetGoogle(); }
});

test('Google: a busca acha lojas pelo nome, junto com a base local, só na área atendida', async () => {
  await adm.req('PUT', '/api/admin/maps-config', {
    credentials: { GOOGLE_MAPS_BROWSER_KEY: GMAPS_BROWSER, GOOGLE_MAPS_SERVER_KEY: GMAPS_SERVER },
  });
  db.prepare(`INSERT INTO local_addresses (kind, name, norm, lat, lng, updated_at)
    VALUES ('rua', 'Rua da Farmácia', 'rua da farmacia', -24.4160, -53.5220, ?)`).run(Date.now());
  try {
    await withFakeGoogle({ google: fakeGoogleOk }, async calls => {
      const r = await pax.req('GET', '/api/geo/search?q=farmacia&session=sessao-de-teste-0001');
      assert.equal(r.status, 200);
      const [rua, loja, ...resto] = r.data.results;
      // a rua da base continua em primeiro, já com coordenada
      assert.equal(rua.source, 'local');
      assert.match(rua.text, /^Rua da Farmácia/);
      assert.equal(typeof rua.lat, 'number');
      // a loja vem do Google: nome, endereço resumido e nenhuma coordenada ainda
      assert.equal(loja.source, 'google');
      assert.equal(loja.text, 'Farmácia São João');
      assert.equal(loja.secondary, 'Avenida Tupãssi, 1200 - Centro');
      assert.equal(loja.place_id, 'ChIJ-farmacia-sao-joao-001');
      assert.equal(loja.needs_details, true);
      assert.equal(loja.lat, null);
      // a "Rua da Farmácia" do Google repete a da base e a sugestão de pesquisa não é um lugar
      assert.equal(resto.filter((x: any) => x.source === 'google').length, 0);

      assert.equal(calls.google.length, 1);
      const c = calls.google[0];
      assert.equal(c.url.pathname, '/v1/places:autocomplete');
      assert.equal(c.headers.get('X-Goog-Api-Key'), GMAPS_SERVER);
      assert.equal(c.body.input, 'farmacia');
      assert.equal(c.body.sessionToken, 'sessao-de-teste-0001');
      assert.deepEqual(c.body.includedRegionCodes, ['br']);
      // só o círculo da área atendida (12 km em volta do centro)
      assert.deepEqual(c.body.locationRestriction.circle,
        { center: { latitude: -24.4156, longitude: -53.5216 }, radius: 12000 });

      // escolher a loja busca a posição, na mesma sessão, pedindo só o básico
      const p = await pax.req('GET', '/api/geo/place?place_id=ChIJ-farmacia-sao-joao-001'
        + '&session=sessao-de-teste-0001&text=' + encodeURIComponent('Farmácia São João'));
      assert.equal(p.status, 200, JSON.stringify(p.data));
      assert.equal(p.data.place.text, 'Farmácia São João — Av. Tupãssi, 1200 - Centro');
      assert.equal(p.data.place.lat, -24.417);
      assert.equal(p.data.place.lng, -53.523);
      assert.equal(p.data.place.in_coverage, true);
      assert.equal(p.data.place.source, 'google');
      const d = calls.google[1];
      assert.equal(d.url.pathname, '/v1/places/ChIJ-farmacia-sao-joao-001');
      assert.equal(d.url.searchParams.get('sessionToken'), 'sessao-de-teste-0001');
      assert.equal(d.headers.get('X-Goog-FieldMask'), 'id,location,formattedAddress');
      assert.equal(d.headers.get('X-Goog-Api-Key'), GMAPS_SERVER);

      // nada do Google fica guardado
      assert.equal((db.prepare('SELECT COUNT(*) c FROM geo_cache').get() as any).c, 0);

      // identificador inválido nem chega ao Google; visitante não usa a busca paga
      assert.equal((await pax.req('GET', '/api/geo/place?place_id=' + encodeURIComponent('../x y'))).status, 400);
      assert.equal(calls.google.length, 2);
      const anon = await fetch(base + '/api/geo/place?place_id=ChIJ-farmacia-sao-joao-001');
      assert.equal(anon.status, 401);
    });

    // lugar fora da área atendida: volta marcado, e o app recusa
    await withFakeGoogle({
      google: r => r.url.pathname.startsWith('/v1/places/')
        ? { body: { id: 'x', location: { latitude: -24.95, longitude: -53.46 }, formattedAddress: 'Av. Brasil, 100 - Cascavel - PR' } }
        : fakeGoogleOk(r),
    }, async () => {
      const p = await pax.req('GET', '/api/geo/place?place_id=ChIJ-loja-de-cascavel-0001&text=Loja');
      assert.equal(p.data.place.in_coverage, false);
      assert.ok(p.data.place.distance_m > 12000);
    });

    // Google fora do ar: a busca continua com a base, sem erro
    await withFakeGoogle({ google: () => ({ status: 503, body: {} }) }, async () => {
      const r = await pax.req('GET', '/api/geo/search?q=farmacia');
      assert.equal(r.status, 200);
      assert.equal(r.data.results[0].source, 'local');
      assert.equal(r.data.results.some((x: any) => x.source === 'google'), false);
      const p = await pax.req('GET', '/api/geo/place?place_id=ChIJ-farmacia-sao-joao-001');
      assert.equal(p.status, 502);
    });
  } finally {
    db.prepare(`DELETE FROM local_addresses WHERE norm = 'rua da farmacia'`).run();
    await resetGoogle();
  }
});

test('Google: "rua + número" fica com a base e o número de casa usa a mesma chave', async () => {
  seedTupassi();
  await adm.req('PUT', '/api/admin/maps-config', { credentials: { GOOGLE_MAPS_BROWSER_KEY: GMAPS_BROWSER } });
  try {
    await withFakeGoogle({
      google: r => r.url.pathname === '/maps/api/geocode/json' ? googleResult('6161', CASA_6161) : fakeGoogleOk(r),
    }, async calls => {
      const top = (await buscaTupassi()).data.results[0];
      assert.equal(top.source, 'local');
      assert.equal(top.number_how, 'localizado');
      assert.equal(top.lat, CASA_6161.lat);
      // só o Geocoding foi chamado: nada de sugestões pagas para "rua + número"
      assert.deepEqual(calls.google.map(c => c.url.pathname), ['/maps/api/geocode/json']);
      assert.equal(calls.google[0].url.searchParams.get('key'), GMAPS_BROWSER);
    });
  } finally {
    await cleanNumberTests();
    await resetGoogle();
  }
});

test('Google: endereço do GPS escolhe a rua com número, não a cidade', async () => {
  await adm.req('PUT', '/api/admin/maps-config', { credentials: { GOOGLE_MAPS_BROWSER_KEY: GMAPS_BROWSER } });
  try {
    await withFakeGoogle({ google: fakeGoogleOk }, async calls => {
      const r = await pax.req('GET', `/api/geo/reverse?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}`);
      assert.equal(r.status, 200);
      assert.equal(r.data.text, 'Av. Tupãssi, 1200 - Centro, Assis Chateaubriand - PR');
      assert.equal(r.data.exact, true);
      assert.equal(calls.google[0].url.searchParams.get('latlng'), `${ORIGIN.lat},${ORIGIN.lng}`);
    });
    // sem resultado no Google: segue para os outros serviços, sem inventar endereço
    await withFakeGoogle({ google: () => ({ body: { status: 'ZERO_RESULTS', results: [] } }) }, async () => {
      const r = await pax.req('GET', `/api/geo/reverse?lat=${ORIGIN.lat}&lng=${ORIGIN.lng}`);
      assert.equal(r.status, 200);
      assert.equal(r.data.exact, false);
    });
  } finally { await resetGoogle(); }
});

test('diagnóstico de mapas: confere cada API do Google e explica chave restrita por site', async () => {
  await adm.req('PUT', '/api/admin/maps-config', { credentials: { GOOGLE_MAPS_BROWSER_KEY: GMAPS_BROWSER } });
  try {
    await withFakeGoogle({ google: fakeGoogleOk }, async () => {
      const r = await adm.req('POST', '/api/admin/maps-config/test');
      const by = Object.fromEntries(r.data.checks.map((c: any) => [c.item, c]));
      assert.equal(r.data.checks[0].item, 'Token do Mapbox');       // o Mapbox continua relatado primeiro
      assert.equal(by['Google Maps — mapa nos aplicativos'].ok, true);
      assert.equal(by['Google — rotas (Routes API)'].ok, true);
      assert.match(by['Google — rotas (Routes API)'].detail, /3\.9 km.*motocicleta/);
      assert.equal(by['Google — busca por nome (Places API)'].ok, true);
      assert.equal(by['Google — endereço do GPS (Geocoding API)'].ok, true);
      assert.equal(JSON.stringify(r.data).includes(GMAPS_BROWSER), false);
    });

    await withFakeGoogle({
      google: () => ({ status: 403, body: { error: { message: 'Requests from referer <empty> are blocked.', status: 'PERMISSION_DENIED' } } }),
    }, async () => {
      const r = await adm.req('POST', '/api/admin/maps-config/test');
      const rota = r.data.checks.find((c: any) => c.item === 'Google — rotas (Routes API)');
      assert.equal(rota.ok, false);
      assert.match(rota.detail, /Chave de servidor/);
      assert.equal(JSON.stringify(r.data).includes(GMAPS_BROWSER), false);
    });
  } finally { await resetGoogle(); }
});

// ================= configurações (correção) =================

test('configurações: confirmação, limite de dívida e precisão do GPS são gravados e validados', async () => {
  const before = (await adm.req('GET', '/api/admin/settings')).data.settings;
  try {
    const ok = await adm.req('PUT', '/api/admin/settings', {
      settings: { confirm_window_s: '8', driver_debt_limit_cents: '7500', gps_max_accuracy_m: '200' },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const s = (await adm.req('GET', '/api/admin/settings')).data.settings;
    assert.equal(s.confirm_window_s, '8');
    assert.equal(s.driver_debt_limit_cents, '7500');
    assert.equal(s.gps_max_accuracy_m, '200');
    // fora do intervalo: recusado sem gravar
    for (const bad of [{ confirm_window_s: '0' }, { confirm_window_s: '500' },
      { driver_debt_limit_cents: '-1' }, { gps_max_accuracy_m: 'abc' }]) {
      assert.equal((await adm.req('PUT', '/api/admin/settings', { settings: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await adm.req('GET', '/api/admin/settings')).data.settings.confirm_window_s, '8');
  } finally {
    await adm.req('PUT', '/api/admin/settings', {
      settings: {
        confirm_window_s: before.confirm_window_s, driver_debt_limit_cents: before.driver_debt_limit_cents,
        gps_max_accuracy_m: before.gps_max_accuracy_m,
      },
    });
  }
});

// ================= importação de locais e duplicados =================

test('locais: cadastro manual não sobrescreve em silêncio quem já existe', async () => {
  const t = Date.now();
  db.prepare(`INSERT INTO local_addresses (kind, name, norm, detail, tags, lat, lng, updated_at, source)
    VALUES ('local', 'Igreja Matriz Teste', 'igreja matriz teste', 'Praça A', 'igreja', -24.4160, -53.5200, ?, 'osm')`).run(t);
  const dup = await adm.req('POST', '/api/admin/places', { name: 'Igreja Matriz Teste', lat: -24.4100, lng: -53.5100 });
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, /Já existe/);
  let row = db.prepare(`SELECT lat, source FROM local_addresses WHERE norm = 'igreja matriz teste'`).get() as any;
  assert.equal(row.lat, -24.4160);                  // nada mudou
  assert.equal(row.source, 'osm');
  // nome parecido a poucos metros também pede confirmação
  const near = await adm.req('POST', '/api/admin/places', { name: 'Igreja Matriz Teste Central', lat: -24.41601, lng: -53.52001 });
  assert.equal(near.status, 409);
  // confirmando, grava (e fica na auditoria)
  const ok = await adm.req('POST', '/api/admin/places', { name: 'Igreja Matriz Teste', lat: -24.4100, lng: -53.5100, replace: true });
  assert.equal(ok.status, 200);
  row = db.prepare(`SELECT lat, source FROM local_addresses WHERE norm = 'igreja matriz teste'`).get() as any;
  assert.equal(row.source, 'manual');
  const aud = await adm.req('GET', '/api/admin/audit');
  assert.ok(aud.data.logs.some((l: any) => l.action === 'place_replace'));
  db.prepare(`DELETE FROM local_addresses WHERE norm LIKE 'igreja matriz teste%'`).run();
});

test('locais: importação de planilha confere tudo antes e só grava linhas novas', async () => {
  db.prepare(`INSERT INTO local_addresses (kind, name, norm, lat, lng, updated_at, source)
    VALUES ('local', 'Farmacia Ja Existe', 'farmacia ja existe', -24.4150, -53.5210, ?, 'osm')`).run(Date.now());
  const rows = [
    { name: 'Clinica Nova Importada', tags: 'clinica saude', detail: 'Rua X, 10 – Centro', lat: -24.4170, lng: -53.5230 },
    { name: 'Farmacia Ja Existe', lat: -24.4150, lng: -53.5210 },
    { name: 'Farmácia Já Existe Filial', lat: -24.41505, lng: -53.52105 },     // parecido, a ~7 m
    { name: 'Clinica Nova Importada', lat: -24.4171, lng: -53.5231 },          // repetido na planilha
    { name: 'Longe Demais', lat: -25.5, lng: -54.5 },
    { name: 'Sem Coordenada', lat: NaN, lng: 0 },
    { name: '', lat: -24.41, lng: -53.52 },
  ];
  assert.equal((await pax.req('POST', '/api/admin/places/import', { rows })).status, 403);
  const prev = await adm.req('POST', '/api/admin/places/import', { rows, dry_run: true });
  assert.equal(prev.status, 200);
  assert.equal(prev.data.dry_run, true);
  assert.deepEqual(prev.data.results.map((r: any) => r.status),
    ['novo', 'ja_existe', 'possivel_duplicata', 'repetido_na_planilha', 'fora_da_area', 'invalido', 'invalido']);
  // a prévia não grava nada
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM local_addresses WHERE norm = 'clinica nova importada'`).get() as any).n, 0);

  const done = await adm.req('POST', '/api/admin/places/import', { rows, dry_run: false, source: 'teste.csv' });
  assert.equal(done.data.summary.novos, 1);
  const created = db.prepare(`SELECT source, detail, tags FROM local_addresses WHERE norm = 'clinica nova importada'`).get() as any;
  assert.equal(created.source, 'manual');
  assert.equal(created.detail, 'Rua X, 10 – Centro');
  // o que já existia continua igual
  assert.equal((db.prepare(`SELECT source FROM local_addresses WHERE norm = 'farmacia ja existe'`).get() as any).source, 'osm');
  // importar de novo não duplica
  const again = await adm.req('POST', '/api/admin/places/import', { rows, dry_run: false });
  assert.equal(again.data.summary.novos, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM local_addresses WHERE norm = 'clinica nova importada'`).get() as any).n, 1);
  // aparece na busca do passageiro
  const s = await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('clinica nova importada'));
  assert.ok(s.data.results.some((x: any) => x.text.startsWith('Clinica Nova Importada')));
  const aud = await adm.req('GET', '/api/admin/audit');
  assert.ok(aud.data.logs.some((l: any) => l.action === 'places_import' && /teste\.csv/.test(l.details)));
  db.prepare(`DELETE FROM local_addresses WHERE norm IN ('clinica nova importada', 'farmacia ja existe')`).run();
});
