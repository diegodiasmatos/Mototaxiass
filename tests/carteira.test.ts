/**
 * Carteira do mototaxista: comissão de 15% calculada no servidor, dívida das
 * corridas em dinheiro descontada no saque, saque a cada 48 h, um saque por
 * vez, recusa devolvendo tudo, estorno com lançamentos compensatórios.
 * Nenhum pagamento real: provedor em modo de teste.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

process.env.GEO_OFFLINE = '1';
process.env.ADMIN_EMAIL = 'dono-cart@teste.com';
process.env.ADMIN_PASSWORD = 'senha-admin-cart-teste';
process.env.SESSION_SECRET = 'segredo-de-teste-carteira';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assis-cart-'));

const { start } = await import('../server/index.ts');
const dbMod = await import('../server/db.ts');
const pay = await import('../server/payments.ts');
const db = { prepare: (sql: string) => dbMod.db.prepare(sql) };

let base = '';
let close: () => Promise<void>;

function actor() {
  let cookie = '';
  return {
    async req(method: string, p: string, body?: unknown) {
      const r = await fetch(base + p, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
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

const jpeg = () => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3996, 7)]).toString('base64')}`;
const ORIGIN = { lat: -24.4156, lng: -53.5216, text: 'Centro, Assis Chateaubriand' };
const DEST = { lat: -24.4450, lng: -53.5400, text: 'Jardim Paraná, Assis Chateaubriand' };
const pax = actor(), adm = actor();
const CPFS = ['529.982.247-25', '111.444.777-35', '390.533.447-05', '123.456.789-09'];
let cpfIdx = 0;
const idem = () => `k${Date.now()}${Math.random().toString(36).slice(2, 10)}`;

async function newDriver(email: string) {
  const a = actor();
  const cpf = CPFS[cpfIdx++];
  await a.req('POST', '/api/auth/register', { role: 'driver', accept_terms: true, name: 'Moto ' + email, cpf,
    phone: '(44) 90000-7777', email, password: 'senha12345' });
  await a.req('POST', '/api/driver/apply', {
    birth_date: '1990-01-01', cnh_expiry: '2031-01-01', cnh_first_date: '2012-05-10', decl_cat_a_ear: true,
    address: 'Rua A, 10', moto_plate: 'ABC-1D23', moto_brand: 'Honda', moto_model: 'CG 160', moto_year: '2022',
    moto_color: 'Preta', documents: { cnh: jpeg(), crlv: jpeg(), selfie: jpeg() },
  });
  const uid = (db.prepare('SELECT id FROM users WHERE email = ?').get(email) as any).id as string;
  await adm.req('POST', `/api/admin/drivers/${uid}/review`, { action: 'approve' });
  return { a, id: uid, cpf: cpf.replace(/\D/g, '') };
}

/** Corrida completa com valor fixado (fixture), concluída pelo passageiro. A comissão é do servidor. */
async function ride(d: { a: ReturnType<typeof actor> }, method: 'pix' | 'dinheiro', priceCents: number,
  opts: { unconfirmed?: boolean } = {}) {
  await d.a.req('POST', '/api/driver/online', { online: true });
  await d.a.req('POST', '/api/driver/location', { lat: -24.4150, lng: -53.5210, accuracy_m: 10 });
  const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  const c = await pax.req('POST', '/api/rides', { quote_id: q.data.quotes[0].id, payment_method: method });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const rid = c.data.ride.id as string;
  db.prepare('UPDATE rides SET price_cents = ? WHERE id = ?').run(priceCents, rid);
  db.prepare('UPDATE payments SET amount_cents = ? WHERE ride_id = ?').run(priceCents, rid);
  if (method !== 'dinheiro') assert.equal((await pax.req('POST', `/api/rides/${rid}/payment/test-approve`)).status, 200);
  assert.equal((await d.a.req('POST', `/api/driver/rides/${rid}/accept`)).status, 200);
  await d.a.req('POST', `/api/driver/rides/${rid}/arrived`);
  const code = (await pax.req('GET', `/api/rides/${rid}`)).data.ride.boarding_code;
  assert.equal((await d.a.req('POST', `/api/driver/rides/${rid}/start`, { code })).status, 200);
  assert.equal((await d.a.req('POST', `/api/driver/rides/${rid}/complete`)).status, 200);
  // simula um pagamento digital ainda NÃO confirmado pelo provedor
  if (opts.unconfirmed) db.prepare(`UPDATE payments SET status = 'aguardando_pagamento' WHERE ride_id = ?`).run(rid);
  assert.equal((await pax.req('POST', `/api/rides/${rid}/confirm`)).status, 200);
  await d.a.req('POST', '/api/driver/online', { online: false });
  return rid;
}

