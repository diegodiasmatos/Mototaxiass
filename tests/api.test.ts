/**
 * Testes ponta a ponta do Assis MotoTáxi.
 * Sobe o servidor real em porta aleatória com banco temporário e GEO_OFFLINE=1
 * (sem depender de internet) e percorre os fluxos de passageiro, mototaxista,
 * administrador e as regras de segurança.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

process.env.GEO_OFFLINE = '1';
process.env.ADMIN_EMAIL = 'dono@teste.com';
process.env.ADMIN_PASSWORD = 'senha-admin-teste-123';
process.env.SESSION_SECRET = 'segredo-de-teste';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assis-test-'));

const { start } = await import('../server/index.ts');
const { computePriceCents, splitCommission } = await import('../server/fares.ts');

let base = '';
let close: () => Promise<void>;

/** jar de cookies por ator */
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
      const setc = r.headers.getSetCookie?.() ?? [];
      for (const c of setc) {
        const m = /^amt_session=([^;]*)/.exec(c);
        if (m) cookie = m[1] ? `amt_session=${m[1]}` : '';
      }
      let data: any = {};
      try { data = await r.json(); } catch { }
      return { status: r.status, data };
    },
  };
}

const fakeDoc = (kind = 'jpeg') =>
  `data:image/${kind};base64,${Buffer.alloc(4000, 7).toString('base64')}`;

// pontos dentro de Assis Chateaubriand
const ORIGIN = { lat: -24.4156, lng: -53.5216, text: 'Centro, Assis Chateaubriand' };
const DEST = { lat: -24.4450, lng: -53.5400, text: 'Jardim Paraná, Assis Chateaubriand' };

const passenger = actor();
const passenger2 = actor();
const driver = actor();
const driver2 = actor();
const admin = actor();

before(async () => {
  const s = await start({ port: 0, quiet: true, dbPath: path.join(process.env.DATA_DIR!, 'test.db') });
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;
});
after(async () => { await close(); });

/* ================= unidade: tarifas ================= */

test('cálculo de tarifa: exemplos da especificação', () => {
  const eco = { category: 'economica', label: '', base_cents: 550, included_m: 2000, per_km_cents: 200 };
  const pri = { category: 'prioridade', label: '', base_cents: 650, included_m: 2000, per_km_cents: 300 };
  assert.equal(computePriceCents(eco, 5000), 1150);  // R$ 5,50 + 3 × R$ 2,00
  assert.equal(computePriceCents(pri, 5000), 1550);  // R$ 6,50 + 3 × R$ 3,00
  assert.equal(computePriceCents(eco, 1500), 550);   // dentro da base
  assert.equal(computePriceCents(eco, 2500), 650);   // proporcional: +0,5 km × 2,00
});

test('divisão de comissão 15/85 em centavos inteiros', () => {
  const s = splitCommission(2000, 15);
  assert.equal(s.commission_cents, 300);
  assert.equal(s.driver_cents, 1700);
  assert.equal(s.commission_cents + s.driver_cents, 2000);
});

/* ================= autenticação ================= */

