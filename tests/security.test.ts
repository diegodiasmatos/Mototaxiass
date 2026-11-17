/**
 * Testes de segurança de sessão/cookies, CSRF, força bruta, privacidade da
 * localização, retenção de dados (GPS), anonimização (LGPD) e cabeçalhos.
 * Servidor real em porta aleatória, banco temporário, sem internet.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

process.env.GEO_OFFLINE = '1';
process.env.ADMIN_EMAIL = 'dono-seg@teste.com';
process.env.ADMIN_PASSWORD = 'senha-admin-seg-teste';
process.env.SESSION_SECRET = 'segredo-de-teste-seg';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assis-seg-'));
delete process.env.TRUST_PROXY;
delete process.env.COOKIE_SECURE;

const { start } = await import('../server/index.ts');
const dbMod = await import('../server/db.ts');
const maint = await import('../server/maintenance.ts');
const util = await import('../server/util.ts');
const db = { prepare: (sql: string) => dbMod.db.prepare(sql) };

let base = '';
let close: () => Promise<void>;

const HDR = { 'X-VAIRO-Request': '1' };

/** Cliente que se comporta como o app (manda o cabeçalho anti-CSRF). */
function actor() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    set cookie(v: string) { cookie = v; },
    async req(method: string, p: string, body?: unknown, extra: Record<string, string> = {}) {
      const r = await fetch(base + p, {
        method,
        headers: {
          ...HDR,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...extra,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      for (const c of r.headers.getSetCookie?.() ?? []) {
        const m = /^amt_session=([^;]*)/.exec(c);
        if (m) cookie = m[1] ? `amt_session=${m[1]}` : '';
      }
      let data: any = {};
      try { data = await r.json(); } catch { }
      return { status: r.status, data, headers: r.headers };
    },
  };
}

const fakeDoc = () => `data:image/jpeg;base64,${Buffer.alloc(4000, 7).toString('base64')}`;
const ORIGIN = { lat: -24.4156, lng: -53.5216, text: 'Centro, Assis Chateaubriand' };
const DEST = { lat: -24.4450, lng: -53.5400, text: 'Jardim Paraná, Assis Chateaubriand' };
const DAY = 24 * 3600_000;

const pax = actor();     // Ana
const pax2 = actor();    // Bia
const drv = actor();     // Caio (aprovado, online)
const drv2 = actor();    // Davi (aprovado, sem corrida)
const adm = actor();
let drvId = '', drv2Id = '', paxId = '';

async function newDriver(a: ReturnType<typeof actor>, name: string, email: string, cpf: string): Promise<string> {
  await a.req('POST', '/api/auth/register', {
    role: 'driver', name, cpf, phone: '(44) 90000-3333', email, password: 'senha12345',
  });
  await a.req('POST', '/api/driver/apply', {
    birth_date: '1990-01-01', address: 'Rua A, 10', moto_plate: 'ABC-1D23',
    moto_brand: 'Honda', moto_model: 'CG 160', moto_year: '2022', moto_color: 'Preta',
    documents: { cnh: fakeDoc(), crlv: fakeDoc(), selfie: fakeDoc() },
  });
  const me = await a.req('GET', '/api/me');
  await adm.req('POST', `/api/admin/drivers/${me.data.user.id}/review`, { action: 'approve' });
  return me.data.user.id;
}

/** Corrida em dinheiro já aceita pelo `drv`. */
async function acceptedRide(by = pax): Promise<string> {
  const q = await by.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  const quote = q.data.quotes.find((x: any) => x.category === 'economica');
  const c = await by.req('POST', '/api/rides', { quote_id: quote.id, payment_method: 'dinheiro' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const rid = c.data.ride.id;
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/accept`)).status, 200);
  return rid;
}

async function finishRide(rid: string, by = pax): Promise<void> {
  await drv.req('POST', `/api/driver/rides/${rid}/arrived`);
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/start`)).status, 200);
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/complete`)).status, 200);
  assert.equal((await by.req('POST', `/api/rides/${rid}/confirm`)).status, 200);
}

before(async () => {
  const s = await start({ port: 0, quiet: true, dbPath: path.join(process.env.DATA_DIR!, 'seg.db') });
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;
  await adm.req('POST', '/api/auth/login', { email: 'dono-seg@teste.com', password: 'senha-admin-seg-teste' });
  const r1 = await pax.req('POST', '/api/auth/register', {
    role: 'passenger', name: 'Ana Silva', phone: '(44) 90000-1111', email: 'ana@seg.test', password: 'senha12345',
  });
  paxId = r1.data.user.id;
  await pax2.req('POST', '/api/auth/register', {
    role: 'passenger', name: 'Bia Souza', phone: '(44) 90000-2222', email: 'bia@seg.test', password: 'senha12345',
  });
  drvId = await newDriver(drv, 'Caio Moto', 'caio@seg.test', '529.982.247-25');
  drv2Id = await newDriver(drv2, 'Davi Moto', 'davi@seg.test', '111.444.777-35');
  await drv.req('POST', '/api/driver/online', { online: true });
  await drv.req('POST', '/api/driver/location', { lat: -24.4150, lng: -53.5210, accuracy_m: 12 });
});
after(async () => { await close(); });

// =====================================================================
// Sessões e cookies
// =====================================================================

test('sessão: o banco guarda só o hash do token, nunca o token do cookie', async () => {
  const raw = pax.cookie.replace('amt_session=', '');
  assert.ok(raw.length >= 40);
  const rows = db.prepare('SELECT token FROM sessions').all() as any[];
  assert.ok(rows.length >= 5);
  assert.equal(rows.some(r => r.token === raw), false);
  assert.ok(rows.every(r => /^[0-9a-f]{64}$/.test(r.token)));
  assert.ok(db.prepare('SELECT 1 FROM sessions WHERE token = ?').get(util.hashToken(raw)));
});

test('sessão: o hash copiado do banco não funciona como cookie', async () => {
  const h = (db.prepare('SELECT token FROM sessions WHERE user_id = ?').get(paxId) as any).token;
  const thief = actor();
  thief.cookie = `amt_session=${h}`;
  assert.equal((await thief.req('GET', '/api/me')).status, 401);
  // token inventado também não
  thief.cookie = 'amt_session=' + 'x'.repeat(43);
  assert.equal((await thief.req('GET', '/api/me')).status, 401);
});

test('sessão: um usuário não usa a sessão nem os dados de outro', async () => {
  const rid = await acceptedRide(pax);
  // Bia (outra passageira) tenta ver corrida, pagamento, chat e mexer na corrida da Ana
  assert.equal((await pax2.req('GET', `/api/rides/${rid}`)).status, 403);
  assert.equal((await pax2.req('GET', `/api/rides/${rid}/payment`)).status, 403);
  assert.equal((await pax2.req('GET', `/api/rides/${rid}/messages`)).status, 403);
  assert.equal((await pax2.req('POST', `/api/rides/${rid}/messages`, { body: 'oi' })).status, 403);
  assert.equal((await pax2.req('POST', `/api/rides/${rid}/location`, ORIGIN)).status, 403);
  assert.equal((await pax2.req('POST', `/api/rides/${rid}/cancel`, {})).status, 403);
  // a lista da Bia não contém a corrida da Ana
  const list = await pax2.req('GET', '/api/rides');
  assert.equal(list.data.rides.some((r: any) => r.id === rid), false);
  // favorito da Ana não pode ser apagado pela Bia
  const fav = await pax.req('POST', '/api/favorites', { label: 'Casa', text: 'Rua X', lat: ORIGIN.lat, lng: ORIGIN.lng });
  await pax2.req('DELETE', `/api/favorites/${fav.data.id || fav.data.favorite?.id}`);
  assert.equal((await pax.req('GET', '/api/favorites')).data.favorites.length, 1);
  // passageiro não usa rota de motorista nem de admin
  assert.equal((await pax.req('GET', '/api/driver/offers')).status, 403);
  assert.equal((await pax.req('GET', '/api/admin/passengers')).status, 403);
  await finishRide(rid);
});

test('cookie: HttpOnly e SameSite sempre; Secure só com HTTPS (proxy de confiança)', async () => {
  const login = (extra: Record<string, string>) => fetch(base + '/api/auth/login', {
    method: 'POST', headers: { ...HDR, 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify({ email: 'bia@seg.test', password: 'senha12345' }),
  });
  // HTTP local: sem Secure (senão o navegador nem guardaria o cookie)
  let r = await login({});
  let c = r.headers.getSetCookie()[0];
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Max-Age=\d+/);
  assert.doesNotMatch(c, /Secure/);
  assert.equal(r.headers.get('strict-transport-security'), null);

  // cabeçalho de proxy forjado sem TRUST_PROXY: ignorado
  r = await login({ 'X-Forwarded-Proto': 'https' });
  assert.doesNotMatch(r.headers.getSetCookie()[0], /Secure/);

  // produção (Fly.io): TRUST_PROXY=1 e o proxy informa HTTPS
  process.env.TRUST_PROXY = '1';
  try {
    r = await login({ 'X-Forwarded-Proto': 'https' });
    c = r.headers.getSetCookie()[0];
    assert.match(c, /; Secure/);
    assert.match(c, /HttpOnly/);
    assert.match(r.headers.get('strict-transport-security') || '', /max-age=31536000/);
    // logout em HTTPS também apaga com Secure
    const cookie = /amt_session=[^;]*/.exec(c)![0];
    const out = await fetch(base + '/api/auth/logout', {
      method: 'POST', headers: { ...HDR, Cookie: cookie, 'X-Forwarded-Proto': 'https' },
    });
    assert.match(out.headers.getSetCookie()[0], /Max-Age=0.*Secure/);
  } finally { delete process.env.TRUST_PROXY; }
});

test('logout: a sessão é apagada no servidor e o cookie antigo deixa de valer', async () => {
  const a = actor();
  assert.equal((await a.req('POST', '/api/auth/login', { email: 'bia@seg.test', password: 'senha12345' })).status, 200);
  const old = a.cookie;
  assert.equal((await a.req('GET', '/api/me')).status, 200);
  const out = await a.req('POST', '/api/auth/logout');
  assert.equal(out.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE token = ?')
    .get(util.hashToken(old.replace('amt_session=', ''))), undefined);
  a.cookie = old;                                 // alguém guardou o cookie antigo
  assert.equal((await a.req('GET', '/api/me')).status, 401);
});

test('sessão expirada por inatividade ou pelo prazo máximo é recusada e apagada', async () => {
  const a = actor();
  await a.req('POST', '/api/auth/login', { email: 'bia@seg.test', password: 'senha12345' });
  const h = util.hashToken(a.cookie.replace('amt_session=', ''));
  // inatividade
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, h);
  assert.equal((await a.req('GET', '/api/me')).status, 401);
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE token = ?').get(h), undefined);

  // prazo máximo (90 dias desde o login), mesmo com uso recente
  const b = actor();
  await b.req('POST', '/api/auth/login', { email: 'bia@seg.test', password: 'senha12345' });
  const hb = util.hashToken(b.cookie.replace('amt_session=', ''));
  db.prepare('UPDATE sessions SET created_at = ?, last_seen_at = ? WHERE token = ?')
    .run(Date.now() - 91 * DAY, Date.now(), hb);
  assert.equal((await b.req('GET', '/api/me')).status, 401);

  // central: 12 h sem uso derrubam a sessão do administrador
  const ad = actor();
  await ad.req('POST', '/api/auth/login', { email: 'dono-seg@teste.com', password: 'senha-admin-seg-teste' });
  const ha = util.hashToken(ad.cookie.replace('amt_session=', ''));
  const row = db.prepare('SELECT created_at, expires_at FROM sessions WHERE token = ?').get(ha) as any;
  assert.ok(row.expires_at - row.created_at <= 12 * 3600_000 + 1000, 'admin expira em até 12 h sem uso');
  db.prepare('UPDATE sessions SET created_at = ?, last_seen_at = ? WHERE token = ?')
    .run(Date.now() - 8 * DAY, Date.now(), ha);
  assert.equal((await ad.req('GET', '/api/admin/dashboard')).status, 401, 'admin: máximo de 7 dias');
});

test('sessão em uso é renovada (prazo de inatividade e cookie), sem passar do máximo', async () => {
  const a = actor();
  await a.req('POST', '/api/auth/login', { email: 'bia@seg.test', password: 'senha12345' });
  const h = util.hashToken(a.cookie.replace('amt_session=', ''));
  const t0 = Date.now();
  db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token = ?')
    .run(t0 - 10 * DAY, t0 + 20 * DAY, h);
  const r = await a.req('GET', '/api/me');
  assert.equal(r.status, 200);
  const renewed = r.headers.getSetCookie().find(c => c.startsWith('amt_session='))!;
  assert.match(renewed, /HttpOnly/);
  const maxAge = Number(/Max-Age=(\d+)/.exec(renewed)![1]);
  assert.ok(maxAge > 29 * 86400 && maxAge <= 30 * 86400, `Max-Age ${maxAge}`);
  const row = db.prepare('SELECT expires_at, last_seen_at FROM sessions WHERE token = ?').get(h) as any;
  assert.ok(row.expires_at > t0 + 29 * DAY);
  assert.ok(row.last_seen_at >= t0);
  // perto do prazo máximo: renova só até ele
  db.prepare('UPDATE sessions SET created_at = ?, last_seen_at = ? WHERE token = ?')
    .run(t0 - 89 * DAY, t0 - 2 * DAY, h);
  await a.req('GET', '/api/me');
  const row2 = db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(h) as any;
  assert.ok(row2.expires_at <= t0 - 89 * DAY + 90 * DAY + 5000);
});

test('bloquear o usuário derruba todas as sessões dele', async () => {
  const a = actor(), b = actor();
  const u = await a.req('POST', '/api/auth/register', {
    role: 'passenger', name: 'Edu Teste', phone: '(44) 90000-4444', email: 'edu@seg.test', password: 'senha12345',
  });
  await b.req('POST', '/api/auth/login', { email: 'edu@seg.test', password: 'senha12345' });
  assert.equal((await adm.req('POST', `/api/admin/users/${u.data.user.id}/block`,
    { blocked: true, reason: 'teste' })).status, 200);
  assert.equal((await a.req('GET', '/api/me')).status, 401);
  assert.equal((await b.req('GET', '/api/me')).status, 401);
});

// =====================================================================
// CSRF e origem
// =====================================================================

test('CSRF: escrita sem o cabeçalho do app, de outra origem ou em formulário é bloqueada', async () => {
  const send = (headers: Record<string, string>, body = JSON.stringify({ label: 'X', text: 'Y', lat: ORIGIN.lat, lng: ORIGIN.lng })) =>
    fetch(base + '/api/favorites', { method: 'POST', headers: { Cookie: pax.cookie, ...headers }, body });
  const before = (db.prepare('SELECT COUNT(*) c FROM favorites').get() as any).c;

  // 1. sem o cabeçalho X-VAIRO-Request (o que um site de terceiros conseguiria mandar)
  let r = await send({ 'Content-Type': 'application/json' });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /CSRF/);
  // 2. formulário HTML de outro site (text/plain), mesmo que tentasse o cabeçalho
  r = await send({ ...HDR, 'Content-Type': 'text/plain' });
  assert.equal(r.status, 415);
  // 3. Origin de outro site
  r = await send({ ...HDR, 'Content-Type': 'application/json', Origin: 'https://site-malicioso.example' });
  assert.equal(r.status, 403);
  r = await send({ ...HDR, 'Content-Type': 'application/json', Origin: 'null' });
  assert.equal(r.status, 403);
  // 4. Referer de outro site (sem Origin)
  r = await send({ ...HDR, 'Content-Type': 'application/json', Referer: 'https://site-malicioso.example/x' });
  assert.equal(r.status, 403);
  // nada foi gravado
  assert.equal((db.prepare('SELECT COUNT(*) c FROM favorites').get() as any).c, before);

  // a própria origem passa (inclusive em https: atrás de proxy o servidor pode ver http)
  r = await send({ ...HDR, 'Content-Type': 'application/json', Origin: base });
  assert.equal(r.status, 201);
  r = await send({ ...HDR, 'Content-Type': 'application/json', Origin: base.replace('http:', 'https:') });
  assert.equal(r.status, 201);
  // subdomínio ou porta diferente é outra origem
  r = await send({ ...HDR, 'Content-Type': 'application/json', Origin: base.replace('127.0.0.1', 'evil.127.0.0.1') });
  assert.equal(r.status, 403);
  // logout e login também exigem (login CSRF: forçar alguém a entrar na conta do atacante)
  r = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'bia@seg.test', password: 'senha12345' }),
  });
  assert.equal(r.status, 403);
  // leitura (GET) não exige
  assert.equal((await fetch(base + '/api/config')).status, 200);
});

test('CSRF: o webhook do Mercado Pago continua aceito (validado pela assinatura dele)', async () => {
  const r = await fetch(base + '/api/webhooks/mercadopago', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.notEqual(r.status, 403);
  assert.notEqual(r.status, 415);
});

// =====================================================================
// Força bruta
// =====================================================================

test('força bruta: 5 senhas erradas põem a conta em espera, até com a senha certa', async () => {
  const a = actor();
  const tryLogin = (password: string) => a.req('POST', '/api/auth/login', { email: 'davi@seg.test', password });
  for (let i = 0; i < 5; i++) assert.equal((await tryLogin('errada-' + i)).status, 401);
  const locked = await tryLogin('senha12345');
  assert.equal(locked.status, 429);
  assert.match(locked.data.error, /Tente de novo em \d+ min/);
  // e-mail com outra caixa é a mesma conta
  assert.equal((await a.req('POST', '/api/auth/login', { email: 'DAVI@seg.test', password: 'senha12345' })).status, 429);
  // outra conta não é afetada
  assert.equal((await actor().req('POST', '/api/auth/login', { email: 'bia@seg.test', password: 'senha12345' })).status, 200);
  // a central foi avisada
  const notes = (await adm.req('GET', '/api/notifications')).data.notifications as any[];
  assert.ok(notes.some(n => /senhas erradas/i.test(n.title + ' ' + (n.body || ''))));
  // e-mail inexistente responde igual (não revela quais e-mails têm conta)
  const ghost = await actor().req('POST', '/api/auth/login', { email: 'ninguem@seg.test', password: 'x'.repeat(8) });
  assert.equal(ghost.status, 401);
  assert.equal(ghost.data.error, 'E-mail ou senha incorretos.');
});

test('IP do cliente: cabeçalhos de proxy só valem com TRUST_PROXY', () => {
  const req = (h: Record<string, string>) => ({ headers: h, socket: { remoteAddress: '::ffff:10.0.0.9' } }) as any;
  assert.equal(util.clientIp(req({ 'fly-client-ip': '200.1.2.3' })), '10.0.0.9');
  process.env.TRUST_PROXY = '1';
  try {
    assert.equal(util.clientIp(req({ 'fly-client-ip': '200.1.2.3' })), '200.1.2.3');
    // X-Forwarded-For: vale o último (o que o proxy acrescentou), não o que o cliente forjou
    assert.equal(util.clientIp(req({ 'x-forwarded-for': '6.6.6.6, 200.9.9.9' })), '200.9.9.9');
    assert.equal(util.clientIp(req({})), '10.0.0.9');
  } finally { delete process.env.TRUST_PROXY; }
});

// =====================================================================
// Localização
// =====================================================================

test('localização: passageiro vê o motorista só durante a corrida, nunca depois', async () => {
  const rid = await acceptedRide(pax);
  await drv.req('POST', '/api/driver/location', { lat: -24.4160, lng: -53.5220, accuracy_m: 10 });
  let ride = (await pax.req('GET', `/api/rides/${rid}`)).data.ride;
  assert.equal(ride.driver.last_lat, -24.416);
  assert.ok(ride.eta_s != null);

  await finishRide(rid);
  await drv.req('POST', '/api/driver/location', { lat: -24.4300, lng: -53.5300, accuracy_m: 10 });
  ride = (await pax.req('GET', `/api/rides/${rid}`)).data.ride;
  assert.equal(ride.status, 'completed');
  assert.equal(ride.driver.last_lat, undefined);
  assert.equal(ride.driver.last_lng, undefined);
  assert.equal(ride.eta_s ?? null, null);
  // nem pelo histórico
  const hist = (await pax.req('GET', '/api/rides')).data.rides as any[];
  assert.ok(hist.length >= 1);
  for (const r of hist.filter(x => !['accepted', 'in_progress'].includes(x.status))) {
    assert.equal(r.driver?.last_lat, undefined, `corrida ${r.status} não pode expor o motorista`);
  }
  // o nome e a moto continuam (recibo/avaliação)
  assert.equal(ride.driver.name, 'Caio Moto');
});

test('localização: passageiro só envia/guarda GPS com motorista designado; outro motorista não acessa', async () => {
  // corrida ainda procurando motorista: posição ignorada, nada guardado
  const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  const quote = q.data.quotes.find((x: any) => x.category === 'economica');
  const c = await pax.req('POST', '/api/rides', { quote_id: quote.id, payment_method: 'dinheiro' });
  const rid = c.data.ride.id;
  const r1 = await pax.req('POST', `/api/rides/${rid}/location`, { lat: -24.41, lng: -53.52, accuracy_m: 5 });
  assert.equal(r1.data.ignored, true);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM ride_locations WHERE ride_id = ?').get(rid) as any).c, 0);

  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/accept`)).status, 200);
  const r2 = await pax.req('POST', `/api/rides/${rid}/location`, { lat: -24.41, lng: -53.52, accuracy_m: 5 });
  assert.equal(r2.data.ignored, undefined);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM ride_locations WHERE ride_id = ? AND who = 'passenger'`)
    .get(rid) as any).c, 1);

  // outro motorista (aprovado) não vê a corrida, o chat nem age sobre ela
  assert.equal((await drv2.req('GET', `/api/rides/${rid}/messages`)).status, 403);
  assert.equal((await drv2.req('GET', `/api/rides/${rid}`)).status, 403);
  assert.notEqual((await drv2.req('POST', `/api/driver/rides/${rid}/start`)).status, 200);
  const drv2Rides = (await drv2.req('GET', '/api/driver/rides')).data.rides as any[];
  assert.equal(drv2Rides.some(r => r.id === rid), false);
  // nem o histórico de GPS pela central (rota só de admin)
  assert.equal((await drv2.req('GET', `/api/admin/rides/${rid}`)).status, 403);

  await finishRide(rid);
});

test('localização: motorista offline e sem corrida não tem posição guardada', async () => {
  await drv2.req('POST', '/api/driver/online', { online: false });
  db.prepare('UPDATE drivers SET last_lat = NULL, last_lng = NULL WHERE user_id = ?').run(drv2Id);
  const r = await drv2.req('POST', '/api/driver/location', { lat: -24.42, lng: -53.52, accuracy_m: 9 });
  assert.equal(r.status, 200);
  assert.equal(r.data.ignored, true);
  const d = db.prepare('SELECT last_lat FROM drivers WHERE user_id = ?').get(drv2Id) as any;
  assert.equal(d.last_lat, null);
  // online, a posição volta a ser guardada (é usada para chamar corridas)
  await drv2.req('POST', '/api/driver/online', { online: true });
  await drv2.req('POST', '/api/driver/location', { lat: -24.42, lng: -53.52, accuracy_m: 9 });
  assert.equal((db.prepare('SELECT last_lat FROM drivers WHERE user_id = ?').get(drv2Id) as any).last_lat, -24.42);
  await drv2.req('POST', '/api/driver/online', { online: false });
});

test('central: consulta ao histórico de GPS de uma corrida fica na auditoria', async () => {
  const rid = await acceptedRide(pax);
  await drv.req('POST', '/api/driver/location', { lat: -24.4161, lng: -53.5221, accuracy_m: 10 });
  const r = await adm.req('GET', `/api/admin/rides/${rid}`);
  assert.ok(r.data.locations.length >= 1);
  const log = db.prepare(`SELECT * FROM admin_audit_logs WHERE action = 'gps_view' AND target_id = ?`).get(rid);
  assert.ok(log);
  await finishRide(rid);
});

// =====================================================================
// Retenção e limpeza
// =====================================================================

/** Insere uma corrida "antiga" diretamente no banco, com pontos de GPS. */
function seedRide(status: string, endedDaysAgo: number, points = 3): string {
  const rid = 'ride_seed_' + Math.random().toString(36).slice(2, 10);
  const t = Date.now() - endedDaysAgo * DAY;
  db.prepare(`INSERT INTO rides (id, passenger_id, driver_id, category, status,
      origin_text, origin_lat, origin_lng, dest_text, dest_lat, dest_lng,
      distance_m, duration_s, price_cents, commission_pct, commission_cents, driver_cents,
      payment_method, payment_status, requested_at, completed_at, cancelled_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(rid, paxId, drvId, 'economica', status, 'A', ORIGIN.lat, ORIGIN.lng, 'B', DEST.lat, DEST.lng,
      3000, 600, 1000, 15, 150, 850, 'dinheiro', 'dinheiro_recebido', t - 3600_000,
      status === 'completed' ? t : null, status === 'cancelled' ? t : null);
  for (let i = 0; i < points; i++) {
    db.prepare('INSERT INTO ride_locations (ride_id, who, lat, lng, accuracy_m, at) VALUES (?,?,?,?,?,?)')
      .run(rid, i % 2 ? 'driver' : 'passenger', ORIGIN.lat, ORIGIN.lng, 10, t - i * 60_000);
  }
  return rid;
}
const gpsCount = (rid: string) => (db.prepare('SELECT COUNT(*) c FROM ride_locations WHERE ride_id = ?').get(rid) as any).c;