const kinds = (rideId: string) => (db.prepare('SELECT kind, amount_cents FROM financial_transactions WHERE ride_id = ? ORDER BY created_at')
  .all(rideId) as any[]).map(x => `${x.kind}:${x.amount_cents}`);
const wallet = async (d: { a: ReturnType<typeof actor> }) => (await d.a.req('GET', '/api/driver/wallet')).data;
async function setPix(d: { a: ReturnType<typeof actor>; cpf: string }) {
  const r = await d.a.req('PUT', '/api/driver/wallet/pix', { type: 'cpf', key: d.cpf, holder_name: 'Moto Teste Silva' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

let A: any, B: any, C: any;
before(async () => {
  const s = await start({ port: 0, quiet: true, dbPath: path.join(process.env.DATA_DIR!, 'cart.db') });
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;
  await adm.req('POST', '/api/auth/login', { email: 'dono-cart@teste.com', password: 'senha-admin-cart-teste' });
  await pax.req('POST', '/api/auth/register', { role: 'passenger', accept_terms: true, name: 'Pat Passageira',
    phone: '(44) 90000-1212', email: 'pat@cart.test', password: 'senha12345' });
  A = await newDriver('a@cart.test');
  B = await newDriver('b@cart.test');
  C = await newDriver('c@cart.test');
  dbMod.setSetting('driver_debt_limit_cents', '100000');
});
after(async () => { await close(); });

test('1: corrida de R$ 20,00 em dinheiro → R$ 3,00 de comissão pendente', async () => {
  const rid = await ride(A, 'dinheiro', 2000);
  assert.deepEqual(kinds(rid), ['cobranca:2000', 'comissao:300', 'divida_comissao:300']);
  const w = await wallet(A);
  assert.equal(w.pending_commission_cents, 300);
  assert.equal(w.available_cents, 0);
  assert.equal(w.withdrawable_cents, 0);
  assert.equal(w.commission_pct, 15);
  assert.equal(w.totals.cash_gross_cents, 2000);
});

test('2: corrida de R$ 100,00 digital → R$ 15,00 de comissão e R$ 85,00 líquidos, sem nova cobrança no saque', async () => {
  const rid = await ride(A, 'pix', 10000);
  assert.deepEqual(kinds(rid), ['cobranca:10000', 'comissao:1500', 'repasse_devido:8500']);
  const w = await wallet(A);
  assert.equal(w.available_cents, 8500);
  assert.equal(w.pending_commission_cents, 300);           // só a do dinheiro
  assert.equal(w.withdrawable_cents, 8200);                // 85,00 − 3,00 (nada de 15% de novo)
  // a conclusão repetida não lança de novo
  assert.equal(pay.postRideFinancials(rid), false);
  assert.equal(kinds(rid).length, 3);
});

test('3: saldo digital de R$ 100,00 e comissão pendente de R$ 15,00 → saque líquido de R$ 85,00', async () => {
  await ride(B, 'pix', 11765);       // 15% = 17,65 (arredondado) → líquido exato de R$ 100,00
  await ride(B, 'dinheiro', 10000);  // comissão de R$ 15,00 pendente
  let w = await wallet(B);
  assert.equal(w.available_cents, 10000);
  assert.equal(w.pending_commission_cents, 1500);
  assert.equal(w.withdrawable_cents, 8500);
  assert.equal(w.can_withdraw, false);                      // sem chave Pix
  // titularidade: chave CPF de outra pessoa é recusada
  assert.equal((await B.a.req('PUT', '/api/driver/wallet/pix', { type: 'cpf', key: A.cpf, holder_name: 'Outra Pessoa' })).status, 400);
  await setPix(B);
  // pedir mais que o líquido: recusado
  assert.equal((await B.a.req('POST', '/api/driver/withdrawals', { amount_cents: 8501, idempotency_key: idem() })).status, 400);
  const r = await B.a.req('POST', '/api/driver/withdrawals', { idempotency_key: idem() });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.withdrawal.amount_cents, 8500);
  assert.equal(r.data.withdrawal.gross_cents, 10000);
  assert.equal(r.data.withdrawal.debt_cents, 1500);
  assert.equal(r.data.withdrawal.fees_cents, 0);
  assert.equal(r.data.withdrawal.status, 'aguardando_aprovacao');
  w = r.data.wallet;
  assert.equal(w.available_cents, 0);                       // reservado
  assert.equal(w.pending_commission_cents, 0);              // comissão baixada no saque
  assert.ok(w.next_withdrawal_at > Date.now() + 47 * 3600_000);
  // a central: pagar sem aprovar não pode; aprovar não é pagar
  const wid = r.data.withdrawal.id;
  assert.equal((await adm.req('POST', `/api/admin/withdrawals/${wid}/pay`, { reference: 'E2E-TESTE-0001' })).status, 409);
  assert.equal((await B.a.req('POST', `/api/admin/withdrawals/${wid}/approve`)).status, 403);
  assert.equal((await adm.req('POST', `/api/admin/withdrawals/${wid}/approve`)).status, 200);
  assert.equal((await wallet(B)).history[0].status, 'aprovado');
  assert.equal(db.prepare(`SELECT 1 FROM financial_transactions WHERE payout_id = ? AND kind = 'saque_pago'`).get(wid), undefined);
  assert.equal((await adm.req('POST', `/api/admin/withdrawals/${wid}/processing`)).status, 200);
  const paid = await adm.req('POST', `/api/admin/withdrawals/${wid}/pay`, { reference: 'E2E-TESTE-0001' });
  assert.equal(paid.status, 200);
  w = await wallet(B);
  assert.equal(w.history[0].status, 'pago');
  assert.equal(w.last_paid.amount_cents, 8500);
  assert.equal(w.available_cents, 0);
  assert.ok(db.prepare(`SELECT 1 FROM admin_audit_logs WHERE action = 'withdrawal_paid' AND target_id = ?`).get(wid));
});

test('4: novo saque antes de 48 h → bloqueado', async () => {
  await ride(B, 'pix', 2000);                               // novo saldo: 17,00
  const r = await B.a.req('POST', '/api/driver/withdrawals', { idempotency_key: idem() });
  assert.equal(r.status, 429);
  assert.ok(r.data.next_withdrawal_at > Date.now());
  assert.match(r.data.error, /Próximo saque liberado/);
});

test('5: depois de 48 h → liberado (havendo saldo)', async () => {
  // o tempo passa no servidor: o pedido anterior fica 49 h no passado
  db.prepare(`UPDATE payouts SET created_at = created_at - ? WHERE driver_id = ? AND origin = 'motorista'`).run(49 * 3600_000, B.id);
  const r = await B.a.req('POST', '/api/driver/withdrawals', { idempotency_key: idem() });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.withdrawal.amount_cents, 1700);
});

test('6: duas solicitações simultâneas → só uma vale; repetir o mesmo pedido não duplica', async () => {
  await ride(A, 'pix', 4000);                               // A: 85 + 34 = 119 disponível, 3 de comissão
  await setPix(A);
  const [r1, r2] = await Promise.all([
    A.a.req('POST', '/api/driver/withdrawals', { idempotency_key: idem() }),
    A.a.req('POST', '/api/driver/withdrawals', { idempotency_key: idem() }),
  ]);
  const st = [r1.status, r2.status].sort();
  assert.deepEqual(st, [201, 409]);
  const ok = r1.status === 201 ? r1 : r2;
  assert.equal(ok.data.withdrawal.amount_cents, 11900 - 300);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM payouts WHERE driver_id = ? AND origin = 'motorista'`).get(A.id) as any).c, 1);
  // o app reenviando o MESMO pedido (rede caiu): devolve o mesmo saque
  const key = (db.prepare(`SELECT idem_key FROM payouts WHERE driver_id = ?`).get(A.id) as any).idem_key;
  const again = await A.a.req('POST', '/api/driver/withdrawals', { idempotency_key: key });
  assert.equal(again.status, 200);
  assert.equal(again.data.replay, true);
  assert.equal(again.data.withdrawal.id, ok.data.withdrawal.id);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM financial_transactions WHERE driver_id = ? AND kind = 'saque_reserva'`).get(A.id) as any).c, 1);
});

