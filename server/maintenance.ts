/**
 * Manutenção periódica: cópia diária do banco e (só se a central ligar)
 * prazos de guarda de GPS e de mensagens.
 *
 * Regras da limpeza (desligada por padrão — 0 dias = não apagar):
 *  - nada de corridas ativas é tocado;
 *  - corrida com ocorrência aberta mantém GPS e mensagens (são prova);
 *  - corridas, pagamentos e livro-caixa NUNCA são apagados aqui.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, getSettingNum, dbFilePath } from './db.ts';
import { now, pruneRateLimits } from './util.ts';
import { checkCnhExpiry } from './notify-events.ts';

const DAY = 24 * 3600_000;
const ACTIVE = `'pending_payment','requested','accepted','in_progress','awaiting_confirmation','disputed'`;
const OPEN_ISSUE = `'aberta','em_analise'`;

/** Pasta das cópias: ao lado do banco (no Fly.io, o disco /data). */
export function backupDir(): string {
  return path.join(path.dirname(dbFilePath() || path.join(process.env.DATA_DIR || '.', 'x')), 'backups');
}

/** Lista as cópias diárias, da mais nova para a mais antiga. */
export function listBackups(): { name: string; size: number; at: number }[] {
  try {
    return fs.readdirSync(backupDir())
      .filter(f => f.startsWith('assis-diario-') && f.endsWith('.db'))
      .map(f => { const st = fs.statSync(path.join(backupDir(), f)); return { name: f, size: st.size, at: st.mtimeMs }; })
      .sort((a, b) => b.at - a.at);
  } catch { return []; }
}

/** Faz a cópia diária se a última tiver mais de 24 h; mantém as `backup_keep` mais novas. */
export function dailyBackupIfDue(t = now(), force = false): string | null {
  const list = listBackups();
  if (!force && list.length && t - list[0].at < DAY) return null;
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(t).toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `assis-diario-${stamp}.db`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const keep = Math.max(1, getSettingNum('backup_keep') || 7);
  for (const old of listBackups().slice(keep)) {
    try { fs.unlinkSync(path.join(dir, old.name)); } catch { /* já não existe */ }
  }
  return target;
}

/** GPS de corridas encerradas há mais de `gps_retention_days` (0 = desligado). */
export function purgeOldGps(t = now()): number {
  const days = getSettingNum('gps_retention_days');
  if (!(days > 0)) return 0;
  const cutoff = t - days * DAY;
  return Number(db.prepare(`DELETE FROM ride_locations WHERE ride_id IN (
      SELECT r.id FROM rides r WHERE r.status IN ('completed','cancelled')
        AND COALESCE(r.completed_at, r.cancelled_at, r.requested_at) < ?
        AND NOT EXISTS (SELECT 1 FROM ride_issues i WHERE i.ride_id = r.id AND i.status IN (${OPEN_ISSUE})))`)
    .run(cutoff).changes);
}

/** Mensagens do chat de corridas encerradas há mais de `messages_retention_days` (0 = desligado). */
export function purgeOldMessages(t = now()): number {
  const days = getSettingNum('messages_retention_days');
  if (!(days > 0)) return 0;
  const cutoff = t - days * DAY;
  return Number(db.prepare(`DELETE FROM ride_messages WHERE ride_id IN (
      SELECT r.id FROM rides r WHERE r.status NOT IN (${ACTIVE})
        AND COALESCE(r.completed_at, r.cancelled_at, r.requested_at) < ?
        AND NOT EXISTS (SELECT 1 FROM ride_issues i WHERE i.ride_id = r.id AND i.status IN (${OPEN_ISSUE})))`)
    .run(cutoff).changes);
}

export interface MaintenanceReport { backup: string | null; gps: number; messages: number; sessions: number }

/** Uma rodada. Cada parte é independente: uma falha não impede as outras. */
export function runMaintenance(t = now(), opts: { backup?: boolean } = {}): MaintenanceReport {
  const r: MaintenanceReport = { backup: null, gps: 0, messages: 0, sessions: 0 };
  const safe = (fn: () => void, what: string) => {
    try { fn(); } catch (e: any) { console.error(`[manutenção] ${what}: ${e?.message || e}`); }
  };
  safe(() => { r.sessions = Number(db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t).changes); }, 'sessões');
  safe(() => { db.prepare('DELETE FROM ride_quotes WHERE expires_at < ? AND used = 0').run(t - DAY); }, 'cotações');
  safe(() => { r.gps = purgeOldGps(t); }, 'GPS');
  safe(() => { r.messages = purgeOldMessages(t); }, 'mensagens');
  safe(() => { pruneRateLimits(); }, 'contadores');
  safe(() => { checkCnhExpiry(t); }, 'validade da CNH');
  if (opts.backup !== false) safe(() => { r.backup = dailyBackupIfDue(t); }, 'cópia diária');
  if (r.backup) console.log(`[manutenção] cópia diária do banco: ${r.backup}`);
  return r;
}

/** 1 min depois de ligar e depois a cada 10 min. */
export function startMaintenance(): void {
  setTimeout(() => runMaintenance(), 60_000).unref();
  setInterval(() => runMaintenance(), 10 * 60_000).unref();
}
