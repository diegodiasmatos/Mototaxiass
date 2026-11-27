/**
 * Localização em tempo real e mapas: privacidade das coordenadas, envio só
 * entre os participantes da corrida, nada de rastro fora do serviço, aviso
 * "mototaxista aguardando", destinos recentes e o teto de consumo do Google.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

process.env.GEO_OFFLINE = '1';
process.env.ADMIN_EMAIL = 'dono-loc@teste.com';
process.env.ADMIN_PASSWORD = 'senha-admin-loc-teste';
process.env.SESSION_SECRET = 'segredo-de-teste-localizacao';
process.env.GOOGLE_MAPS_BROWSER_KEY = 'chave-de-teste-navegador';   // nenhuma chamada real: GEO_OFFLINE
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assis-loc-'));

const { start } = await import('../server/index.ts');
const dbMod = await import('../server/db.ts');
const { expireStaleRides } = await import('../server/rides.ts');
const usage = await import('../server/geo-usage.ts');
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

const fakeDoc = () => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3996, 7)]).toString('base64')}`;
const ORIGIN = { lat: -24.4156, lng: -53.5216, text: 'Centro, Assis Chateaubriand' };
const DEST = { lat: -24.4450, lng: -53.5400, text: 'Jardim Paraná, Assis Chateaubriand' };
const pax = actor(), intruso = actor(), drv = actor(), drv2 = actor(), adm = actor(), anon = actor();
let driverId = '', driver2Id = '';

async function newDriver(a: ReturnType<typeof actor>, email: string, cpf: string) {
  await a.req('POST', '/api/auth/register', { role: 'driver', accept_terms: true, name: 'Moto ' + email,
    cpf, phone: '(44) 90000-7777', email, password: 'senha12345' });
  await a.req('POST', '/api/driver/apply', {
    birth_date: '1990-01-01', cnh_expiry: '2031-01-01', cnh_first_date: '2012-05-10', decl_cat_a_ear: true,
    address: 'Rua A, 10', moto_plate: 'ABC-1D23', moto_brand: 'Honda', moto_model: 'CG 160', moto_year: '2022',
    moto_color: 'Preta', documents: { cnh: fakeDoc(), crlv: fakeDoc(), selfie: fakeDoc() },
  });
  const id = (db.prepare('SELECT id FROM users WHERE email = ?').get(email) as any).id;
  await adm.req('POST', `/api/admin/drivers/${id}/review`, { action: 'approve' });
  return id as string;
}

async function newRide() {
  const q = await pax.req('POST', '/api/quotes', { origin: ORIGIN, dest: DEST });
  const c = await pax.req('POST', '/api/rides', { quote_id: q.data.quotes[0].id, payment_method: 'dinheiro' });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  return c.data.ride.id as string;
}

before(async () => {
  const s = await start({ port: 0, quiet: true, dbPath: path.join(process.env.DATA_DIR!, 'loc.db') });
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;
  await adm.req('POST', '/api/auth/login', { email: 'dono-loc@teste.com', password: 'senha-admin-loc-teste' });
  for (const [a, email] of [[pax, 'lia@loc.test'], [intruso, 'ivo@loc.test']] as const) {
    await a.req('POST', '/api/auth/register', { role: 'passenger', accept_terms: true, name: 'P ' + email,
      phone: '(44) 90000-8888', email, password: 'senha12345' });
  }
  driverId = await newDriver(drv, 'mauro@loc.test', '529.982.247-25');
  driver2Id = await newDriver(drv2, 'nei@loc.test', '111.444.777-35');
});
after(async () => { await close(); });

test('endpoint público não expõe a posição de mototaxistas', async () => {
  await drv.req('POST', '/api/driver/online', { online: true });
  await drv.req('POST', '/api/driver/location', { lat: -24.4150, lng: -53.5210, accuracy_m: 10 });
  const st = await anon.req('GET', '/api/public/stats');
  assert.equal(st.status, 200);
  assert.ok(st.data.online_drivers >= 1);
  assert.deepEqual(st.data.markers, []);
  assert.doesNotMatch(JSON.stringify(st.data), /-24\.41|-53\.52/);
});

test('mototaxista offline: posição não é guardada e a última é apagada', async () => {
  await drv2.req('POST', '/api/driver/online', { online: true });
  await drv2.req('POST', '/api/driver/location', { lat: -24.4200, lng: -53.5200, accuracy_m: 10 });
  assert.ok((db.prepare('SELECT last_lat FROM drivers WHERE user_id = ?').get(driver2Id) as any).last_lat);
  await drv2.req('POST', '/api/driver/online', { online: false });
  const row = db.prepare('SELECT last_lat, last_lng, last_loc_at FROM drivers WHERE user_id = ?').get(driver2Id) as any;
  assert.equal(row.last_lat, null); assert.equal(row.last_loc_at, null);
  const r = await drv2.req('POST', '/api/driver/location', { lat: -24.4201, lng: -53.5201, accuracy_m: 10 });
  assert.equal(r.status, 200);
  assert.equal(r.data.ignored, true);
  assert.equal((db.prepare('SELECT last_lat FROM drivers WHERE user_id = ?').get(driver2Id) as any).last_lat, null);
});

test('posição do passageiro: só depois do aceite, só da própria corrida, sem excesso', async () => {
  const rid = await newRide();
  // antes do aceite: não guarda (não há com quem compartilhar)
  const early = await pax.req('POST', `/api/rides/${rid}/location`, { lat: -24.4157, lng: -53.5217, accuracy_m: 8 });
  assert.equal(early.data.ignored, true);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM ride_locations WHERE ride_id = ? AND who = 'passenger'`).get(rid) as any).c, 0);
  // outra pessoa não pode mandar posição na corrida alheia
  assert.equal((await intruso.req('POST', `/api/rides/${rid}/location`, { lat: -24.4, lng: -53.5 })).status, 403);

  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/accept`)).status, 200);
  const ok = await pax.req('POST', `/api/rides/${rid}/location`, { lat: -24.4157, lng: -53.5217, accuracy_m: 8 });
  assert.equal(ok.data.ignored, undefined);
  const again = await pax.req('POST', `/api/rides/${rid}/location`, { lat: -24.4158, lng: -53.5218, accuracy_m: 8 });
  assert.equal(again.data.ignored, true);       // menos de 3 s depois
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM ride_locations WHERE ride_id = ? AND who = 'passenger'`).get(rid) as any).c, 1);

  // o passageiro vê a moto enquanto ela vem; o intruso não vê a corrida
  const v = await pax.req('GET', `/api/rides/${rid}`);
  assert.ok(v.data.ride.driver.last_lat != null);
  assert.equal((await intruso.req('GET', `/api/rides/${rid}`)).status, 403);
  // outro mototaxista não manda nem recebe nada desta corrida
  assert.notEqual((await drv2.req('POST', `/api/driver/rides/${rid}/arrived`)).status, 200);

  // cancelada: a corrida antiga não mostra mais onde o mototaxista está
  await pax.req('POST', `/api/rides/${rid}/cancel`, { reason: 'teste' });
  const after = await pax.req('GET', `/api/rides/${rid}`);
  assert.equal(after.data.ride.status, 'cancelled');
  assert.equal(after.data.ride.driver.last_lat, null);
  assert.equal(after.data.ride.driver.last_lng, null);
  const late = await pax.req('POST', `/api/rides/${rid}/location`, { lat: -24.4159, lng: -53.5219 });
  assert.equal(late.data.ignored, true);
});

test('mototaxista aguardando: aviso uma vez, 3 min depois da chegada', async () => {
  await drv.req('POST', '/api/driver/online', { online: true });
  await drv.req('POST', '/api/driver/location', { lat: -24.4157, lng: -53.5216, accuracy_m: 10 });
  const rid = await newRide();
  await drv.req('POST', `/api/driver/rides/${rid}/accept`);
  assert.equal((await drv.req('POST', `/api/driver/rides/${rid}/arrived`)).status, 200);
  const paxId = (db.prepare('SELECT passenger_id FROM rides WHERE id = ?').get(rid) as any).passenger_id;
  const count = () => (db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND kind = 'driver_waiting' AND ride_id = ?`).get(paxId, rid) as any).c;
  await expireStaleRides(Date.now() + 60_000);
  assert.equal(count(), 0);                    // 1 min: ainda não
  await expireStaleRides(Date.now() + 4 * 60_000);
  await expireStaleRides(Date.now() + 5 * 60_000);
  assert.equal(count(), 1);                    // uma vez só
  const arrived = (db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND kind = 'driver_arrived' AND ride_id = ?`).get(paxId, rid) as any).c;
  assert.equal(arrived, 1);
  await pax.req('POST', `/api/rides/${rid}/cancel`, { reason: 'teste' });
});

test('destinos recentes: só os da própria pessoa', async () => {
  const mine = await pax.req('GET', '/api/geo/recent');
  assert.equal(mine.status, 200);
  assert.ok(mine.data.recent.some((r: any) => r.text === DEST.text));
  const other = await intruso.req('GET', '/api/geo/recent');
  assert.deepEqual(other.data.recent, []);
  assert.equal((await drv.req('GET', '/api/geo/recent')).status, 403);
  assert.equal((await anon.req('GET', '/api/geo/recent')).status, 401);
});

test('Google: teto mensal abaixo da cota grátis; no teto o mapa vira OpenStreetMap', async () => {
  const cfg1 = await pax.req('GET', '/api/config');
  assert.equal(cfg1.data.maps.provider, 'google');
  const before = usage.usageOf('maploads');
  await pax.req('POST', '/api/geo/mapload');
  assert.equal(usage.usageOf('maploads'), before + 1);

  // o teto não pode passar da cota grátis do Google
  assert.equal((await adm.req('PUT', '/api/admin/geo-usage', { routes: 5000 })).status, 400);
  assert.equal((await pax.req('PUT', '/api/admin/geo-usage', { maploads: 1 })).status, 403);
  const r = await adm.req('PUT', '/api/admin/geo-usage', { maploads: before + 1 });
  assert.equal(r.status, 200);
  assert.equal(r.data.apis.find((a: any) => a.api === 'maploads').blocked, true);

  const cfg2 = await pax.req('GET', '/api/config');
  assert.equal(cfg2.data.maps.google_key, null);
  assert.notEqual(cfg2.data.maps.provider, 'google');
  assert.ok(db.prepare(`SELECT 1 FROM admin_audit_logs WHERE action = 'google_caps'`).get());

  // rotas: no teto o Google não é chamado
  dbMod.setSetting('google_cap_routes', '0');
  assert.equal(usage.googleAllowed('routes'), false);
  const { googleRoute } = await import('../server/google-maps.ts');
  assert.equal(await googleRoute({ lat: -24.41, lng: -53.52 }, { lat: -24.44, lng: -53.54 }), null);
  dbMod.setSetting('google_cap_routes', '900');
  await adm.req('PUT', '/api/admin/geo-usage', { maploads: 9000 });
});

test('mês de cobrança segue o horário do Pacífico', () => {
  // 1º de dezembro 05:00 UTC ainda é 30 de novembro na Califórnia
  assert.equal(usage.billingMonth(Date.UTC(2026, 11, 1, 5)), '2026-11');
  assert.equal(usage.billingMonth(Date.UTC(2026, 11, 1, 12)), '2026-12');
});

test('OpenStreetMap público: sem autocompletar no Nominatim e no máximo 1 consulta/s', async () => {
  const calls: { url: string; at: number }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url || input);
    if (/nominatim|project-osrm/.test(url)) {
      calls.push({ url, at: Date.now() });
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  }) as any;
  process.env.GEO_OFFLINE = '0';
  try {
    // digitando (busca comum): o Nominatim não é chamado
    await pax.req('GET', '/api/geo/search?q=' + encodeURIComponent('rua inexistente xyz'));
    assert.equal(calls.filter(c => /nominatim.*search/.test(c.url)).length, 0);
    // a pessoa pediu ("Buscar no OpenStreetMap"): chama, identificando o app
    const r = await pax.req('GET', '/api/geo/search?deep=1&q=' + encodeURIComponent('rua inexistente xyz'));
    assert.equal(r.data.deep, true);
    const searches = calls.filter(c => /nominatim.*search/.test(c.url));
    assert.ok(searches.length >= 1);
    // duas consultas seguidas ao serviço público ficam a pelo menos 1 s uma da outra
    for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= 1000, `intervalo ${calls[i].at - calls[i - 1].at} ms`);
  } finally {
    process.env.GEO_OFFLINE = '1';
    globalThis.fetch = realFetch;
  }
});

test('Mapbox: carregamentos e chamadas contam; no teto o token não vai ao app e a API não é chamada', async () => {
  process.env.MAPBOX_PUBLIC_TOKEN = 'pk.teste-local';
  try {
    const c1 = await pax.req('GET', '/api/config');
    assert.ok(c1.data.maps.mapbox_token);
    const before = usage.usageOf('mb_maploads');
    await pax.req('POST', '/api/geo/mapload?p=mapbox');
    assert.equal(usage.usageOf('mb_maploads'), before + 1);
    dbMod.setSetting('mapbox_cap_maploads', String(before + 1));
    const c2 = await pax.req('GET', '/api/config');
    assert.equal(c2.data.maps.mapbox_token, null);
    // rotas: no teto, nenhuma chamada sai para o Mapbox
    dbMod.setSetting('mapbox_cap_directions', '0');
    const { mapboxRoute } = await import('../server/mapbox.ts');
    await assert.rejects(() => mapboxRoute({ lat: -24.41, lng: -53.52 }, { lat: -24.44, lng: -53.54 }), /teto/);
  } finally {
    delete process.env.MAPBOX_PUBLIC_TOKEN;
    dbMod.setSetting('mapbox_cap_maploads', '45000');
    dbMod.setSetting('mapbox_cap_directions', '50000');
  }
});

test('documento do mototaxista: o conteúdo precisa ser do tipo declarado', async () => {
  const a = actor();
  await a.req('POST', '/api/auth/register', { role: 'driver', accept_terms: true, name: 'Doc Falso',
    cpf: '390.533.447-05', phone: '(44) 90000-6060', email: 'docfalso@loc.test', password: 'senha12345' });
  const html = `data:image/jpeg;base64,${Buffer.from('<html><script>alert(1)</script>' + 'x'.repeat(2000)).toString('base64')}`;
  const r = await a.req('POST', '/api/driver/apply', {
    birth_date: '1990-01-01', cnh_expiry: '2031-01-01', cnh_first_date: '2012-05-10', decl_cat_a_ear: true,
    address: 'Rua A, 10', moto_plate: 'ABC-1D23', moto_brand: 'Honda', moto_model: 'CG 160', moto_year: '2022',
    moto_color: 'Preta', documents: { cnh: html, crlv: fakeDoc(), selfie: fakeDoc() },
  });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /não é um JPG válido/);
});