test('GPS: a limpeza apaga o histórico vencido e preserva corridas ativas e em disputa', () => {
  const oldDone = seedRide('completed', 40);
  const oldCancel = seedRide('cancelled', 31);
  const recent = seedRide('completed', 10);
  const active = seedRide('in_progress', 45);           // corrida "presa" há 45 dias: não é tocada
  const disputedOld = seedRide('completed', 50);
  db.prepare(`INSERT INTO ride_issues (ride_id, user_id, role, kind, description, status, created_at)
    VALUES (?,?,?,?,?,?,?)`).run(disputedOld, paxId, 'passenger', 'outro', 'teste', 'aberta', Date.now());
  const ridesBefore = (db.prepare('SELECT COUNT(*) c FROM rides').get() as any).c;

  const rep = maint.runMaintenance(Date.now(), { backup: false });
  assert.ok(rep.gps_points >= 6, JSON.stringify(rep));
  assert.equal(gpsCount(oldDone), 0);
  assert.equal(gpsCount(oldCancel), 0);
  assert.equal(gpsCount(recent), 3, 'dentro do prazo de 30 dias');
  assert.equal(gpsCount(active), 3, 'corrida em andamento');
  assert.equal(gpsCount(disputedOld), 3, 'ocorrência aberta');
  // corridas nunca são apagadas pela limpeza
  assert.equal((db.prepare('SELECT COUNT(*) c FROM rides').get() as any).c, ridesBefore);
  // encerra as corridas inventadas (o passageiro só pode ter uma ativa)
  db.prepare(`UPDATE rides SET status = 'cancelled', cancelled_at = ? WHERE id = ?`).run(Date.now(), active);
});