test('cadastro e login do passageiro', async () => {
  const r = await passenger.req('POST', '/api/auth/register', {
    role: 'passenger', name: 'Maria Silva', phone: '(44) 99999-0001',
    email: 'maria@teste.com', password: 'senha12345',
  });
  assert.equal(r.status, 201);
  const me = await passenger.req('GET', '/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.user.role, 'passenger');
});

test('senha curta e e-mail inválido são rejeitados', async () => {
  const a = actor();
  assert.equal((await a.req('POST', '/api/auth/register',
    { role: 'passenger', name: 'X', phone: '1', email: 'x@x.com', password: '123' })).status, 400);
  assert.equal((await a.req('POST', '/api/auth/register',
    { role: 'passenger', name: 'X', phone: '1', email: 'nao-email', password: 'senha12345' })).status, 400);
});

test('login admin via credenciais de bootstrap', async () => {
  const r = await admin.req('POST', '/api/auth/login',
    { email: 'dono@teste.com', password: 'senha-admin-teste-123' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'admin');
});

test('rota admin recusa não-admin', async () => {
  assert.equal((await passenger.req('GET', '/api/admin/dashboard')).status, 403);
  assert.equal((await actor().req('GET', '/api/admin/dashboard')).status, 401);
});

/* ================= cotações ================= */

let quoteEco: any, quotePri: any;

test('cotação calcula as duas categorias no servidor', async () => {
  const r = await passenger.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  assert.equal(r.status, 200);
  assert.equal(r.data.quotes.length, 2);
  quoteEco = r.data.quotes.find((q: any) => q.category === 'economica');
  quotePri = r.data.quotes.find((q: any) => q.category === 'prioridade');
  // preço bate com a fórmula aplicada à distância retornada
  const d = quoteEco.distance_m;
  assert.equal(quoteEco.price_cents, 550 + Math.round(Math.max(0, d - 2000) * 200 / 1000));
  assert.equal(quotePri.price_cents, 650 + Math.round(Math.max(0, d - 2000) * 300 / 1000));
  assert.ok(quotePri.price_cents > quoteEco.price_cents);
});

test('fora da área de cobertura é recusado', async () => {
  const r = await passenger.req('POST', '/api/quotes', {
    origin: ORIGIN, dest: { lat: -25.5, lng: -54.5, text: 'Foz do Iguaçu' },
  });
  assert.equal(r.status, 422);
});

/* ================= cadastro do mototaxista ================= */

test('fluxo de cadastro do mototaxista até aprovação', async () => {
  assert.equal((await driver.req('POST', '/api/auth/register', {
    role: 'driver', name: 'João Pereira', cpf: '529.982.247-25',
    phone: '(44) 98888-0001', email: 'joao@teste.com', password: 'senha12345',
  })).status, 201);

  // não pode ficar online sem cadastro aprovado
  assert.equal((await driver.req('POST', '/api/driver/online', { online: true })).status, 403);

  // documentos incompletos → recusado
  assert.equal((await driver.req('POST', '/api/driver/apply', {
    birth_date: '1990-05-10', address: 'Rua A, 100', moto_plate: 'ABC-1D23',
    moto_brand: 'Honda', moto_model: 'CG 160', moto_year: '2022', moto_color: 'Vermelha',
    documents: { cnh: fakeDoc() },
  })).status, 400);

  const apply = await driver.req('POST', '/api/driver/apply', {
    birth_date: '1990-05-10', address: 'Rua A, 100', moto_plate: 'ABC-1D23',
    moto_brand: 'Honda', moto_model: 'CG 160', moto_year: '2022', moto_color: 'Vermelha',
    documents: { cnh: fakeDoc(), crlv: fakeDoc(), selfie: fakeDoc() },
  });
  assert.equal(apply.status, 201);
  assert.equal(apply.data.status, 'pending');

  // ainda pendente → continua sem poder ficar online
  assert.equal((await driver.req('POST', '/api/driver/online', { online: true })).status, 403);

  // admin vê o pendente com documentos em link assinado
  const list = await admin.req('GET', '/api/admin/drivers?status=pending');
  assert.equal(list.data.drivers.length, 1);
  const driverId = list.data.drivers[0].user_id;
  const detail = await admin.req('GET', `/api/admin/drivers/${driverId}`);
  assert.equal(detail.data.documents.length, 3);
  const docUrl: string = detail.data.documents[0].url;
  assert.match(docUrl, /^\/files\/doc\/.+\?e=\d+&s=/);

  // link assinado funciona; assinatura adulterada falha
  assert.equal((await fetch(base + docUrl)).status, 200);
  assert.equal((await fetch(base + docUrl.replace(/s=.{6}/, 's=zzzzzz'))).status, 403);
  // acesso sem assinatura falha
  assert.equal((await fetch(base + docUrl.split('?')[0])).status, 403);

  // reprovar exige motivo
  assert.equal((await admin.req('POST', `/api/admin/drivers/${driverId}/review`,
    { action: 'reject' })).status, 400);

  // aprovar
  const ok = await admin.req('POST', `/api/admin/drivers/${driverId}/review`, { action: 'approve' });
  assert.equal(ok.status, 200);

  // agora pode ficar online (com localização)
  assert.equal((await driver.req('POST', '/api/driver/online', { online: true })).status, 200);
  assert.equal((await driver.req('POST', '/api/driver/location',
    { lat: -24.4160, lng: -53.5220 })).status, 200);

  const stats = await passenger.req('GET', '/api/public/stats');
  assert.equal(stats.data.online_drivers, 1);
});

/* ================= corrida completa ================= */

let rideId = '';

test('corrida: solicitação, aceite atômico, fluxo até conclusão', async () => {
  // segundo mototaxista aprovado e online (para o teste de aceite simultâneo)
  await driver2.req('POST', '/api/auth/register', {
    role: 'driver', name: 'Carlos Souza', cpf: '111.444.777-35',
    phone: '(44) 97777-0002', email: 'carlos@teste.com', password: 'senha12345',
  });
  await driver2.req('POST', '/api/driver/apply', {
    birth_date: '1985-01-20', address: 'Rua B, 200', moto_plate: 'XYZ-9A87',
    moto_brand: 'Yamaha', moto_model: 'Factor 150', moto_year: '2021', moto_color: 'Preta',
    documents: { cnh: fakeDoc(), crlv: fakeDoc(), selfie: fakeDoc() },
  });
  const pend = await admin.req('GET', '/api/admin/drivers?status=pending');
  await admin.req('POST', `/api/admin/drivers/${pend.data.drivers[0].user_id}/review`, { action: 'approve' });
  await driver2.req('POST', '/api/driver/online', { online: true });
  await driver2.req('POST', '/api/driver/location', { lat: -24.4150, lng: -53.5210 });

  // nova cotação (a anterior pode ter sido usada) e solicitação
  const q = await passenger.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  const eco = q.data.quotes.find((x: any) => x.category === 'economica');
  const create = await passenger.req('POST', '/api/rides', { quote_id: eco.id, payment_method: 'pix' });
  assert.equal(create.status, 201);
  rideId = create.data.ride.id;
  assert.equal(create.data.ride.status, 'requested');
  assert.equal(create.data.notified_drivers, 2);

  // cotação não pode ser reutilizada
  assert.equal((await passenger.req('POST', '/api/rides', { quote_id: eco.id, payment_method: 'pix' })).status, 409);
  // nem segunda corrida simultânea com outra cotação
  const q2 = await passenger.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  assert.equal((await passenger.req('POST', '/api/rides',
    { quote_id: q2.data.quotes[0].id, payment_method: 'pix' })).status, 409);

  // oferta aparece para os motoristas
  const offers = await driver.req('GET', '/api/driver/offers');
  assert.ok(offers.data.offers.some((o: any) => o.id === rideId));

  // ACEITE SIMULTÂNEO: os dois tentam, só um consegue
  const [a1, a2] = await Promise.all([
    driver.req('POST', `/api/driver/rides/${rideId}/accept`),
    driver2.req('POST', `/api/driver/rides/${rideId}/accept`),
  ]);
  const statuses = [a1.status, a2.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const winner = a1.status === 200 ? driver : driver2;
  const loser = a1.status === 200 ? driver2 : driver;

  // perdedor não controla a corrida de terceiro
  assert.equal((await loser.req('POST', `/api/driver/rides/${rideId}/start`)).status, 403);

  // passageiro vê o cartão do mototaxista
  const act = await passenger.req('GET', '/api/rides/active');
  assert.equal(act.data.ride.status, 'accepted');
  assert.ok(act.data.ride.driver.name);
  assert.ok(act.data.ride.driver.moto.plate);

  // chat funciona entre participantes e é bloqueado para terceiros
  assert.equal((await passenger.req('POST', `/api/rides/${rideId}/messages`, { body: 'Estou de blusa azul' })).status, 201);
  assert.equal((await winner.req('GET', `/api/rides/${rideId}/messages`)).data.messages.length, 1);
  await passenger2.req('POST', '/api/auth/register', {
    role: 'passenger', name: 'Ana Souza', phone: '(44) 90000-0003',
    email: 'ana@teste.com', password: 'senha12345',
  });
  assert.equal((await passenger2.req('GET', `/api/rides/${rideId}`)).status, 403);
  assert.equal((await passenger2.req('GET', `/api/rides/${rideId}/messages`)).status, 403);

  // fluxo: cheguei → iniciar → finalizar
  assert.equal((await winner.req('POST', `/api/driver/rides/${rideId}/arrived`)).status, 200);
  // concluir antes de iniciar é inválido
  assert.equal((await winner.req('POST', `/api/driver/rides/${rideId}/complete`)).status, 409);
  assert.equal((await winner.req('POST', `/api/driver/rides/${rideId}/start`)).status, 200);
  // passageiro não cancela corrida em andamento
  assert.equal((await passenger.req('POST', `/api/rides/${rideId}/cancel`, {})).status, 409);
  const done = await winner.req('POST', `/api/driver/rides/${rideId}/complete`, { payment_received: true });
  assert.equal(done.status, 200);
  assert.equal(done.data.ride.status, 'completed');

  // financeiro: comissão 15% consistente
  const price = done.data.ride.price_cents;
  assert.equal(done.data.ride.commission_cents, Math.round(price * 0.15));
  assert.equal(done.data.ride.driver_cents, price - Math.round(price * 0.15));
  const earn = await winner.req('GET', '/api/driver/earnings');
  assert.equal(earn.data.day.rides, 1);
  assert.equal(earn.data.day.net, done.data.ride.driver_cents);

  // avaliação: ok uma vez, duplicada falha
  assert.equal((await passenger.req('POST', `/api/rides/${rideId}/rate`, { stars: 5, comment: 'Ótimo!' })).status, 201);
  assert.equal((await passenger.req('POST', `/api/rides/${rideId}/rate`, { stars: 1 })).status, 409);
  // corrida concluída não pode ser cancelada
  assert.equal((await passenger.req('POST', `/api/rides/${rideId}/cancel`, {})).status, 409);
});

test('cancelamento pelo passageiro e desistência do mototaxista (re-despacho)', async () => {
  // corrida 2: passageiro cancela em requested
  let q = await passenger.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  let r = await passenger.req('POST', '/api/rides',
    { quote_id: q.data.quotes[0].id, payment_method: 'dinheiro' });
  assert.equal((await passenger.req('POST', `/api/rides/${r.data.ride.id}/cancel`,
    { reason: 'mudei de ideia' })).status, 200);
  const got = await passenger.req('GET', `/api/rides/${r.data.ride.id}`);
  assert.equal(got.data.ride.status, 'cancelled');
  assert.equal(got.data.ride.cancelled_by, 'passenger');

  // corrida 3: motorista aceita e desiste → volta para a fila
  q = await passenger.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  r = await passenger.req('POST', '/api/rides',
    { quote_id: q.data.quotes[0].id, payment_method: 'dinheiro' });
  const rid = r.data.ride.id;
  assert.equal((await driver.req('POST', `/api/driver/rides/${rid}/accept`)).status, 200);
  const giveUp = await driver.req('POST', `/api/driver/rides/${rid}/cancel`, { reason: 'pneu furou' });
  assert.equal(giveUp.status, 200);
  assert.equal(giveUp.data.redispatched, true);
  const back = await passenger.req('GET', '/api/rides/active');
  assert.equal(back.data.ride.status, 'requested');
  // outro motorista pode aceitar
  assert.equal((await driver2.req('POST', `/api/driver/rides/${rid}/accept`)).status, 200);
  // limpar: cancelar
  await driver2.req('POST', `/api/driver/rides/${rid}/cancel`, { reason: 'teste' });
  const after2 = await passenger.req('GET', '/api/rides/active');
  if (after2.data.ride) await passenger.req('POST', `/api/rides/${after2.data.ride.id}/cancel`, {});
});

/* ================= administração ================= */

test('alterar tarifas/comissão não muda corridas antigas', async () => {
  const before = await admin.req('GET', `/api/admin/rides/${rideId}`);
  const oldCommission = before.data.ride.commission_cents;

  const upd = await admin.req('PUT', '/api/admin/settings', {
    settings: { commission_pct: '20' },
    fares: [{ category: 'economica', base_cents: 700, included_m: 2000, per_km_cents: 250 }],
  });
  assert.equal(upd.status, 200);

  // corrida antiga preservada
  const afterRide = await admin.req('GET', `/api/admin/rides/${rideId}`);
  assert.equal(afterRide.data.ride.commission_cents, oldCommission);
  assert.equal(afterRide.data.ride.commission_pct, 15);

  // nova cotação usa a tarifa nova
  const q = await passenger.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  const eco = q.data.quotes.find((x: any) => x.category === 'economica');
  assert.equal(eco.price_cents, 700 + Math.round(Math.max(0, eco.distance_m - 2000) * 250 / 1000));

  // auditoria registrou
  const audit = await admin.req('GET', '/api/admin/audit');
  assert.ok(audit.data.logs.some((l: any) => l.action === 'settings_update'));

  // calculadora com a comissão nova
  const calc = await admin.req('POST', '/api/admin/calc', { category: 'economica', distance_km: 5 });
  assert.equal(calc.data.commission_pct, 20);
  assert.equal(calc.data.price_cents, 700 + 3 * 250);

  // restaura comissão
  await admin.req('PUT', '/api/admin/settings', { settings: { commission_pct: '15' } });
});

test('bloqueio de usuário derruba sessão e tira motorista do ar', async () => {
  const list = await admin.req('GET', '/api/admin/drivers?status=approved');
  const d2 = list.data.drivers.find((d: any) => d.email === 'carlos@teste.com');
  assert.equal((await admin.req('POST', `/api/admin/users/${d2.user_id}/block`,
    { blocked: true, reason: 'teste de bloqueio' })).status, 200);
  // sessão derrubada
  assert.equal((await driver2.req('GET', '/api/me')).status, 401);
  // não conta mais como online
  const stats = await passenger.req('GET', '/api/public/stats');
  assert.equal(stats.data.online_drivers, 1);
  await admin.req('POST', `/api/admin/users/${d2.user_id}/block`, { blocked: false });
});

test('dashboard consolida os números', async () => {
  const r = await admin.req('GET', '/api/admin/dashboard');
  assert.equal(r.status, 200);
  assert.ok(r.data.totals.passengers >= 2);
  assert.equal(r.data.totals.drivers_approved, 2);
  assert.ok(r.data.totals.rides_completed >= 1);
  assert.ok(r.data.totals.commission_cents > 0);
  assert.equal(Object.keys(r.data.series).length, 14);
});

test('suporte: passageiro envia, admin responde', async () => {
  assert.equal((await passenger.req('POST', '/api/support',
    { subject: 'Dúvida', body: 'Como altero meu telefone?' })).status, 201);
  const list = await admin.req('GET', '/api/admin/support');
  const msg = list.data.messages[0];
  assert.equal((await admin.req('POST', `/api/admin/support/${msg.id}/reply`,
    { body: 'Na aba Perfil você pode editar.' })).status, 201);
  const mine = await passenger.req('GET', '/api/support');
  assert.equal(mine.data.replies.length, 1);
});
