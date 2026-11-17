/**
 * Manutenção periódica do banco: limpeza de dados vencidos, retenção de GPS
 * e cópia de segurança diária.
 *
 * Regras de segurança da limpeza:
 *  - nada de corridas ATIVAS é tocado (pagamento pendente, procurando,
 *    aceita, em andamento, aguardando confirmação, em disputa);
 *  - corrida com ocorrência aberta mantém o GPS (é prova na análise);
 *  - apaga em lotes pequenos, para não segurar o banco por muito tempo;
 *  - corridas, pagamentos e livro-caixa NUNCA são apagados aqui.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, getSettingNum, backupDb, backupDir } from './db.ts';
import { now, pruneRateLimits } from './util.ts';
import { pruneLoginFailures } from './auth.ts';

const HOUR = 3600_000, DAY = 24 * HOUR;
const BATCH = 500;
const MAX_BATCHES = 200;              // no máximo 100 mil linhas por rodada

/** Situações em que a corrida ainda está acontecendo. */
export const ACTIVE_RIDE_STATUSES = [
  'pending_payment', 'requested', 'accepted', 'in_progress', 'awaiting_confirmation', 'disputed',
];
const OPEN_ISSUE_STATUSES = ['aberta', 'em_analise'];

const list = (xs: string[]) => xs.map(x => `'${x}'`).join(',');

export interface MaintenanceReport {
  sessions: number;
  quotes: number;
  gps_points: number;
  driver_locations: number;
  backup: string | null;
}

/** Apaga em lotes; devolve o total removido. */
function deleteInBatches(sql: string, ...params: (string | number)[]): number {
  const stmt = db.prepare(sql);
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = Number(stmt.run(...params, BATCH).changes);
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

/**
 * Histórico de GPS de corridas encerradas há mais de `gps_retention_days`.
 * CROSS JOIN fixa a ordem: parte do índice por data (só os pontos vencidos),
 * em vez de percorrer todas as corridas encerradas a cada rodada.
 */
export function purgeOldGps(t = now()): number {
  const days = getSettingNum('gps_retention_days');
  if (!(days > 0)) return 0;                     // 0 ou inválido = não apagar
  const cutoff = t - days * DAY;
  return deleteInBatches(`DELETE FROM ride_locations WHERE id IN (
      SELECT l.id FROM ride_locations l CROSS JOIN rides r ON r.id = l.ride_id
      WHERE l.at < ?
        AND r.status IN ('completed','cancelled')
        AND COALESCE(r.completed_at, r.cancelled_at, r.confirmed_at, l.at) < ?
        AND NOT EXISTS (SELECT 1 FROM ride_issues i
          WHERE i.ride_id = r.id AND i.status IN (${list(OPEN_ISSUE_STATUSES)}))
      LIMIT ?)`, cutoff, cutoff);
}

/**
 * Última posição de motorista OFFLINE há mais de `driver_offline_loc_hours`
 * (só a coordenada; o horário fica para as estatísticas). Motorista online
 * ou com corrida ativa não é tocado.
 */
export function purgeOfflineDriverLocations(t = now()): number {
  const hours = getSettingNum('driver_offline_loc_hours');
  if (!(hours > 0)) return 0;
  const cutoff = t - hours * HOUR;
  return Number(db.prepare(`UPDATE drivers SET last_lat = NULL, last_lng = NULL, last_accuracy_m = NULL
    WHERE last_lat IS NOT NULL AND online = 0
      AND COALESCE(last_loc_at, 0) < ?
      AND user_id NOT IN (SELECT driver_id FROM rides
        WHERE driver_id IS NOT NULL AND status IN (${list(ACTIVE_RIDE_STATUSES)}))`)
    .run(cutoff).changes);
}

/** Sessões vencidas por inatividade ou pelo prazo máximo do papel. */
export function purgeSessions(t = now()): number {
  const adminMax = Math.max(1, getSettingNum('admin_session_max_days') || 7) * DAY;
  const userMax = Math.max(1, getSettingNum('session_max_days') || 90) * DAY;
  let n = Number(db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(t).changes);
  n += Number(db.prepare(`DELETE FROM sessions WHERE created_at < ?
    AND user_id IN (SELECT id FROM users WHERE role = 'admin')`).run(t - adminMax).changes);
  n += Number(db.prepare(`DELETE FROM sessions WHERE created_at < ?
    AND user_id IN (SELECT id FROM users WHERE role <> 'admin')`).run(t - userMax).changes);
  return n;
}

/** Cópia diária: só cria se a mais recente tiver mais de 24 h. */
export function dailyBackupIfDue(t = now()): string | null {
  const keep = Math.max(1, getSettingNum('backup_keep') || 7);
  const dir = backupDir();
  let latest = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('assis-diario-') && f.endsWith('.db')) {
        latest = Math.max(latest, fs.statSync(path.join(dir, f)).mtimeMs);
      }
    }
  } catch { /* pasta ainda não existe */ }
  if (latest && t - latest < DAY) return null;
  const file = backupDb('diario', undefined, keep);
  try { db.exec('PRAGMA optimize'); } catch { /* opcional */ }
  return file;
}

/** Uma rodada completa. Cada parte é independente: uma falha não impede as outras. */
export function runMaintenance(t = now(), opts: { backup?: boolean } = {}): MaintenanceReport {
  const r: MaintenanceReport = { sessions: 0, quotes: 0, gps_points: 0, driver_locations: 0, backup: null };
  const safe = (fn: () => void, what: string) => {
    try { fn(); } catch (e: any) { console.error(`[manutenção] ${what}: ${e?.message || e}`); }
  };
  safe(() => { r.sessions = purgeSessions(t); }, 'sessões');
  safe(() => {
    r.quotes = Number(db.prepare('DELETE FROM ride_quotes WHERE expires_at < ? AND used = 0')
      .run(t - DAY).changes);
  }, 'cotações');
  safe(() => { r.gps_points = purgeOldGps(t); }, 'GPS');
  safe(() => { r.driver_locations = purgeOfflineDriverLocations(t); }, 'posição de motoristas');
  safe(() => { pruneRateLimits(); pruneLoginFailures(); }, 'contadores');
  if (r.gps_points > 0) safe(() => { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); }, 'checkpoint');
  if (opts.backup !== false) safe(() => { r.backup = dailyBackupIfDue(t); }, 'backup');
  return r;
}

/** Agenda a manutenção: 1 min depois de subir e depois a cada 10 min. */
export function startMaintenance(): void {
  const tick = () => { runMaintenance(); };
  const first = setTimeout(tick, 60_000);
  first.unref();
  const every = setInterval(tick, 10 * 60_000);
  every.unref();
}
