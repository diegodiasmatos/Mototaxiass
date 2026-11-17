import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, getSetting, getSettingNum } from './db.ts';
import {
  ApiError, hashPassword, verifyPassword, id, now, json, readBody,
  isValidEmail, isValidCpf, reqStr, rateLimit, setSessionCookie, clearSessionCookie,
  hashToken, parseCookies,
} from './util.ts';
import { route, type Route, type SessionUser } from './router.ts';
import { notifyAdmins } from './notify.ts';

// ================= sessões =================
//
// - O cookie leva um token aleatório de 256 bits; o banco guarda só o
//   SHA-256 dele (cópia do banco não dá acesso às contas).
// - Expira por inatividade (`*_idle_*`) e tem um prazo máximo desde o login
//   (`*_max_days`); a central tem prazos bem menores que os apps.
// - Cada uso renova o prazo de inatividade (no máximo uma escrita por
//   minuto), sem passar do prazo máximo.

const HOUR = 3600_000, DAY = 24 * HOUR;
const MAX_SESSIONS_PER_USER = 10;
const RENEW_EVERY_MS = 60_000;

/** Prazos de sessão do papel, lidos das configurações (ajustáveis na central). */
export function sessionPolicy(role: string): { idleMs: number; maxMs: number } {
  if (role === 'admin') {
    return {
      idleMs: Math.max(1, getSettingNum('admin_session_idle_hours') || 12) * HOUR,
      maxMs: Math.max(1, getSettingNum('admin_session_max_days') || 7) * DAY,
    };
  }
  return {
    idleMs: Math.max(1, getSettingNum('session_idle_days') || 30) * DAY,
    maxMs: Math.max(1, getSettingNum('session_max_days') || 90) * DAY,
  };
}

/** Cria a sessão e devolve o token (só o cookie o conhece) e a validade do cookie. */
export function createSession(userId: string, role: string): { token: string; maxAgeS: number } {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  const { idleMs, maxMs } = sessionPolicy(role);
  const expires = t + Math.min(idleMs, maxMs);
  db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)`).run(hashToken(token), userId, t, expires, t);
  // limpeza do próprio usuário: sessões vencidas e excesso de aparelhos antigos
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').run(userId, t);
  db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token NOT IN (
    SELECT token FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`)
    .run(userId, userId, MAX_SESSIONS_PER_USER);
  return { token, maxAgeS: Math.floor((expires - t) / 1000) };
}

/**
 * Valida o token do cookie. Sessão vencida (inatividade ou prazo máximo) é
 * apagada. Quando o prazo é renovado, `renewMaxAgeS` traz a nova validade
 * para reenviar o cookie.
 */
export function sessionFromToken(token: string | undefined):
  { user: SessionUser; renewMaxAgeS: number | null } | null {
  if (!token || token.length > 200) return null;
  const h = hashToken(token);
  const row = db.prepare(`
    SELECT u.id, u.role, u.name, u.email, u.phone, u.cpf, u.photo, u.blocked,
           s.created_at s_created, s.expires_at s_expires, s.last_seen_at s_seen
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?`).get(h) as any;
  if (!row) return null;
  const t = now();
  const { idleMs, maxMs } = sessionPolicy(row.role);
  const absolute = row.s_created + maxMs;
  if (row.s_expires <= t || absolute <= t) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(h);
    return null;
  }
  let renewMaxAgeS: number | null = null;
  if (t - (row.s_seen ?? row.s_created) >= RENEW_EVERY_MS) {
    const next = Math.min(t + idleMs, absolute);
    db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token = ?').run(t, next, h);
    renewMaxAgeS = Math.floor((next - t) / 1000);
  }
  const { s_created, s_expires, s_seen, ...user } = row;
  return { user: user as SessionUser, renewMaxAgeS };
}