test('GPS: o prazo é configurável na central e validado', async () => {
  const mid = seedRide('completed', 45);
  assert.equal((await adm.req('PUT', '/api/admin/settings', { settings: { gps_retention_days: 0 } })).status, 400);
  assert.equal((await adm.req('PUT', '/api/admin/settings', { settings: { gps_retention_days: 'abc' } })).status, 400);
  assert.equal((await adm.req('PUT', '/api/admin/settings',
    { settings: { session_idle_days: 60, session_max_days: 30 } })).status, 400);
  assert.equal((await adm.req('PUT', '/api/admin/settings', { settings: { gps_retention_days: 60 } })).status, 200);
  maint.runMaintenance(Date.now(), { backup: false });
  assert.equal(gpsCount(mid), 3, '45 dias < 60 dias: fica');
  await adm.req('PUT', '/api/admin/settings', { settings: { gps_retention_days: 30 } });
  maint.runMaintenance(Date.now(), { backup: false });
  assert.equal(gpsCount(mid), 0);
  const audit = db.prepare(`SELECT details FROM admin_audit_logs WHERE action = 'settings_update'
    ORDER BY id DESC LIMIT 1`).get() as any;
  assert.match(audit.details, /gps_retention_days=30/);
});

test('motorista: última posição apagada só se offline há mais de 6 h e sem corrida ativa', () => {
  const old = Date.now() - 7 * 3600_000;
  db.prepare('UPDATE drivers SET online = 0, last_lat = -24.4, last_lng = -53.5, last_loc_at = ? WHERE user_id = ?')
    .run(old, drv2Id);
  // motorista com corrida ativa, offline e posição antiga: preservado
  const busy = seedRide('in_progress', 0, 0);
  db.prepare('UPDATE rides SET driver_id = ? WHERE id = ?').run(drvId, busy);
  db.prepare('UPDATE drivers SET online = 0, last_lat = -24.41, last_lng = -53.51, last_loc_at = ? WHERE user_id = ?')
    .run(old, drvId);
  maint.runMaintenance(Date.now(), { backup: false });
  assert.equal((db.prepare('SELECT last_lat FROM drivers WHERE user_id = ?').get(drv2Id) as any).last_lat, null);
  const keep = db.prepare('SELECT last_lat, last_loc_at FROM drivers WHERE user_id = ?').get(drvId) as any;
  assert.equal(keep.last_lat, -24.41);
  // devolve o estado normal ao motorista principal
  db.prepare(`UPDATE rides SET status = 'completed', completed_at = ? WHERE id = ?`).run(Date.now(), busy);
  db.prepare('UPDATE drivers SET online = 1, last_loc_at = ? WHERE user_id = ?').run(Date.now(), drvId);
});