test('7: saque recusado → valor e comissão devolvidos; prazo liberado', async () => {
  const w0 = await wallet(A);
  const wid = w0.open.id;
  assert.equal((await adm.req('POST', `/api/admin/withdrawals/${wid}/reject`, { reason: 'x' })).status, 400);   // sem justificativa
  const r = await adm.req('POST', `/api/admin/withdrawals/${wid}/reject`, { reason: 'Titular da conta não confere' });
  assert.equal(r.status, 200);
  const w = await wallet(A);
  assert.equal(w.available_cents, 11900);
  assert.equal(w.pending_commission_cents, 300);
  assert.equal(w.withdrawable_cents, 11600);
  assert.equal(w.next_withdrawal_at, null);                 // recusa não conta para as 48 h
  assert.equal(w.can_withdraw, true);
  // recusar de novo ou pagar o recusado: não
  assert.equal((await adm.req('POST', `/api/admin/withdrawals/${wid}/pay`, { reference: 'E2E-TESTE-0002' })).status, 409);
  assert.equal((await adm.req('POST', `/api/admin/withdrawals/${wid}/reject`, { reason: 'de novo, duplicado' })).status, 409);
  // cancelamento pelo próprio parceiro também devolve; outro parceiro não mexe
  const n = await A.a.req('POST', '/api/driver/withdrawals', { idempotency_key: idem() });
  assert.equal(n.status, 201);
  assert.equal((await B.a.req('POST', `/api/driver/withdrawals/${n.data.withdrawal.id}/cancel`)).status, 404);
  assert.equal((await A.a.req('POST', `/api/driver/withdrawals/${n.data.withdrawal.id}/cancel`)).status, 200);
  assert.equal((await wallet(A)).withdrawable_cents, 11600);
  // o mesmo comprovante não paga dois saques
  const m = await A.a.req('POST', '/api/driver/withdrawals', { idempotency_key: idem() });
  await adm.req('POST', `/api/admin/withdrawals/${m.data.withdrawal.id}/approve`);
  assert.equal((await adm.req('POST', `/api/admin/withdrawals/${m.data.withdrawal.id}/pay`, { reference: 'E2E-TESTE-0001' })).status, 409);
});

