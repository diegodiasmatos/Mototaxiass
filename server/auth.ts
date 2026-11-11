import crypto from 'node:crypto';
import { db, getSetting } from './db.ts';
import {
  ApiError, hashPassword, verifyPassword, id, now, json, readBody,
  isValidEmail, isValidCpf, reqStr, rateLimit, setSessionCookie, clearSessionCookie,
} from './util.ts';
import { route, type Route, type SessionUser } from './router.ts';
import { notifyAdmins } from './notify.ts';

const SESSION_TTL = 30 * 24 * 3600 * 1000;

export function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now(), now() + SESSION_TTL);
  return token;
}

export function userFromToken(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.role, u.name, u.email, u.phone, u.cpf, u.photo, u.blocked
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`).get(token, now()) as any;
  return row ?? null;
}

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

async function loginUser(res: any, u: any): Promise<void> {
  if (u.blocked) throw new ApiError(403, `Conta bloqueada. ${u.blocked_reason || 'Fale com o suporte.'}`);
  const token = createSession(u.id);
  setSessionCookie(res, token);
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
    const token = createSession(uid);
    setSessionCookie(res, token);
    json(res, 201, { ok: true, user: { id: uid, role: roleIn, name, email: b.email, phone, photo: null } });
  }),

  route('POST /api/auth/login', null, async ({ req, res, ip }) => {
    if (!rateLimit(`login:${ip}`, 25, 10 * 60_000)) throw new ApiError(429, 'Muitas tentativas. Aguarde alguns minutos.');
    const b = await readBody(req);
    const email = reqStr(b.email, 'e-mail', 160);
    const password = reqStr(b.password, 'senha', 200);
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
    if (!u || !verifyPassword(password, u.password_hash)) {
      throw new ApiError(401, 'E-mail ou senha incorretos.');
    }
    await loginUser(res, u);
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
    await loginUser(res, u);
  }),

  route('POST /api/auth/logout', 'any', async ({ req, res }) => {
    const { parseCookies } = await import('./util.ts');
    const token = parseCookies(req)['amt_session'];
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    clearSessionCookie(res);
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
   * A chave do Maps que vai aqui é a do NAVEGADOR (restrita por domínio no
   * Google Cloud). A chave de servidor nunca sai do backend.
   */
  route('GET /api/config', null, async ({ res }) => {
    const { browserKey, googleEnabled } = await import('./google-maps.ts');
    json(res, 200, {
      city_name: getSetting('city_name'),
      center: { lat: Number(getSetting('center_lat')), lng: Number(getSetting('center_lng')) },
      coverage_radius_km: Number(getSetting('coverage_radius_km')),
      welcome_message: getSetting('welcome_message'),
      google_client_id: process.env.GOOGLE_CLIENT_ID || null,
      review_sla_hours: Number(getSetting('review_sla_hours')),
      maps: {
        browser_key: browserKey(),      // pública por natureza; restrinja por domínio
        provider: browserKey() ? 'google' : 'osm',
        server_routing: googleEnabled() ? 'google' : 'osrm',
      },
    });
  }),
];
