/**
 * Compatibilidade da migração V3.1 (versão 8) com bancos existentes:
 * cópia de segurança antes de migrar, sessões convertidas para hash sem
 * deslogar ninguém e nenhum dado perdido.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

process.env.GEO_OFFLINE = '1';
process.env.SESSION_SECRET = 'segredo-de-teste-migracao';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assis-mig-'));

const dbMod = await import('../server/db.ts');
const { sessionFromToken } = await import('../server/auth.ts');
const { hashToken } = await import('../server/util.ts');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Contagem de linhas de cada tabela (para provar que nada some). */
/** Tabelas que crescem de propósito na migração (versão nova, configurações novas). */
const GROWS = new Set(['schema_migrations', 'app_settings']);
function assertNothingLost(before: Record<string, number>, after: Record<string, number>): void {
  for (const [k, n] of Object.entries(before)) {
    if (GROWS.has(k)) assert.ok(after[k] >= n, k);
    else assert.equal(after[k], n, `tabela ${k}`);
  }
}
function counts(file: string): Record<string, number> {
  const d = new DatabaseSync(file, { readOnly: true });
  const out: Record<string, number> = {};
  for (const { name } of d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as any[]) {
    out[name] = (d.prepare(`SELECT COUNT(*) c FROM "${name}"`).get() as any).c;
  }
  d.close();
  return out;
}

test('banco no formato anterior (v7): backup antes, tokens viram hash, sessão continua válida', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assis-mig-v7-'));
  const file = path.join(dir, 'assis.db');

  // 1) monta um banco atual e o "volta" para a versão 7
  let db = dbMod.initDb(file);
  db.exec(`DROP INDEX idx_sessions_expires; DROP INDEX idx_ride_locations_at;
    ALTER TABLE sessions DROP COLUMN last_seen_at;
    DELETE FROM schema_migrations WHERE version >= 8;`);
  const t = Date.now();
  db.prepare(`INSERT INTO users (id, role, name, email, phone, password_hash, created_at)
    VALUES ('usr_antigo', 'passenger', 'Pessoa Antiga', 'antiga@mig.test', '1', 'x', ?)`).run(t);
  const rawToken = 'TOKEN-ANTIGO-EM-TEXTO-PURO-0123456789abcdef';
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(rawToken, 'usr_antigo', t - 3600_000, t + 20 * 24 * 3600_000);
  db.close();
  const before = counts(file);

  // 2) abre como o servidor faria ao subir a versão nova
  db = dbMod.initDb(file);
  const versions = (db.prepare('SELECT version FROM schema_migrations').all() as any[]).map(r => r.version);
  assert.ok(versions.includes(8));

  // cópia de segurança feita ANTES de migrar, no formato antigo
  const backups = fs.readdirSync(path.join(dir, 'backups')).filter(f => f.startsWith('assis-pre-migracao-v8-'));
  assert.equal(backups.length, 1);
  const old = new DatabaseSync(path.join(dir, 'backups', backups[0]), { readOnly: true });
  assert.equal((old.prepare('SELECT token FROM sessions').get() as any).token, rawToken);
  assert.equal((old.prepare('SELECT MAX(version) v FROM schema_migrations').get() as any).v, 7);
  old.close();

  // token guardado só como hash, e o cookie antigo continua funcionando
  const row = db.prepare('SELECT token, last_seen_at FROM sessions').get() as any;
  assert.equal(row.token, hashToken(rawToken));
  assert.ok(row.last_seen_at);
  const s = sessionFromToken(rawToken);
  assert.equal(s?.user.id, 'usr_antigo');

  // nenhuma tabela perdeu linhas
  assertNothingLost(before, counts(file));

  // abrir de novo não migra nem copia outra vez
  db.close();
  dbMod.initDb(file);
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1);
  dbMod.db.close();
});

test('banco novo não gera cópia antes da migração', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assis-mig-novo-'));
  dbMod.initDb(path.join(dir, 'assis.db'));
  assert.equal(fs.existsSync(path.join(dir, 'backups')), false);
  dbMod.db.close();
});

// O banco que está versionado no repositório (data/assis.db), quando existir:
// a migração roda numa CÓPIA e o original não é tocado.
const repoDb = path.join(ROOT, 'data', 'assis.db');
test('cópia do banco do repositório migra sem perder dados', { skip: !fs.existsSync(repoDb) && 'sem data/assis.db' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assis-mig-repo-'));
  const file = path.join(dir, 'assis.db');
  for (const ext of ['', '-wal', '-shm']) {
    if (fs.existsSync(repoDb + ext)) fs.copyFileSync(repoDb + ext, file + ext);
  }
  const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const originalHash = sha(repoDb);
  // consolida o WAL na cópia para comparar contagens
  const pre = new DatabaseSync(file);
  pre.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  pre.close();
  const before = counts(file);

  const db = dbMod.initDb(file);
  assertNothingLost(before, counts(file));
  const tokens = (db.prepare('SELECT token FROM sessions').all() as any[]).map(r => r.token);
  assert.ok(tokens.every(tk => /^[0-9a-f]{64}$/.test(tk)));
  db.close();
  // o arquivo original do repositório não mudou
  assert.equal(sha(repoDb), originalHash);
});