test('limpeza: sessões vencidas somem; cópia diária do banco é criada e girada', () => {
  db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)`)
    .run('f'.repeat(64), paxId, Date.now() - 40 * DAY, Date.now() - DAY, Date.now() - 40 * DAY);
  const rep = maint.runMaintenance(Date.now());
  assert.ok(rep.sessions >= 1);
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE token = ?').get('f'.repeat(64)), undefined);
  assert.ok(rep.backup && fs.existsSync(rep.backup), 'primeira cópia diária');
  // a cópia abre e tem os dados
  const copy = new DatabaseSync(rep.backup!, { readOnly: true });
  assert.ok((copy.prepare('SELECT COUNT(*) c FROM users').get() as any).c >= 5);
  copy.close();
  // menos de 24 h depois: não repete
  assert.equal(maint.runMaintenance(Date.now()).backup, null);
  // giro: mantém só as N mais recentes
  for (let i = 0; i < 9; i++) dbMod.backupDb('diario', undefined, 7);
  const dir = path.dirname(rep.backup!);
  assert.ok(fs.readdirSync(dir).filter(f => f.startsWith('assis-diario-')).length <= 7);
});

// =====================================================================
// LGPD — anonimização
// =====================================================================

test('LGPD: anonimizar apaga dados pessoais e preserva corrida, pagamento e livro-caixa', async () => {
  const f = actor();
  const reg = await f.req('POST', '/api/auth/register', {
    role: 'passenger', name: 'Fábio Pereira', phone: '(44) 90000-5555', cpf: '529.982.247-25',
    email: 'fabio@seg.test', password: 'senha12345',
  });
  const fid = reg.data.user.id;
  await f.req('POST', '/api/favorites', { label: 'Casa', text: 'Rua das Flores, 100', lat: ORIGIN.lat, lng: ORIGIN.lng });
  const rid = await acceptedRide(f);
  await f.req('POST', `/api/rides/${rid}/messages`, { body: 'Estou no portão azul' });
  await f.req('POST', `/api/rides/${rid}/location`, { lat: -24.4157, lng: -53.5217, accuracy_m: 5 });

  // corrida ativa: recusa
  let r = await adm.req('POST', `/api/admin/users/${fid}/anonymize`, { confirm: 'ANONIMIZAR' });
  assert.equal(r.status, 409);
  await finishRide(rid, f);
  assert.equal((db.prepare('SELECT status FROM rides WHERE id = ?').get(rid) as any).status, 'completed');

  const price = (db.prepare('SELECT price_cents FROM rides WHERE id = ?').get(rid) as any).price_cents;
  const ledgerBefore = (db.prepare('SELECT COUNT(*) c FROM financial_transactions WHERE ride_id = ?').get(rid) as any).c;

  // sem a palavra de confirmação: recusa; admin não é anonimizado por aqui
  assert.equal((await adm.req('POST', `/api/admin/users/${fid}/anonymize`, {})).status, 400);
  const admId = (await adm.req('GET', '/api/me')).data.user.id;
  assert.equal((await adm.req('POST', `/api/admin/users/${admId}/anonymize`, { confirm: 'ANONIMIZAR' })).status, 403);
  // só admin pode
  assert.equal((await drv.req('POST', `/api/admin/users/${fid}/anonymize`, { confirm: 'ANONIMIZAR' })).status, 403);

  r = await adm.req('POST', `/api/admin/users/${fid}/anonymize`, { confirm: 'ANONIMIZAR' });
  assert.equal(r.status, 200, JSON.stringify(r.data) + ' ' + JSON.stringify(
    db.prepare('SELECT id, status, driver_id = ? d FROM rides WHERE passenger_id = ? OR driver_id = ?').all(fid, fid, fid)));

  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(fid) as any;
  assert.equal(u.name, 'Usuário removido');
  assert.match(u.email, /@anonimizado\.invalid$/);
  assert.equal(u.phone, null);
  assert.equal(u.cpf, null);
  assert.equal(u.photo, null);
  assert.equal(u.blocked, 1);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get(fid) as any).c, 0);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM favorites WHERE user_id = ?').get(fid) as any).c, 0);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ?').get(fid) as any).c, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM ride_locations WHERE ride_id = ? AND who = 'passenger'`).get(rid) as any).c, 0);
  const msg = db.prepare('SELECT body FROM ride_messages WHERE ride_id = ? AND sender_id = ?').get(rid, fid) as any;
  assert.equal(msg.body, '[mensagem removida]');

  // corrida, preço e livro-caixa preservados; endereços descaracterizados
  const ride = db.prepare('SELECT * FROM rides WHERE id = ?').get(rid) as any;
  assert.equal(ride.price_cents, price);
  assert.equal(ride.status, 'completed');
  assert.equal(ride.origin_text, '[endereço removido]');
  assert.equal(ride.route_geojson, null);
  const quote = db.prepare('SELECT origin_text, route_geojson FROM ride_quotes WHERE id = ?').get(ride.quote_id) as any;
  assert.equal(quote.origin_text, '[endereço removido]');
  assert.equal(quote.route_geojson, null);
  assert.equal(ride.origin_lat, Math.round(ORIGIN.lat * 100) / 100);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM financial_transactions WHERE ride_id = ?').get(rid) as any).c, ledgerBefore);

  // a pessoa não entra mais; os dados antigos não servem de login
  assert.equal((await f.req('GET', '/api/me')).status, 401);
  assert.equal((await actor().req('POST', '/api/auth/login', { email: 'fabio@seg.test', password: 'senha12345' })).status, 401);
  // registrado na auditoria, e não repete
  assert.ok(db.prepare(`SELECT 1 FROM admin_audit_logs WHERE action = 'user_anonymize' AND target_id = ?`).get(fid));
  assert.equal((await adm.req('POST', `/api/admin/users/${fid}/anonymize`, { confirm: 'ANONIMIZAR' })).status, 409);
});

