/**
 * Atualização do app para quem já tem instalado: a versão publicada vai para
 * /api/version, para dentro do /sw.js e para cada página; muda quando qualquer
 * arquivo de public/ muda.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

process.env.GEO_OFFLINE = '1';
process.env.ADMIN_EMAIL = 'dono-upd@teste.com';
process.env.ADMIN_PASSWORD = 'senha-admin-upd-teste';
process.env.SESSION_SECRET = 'segredo-de-teste-upd';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assis-upd-'));

const { start } = await import('../server/index.ts');
const { computeVersion, injectSwVersion, injectHtmlVersion } = await import('../server/version.ts');

let base = '';
let close: () => Promise<void>;
before(async () => {
  const s = await start({ port: 0, quiet: true, dbPath: path.join(process.env.DATA_DIR!, 'upd.db') });
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;
});
after(async () => { await close(); });

test('versão: /api/version, sw.js e páginas mostram a mesma versão', async () => {
  const r = await fetch(base + '/api/version');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const { version } = await r.json() as any;
  assert.match(version, /^[0-9a-f]{12}$/);

  const sw = await fetch(base + '/sw.js');
  assert.match(sw.headers.get('cache-control') || '', /no-cache/);
  const swText = await sw.text();
  assert.ok(swText.includes(`const VERSION = 'amt-${version}';`), 'sw.js deveria levar a versão');
  // o resto do service worker continua igual (push, cache etc.)
  assert.ok(swText.includes("addEventListener('push'"));

  for (const page of ['/passageiro', '/motorista', '/admin', '/visao-geral']) {
    const html = await (await fetch(base + page)).text();
    assert.ok(html.includes(`<meta name="app-version" content="${version}">`), `${page} sem a versão`);
  }
});

test('versão: muda quando um arquivo muda, e não muda à toa', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assis-ver-'));
  fs.mkdirSync(path.join(dir, 'js'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><head></head></html>');
  fs.writeFileSync(path.join(dir, 'js', 'a.js'), 'console.log(1)');
  const v1 = computeVersion(dir);
  assert.equal(computeVersion(dir), v1);
  fs.writeFileSync(path.join(dir, 'js', 'a.js'), 'console.log(2)');
  const v2 = computeVersion(dir);
  assert.notEqual(v2, v1);
  fs.writeFileSync(path.join(dir, 'img.png'), 'x');
  assert.notEqual(computeVersion(dir), v2);
});

test('versão: injeção no sw.js e no HTML', () => {
  assert.equal(injectSwVersion("const VERSION = 'amt-v4';\nx", 'abc'), "const VERSION = 'amt-abc';\nx");
  const html = injectHtmlVersion('<html><head><title>x</title></head></html>', 'abc');
  assert.ok(html.includes('<meta name="app-version" content="abc">\n</head>'));
  assert.equal(injectHtmlVersion(html, 'zzz'), html);   // não duplica
});

test('versão: /api/version funciona sem login (o app precisa antes de entrar)', async () => {
  const r = await fetch(base + '/api/version', { headers: { Cookie: 'amt_session=invalido' } });
  assert.equal(r.status, 200);
});
