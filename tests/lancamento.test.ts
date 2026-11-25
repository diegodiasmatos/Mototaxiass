/**
 * Correções antes do lançamento (itens críticos da auditoria):
 *  C2 — passageiro não fica preso: cancela com Pix pendente e prazos vencem sozinhos;
 *  C3 — limite de tentativas pelo IP real e só para senha errada;
 *  C4 — pagamento de teste bloqueado no app publicado.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

process.env.GEO_OFFLINE = '1';
process.env.ADMIN_EMAIL = 'dono-lanc@teste.com';
process.env.ADMIN_PASSWORD = 'senha-admin-lanc-teste';
process.env.SESSION_SECRET = 'segredo-de-teste-lancamento';
process.env.TRUST_PROXY = '1';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assis-lanc-'));

const { start } = await import('../server/index.ts');
const dbMod = await import('../server/db.ts');
const { expireStaleRides } = await import('../server/rides.ts');
const db = { prepare: (sql: string) => dbMod.db.prepare(sql) };

let base = '';
let close: () => Promise<void>;

function actor(ip = '200.1.1.1') {
  let cookie = '';
  return {
    ip,
    async req(method: string, p: string, body?: unknown) {
      const r = await fetch(base + p, {
        method,
        headers: {
          'Fly-Client-IP': this.ip,
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

const ORIGIN = { lat: -24.4156, lng: -53.5216, text: 'Centro, Assis Chateaubriand' };
const DEST = { lat: -24.4450, lng: -53.5400, text: 'Jardim Paraná, Assis Chateaubriand' };
const pax = actor('200.1.1.10');

async function newRide(method: 'pix' | 'dinheiro' = 'pix') {
  const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  const c = await pax.req('POST', '/api/rides', { quote_id: q.data.quotes[0].id, payment_method: method });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  return c.data.ride.id as string;
}

before(async () => {
  const s = await start({ port: 0, quiet: true, dbPath: path.join(process.env.DATA_DIR!, 'lanc.db') });
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;
  await pax.req('POST', '/api/auth/register', {
    role: 'passenger', name: 'Paula Passageira', phone: '(44) 90000-3333',
    email: 'paula@lanc.test', password: 'senha12345', accept_terms: true,
  });
});
after(async () => { await close(); });

// ================= C2 =================

test('C2: com o Pix pendente o passageiro cancela e pode pedir outra corrida', async () => {
  const rid = await newRide('pix');
  assert.equal((db.prepare('SELECT status FROM rides WHERE id = ?').get(rid) as any).status, 'pending_payment');
  const c = await pax.req('POST', `/api/rides/${rid}/cancel`, { reason: 'desisti' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const row = db.prepare('SELECT status, cancelled_by FROM rides WHERE id = ?').get(rid) as any;
  assert.equal(row.status, 'cancelled');
  assert.equal(row.cancelled_by, 'passenger');
  // não fica preso: consegue pedir de novo
  const again = await newRide('pix');
  await pax.req('POST', `/api/rides/${again}/cancel`, {});
});

test('C2: Pix não pago vence sozinho e o passageiro é avisado', async () => {
  const rid = await newRide('pix');
  db.prepare('UPDATE rides SET requested_at = ? WHERE id = ?').run(Date.now() - 60 * 60_000, rid);
  const r = await expireStaleRides();
  assert.ok(r.payment >= 1);
  const row = db.prepare('SELECT status, cancelled_by, cancel_reason FROM rides WHERE id = ?').get(rid) as any;
  assert.equal(row.status, 'cancelled');
  assert.equal(row.cancelled_by, 'sistema');
  assert.match(row.cancel_reason, /Pagamento não confirmado/);
  const n = await pax.req('GET', '/api/notifications');
  assert.ok(n.data.notifications.some((x: any) => x.kind === 'ride_cancelled'));
});

test('C2: sem aceite no prazo, a corrida é cancelada e o Pix pago é estornado', async () => {
  const rid = await newRide('pix');
  await pax.req('POST', `/api/rides/${rid}/payment/test-approve`);
  assert.equal((db.prepare('SELECT status FROM rides WHERE id = ?').get(rid) as any).status, 'requested');
  // ainda dentro do prazo: nada acontece
  await expireStaleRides();
  assert.equal((db.prepare('SELECT status FROM rides WHERE id = ?').get(rid) as any).status, 'requested');
  db.prepare('UPDATE rides SET requested_at = ? WHERE id = ?').run(Date.now() - 16 * 60_000, rid);
  const r = await expireStaleRides();
  assert.equal(r.request, 1);
  const row = db.prepare('SELECT status, cancelled_by FROM rides WHERE id = ?').get(rid) as any;
  assert.equal(row.status, 'cancelled');
  assert.equal(row.cancelled_by, 'sistema');
  const pay = db.prepare('SELECT status FROM payments WHERE ride_id = ?').get(rid) as any;
  assert.equal(pay.status, 'estornado');
});

test('C2: prazo de aceite pode ser desligado (0) pela central', async () => {
  db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('request_timeout_min', '0')`).run();
  try {
    const rid = await newRide('dinheiro');
    db.prepare('UPDATE rides SET requested_at = ? WHERE id = ?').run(Date.now() - 5 * 3600_000, rid);
    await expireStaleRides();
    assert.equal((db.prepare('SELECT status FROM rides WHERE id = ?').get(rid) as any).status, 'requested');
    await pax.req('POST', `/api/rides/${rid}/cancel`, {});
  } finally {
    db.prepare(`UPDATE app_settings SET value = '15' WHERE key = 'request_timeout_min'`).run();
  }
});

// ================= C3 =================

test('C3: login certo nunca é barrado; erros contam por IP real', async () => {
  // 30 logins certos seguidos do mesmo IP: todos passam
  for (let i = 0; i < 30; i++) {
    const r = await actor('200.2.2.2').req('POST', '/api/auth/login', { email: 'paula@lanc.test', password: 'senha12345' });
    assert.equal(r.status, 200, `login ${i + 1}`);
  }
  // 20 senhas erradas (contas inexistentes) do IP A: o IP A espera...
  const a = actor('200.3.3.3');
  for (let i = 0; i < 20; i++) {
    assert.equal((await a.req('POST', '/api/auth/login', { email: `x${i}@lanc.test`, password: 'errada123' })).status, 401);
  }
  assert.equal((await a.req('POST', '/api/auth/login', { email: 'paula@lanc.test', password: 'senha12345' })).status, 429);
  // ...mas quem está em outro IP entra normalmente
  assert.equal((await actor('200.4.4.4').req('POST', '/api/auth/login',
    { email: 'paula@lanc.test', password: 'senha12345' })).status, 200);
});

test('C3: muitas senhas erradas na mesma conta, de IPs diferentes, pausam a conta', async () => {
  await actor('200.5.5.5').req('POST', '/api/auth/register', {
    role: 'passenger', name: 'Alvo', phone: '(44) 90000-4444', email: 'alvo@lanc.test',
    password: 'senha12345', accept_terms: true,
  });
  for (let i = 0; i < 8; i++) {
    assert.equal((await actor(`201.0.0.${i}`).req('POST', '/api/auth/login',
      { email: 'alvo@lanc.test', password: 'errada123' })).status, 401);
  }
  const r = await actor('201.0.0.99').req('POST', '/api/auth/login', { email: 'ALVO@lanc.test', password: 'errada123' });
  assert.equal(r.status, 429);
  assert.match(r.data.error, /15 minutos/);
});

test('C3: sem TRUST_PROXY o cabeçalho do proxy é ignorado (não dá para forjar IP)', async () => {
  const { clientIp } = await import('../server/util.ts');
  const fake = { headers: { 'fly-client-ip': '9.9.9.9' }, socket: { remoteAddress: '::ffff:10.0.0.1' } } as any;
  assert.equal(clientIp(fake), '9.9.9.9');
  process.env.TRUST_PROXY = '0';
  try { assert.equal(clientIp(fake), '10.0.0.1'); } finally { process.env.TRUST_PROXY = '1'; }
});

// ================= C4 =================

test('C4: no app publicado sem Mercado Pago, só dinheiro; pagamento de teste recusado', async () => {
  // corrida de teste criada antes (como se fosse ambiente de testes)
  const old = await newRide('pix');
  process.env.APP_ENV = 'production';
  try {
    const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
    const m = Object.fromEntries(q.data.payment_methods.map((x: any) => [x.method, x.enabled]));
    assert.deepEqual(m, { pix: false, cartao: false, dinheiro: true });
    assert.equal(q.data.test_mode, false);
    const pix = await pax.req('POST', '/api/rides', { quote_id: q.data.quotes[0].id, payment_method: 'pix' });
    assert.equal(pix.status, 400);
    assert.match(pix.data.error, /Mercado Pago/);
    // nenhuma corrida de teste vira "paga" no app publicado
    assert.equal((await pax.req('POST', `/api/rides/${old}/payment/test-approve`)).status, 403);
  } finally {
    delete process.env.APP_ENV;
  }
  await pax.req('POST', `/api/rides/${old}/cancel`, {});
});