test('LGPD: anonimizar motorista apaga documentos (arquivos) e dados da moto', async () => {
  const g = actor();
  const gid = await newDriver(g, 'Gil Moto', 'gil@seg.test', '111.444.777-35');
  const files = (db.prepare('SELECT file_path FROM driver_documents WHERE driver_id = ?').all(gid) as any[]).map(d => d.file_path);
  assert.equal(files.length, 3);
  assert.ok(files.every(f => fs.existsSync(f)));
  const r = await adm.req('POST', `/api/admin/users/${gid}/anonymize`, { confirm: 'ANONIMIZAR' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.files_removed, 3);
  assert.ok(files.every(f => !fs.existsSync(f)));
  const d = db.prepare('SELECT * FROM drivers WHERE user_id = ?').get(gid) as any;
  assert.equal(d.moto_plate, null);
  assert.equal(d.address, null);
  assert.equal(d.birth_date, null);
  assert.equal(d.online, 0);
});

// =====================================================================
// Cabeçalhos e CSP
// =====================================================================

test('cabeçalhos: CSP nas páginas, sem eval e sem atributos de evento; proteções em todas as respostas', async () => {
  for (const p of ['/', '/passageiro', '/motorista', '/admin', '/empresa', '/offline.html']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    const csp = r.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'self'/, p);
    assert.match(csp, /frame-ancestors 'none'/, p);
    assert.match(csp, /object-src 'none'/, p);
    assert.doesNotMatch(csp, /unsafe-eval/, p);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/, p);
    // cada <script> embutido da página está autorizado pelo hash
    const html = await r.text();
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      const h = crypto.createHash('sha256').update(m[1], 'utf8').digest('base64');
      assert.ok(csp.includes(`'sha256-${h}'`), `${p}: script embutido sem hash na CSP`);
    }
    assert.doesNotMatch(html, /\son(click|load|error|change|submit)=/i, `${p}: atributo de evento`);
  }
  const api = await fetch(base + '/api/config');
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(api.headers.get('x-frame-options'), 'DENY');
  assert.match(api.headers.get('permissions-policy') || '', /geolocation=\(self\)/);
  assert.equal(api.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(api.headers.get('cache-control'), 'no-store');
});

test('o aplicativo continua funcionando: corrida completa do pedido à avaliação', async () => {
  const rid = await acceptedRide(pax);
  await finishRide(rid);
  const rate = await pax.req('POST', `/api/rides/${rid}/rate`, { stars: 5, comment: 'Ótimo' });
  assert.ok([200, 201].includes(rate.status), JSON.stringify(rate.data));
  const earn = await drv.req('GET', '/api/driver/earnings');
  assert.equal(earn.status, 200);
  const dash = await adm.req('GET', '/api/admin/dashboard');
  assert.equal(dash.status, 200);
});
