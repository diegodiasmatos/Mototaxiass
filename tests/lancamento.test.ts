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

// ================= C5: termos =================

test('C5: cadastro exige aceite dos termos e grava versão e data', async () => {
  const a = actor('200.6.6.6');
  const no = await a.req('POST', '/api/auth/register', {
    role: 'passenger', name: 'Sem Aceite', phone: '(44) 90000-5555', email: 'semaceite@lanc.test', password: 'senha12345',
  });
  assert.equal(no.status, 400);
  assert.match(no.data.error, /Termos de Uso/);
  const ok = await a.req('POST', '/api/auth/register', {
    role: 'passenger', name: 'Com Aceite', phone: '(44) 90000-5555', email: 'comaceite@lanc.test',
    password: 'senha12345', accept_terms: true,
  });
  assert.equal(ok.status, 201);
  const row = db.prepare(`SELECT terms_version, terms_accepted_at FROM users WHERE email = 'comaceite@lanc.test'`).get() as any;
  const legal = await a.req('GET', '/api/legal');
  assert.equal(row.terms_version, legal.data.version);
  assert.ok(row.terms_accepted_at > 0);
  assert.equal((await a.req('GET', '/api/me')).data.terms_ok, true);
  // páginas públicas existem
  for (const p of ['/termos', '/privacidade']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /legal\.js/);
  }
  assert.equal(legal.data.reviewed, false);          // aviso de versão preliminar ligado
});

test('C5: conta antiga sem aceite não pede corrida até aceitar', async () => {
  const a = actor('200.7.7.7');
  await a.req('POST', '/api/auth/register', {
    role: 'passenger', name: 'Antiga', phone: '(44) 90000-6666', email: 'antiga@lanc.test',
    password: 'senha12345', accept_terms: true,
  });
  db.prepare(`UPDATE users SET terms_version = NULL WHERE email = 'antiga@lanc.test'`).run();
  const me = await a.req('GET', '/api/me');
  assert.equal(me.data.terms_ok, false);
  const q = await a.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  assert.equal(q.status, 428);
  assert.equal((await a.req('POST', '/api/me/accept-terms', { version: 'velha' })).status, 409);
  assert.equal((await a.req('POST', '/api/me/accept-terms', { version: me.data.terms_version })).status, 200);
  assert.equal((await a.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST })).status, 200);
});

// ================= C6: senha =================

const adm = actor('200.9.9.9');

