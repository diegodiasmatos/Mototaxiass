/**
 * Eventos de notificação que não pertencem a uma rota só: aparelho novo na
 * conta, validade da CNH (rodada de manutenção) e erro grave do servidor.
 */
import crypto from 'node:crypto';
import { db } from './db.ts';
import { now } from './util.ts';
import { notify, notifyAdmins } from './notify.ts';

/** "Chrome no Android": o bastante para reconhecer o aparelho, sem guardar o user-agent inteiro nem o IP. */
export function deviceLabel(ua: string): string {
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'Chromebook'
    : /Linux/.test(ua) ? 'Linux' : 'outro sistema';
  const br = /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'navegador';
  return `${br} no ${os}`;
}

/**
 * Registra o aparelho do login. Se a conta já tinha outro aparelho e este é
 * novo, avisa o titular (categoria Conta e segurança: não dá para desligar).
 */
export function recordLoginDevice(userId: string, ua: string): { isNew: boolean; label: string } {
  const label = deviceLabel(String(ua || ''));
  const key = crypto.createHash('sha256').update(label).digest('hex').slice(0, 16);
  const t = now();
  const known = db.prepare('SELECT 1 FROM user_devices WHERE user_id = ? AND device_key = ?').get(userId, key);
  if (known) {
    db.prepare('UPDATE user_devices SET last_seen = ? WHERE user_id = ? AND device_key = ?').run(t, userId, key);
    return { isNew: false, label };
  }
  const others = (db.prepare('SELECT COUNT(*) c FROM user_devices WHERE user_id = ?').get(userId) as any).c;
  db.prepare('INSERT INTO user_devices (user_id, device_key, label, first_seen, last_seen) VALUES (?,?,?,?,?)')
    .run(userId, key, label, t, t);
  if (others > 0) {
    notify(userId, 'new_login', 'Novo acesso à sua conta',
      `Entraram na sua conta por ${label}. Se foi você, está tudo certo. Se não foi, troque a senha agora em Perfil.`);
  }
  return { isNew: true, label };
}

const DAY = 86400_000;
function parseYmd(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

/**
 * CNH dos mototaxistas aprovados: aviso 30 dias antes e no vencimento (uma
 * vez cada, por data de validade). Vencida, a central também é avisada.
 */
export function checkCnhExpiry(t = now()): number {
  let sent = 0;
  const rows = db.prepare(`SELECT d.user_id, d.cnh_expiry, u.name FROM drivers d JOIN users u ON u.id = d.user_id
    WHERE d.status = 'approved' AND u.blocked = 0 AND d.cnh_expiry IS NOT NULL`).all() as any[];
  for (const r of rows) {
    const exp = parseYmd(r.cnh_expiry);
    if (exp == null) continue;
    const br = r.cnh_expiry.split('-').reverse().join('/');
    if (exp + DAY <= t) {
      if (notify(r.user_id, 'doc_expired', 'Sua CNH venceu', {
        body: `A validade da sua CNH (${br}) passou. Renove e envie a nova CNH pelo app para continuar recebendo corridas.`,
        eventKey: `cnh-expired:${r.cnh_expiry}` })) sent++;
      // a central recebe um aviso por CNH vencida (a chave evita repetir a cada rodada)
      notifyAdmins('doc_expired_admin', 'CNH de mototaxista vencida', {
        body: `${r.name}: a CNH venceu em ${br}.`, eventKey: `cnh-expired:${r.user_id}:${r.cnh_expiry}`, url: '/admin#drivers' });
    } else if (exp - 30 * DAY <= t) {
      const days = Math.max(1, Math.ceil((exp - t) / DAY));
      if (notify(r.user_id, 'doc_expiring', 'Sua CNH vence em breve',
        { body: `Sua CNH vence em ${br} (${days} dia${days > 1 ? 's' : ''}). Renove a tempo para não ficar sem corridas.`,
          eventKey: `cnh-expiring:${r.cnh_expiry}` })) sent++;
    }
  }
  return sent;
}

/** Erro grave do servidor: avisa a central no máximo 1 vez a cada 30 min, sem detalhes técnicos sensíveis. */
let lastSystemAlert = 0;
export function alertSystemError(what: string): void {
  const t = now();
  if (t - lastSystemAlert < 30 * 60_000) return;
  lastSystemAlert = t;
  try {
    notifyAdmins('system_error', 'Erro no servidor',
      `${what.slice(0, 120)}. O servidor continua no ar. Veja os registros (logs) da hospedagem.`);
  } catch { /* banco indisponível: só o log */ }
}
export function _resetSystemAlert(): void { lastSystemAlert = 0; }
