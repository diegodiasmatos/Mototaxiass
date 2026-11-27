/**
 * Central de notificações: acesso só às próprias, lida/não lida, excluir,
 * paginação, filtros, preferências com travas, sem duplicar o mesmo evento,
 * texto do push sem dados sensíveis e os eventos reais novos.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

process.env.GEO_OFFLINE = '1';
process.env.ADMIN_EMAIL = 'dono-notif@teste.com';
process.env.ADMIN_PASSWORD = 'senha-admin-notif-teste';
process.env.SESSION_SECRET = 'segredo-de-teste-notificacoes';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assis-notif-'));

const { start } = await import('../server/index.ts');
const dbMod = await import('../server/db.ts');
const { notify } = await import('../server/notify.ts');
const { KINDS, kindInfo } = await import('../server/notification-catalog.ts');
const { checkCnhExpiry, deviceLabel } = await import('../server/notify-events.ts');
const db = { prepare: (sql: string) => dbMod.db.prepare(sql) };

const ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

let base = '';
let close: () => Promise<void>;

function actor(ua = ANDROID) {
  let cookie = '';
  return {
    ua, cookie: () => cookie, reset() { cookie = ''; },
    async req(method: string, p: string, body?: unknown) {
      const r = await fetch(base + p, {
        method,
        headers: {
          'User-Agent': this.ua,
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

const fakeDoc = () => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3996, 7)]).toString('base64')}`;
const ORIGIN = { lat: -24.4156, lng: -53.5216, text: 'Centro, Assis Chateaubriand' };
const DEST = { lat: -24.4450, lng: -53.5400, text: 'Jardim Paraná, Assis Chateaubriand' };

const pax = actor();
const other = actor();
const drv = actor();
const adm = actor();
let paxId = '', otherId = '', driverId = '';

const uid = (email: string) => (db.prepare('SELECT id FROM users WHERE email = ?').get(email) as any).id as string;
const kinds = (userId: string) => (db.prepare('SELECT kind FROM notifications WHERE user_id = ? ORDER BY created_at').all(userId) as any[]).map(r => r.kind);

before(async () => {
  const s = await start({ port: 0, quiet: true, dbPath: path.join(process.env.DATA_DIR!, 'notif.db') });
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;
  await pax.req('POST', '/api/auth/register', { role: 'passenger', accept_terms: true, name: 'Nina Passageira',
    phone: '(44) 90000-4444', email: 'nina@notif.test', password: 'senha12345' });
  await other.req('POST', '/api/auth/register', { role: 'passenger', accept_terms: true, name: 'Otto Outro',
    phone: '(44) 90000-5555', email: 'otto@notif.test', password: 'senha12345' });
  await drv.req('POST', '/api/auth/register', { role: 'driver', accept_terms: true, name: 'Davi Motoboy',
    cpf: '529.982.247-25', phone: '(44) 90000-6666', email: 'davi@notif.test', password: 'senha12345' });
  await drv.req('POST', '/api/driver/apply', {
    birth_date: '1990-01-01', cnh_expiry: '2031-01-01', cnh_first_date: '2012-05-10', decl_cat_a_ear: true,
    address: 'Rua A, 10', moto_plate: 'ABC-1D23', moto_brand: 'Honda', moto_model: 'CG 160', moto_year: '2022',
    moto_color: 'Preta', documents: { cnh: fakeDoc(), crlv: fakeDoc(), selfie: fakeDoc() },
  });
  await adm.req('POST', '/api/auth/login', { email: 'dono-notif@teste.com', password: 'senha-admin-notif-teste' });
  paxId = uid('nina@notif.test'); otherId = uid('otto@notif.test'); driverId = uid('davi@notif.test');
  await adm.req('POST', `/api/admin/drivers/${driverId}/review`, { action: 'approve' });
});
after(async () => { await close(); });

test('boas-vindas no cadastro e categoria gravada', async () => {
  const r = await pax.req('GET', '/api/notifications');
  assert.equal(r.status, 200);
  const w = r.data.notifications.find((n: any) => n.kind === 'welcome');
  assert.ok(w, 'boas-vindas');
  assert.equal(w.category, 'conta');
  assert.equal(w.read, false);
  assert.ok(r.data.unread >= 1);
  assert.equal(typeof w.link, 'string');
});

test('cada pessoa só vê, lê e exclui as próprias notificações', async () => {
  const nid = notify(paxId, 'support_reply', 'Resposta do suporte', 'Olá Nina');
  const o = await other.req('GET', '/api/notifications');
  assert.ok(!o.data.notifications.some((n: any) => n.id === nid));
  assert.equal((await other.req('POST', `/api/notifications/${nid}/read`)).status, 404);
  assert.equal((await other.req('DELETE', `/api/notifications/${nid}`)).status, 404);
  assert.equal((db.prepare('SELECT read FROM notifications WHERE id = ?').get(nid) as any).read, 0);
  // sem login, nada
  const anon = actor();
  assert.equal((await anon.req('GET', '/api/notifications')).status, 401);
});

test('marcar uma como lida grava a hora; contador acompanha', async () => {
  const before = (await pax.req('GET', '/api/notifications/unread-count')).data.unread;
  const nid = notify(paxId, 'support_reply', 'Outra resposta', 'Teste');
  assert.equal((await pax.req('GET', '/api/notifications/unread-count')).data.unread, before + 1);
  const r = await pax.req('POST', `/api/notifications/${nid}/read`);
  assert.equal(r.status, 200);
  assert.equal(r.data.unread, before);
  const row = db.prepare('SELECT read, read_at FROM notifications WHERE id = ?').get(nid) as any;
  assert.equal(row.read, 1);
  assert.ok(row.read_at > 0);
});

test('excluir remove só a escolhida', async () => {
  const a = notify(paxId, 'support_reply', 'Para excluir', 'x');
  const b = notify(paxId, 'support_reply', 'Para manter', 'y');
  assert.equal((await pax.req('DELETE', `/api/notifications/${a}`)).status, 200);
  assert.equal(db.prepare('SELECT 1 FROM notifications WHERE id = ?').get(a), undefined);
  assert.ok(db.prepare('SELECT 1 FROM notifications WHERE id = ?').get(b));
});

test('histórico paginado, filtro de não lidas e de categoria, marcar todas', async () => {
  const t0 = Date.now() - 10_000;
  for (let i = 0; i < 25; i++) {
    db.prepare(`INSERT INTO notifications (id, user_id, kind, title, body, read, created_at, category, priority, link)
      VALUES (?, ?, 'rating', ?, NULL, 0, ?, 'corrida', 'baixa', '/passageiro#corridas')`)
      .run(`ntf_pg_${i}`, otherId, `Aviso ${i}`, t0 + i);
  }
  const p1 = await other.req('GET', '/api/notifications?limit=10&filter=corrida');
  assert.equal(p1.data.notifications.length, 10);
  assert.equal(p1.data.has_more, true);
  assert.equal(p1.data.notifications[0].title, 'Aviso 24');   // mais nova primeiro
  const last = p1.data.notifications[9].created_at;
  const p2 = await other.req('GET', `/api/notifications?limit=10&filter=corrida&before=${last}`);
  assert.equal(p2.data.notifications[0].title, 'Aviso 14');
  const p3 = await other.req('GET', `/api/notifications?limit=10&filter=corrida&before=${p2.data.notifications[9].created_at}`);
  assert.equal(p3.data.notifications.length, 5);
  assert.equal(p3.data.has_more, false);

  // marcar todas só de uma categoria
  const r = await other.req('POST', '/api/notifications/read', { category: 'corrida' });
  assert.equal(r.status, 200);
  const unreadCorrida = await other.req('GET', '/api/notifications?filter=unread&limit=100');
  assert.ok(!unreadCorrida.data.notifications.some((n: any) => n.category === 'corrida'));
  // a de boas-vindas (conta) continua não lida
  assert.ok(unreadCorrida.data.notifications.some((n: any) => n.kind === 'welcome'));
  await other.req('POST', '/api/notifications/read', {});
  assert.equal((await other.req('GET', '/api/notifications/unread-count')).data.unread, 0);
});

test('mesmo evento não gera notificação duplicada', () => {
  const a = notify(paxId, 'ride_accepted', 'A caminho', { body: 'x', eventKey: 'evt:teste-1' });
  const b = notify(paxId, 'ride_accepted', 'A caminho', { body: 'x', eventKey: 'evt:teste-1' });
  assert.equal(a, b);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND event_key = 'evt:teste-1'`).get(paxId) as any).c, 1);
  // a mesma chave para outra pessoa é outra notificação
  assert.notEqual(notify(otherId, 'ride_accepted', 'A caminho', { eventKey: 'evt:teste-1' }), a);
});

test('preferências: desligar o opcional funciona; essenciais e segurança não desligam', async () => {
  const p = await pax.req('GET', '/api/notifications/prefs');
  assert.equal(p.status, 200);
  const keys = p.data.categories.map((c: any) => c.key);
  assert.ok(keys.includes('corrida') && keys.includes('conta') && keys.includes('novidades'));
  assert.ok(!keys.includes('financeiro') && !keys.some((k: string) => k.startsWith('admin_')));   // só as do passageiro
  assert.equal(p.data.categories.find((c: any) => c.key === 'novidades').inapp, false);           // começa desligada

  assert.equal((await pax.req('PUT', '/api/notifications/prefs', { category: 'conta', push: false })).status, 400);
  assert.equal((await pax.req('PUT', '/api/notifications/prefs', { category: 'corrida', inapp: false })).status, 400);
  assert.equal((await pax.req('PUT', '/api/notifications/prefs', { category: 'financeiro', push: false })).status, 400);

  // suporte: desliga o push e depois tudo
  const r1 = await pax.req('PUT', '/api/notifications/prefs', { category: 'suporte', push: false });
  assert.equal(r1.status, 200);
  assert.deepEqual([r1.data.inapp, r1.data.push], [true, false]);
  const r2 = await pax.req('PUT', '/api/notifications/prefs', { category: 'suporte', inapp: false });
  assert.deepEqual([r2.data.inapp, r2.data.push], [false, false]);
  assert.equal(notify(paxId, 'support_reply', 'Não deve chegar', 'z'), '');
  // de volta
  await pax.req('PUT', '/api/notifications/prefs', { category: 'suporte', inapp: true, push: true });
  assert.ok(notify(paxId, 'support_reply', 'Chega de novo', 'z'));
});

test('push fora do app: sem endereço, valor ou conteúdo de mensagem na tela bloqueada', () => {
  for (const k of ['ride_offer', 'chat', 'payout', 'debt', 'ride_completed', 'refund', 'pickup_updated', 'new_login']) {
    const info = kindInfo(k);
    assert.ok(info.push, `${k} tem texto próprio para o push`);
    const txt = `${info.push!.title} ${info.push!.body || ''}`;
    assert.doesNotMatch(txt, /R\$|\d{2,}|rua|avenida|av\.|jardim/i, `${k}: ${txt}`);
  }
  // tipos cujo corpo pode ter valor/endereço não podem ser marcados como seguros
  for (const k of ['ride_offer', 'chat', 'payout', 'debt', 'refund', 'ride_completed', 'pickup_updated']) {
    assert.notEqual(KINDS[k].bodySafe, true, k);
  }
  // o status do push fica registrado (aqui não há aparelho inscrito)
  const nid = notify(paxId, 'chat', 'Mensagem', { body: 'Estou na Rua Sete de Setembro, 1259', push: true });
  const st = (db.prepare('SELECT push_status FROM notifications WHERE id = ?').get(nid) as any).push_status;
  assert.ok(['enviando', 'sem_aparelho', 'na_tela', 'enviado'].includes(st), String(st));
});

test('aparelho novo: avisa no segundo aparelho, não no primeiro nem no mesmo de novo', async () => {
  const k0 = kinds(paxId).filter(k => k === 'new_login').length;
  pax.reset();
  await pax.req('POST', '/api/auth/login', { email: 'nina@notif.test', password: 'senha12345' });   // mesmo Android
  assert.equal(kinds(paxId).filter(k => k === 'new_login').length, k0);
  const phone = actor(IPHONE);
  assert.equal((await phone.req('POST', '/api/auth/login', { email: 'nina@notif.test', password: 'senha12345' })).status, 200);
  assert.equal(kinds(paxId).filter(k => k === 'new_login').length, k0 + 1);
  const n = db.prepare(`SELECT body, category FROM notifications WHERE user_id = ? AND kind = 'new_login' ORDER BY created_at DESC`).get(paxId) as any;
  assert.match(n.body, /Safari no iPhone/);
  assert.equal(n.category, 'conta');
  // não guarda IP nem o user-agent inteiro
  const dev = db.prepare('SELECT * FROM user_devices WHERE user_id = ?').all(paxId) as any[];
  assert.equal(dev.length, 2);
  assert.ok(dev.every(d => !/Mozilla|AppleWebKit/.test(JSON.stringify(d))));
  assert.equal(deviceLabel(ANDROID), 'Chrome no Android');
});

test('perfil alterado e conta reativada geram aviso', async () => {
  await pax.req('PATCH', '/api/me', { phone: '(44) 90000-4445' });
  const n = db.prepare(`SELECT body FROM notifications WHERE user_id = ? AND kind = 'profile_updated'`).get(paxId) as any;
  assert.match(n.body, /telefone/);
  // salvar sem mudar nada não avisa
  const c = kinds(paxId).filter(k => k === 'profile_updated').length;
  await pax.req('PATCH', '/api/me', { phone: '(44) 90000-4445' });
  assert.equal(kinds(paxId).filter(k => k === 'profile_updated').length, c);

  await adm.req('POST', `/api/admin/users/${otherId}/block`, { blocked: true, reason: 'teste' });
  await adm.req('POST', `/api/admin/users/${otherId}/block`, { blocked: false });
  assert.ok(kinds(otherId).includes('account_reactivated'));
  // o bloqueio encerrou as sessões: entra de novo
  assert.equal((await other.req('POST', '/api/auth/login', { email: 'otto@notif.test', password: 'senha12345' })).status, 200);
});

test('mototaxista chegando: o passageiro é avisado uma vez', async () => {
  await drv.req('POST', '/api/driver/online', { online: true });
  await drv.req('POST', '/api/driver/location', { lat: -24.4300, lng: -53.5300, accuracy_m: 10 });   // longe
  const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  const c = await pax.req('POST', '/api/rides', { quote_id: q.data.quotes[0].id, payment_method: 'dinheiro' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const rid = c.data.ride.id;
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/accept`)).status, 200);
  const count = () => (db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND kind = 'driver_approaching' AND ride_id = ?`).get(paxId, rid) as any).c;
  assert.equal(count(), 0);
  await drv.req('POST', '/api/driver/location', { lat: -24.4170, lng: -53.5225, accuracy_m: 10 });   // ~180 m
  await drv.req('POST', '/api/driver/location', { lat: -24.4160, lng: -53.5218, accuracy_m: 10 });
  assert.equal(count(), 1);
  const n = db.prepare(`SELECT link, priority FROM notifications WHERE user_id = ? AND kind = 'driver_approaching'`).get(paxId) as any;
  assert.equal(n.link, '/passageiro#corrida');
  assert.equal(n.priority, 'alta');
  await drv.req('POST', `/api/driver/rides/${rid}/cancel`, { reason: 'teste' });
  await pax.req('POST', `/api/rides/${rid}/cancel`, { reason: 'teste' });
});

test('CNH vencendo e vencida: uma vez cada; a central é avisada da vencida', () => {
  const day = 86400_000;
  const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
  db.prepare('UPDATE drivers SET cnh_expiry = ? WHERE user_id = ?').run(ymd(Date.now() + 10 * day), driverId);
  checkCnhExpiry(); checkCnhExpiry();
  assert.equal(kinds(driverId).filter(k => k === 'doc_expiring').length, 1);
  db.prepare('UPDATE drivers SET cnh_expiry = ? WHERE user_id = ?').run(ymd(Date.now() - 3 * day), driverId);
  checkCnhExpiry(); checkCnhExpiry();
  assert.equal(kinds(driverId).filter(k => k === 'doc_expired').length, 1);
  const admId = uid('dono-notif@teste.com');
  assert.equal(kinds(admId).filter(k => k === 'doc_expired_admin').length, 1);
  db.prepare('UPDATE drivers SET cnh_expiry = ? WHERE user_id = ?').run('2031-01-01', driverId);
});

test('central: link para a seção certa e aviso de fraude no código de embarque', async () => {
  const admId = uid('dono-notif@teste.com');
  const r = await adm.req('GET', '/api/notifications?limit=100');
  const nd = r.data.notifications.find((n: any) => n.kind === 'new_driver');
  assert.ok(nd);
  assert.equal(nd.link, '/admin#drivers');
  assert.equal(nd.category, 'admin_cadastros');

  await drv.req('POST', '/api/driver/location', { lat: -24.4157, lng: -53.5216, accuracy_m: 10 });
  const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  const c = await pax.req('POST', '/api/rides', { quote_id: q.data.quotes[0].id, payment_method: 'dinheiro' });
  const rid = c.data.ride.id;
  await drv.req('POST', `/api/driver/rides/${rid}/accept`);
  await drv.req('POST', `/api/driver/rides/${rid}/arrived`);
  for (let i = 0; i < 6; i++) await drv.req('POST', `/api/driver/rides/${rid}/start`, { code: '0000' });
  assert.ok(kinds(admId).includes('fraud_suspect'));
  await drv.req('POST', `/api/driver/rides/${rid}/cancel`, { reason: 'teste' });
  await pax.req('POST', `/api/rides/${rid}/cancel`, { reason: 'teste' });
});

test('comunicado: só para quem ativou novidades; limite e auditoria', async () => {
  assert.equal((await pax.req('POST', '/api/admin/announcements', { title: 'x', body: 'y', audience: 'all' })).status, 403);
  await other.req('PUT', '/api/notifications/prefs', { category: 'novidades', inapp: true });
  const r = await adm.req('POST', '/api/admin/announcements', { title: 'Nova área atendida', body: 'Agora no Jardim Paraná.', audience: 'passenger' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.sent, 1);
  assert.ok(kinds(otherId).includes('announcement'));
  assert.ok(!kinds(paxId).includes('announcement'));
  assert.ok(db.prepare(`SELECT 1 FROM admin_audit_logs WHERE action = 'announcement'`).get());
  await adm.req('POST', '/api/admin/announcements', { title: 'Dois', body: 'b', audience: 'passenger' });
  await adm.req('POST', '/api/admin/announcements', { title: 'Três', body: 'c', audience: 'passenger' });
  assert.equal((await adm.req('POST', '/api/admin/announcements', { title: 'Quatro', body: 'd', audience: 'passenger' })).status, 429);
});

test('inscrição de push: só o dono remove', async () => {
  db.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
    VALUES ('ps_t1', ?, 'https://push.example.test/abc', 'k', 'a', ?)`).run(paxId, Date.now());
  await other.req('POST', '/api/push/unsubscribe', { endpoint: 'https://push.example.test/abc' });
  assert.ok(db.prepare(`SELECT 1 FROM push_subscriptions WHERE id = 'ps_t1'`).get());
  await pax.req('POST', '/api/push/unsubscribe', { endpoint: 'https://push.example.test/abc' });
  assert.equal(db.prepare(`SELECT 1 FROM push_subscriptions WHERE id = 'ps_t1'`).get(), undefined);
});
