/**
 * Migração da confirmação de embarque (v8): num banco que já está em uso, o
 * servidor faz uma cópia de segurança antes de mudar a estrutura, e nada do
 * que existia se perde.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assis-mig-'));
process.env.SESSION_SECRET = 'segredo-de-teste-migracao';
const dbMod = await import('../server/db.ts');

const BOARDING_COLS = ['boarding_code', 'boarding_attempts', 'boarding_locked_until',
  'boarding_confirmed_at', 'boarding_confirmed_by', 'boarding_method', 'boarding_dist_m'];

test('migração v8: cópia de segurança antes, colunas novas depois, dados preservados', () => {
  const file = path.join(process.env.DATA_DIR!, 'assis.db');

  // 1) banco "antigo": como estava antes desta versão (sem a v8)
  dbMod.initDb(file);
  dbMod.db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('city_name', 'Cidade Antiga - PR')`).run();
  dbMod.db.exec(`DELETE FROM schema_migrations WHERE version = 8;`);
  for (const c of BOARDING_COLS) dbMod.db.exec(`ALTER TABLE rides DROP COLUMN ${c};`);
  dbMod.db.close();

  // 2) o servidor liga com a versão nova
  dbMod.initDb(file);
  const cols = (dbMod.db.prepare('PRAGMA table_info(rides)').all() as any[]).map(c => c.name);
  for (const c of BOARDING_COLS) assert.ok(cols.includes(c), `coluna ${c} deveria existir`);
  assert.equal((dbMod.db.prepare(`SELECT value FROM app_settings WHERE key = 'city_name'`).get() as any).value,
    'Cidade Antiga - PR');

  // 3) a cópia existe, é da estrutura antiga e tem os dados
  const dir = path.join(process.env.DATA_DIR!, 'backups');
  const backups = fs.readdirSync(dir).filter(f => f.startsWith('antes-da-migracao-v8-'));
  assert.equal(backups.length, 1);
  const copy = new DatabaseSync(path.join(dir, backups[0]), { readOnly: true });
  const oldCols = (copy.prepare('PRAGMA table_info(rides)').all() as any[]).map(c => c.name);
  assert.ok(!oldCols.includes('boarding_code'));
  assert.equal((copy.prepare(`SELECT value FROM app_settings WHERE key = 'city_name'`).get() as any).value,
    'Cidade Antiga - PR');
  copy.close();

  // 4) ligar de novo não faz outra cópia (nada pendente)
  dbMod.db.close();
  dbMod.initDb(file);
  assert.equal(fs.readdirSync(dir).length, 1);
  dbMod.db.close();
});