test('C6: trocar senha pede a atual e encerra as outras sessões', async () => {
  const a1 = actor('200.8.8.1'), a2 = actor('200.8.8.2');
  await a1.req('POST', '/api/auth/register', {
    role: 'passenger', name: 'Troca', phone: '(44) 90000-7777', email: 'troca@lanc.test',
    password: 'senha12345', accept_terms: true,
  });
  await a2.req('POST', '/api/auth/login', { email: 'troca@lanc.test', password: 'senha12345' });
  assert.equal((await a1.req('POST', '/api/me/password',
    { current_password: 'errada000', new_password: 'novasenha1' })).status, 400);
  const ok = await a1.req('POST', '/api/me/password', { current_password: 'senha12345', new_password: 'novasenha1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.other_sessions_closed, 1);
  assert.equal((await a1.req('GET', '/api/me')).status, 200);   // este aparelho continua
  assert.equal((await a2.req('GET', '/api/me')).status, 401);   // o outro saiu
  assert.equal((await actor('200.8.8.3').req('POST', '/api/auth/login',
    { email: 'troca@lanc.test', password: 'novasenha1' })).status, 200);
});

test('C6: esqueci a senha → central gera link de uso único → nova senha', async () => {
  await adm.req('POST', '/api/auth/login', { email: 'dono-lanc@teste.com', password: 'senha-admin-lanc-teste' });
  // a resposta é igual para e-mail que existe e que não existe
  const f1 = await actor('200.10.0.1').req('POST', '/api/auth/forgot', { email: 'paula@lanc.test' });
  const f2 = await actor('200.10.0.2').req('POST', '/api/auth/forgot', { email: 'ninguem@lanc.test' });
  assert.equal(f1.status, 200);
  assert.deepEqual(f1.data, f2.data);
  const notes = await adm.req('GET', '/api/notifications');
  assert.ok(notes.data.notifications.some((n: any) => n.kind === 'password_reset_request'));

  const paulaId = (db.prepare(`SELECT id FROM users WHERE email = 'paula@lanc.test'`).get() as any).id;
  assert.equal((await pax.req('POST', `/api/admin/users/${paulaId}/reset-link`)).status, 403);  // só a central
  const link = await adm.req('POST', `/api/admin/users/${paulaId}/reset-link`);
  assert.equal(link.status, 201);
  const token = /#t=(.+)$/.exec(link.data.url)![1];
  // o banco guarda só o hash
  assert.equal((db.prepare('SELECT COUNT(*) n FROM password_resets WHERE token_hash = ?').get(token) as any).n, 0);

  const r = await actor('200.10.0.3').req('POST', '/api/auth/reset', { token, password: 'outrasenha9' });
  assert.equal(r.status, 200);
  assert.equal((await pax.req('GET', '/api/me')).status, 401);  // sessões antigas encerradas
  assert.equal((await actor('200.10.0.4').req('POST', '/api/auth/reset', { token, password: 'denovo1234' })).status, 410);
  assert.equal((await pax.req('POST', '/api/auth/login', { email: 'paula@lanc.test', password: 'outrasenha9' })).status, 200);
  const aud = await adm.req('GET', '/api/admin/audit');
  assert.ok(aud.data.logs.some((l: any) => l.action === 'password_reset_link'));
});

test('C6: link vencido não funciona', async () => {
  const paulaId = (db.prepare(`SELECT id FROM users WHERE email = 'paula@lanc.test'`).get() as any).id;
  const link = await adm.req('POST', `/api/admin/users/${paulaId}/reset-link`);
  const token = /#t=(.+)$/.exec(link.data.url)![1];
  db.prepare('UPDATE password_resets SET expires_at = ? WHERE user_id = ? AND used_at IS NULL').run(Date.now() - 1, paulaId);
  assert.equal((await actor('200.10.0.5').req('POST', '/api/auth/reset', { token, password: 'qualquer123' })).status, 410);
});

// ================= C7: exclusão de conta =================

test('C7: pedido de exclusão com senha → central anonimiza, corridas ficam sem identificar', async () => {
  const a = actor('200.11.0.1');
  await a.req('POST', '/api/auth/register', {
    role: 'passenger', name: 'Quero Sair', phone: '(44) 90000-8888', email: 'sair@lanc.test',
    password: 'senha12345', accept_terms: true,
  });
  const uid = (db.prepare(`SELECT id FROM users WHERE email = 'sair@lanc.test'`).get() as any).id;
  // uma corrida cancelada no histórico
  const q = await a.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  const rid = (await a.req('POST', '/api/rides', { quote_id: q.data.quotes[0].id, payment_method: 'dinheiro' })).data.ride.id;
  await a.req('POST', `/api/rides/${rid}/cancel`, {});

  assert.equal((await a.req('POST', '/api/me/delete-request', { password: 'errada000' })).status, 400);
  assert.equal((await a.req('POST', '/api/me/delete-request', { password: 'senha12345', reason: 'não uso mais' })).status, 201);
  assert.ok((await a.req('GET', '/api/me')).data.deletion_requested_at > 0);
  // pode desistir e pedir de novo
  assert.equal((await a.req('DELETE', '/api/me/delete-request')).data.cancelled, 1);
  await a.req('POST', '/api/me/delete-request', { password: 'senha12345' });

  const list = await adm.req('GET', '/api/admin/deletion-requests');
  assert.ok(list.data.requests.some((r: any) => r.user_id === uid && r.status === 'pendente'));
  assert.equal((await adm.req('POST', `/api/admin/users/${uid}/anonymize`, { confirm: 'sim' })).status, 400);
  const an = await adm.req('POST', `/api/admin/users/${uid}/anonymize`, { confirm: 'ANONIMIZAR' });
  assert.equal(an.status, 200);

  const u = db.prepare('SELECT name, email, phone, blocked FROM users WHERE id = ?').get(uid) as any;
  assert.equal(u.name, 'Usuário removido');
  assert.match(u.email, /@anonimizado\.invalid$/);
  assert.equal(u.phone, null);
  assert.equal(u.blocked, 1);
  const ride = db.prepare('SELECT origin_text, price_cents FROM rides WHERE id = ?').get(rid) as any;
  assert.equal(ride.origin_text, '[endereço removido]');
  assert.ok(ride.price_cents > 0);                      // valores preservados
  assert.equal((db.prepare(`SELECT status FROM account_deletion_requests WHERE user_id = ? ORDER BY created_at DESC`)
    .get(uid) as any).status, 'concluido');
  assert.equal((await a.req('GET', '/api/me')).status, 401);
});

test('C7: com corrida em andamento a anonimização espera', async () => {
  const a = actor('200.11.0.2');
  await a.req('POST', '/api/auth/register', {
    role: 'passenger', name: 'Em Corrida', phone: '(44) 90000-9999', email: 'emcorrida@lanc.test',
    password: 'senha12345', accept_terms: true,
  });
  const uid = (db.prepare(`SELECT id FROM users WHERE email = 'emcorrida@lanc.test'`).get() as any).id;
  const q = await a.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  const rid = (await a.req('POST', '/api/rides', { quote_id: q.data.quotes[0].id, payment_method: 'dinheiro' })).data.ride.id;
  const r = await a.req('POST', '/api/me/delete-request', { password: 'senha12345' });
  assert.equal(r.data.active_ride, true);
  assert.equal((await adm.req('POST', `/api/admin/users/${uid}/anonymize`, { confirm: 'ANONIMIZAR' })).status, 409);
  await a.req('POST', `/api/rides/${rid}/cancel`, {});
});

// ================= I3: requisitos do mototaxista =================

test('I3: cadastro do mototaxista confere idade, validade e tempo de CNH e a categoria A/EAR', async () => {
  const d = actor('200.12.0.1');
  await d.req('POST', '/api/auth/register', {
    role: 'driver', name: 'Moto Teste', cpf: '529.982.247-25', phone: '(44) 90000-1212',
    email: 'moto@lanc.test', password: 'senha12345', accept_terms: true,
  });
  const doc = `data:image/jpeg;base64,${Buffer.alloc(4000, 7).toString('base64')}`;
  const iso = (yearsAgo: number) => { const t = new Date(); t.setFullYear(t.getFullYear() - yearsAgo); return t.toISOString().slice(0, 10); };
  const body = (over: any = {}) => ({
    birth_date: iso(30), address: 'Rua A, 10', moto_plate: 'ABC-1D23', moto_brand: 'Honda',
    moto_model: 'CG 160', moto_year: '2022', moto_color: 'Preta',
    cnh_expiry: iso(-3), cnh_first_date: iso(5), decl_cat_a_ear: true, decl_course: true,
    documents: { cnh: doc, crlv: doc, selfie: doc }, ...over,
  });
  const cases: [any, RegExp][] = [
    [{ birth_date: iso(20) }, /21 anos/],
    [{ cnh_expiry: iso(1) }, /vencida/],
    [{ cnh_first_date: iso(1) }, /2 anos/],
    [{ decl_cat_a_ear: false }, /categoria A/],
    [{ cnh_expiry: '2030-02-31' }, /Data inválida/],
  ];
  for (const [over, re] of cases) {
    const r = await d.req('POST', '/api/driver/apply', body(over));
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.match(r.data.error, re);
  }
  const ok = await d.req('POST', '/api/driver/apply', body());
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const row = db.prepare(`SELECT cnh_expiry, cnh_first_date, decl_cat_a_ear, decl_course FROM drivers
    WHERE user_id = (SELECT id FROM users WHERE email = 'moto@lanc.test')`).get() as any;
  assert.equal(row.decl_cat_a_ear, 1);
  assert.equal(row.decl_course, 1);
  assert.equal(row.cnh_expiry, iso(-3));
});

// ================= I5 / I7: cópia diária e prazos de guarda =================

test('I5: cópia diária do banco, com rotação e download só pela central (auditado)', async () => {
  const { dailyBackupIfDue, listBackups } = await import('../server/maintenance.ts');
  const first = dailyBackupIfDue();
  assert.ok(first && fs.existsSync(first));
  assert.equal(dailyBackupIfDue(), null);                       // menos de 24 h: não repete
  const t = Date.now();
  for (let i = 1; i <= 8; i++) dailyBackupIfDue(t + i * 1000, true);
  assert.equal(listBackups().length, 7);                        // guarda as 7 mais novas
  const name = listBackups()[0].name;
  assert.equal((await pax.req('GET', `/api/admin/backups/${name}`)).status, 403);
  assert.equal((await adm.req('GET', '/api/admin/backups/..%2F..%2Fetc%2Fpasswd')).status, 404);
  const r = await fetch(`${base}/api/admin/backups/${name}`, {
    headers: { Cookie: await (async () => {
      const x = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Fly-Client-IP': '200.20.0.1' },
        body: JSON.stringify({ email: 'dono-lanc@teste.com', password: 'senha-admin-lanc-teste' }) });
      return /amt_session=[^;]+/.exec(x.headers.get('set-cookie') || '')![0];
    })() },
  });
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  const aud = await adm.req('GET', '/api/admin/audit');
  assert.ok(aud.data.logs.some((l: any) => l.action === 'backup_download'));
});