/** Compatibilidade: só o usuário da sessão, sem renovar. */
export function userFromToken(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.role, u.name, u.email, u.phone, u.cpf, u.photo, u.blocked
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`).get(hashToken(token), now()) as any;
  return row ?? null;
}

// ================= tentativas de login =================
//
// Além do limite por IP, cada CONTA tem um limite: depois de N senhas
// erradas seguidas, novas tentativas ficam bloqueadas por alguns minutos,
// mesmo com a senha certa (senão o bloqueio não protege nada). A central é
// avisada uma vez por bloqueio. Guardado em memória: o app roda numa
// máquina só; reiniciar zera os contadores.

const loginFailures = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();

function lockoutConfig(): { max: number; lockMs: number } {
  return {
    max: Math.max(1, getSettingNum('login_max_failures') || 5),
    lockMs: Math.max(1, getSettingNum('login_lock_min') || 15) * 60_000,
  };
}

/** Lança 429 se a conta estiver em espera. */
function assertNotLocked(email: string): void {
  const f = loginFailures.get(email);
  if (!f) return;
  const t = now();
  if (f.lockedUntil > t) {
    const min = Math.ceil((f.lockedUntil - t) / 60_000);
    throw new ApiError(429,
      `Muitas tentativas com senha errada nesta conta. Tente de novo em ${min} min ou recupere a senha com o suporte.`);
  }
}

function registerFailure(email: string): void {
  const { max, lockMs } = lockoutConfig();
  const t = now();
  let f = loginFailures.get(email);
  // a contagem recomeça se a última sequência de erros já é antiga
  if (!f || (f.lockedUntil && f.lockedUntil <= t) || t - f.firstAt > lockMs) {
    f = { count: 0, firstAt: t, lockedUntil: 0 };
  }
  f.count++;
  if (f.count >= max && !f.lockedUntil) {
    f.lockedUntil = t + lockMs;
    notifyAdmins('login_locked', '🔒 Conta em espera por senhas erradas',
      `${f.count} senhas erradas seguidas para ${email}. Novas tentativas bloqueadas por ${Math.round(lockMs / 60_000)} min.`);
  }
  loginFailures.set(email, f);
}

/** Limpa contadores vencidos (manutenção periódica). */
export function pruneLoginFailures(): void {
  const t = now();
  const { lockMs } = lockoutConfig();
  for (const [k, f] of loginFailures) {
    if (f.lockedUntil ? f.lockedUntil <= t : t - f.firstAt > lockMs) loginFailures.delete(k);
  }
}

// hash fixo para gastar o mesmo tempo quando o e-mail não existe
// (o tempo de resposta não revela quais e-mails têm conta)
let _dummyHash: string | null = null;
function dummyHash(): string { return (_dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'))); }

function publicUser(u: SessionUser): object {
  return { id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone, photo: u.photo };
}

function sanitizePhoto(photo: unknown): string | null {
  if (typeof photo !== 'string' || !photo) return null;
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(photo)) {
    throw new ApiError(400, 'Foto inválida (use JPEG, PNG ou WebP).');
  }
  if (photo.length > 400_000) throw new ApiError(400, 'Foto de perfil muito grande (máx. ~300KB).');
  return photo;
}

async function loginUser(req: IncomingMessage, res: ServerResponse, u: any): Promise<void> {
  if (u.blocked) throw new ApiError(403, `Conta bloqueada. ${u.blocked_reason || 'Fale com o suporte.'}`);
  const { token, maxAgeS } = createSession(u.id, u.role);
  setSessionCookie(req, res, token, maxAgeS);
  json(res, 200, { ok: true, user: publicUser(u) });
}

export const authRoutes: Route[] = [

  route('POST /api/auth/register', null, async ({ req, res, ip }) => {
    if (!rateLimit(`reg:${ip}`, 20, 10 * 60_000)) throw new ApiError(429, 'Muitas tentativas. Aguarde alguns minutos.');
    const b = await readBody(req);
    const roleIn = b.role === 'driver' ? 'driver' : 'passenger';
    const name = reqStr(b.name, 'nome', 120);
    const phone = reqStr(b.phone, 'telefone', 25);
    const password = reqStr(b.password, 'senha', 200);
    if (password.length < 8) throw new ApiError(400, 'A senha deve ter pelo menos 8 caracteres.');
    if (!isValidEmail(b.email)) throw new ApiError(400, 'E-mail inválido.');
    if (b.cpf !== undefined && b.cpf !== '' && !isValidCpf(b.cpf)) throw new ApiError(400, 'CPF inválido.');

    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(b.email) as any;
    if (exists) throw new ApiError(409, 'Já existe uma conta com este e-mail.');

    const uid = id('usr');
    db.prepare(`INSERT INTO users (id, role, name, email, phone, cpf, password_hash, photo, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(uid, roleIn, name, b.email, phone, b.cpf ? String(b.cpf).replace(/\D/g, '') : null,
        hashPassword(password), sanitizePhoto(b.photo), now());

    if (roleIn === 'passenger') notifyAdmins('new_passenger', 'Novo passageiro cadastrado', `${name} (${b.email})`);
    const { token, maxAgeS } = createSession(uid, roleIn);
    setSessionCookie(req, res, token, maxAgeS);
    json(res, 201, { ok: true, user: { id: uid, role: roleIn, name, email: b.email, phone, photo: null } });
  }),

  route('POST /api/auth/login', null, async ({ req, res, ip }) => {
    if (!rateLimit(`login:${ip}`, 25, 10 * 60_000)) throw new ApiError(429, 'Muitas tentativas. Aguarde alguns minutos.');
    const b = await readBody(req);
    const email = reqStr(b.email, 'e-mail', 160);
    const password = reqStr(b.password, 'senha', 200);
    const key = email.trim().toLowerCase();
    assertNotLocked(key);
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
    const ok = verifyPassword(password, u ? u.password_hash : dummyHash());
    if (!u || !ok) {
      registerFailure(key);
      throw new ApiError(401, 'E-mail ou senha incorretos.');
    }
    loginFailures.delete(key);
    await loginUser(req, res, u);
  }),

  // Login com Google (Google Identity Services). Requer GOOGLE_CLIENT_ID no .env.
  route('POST /api/auth/google', null, async ({ req, res, ip }) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      throw new ApiError(501,
        'Login com Google ainda não configurado. Use e-mail e senha, ou configure GOOGLE_CLIENT_ID (ver README).');
    }
    if (!rateLimit(`glogin:${ip}`, 25, 10 * 60_000)) throw new ApiError(429, 'Muitas tentativas.');
    const b = await readBody(req);
    const credential = reqStr(b.credential, 'credential', 4000);
    const r = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
      { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new ApiError(401, 'Credencial Google inválida.');
    const info: any = await r.json();
    if (info.aud !== clientId || info.email_verified !== 'true' || !isValidEmail(info.email)) {
      throw new ApiError(401, 'Credencial Google não aceita.');
    }
    let u = db.prepare('SELECT * FROM users WHERE email = ?').get(info.email) as any;
    if (!u) {
      const uid = id('usr');
      const roleIn = b.role === 'driver' ? 'driver' : 'passenger';
      db.prepare(`INSERT INTO users (id, role, name, email, phone, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(uid, roleIn, info.name || info.email.split('@')[0], info.email, null,
          hashPassword(crypto.randomBytes(24).toString('hex')), now());
      u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid) as any;
      if (roleIn === 'passenger') notifyAdmins('new_passenger', 'Novo passageiro (Google)', info.email);
    }
    await loginUser(req, res, u);
  }),

  route('POST /api/auth/logout', 'any', async ({ req, res }) => {
    const token = parseCookies(req)['amt_session'];
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(hashToken(token));
    clearSessionCookie(req, res);
    json(res, 200, { ok: true });
  }),

  route('GET /api/me', 'any', ({ res, user }) => {
    const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read = 0')
      .get(user!.id) as any;
    let driver: any = null;
    if (user!.role === 'driver') {
      driver = db.prepare(`SELECT status, online, moto_plate, moto_brand, moto_model, moto_year,
        moto_color, submitted_at, deadline_at, review_reason, rating_sum, rating_count, rides_count
        FROM drivers WHERE user_id = ?`).get(user!.id) ?? null;
    }
    json(res, 200, { user: publicUser(user!), driver, unread: unread.c });
  }),

  route('PATCH /api/me', 'any', async ({ req, res, user }) => {
    const b = await readBody(req);
    const name = b.name !== undefined ? reqStr(b.name, 'nome', 120) : user!.name;
    const phone = b.phone !== undefined ? reqStr(b.phone, 'telefone', 25) : user!.phone;
    const photo = b.photo !== undefined ? sanitizePhoto(b.photo) : user!.photo;
    db.prepare('UPDATE users SET name = ?, phone = ?, photo = ? WHERE id = ?')
      .run(name, phone, photo, user!.id);
    json(res, 200, { ok: true });
  }),

  /**
   * Configuração pública consumida pelo frontend.
   * O token do Mapbox que vai aqui é o PÚBLICO (pk., restrito por URL na
   * conta Mapbox) e a chave do Google é a do NAVEGADOR (restrita por site).
   * Token e chave de servidor nunca saem do backend.
   */
  route('GET /api/config', null, async ({ res }) => {
    const { publicToken, mapboxEnabled, mapStyle } = await import('./mapbox.ts');
    const { browserKey, googleEnabled, googleVisualEnabled } = await import('./google-maps.ts');
    // "Forçar OpenStreetMap" vale para TUDO: com o provedor em 'osm', o token
    // nem é enviado — senão o app tentaria carregar um Mapbox com problema
    // (token revogado, cota estourada) em vez de usar o OSM que funciona.
    const forceOsm = getSetting('maps_provider') === 'osm';
    const tk = forceOsm ? null : publicToken();
    // Google primeiro quando há chave; o Mapbox segue junto como reserva
    const gk = googleVisualEnabled() ? browserKey() : null;
    json(res, 200, {
      city_name: getSetting('city_name'),
      center: { lat: Number(getSetting('center_lat')), lng: Number(getSetting('center_lng')) },
      coverage_radius_km: Number(getSetting('coverage_radius_km')),
      welcome_message: getSetting('welcome_message'),
      google_client_id: process.env.GOOGLE_CLIENT_ID || null,
      review_sla_hours: Number(getSetting('review_sla_hours')),
      maps: {
        google_key: gk,                 // pública por natureza; restrinja por site
        mapbox_token: tk,               // público por natureza; restrinja por URL
        provider: gk ? 'google' : tk ? 'mapbox' : 'osm',
        style: mapStyle(),
        server_routing: googleEnabled() ? 'google' : mapboxEnabled() ? 'mapbox' : 'osrm',
      },
    });
  }),
];