test('8: corrida cancelada → nenhuma comissão', async () => {
  await C.a.req('POST', '/api/driver/online', { online: true });
  await C.a.req('POST', '/api/driver/location', { lat: -24.4150, lng: -53.5210, accuracy_m: 10 });
  const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  const c = await pax.req('POST', '/api/rides', { quote_id: q.data.quotes[0].id, payment_method: 'dinheiro' });
  const rid = c.data.ride.id;
  await C.a.req('POST', `/api/driver/rides/${rid}/accept`);
  assert.equal((await pax.req('POST', `/api/rides/${rid}/cancel`, { reason: 'desisti' })).status, 200);
  assert.deepEqual(kinds(rid), []);
  assert.equal((await wallet(C)).pending_commission_cents, 0);
  await C.a.req('POST', '/api/driver/online', { online: false });
});

test('9: estorno de pagamento digital → ganho e comissão desfeitos uma vez', async () => {
  const rid = await ride(C, 'pix', 5000);                   // líquido 42,50 · comissão 7,50
  assert.equal((await wallet(C)).available_cents, 4250);
  const r = await adm.req('POST', `/api/admin/rides/${rid}/refund`, { reason: 'Contestação aceita' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(kinds(rid), ['cobranca:5000', 'comissao:750', 'repasse_devido:4250', 'estorno:5000', 'ajuste_repasse:-4250', 'estorno_comissao:750']);
  assert.equal((await wallet(C)).available_cents, 0);
  // segundo estorno: recusado, nada duplicado
  assert.equal((await adm.req('POST', `/api/admin/rides/${rid}/refund`, { reason: 'de novo' })).status, 409);
  assert.equal(kinds(rid).length, 6);
});

test('pagamento digital não confirmado: nada entra na carteira até o provedor confirmar (uma vez)', async () => {
  const rid = await ride(C, 'pix', 3000, { unconfirmed: true });
  assert.deepEqual(kinds(rid), []);
  assert.equal((await wallet(C)).available_cents, 0);
  const p = pay.getPaymentByRide(rid)!;
  pay.applyPaymentStatus(p, 'pago');                         // provedor confirmou (webhook/sincronização)
  assert.deepEqual(kinds(rid), ['cobranca:3000', 'comissao:450', 'repasse_devido:2550']);
  assert.equal(pay.postRideFinancials(rid), false);
  assert.equal((await wallet(C)).available_cents, 2550);
});

test('extrato e painel da central', async () => {
  const st = await B.a.req('GET', '/api/driver/wallet/statement');
  assert.equal(st.status, 200);
  const k = st.data.entries.map((e: any) => e.kind);
  for (const x of ['cobranca', 'comissao', 'repasse_devido', 'divida_comissao', 'quitacao_divida', 'saque_reserva', 'saque_pago']) assert.ok(k.includes(x), x);
  assert.ok(st.data.entries.every((e: any) => e.id && e.label));
  assert.ok(st.data.entries.some((e: any) => e.ride?.payment_method === 'dinheiro'));
  // extrato é só do próprio parceiro
  assert.ok(!(await A.a.req('GET', '/api/driver/wallet/statement')).data.entries.some((e: any) => e.payout_id && e.payout_id.startsWith('pyo') && st.data.entries.some((b: any) => b.payout_id === e.payout_id)));
  assert.equal((await pax.req('GET', '/api/driver/wallet')).status, 403);
  const adminList = await adm.req('GET', '/api/admin/withdrawals?status=abertos');
  assert.equal(adminList.status, 200);
  assert.equal(adminList.data.totals.commission_cents, 0);          // só pagamentos reais
  assert.ok(adminList.data.totals.commission_test_cents > 0);       // de teste, à parte
  const det = await adm.req('GET', `/api/admin/withdrawals/${adminList.data.withdrawals[0].id}`);
  assert.match(det.data.withdrawal.pix_key, /^\d{11}$/);    // chave completa só para a central
  assert.ok(db.prepare(`SELECT 1 FROM admin_audit_logs WHERE action = 'withdrawal_view'`).get());
  // a chave fica cifrada no banco
  const raw = db.prepare('SELECT pix_key_enc FROM drivers WHERE user_id = ?').get(A.id) as any;
  assert.ok(!String(raw.pix_key_enc).includes(A.cpf));
  // nada é apagado: só inclusões no livro-caixa
  assert.ok((db.prepare(`SELECT COUNT(*) c FROM financial_transactions`).get() as any).c > 20);
});