test('I7: prazos de guarda vêm desligados; ligados, só apagam corrida encerrada sem ocorrência aberta', async () => {
  const { purgeOldGps, purgeOldMessages } = await import('../server/maintenance.ts');
  const paxId = (db.prepare(`SELECT id FROM users WHERE email = 'paula@lanc.test'`).get() as any).id;
  const old = Date.now() - 400 * 86400_000;
  const mk = (id: string, status: string) => {
    db.prepare(`INSERT INTO rides (id, passenger_id, category, status, origin_text, origin_lat, origin_lng,
      dest_text, dest_lat, dest_lng, distance_m, duration_s, price_cents, commission_pct, payment_method,
      payment_status, requested_at, completed_at) VALUES (?, ?, 'economica', ?, 'A', -24.41, -53.52, 'B', -24.44, -53.54,
      1000, 100, 800, 15, 'dinheiro', 'criado', ?, ?)`).run(id, paxId, status, old, old);
    db.prepare(`INSERT INTO ride_locations (ride_id, who, lat, lng, accuracy_m, at) VALUES (?, 'passenger', -24.41, -53.52, 10, ?)`).run(id, old);
    db.prepare(`INSERT INTO ride_messages (id, ride_id, sender_id, body, at) VALUES (?, ?, ?, 'oi', ?)`).run(`m_${id}`, id, paxId, old);
  };
  mk('rid_ret_ok', 'completed');
  mk('rid_ret_issue', 'completed');
  db.prepare(`INSERT INTO ride_issues (id, ride_id, user_id, role, kind, created_at) VALUES ('iss_ret', 'rid_ret_issue', ?, 'passenger', 'outro', ?)`).run(paxId, old);
  const count = (t: string, id: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ride_id = ?`).get(id) as any).n;

  // padrão da Política de Privacidade: 180 dias
  assert.equal((db.prepare(`SELECT value FROM app_settings WHERE key = 'gps_retention_days'`).get() as any).value, '180');
  db.prepare(`UPDATE app_settings SET value = '0' WHERE key IN ('gps_retention_days', 'messages_retention_days')`).run();
  assert.equal(purgeOldGps(), 0);                    // 0 dias = não apaga
  assert.equal(purgeOldMessages(), 0);
  assert.equal(count('ride_locations', 'rid_ret_ok'), 1);

  db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('gps_retention_days', '90'), ('messages_retention_days', '180')`).run();
  try {
    purgeOldGps(); purgeOldMessages();
    assert.equal(count('ride_locations', 'rid_ret_ok'), 0);
    assert.equal(count('ride_messages', 'rid_ret_ok'), 0);
    assert.equal(count('ride_locations', 'rid_ret_issue'), 1);     // ocorrência aberta: guarda a prova
    assert.equal(count('ride_messages', 'rid_ret_issue'), 1);
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM rides WHERE id IN ('rid_ret_ok','rid_ret_issue')`).get() as any).n, 2);
  } finally {
    db.prepare(`UPDATE app_settings SET value = '180' WHERE key IN ('gps_retention_days', 'messages_retention_days')`).run();
  }
});

// ================= I6: cabeçalhos, cookie e sessão da central =================

test('I6: cabeçalhos de segurança, cookie Secure no app publicado e sessão da central de 12 h', async () => {
  const page = await fetch(base + '/passageiro');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.match(page.headers.get('content-security-policy-report-only') || '', /script-src 'self' 'sha256-/);
  assert.match(page.headers.get('permissions-policy') || '', /geolocation=\(self\)/);
  assert.equal(page.headers.get('strict-transport-security'), null);   // fora de produção

  process.env.APP_ENV = 'production';
  try {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Fly-Client-IP': '200.21.0.1' },
      body: JSON.stringify({ email: 'dono-lanc@teste.com', password: 'senha-admin-lanc-teste' }) });
    const cookie = r.headers.get('set-cookie') || '';
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /Max-Age=43200/);                              // central: 12 h
    assert.match(r.headers.get('strict-transport-security') || '', /max-age=/);
    const tok = /amt_session=([^;]+)/.exec(cookie)![1];
    const s = db.prepare('SELECT created_at, expires_at FROM sessions WHERE token = ?').get(tok) as any;
    assert.ok(s.expires_at - s.created_at <= 12 * 3600_000 + 1000);
  } finally { delete process.env.APP_ENV; }
});

// ================= I9 / I10 =================

test('I10: biblioteca do mapa servida pelo próprio app', async () => {
  const js = await fetch(base + '/vendor/leaflet/leaflet.js');
  assert.equal(js.status, 200);
  assert.match(await js.text(), /Leaflet 1\.9\.4/);
  const html = await (await fetch(base + '/passageiro')).text();
  assert.ok(!html.includes('unpkg.com'));
});

test('M3: /api/health responde para monitores externos, sem dados pessoais', async () => {
  const r = await fetch(base + '/api/health');
  assert.equal(r.status, 200);
  const d = await r.json() as any;
  assert.equal(d.ok, true);
  assert.deepEqual(Object.keys(d).sort(), ['ok', 'time', 'version']);
});

// ================= Google Play =================

// Impressão digital do texto dos Termos em vigor (public/legal/termos-de-uso.md).
// O texto aprovado pelo advogado está em docs/legal/termos-de-uso-aprovado-original.md
// (9d55ff97…); a versão em vigor é a completada a pedido do responsável.
// Mudar o arquivo exige atualizar este número de propósito.
const TERMS_SHA256 = 'e0c66d3e37ee54213075898dd7650c94994be82e74c676bcb65db9416a37dd12';

test('Play: Termos de Uso aprovados são servidos sem nenhuma alteração', async () => {
  const crypto = await import('node:crypto');
  // impressão digital do texto aprovado pelo advogado (não alterar este número sem um texto novo aprovado)
  const APPROVED = TERMS_SHA256;
  const local = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'legal', 'termos-de-uso.md'));
  assert.equal(crypto.createHash('sha256').update(local).digest('hex'), APPROVED, 'o arquivo aprovado foi modificado');
  const r = await fetch(base + '/legal/termos-de-uso.md');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /charset=utf-8/);
  const served = Buffer.from(await r.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(served).digest('hex'), APPROVED, 'o servidor alterou o texto');
  // a versão aceita pelos usuários é a do próprio arquivo
  const legal = await (await fetch(base + '/api/legal')).json() as any;
  assert.equal(legal.version, 'termos-' + APPROVED.slice(0, 12));
  const page = await (await fetch(base + '/termos')).text();
  assert.match(page, /data-src="\/legal\/termos-de-uso\.md"/);
});

test('Play: exclusão de conta pela web, sem login, com resposta igual para qualquer e-mail', async () => {
  const page = await fetch(base + '/excluir-conta');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Excluir sua conta VAIRO/);
  const a = await actor('200.30.0.1').req('POST', '/api/account-deletion', { email: 'troca@lanc.test', reason: 'sem acesso' });
  const b = await actor('200.30.0.2').req('POST', '/api/account-deletion', { email: 'naoexiste@lanc.test' });
  assert.equal(a.status, 200);
  assert.deepEqual(a.data, b.data);
  const req = db.prepare(`SELECT status, note FROM account_deletion_requests WHERE user_id =
    (SELECT id FROM users WHERE email = 'troca@lanc.test')`).get() as any;
  assert.equal(req.status, 'pendente');
  assert.match(req.note, /confirmar a identidade/);
});

test('Play: assetlinks.json liga o pacote às impressões digitais configuradas', async () => {
  assert.deepEqual(await (await fetch(base + '/.well-known/assetlinks.json')).json(), []);
  const FP = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase().padStart(2, '0')).join(':');
  db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('android_cert_fingerprints', ?)`).run(`${FP.toLowerCase()}, lixo`);
  try {
    const r = await fetch(base + '/.well-known/assetlinks.json');
    assert.match(r.headers.get('content-type') || '', /application\/json/);
    const d = await r.json() as any;
    assert.equal(d[0].target.package_name, 'br.com.vairo.app');
    assert.deepEqual(d[0].target.sha256_cert_fingerprints, [FP]);
    assert.deepEqual(d[0].relation, ['delegate_permission/common.handle_all_urls']);
  } finally {
    db.prepare(`DELETE FROM app_settings WHERE key = 'android_cert_fingerprints'`).run();
  }
});

test('Play: regras de cancelamento aparecem antes de confirmar a corrida', async () => {
  const html = await (await fetch(base + '/passageiro')).text();
  const rules = html.indexOf('id="quote-rules"'), btn = html.indexOf('id="btn-request"');
  assert.ok(rules > 0 && rules < btn, 'as regras devem vir antes do botão de confirmar');
  const manifest = await (await fetch(base + '/manifest.webmanifest')).json() as any;
  assert.equal(manifest.id, '/');
  assert.ok(manifest.icons.some((i: any) => i.sizes === '512x512' && i.purpose === 'maskable'));
});
