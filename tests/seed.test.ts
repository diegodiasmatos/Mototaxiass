/**
 * Importação automática da pasta seed/ (IBGE + locais conferidos): roda uma
 * vez, não duplica, não sobrescreve e fica na auditoria.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

process.env.GEO_OFFLINE = '1';
process.env.ADMIN_EMAIL = 'dono-seed@teste.com';
process.env.ADMIN_PASSWORD = 'senha-admin-seed-teste';
process.env.SESSION_SECRET = 'segredo-de-teste-seed';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assis-seed-'));

const { start } = await import('../server/index.ts');
const dbMod = await import('../server/db.ts');
const seed = await import('../server/seed.ts');
const db = { prepare: (sql: string) => dbMod.db.prepare(sql) };

let base = '';
let close: () => Promise<void>;
before(async () => {
  const s = await start({ port: 0, quiet: true, dbPath: path.join(process.env.DATA_DIR!, 'seed.db') });
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;
});
after(async () => { await close(); });

test('seed: desligada nos testes e ligada só no app publicado', () => {
  assert.equal(seed.seedImportsEnabled(), false);
  process.env.APP_ENV = 'production';
  try { assert.equal(seed.seedImportsEnabled(), true); } finally { delete process.env.APP_ENV; }
});

test('seed: importa o IBGE e os locais uma vez, sem duplicar nem sobrescrever', async () => {
  // um número que um passageiro já confirmou não pode ser trocado
  db.prepare(`INSERT INTO local_addresses (kind, name, norm, lat, lng, updated_at, source)
    VALUES ('rua', 'Rua Santos Dumont', 'rua santos dumont', -24.4089, -53.5143, ?, 'osm')`).run(Date.now());
  db.prepare(`INSERT INTO address_points (street_norm, street_name, number, lat, lng, source, hits, updated_at)
    VALUES ('rua santos dumont', 'Rua Santos Dumont', 191, -24.40881, -53.51417, 'passageiro', 1, ?)`).run(Date.now());

  const r1 = await seed.runSeedImports();
  assert.equal(r1.length, 2, JSON.stringify(r1));
  assert.ok(r1.every(r => r.status === 'importado'), JSON.stringify(r1));
  assert.equal(r1[0].file.startsWith('ibge-'), true);        // IBGE antes dos locais

  const ibge = (db.prepare(`SELECT COUNT(*) n FROM address_points WHERE source = 'ibge'`).get() as any).n;
  assert.ok(ibge > 10000, `números de casa do IBGE: ${ibge}`);
  assert.equal((db.prepare(`SELECT source FROM address_points WHERE street_norm = 'rua santos dumont' AND number = 191`).get() as any).source, 'passageiro');
  const locais = (db.prepare(`SELECT COUNT(*) n FROM local_addresses WHERE source = 'manual'`).get() as any).n;
  assert.ok(locais >= 50, `locais importados: ${locais}`);

  // segunda subida: nada de novo
  const r2 = await seed.runSeedImports();
  assert.ok(r2.every(r => r.status === 'ja_importado'), JSON.stringify(r2));
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM address_points WHERE source = 'ibge'`).get() as any).n, ibge);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM local_addresses WHERE source = 'manual'`).get() as any).n, locais);

  // auditoria como "sistema"
  const aud = db.prepare(`SELECT action FROM admin_audit_logs WHERE admin_id = 'sistema'`).all() as any[];
  assert.deepEqual(aud.map(a => a.action).sort(), ['cnefe_import', 'places_import']);

  // o passageiro acha endereço com número exato e um local do lote
  const reg = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'passenger', name: 'Seed', phone: '44999990000', email: 's@seed.test', password: 'senha12345', accept_terms: true }) });
  const cookie = /amt_session=[^;]+/.exec(reg.headers.get('set-cookie') || '')![0];
  const q = async (t: string) => ((await (await fetch(base + '/api/geo/search?q=' + encodeURIComponent(t), { headers: { Cookie: cookie } })).json()) as any).results;
  const h = (await q('rua sete de setembro 1259'))[0];
  assert.equal(h.number_how, 'exato');
  assert.ok((await q('laboratorio alfa')).some((x: any) => /Laboratorio Alfa/.test(x.text)));
});

test('seed: arquivo novo (outra versão) entra de novo, só com o que for novo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-dir-'));
  fs.writeFileSync(path.join(dir, 'locais-extra.csv'),
    'nome;latitude;longitude;categoria\nLocal Extra Seed;-24.4170;-53.5230;teste\n');
  const a = await seed.runSeedImports(dir);
  assert.equal(a[0].status, 'importado');
  fs.writeFileSync(path.join(dir, 'locais-extra.csv'),
    'nome;latitude;longitude;categoria\nLocal Extra Seed;-24.4170;-53.5230;teste\nOutro Local Seed;-24.4180;-53.5240;teste\n');
  const b = await seed.runSeedImports(dir);
  assert.equal(b[0].status, 'importado');
  assert.match(b[0].detail, /^1 cadastrado/);
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM local_addresses WHERE norm IN ('local extra seed', 'outro local seed')`).get() as any).n, 2);
});
