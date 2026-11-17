import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ROOT, loadEnv, json, parseCookies, ApiError, verifySignedDoc,
  hashPassword, id, now, clientIp, isSecureRequest, requestOrigin, setSessionCookie,
} from './util.ts';
import { initDb, db, getCredential } from './db.ts';
import { matchRoute, type Route, type Ctx } from './router.ts';
import { authRoutes, sessionFromToken } from './auth.ts';
import { startMaintenance } from './maintenance.ts';
import { rideRoutes, startAutoConfirmSweeper } from './rides.ts';
import { driverRoutes } from './drivers.ts';
import { adminRoutes } from './admin.ts';
import { integrationRoutes } from './integrations.ts';
import { sseConnect } from './notify.ts';

const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

// ================= cabeçalhos de segurança =================

/**
 * Content Security Policy das páginas. Libera só a própria origem e os
 * serviços que o app realmente usa: Google Maps, Mapbox, Leaflet (unpkg),
 * blocos do OpenStreetMap e o login do Google. Scripts embutidos nas páginas
 * entram pelo hash (calculado na subida a partir de public/*.html); atributos
 * de evento (onclick=...) não são permitidos.
 */
function buildCsp(secure: boolean): string {
  const g = ['https://*.googleapis.com', 'https://*.gstatic.com'];
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", ...inlineScriptHashes(), 'https://unpkg.com', 'https://api.mapbox.com',
      ...g, 'https://accounts.google.com/gsi/client'],
    'style-src': ["'self'", "'unsafe-inline'", 'https://unpkg.com', 'https://api.mapbox.com',
      'https://fonts.googleapis.com', 'https://accounts.google.com/gsi/style'],
    'img-src': ["'self'", 'data:', 'blob:', 'https://tile.openstreetmap.org',
      'https://*.tile.openstreetmap.org', 'https://unpkg.com', 'https://api.mapbox.com', ...g,
      'https://*.google.com', 'https://*.googleusercontent.com', 'https://*.ggpht.com'],
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
    'connect-src': ["'self'", 'https://api.mapbox.com', 'https://events.mapbox.com', ...g,
      'https://*.google.com', 'https://accounts.google.com'],
    'worker-src': ["'self'", 'blob:'],
    'child-src': ["'self'", 'blob:'],
    'frame-src': ['https://accounts.google.com'],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  const out = Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`);
  if (secure) out.push('upgrade-insecure-requests');
  return out.join('; ');
}

let _inlineHashes: string[] | null = null;
/** sha256 de cada <script> embutido nas páginas (sem atributo src). */
function inlineScriptHashes(): string[] {
  if (_inlineHashes) return _inlineHashes;
  const set = new Set<string>();
  for (const f of fs.readdirSync(PUBLIC_DIR)) {
    if (!f.endsWith('.html')) continue;
    const html = fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8');
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      set.add(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
    }
  }
  return (_inlineHashes = [...set]);
}

/** Cabeçalhos aplicados a TODAS as respostas. */
function securityHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  // só a geolocalização é usada (e só pela própria origem)
  res.setHeader('Permissions-Policy',
    'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()');
  // o login do Google abre uma janela que precisa falar com esta
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  if (isSecureRequest(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

// ================= CSRF =================

/** Rotas chamadas por servidores de terceiros: protegidas por assinatura própria. */
const CSRF_EXEMPT = [/^\/api\/webhooks\//];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Domínio (com porta) de uma URL; nulo se não for uma URL válida. */
function hostOf(url: string): string | null {
  try { return new URL(url).host.toLowerCase() || null; } catch { return null; }
}

/**
 * Bloqueia escrita na API vinda de outro site:
 *  1. exige o cabeçalho X-VAIRO-Request (o app sempre manda; um site de
 *     terceiros não consegue mandar sem a liberação de CORS, que não existe);
 *  2. Origin/Referer, quando presentes, têm de ser deste próprio site;
 *  3. corpo só em JSON (formulário HTML de outro site não envia JSON).
 */
function assertSameSiteWrite(req: http.IncomingMessage, pathname: string): void {
  if (SAFE_METHODS.has(req.method || 'GET') || !pathname.startsWith('/api/')) return;
  if (CSRF_EXEMPT.some(r => r.test(pathname))) return;
  if (req.headers['x-vairo-request'] !== '1') {
    throw new ApiError(403, 'Requisição bloqueada pela proteção contra CSRF. Recarregue a página.');
  }
  // compara o domínio (não o esquema): atrás de um proxy sem TRUST_PROXY o
  // servidor enxerga http, enquanto o navegador está em https no mesmo site
  const allowed = new Set([hostOf(requestOrigin(req))]);
  const pub = hostOf(getCredential('PUBLIC_URL') || '');
  if (pub) allowed.add(pub);
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const from = typeof origin === 'string' && origin !== 'null' ? hostOf(origin)
    : typeof referer === 'string' ? hostOf(referer) : undefined;
  if (from === null || (from && !allowed.has(from)) || origin === 'null') {
    throw new ApiError(403, 'Requisição de outra origem bloqueada.');
  }
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (hasBody && !type.startsWith('application/json')) {
    throw new ApiError(415, 'Envie os dados em JSON.');
  }
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): boolean {
  let rel = urlPath;
  // páginas amigáveis
  if (rel === '/' || rel === '/visao-geral') rel = '/visao-geral.html';
  if (rel === '/passageiro') rel = '/index.html';
  if (rel === '/motorista' || rel === '/mototaxista') rel = '/motorista.html';
  if (rel === '/empresa') rel = '/empresa.html';
  if (rel === '/admin') rel = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return false; // path traversal
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html') res.setHeader('Content-Security-Policy', buildCsp(isSecureRequest(req)));
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  res.end(fs.readFileSync(file));
  return true;
}

/** Documentos privados: somente via link assinado e temporário. */
function serveSignedDoc(res: http.ServerResponse, docId: string, q: URLSearchParams): void {
  const e = q.get('e') || '', s = q.get('s') || '';
  if (!verifySignedDoc(docId, e, s)) {
    json(res, 403, { error: 'Link expirado ou inválido. Abra o cadastro novamente.' });
    return;
  }
  const doc = db.prepare('SELECT file_path, mime FROM driver_documents WHERE id = ?').get(docId) as any;
  if (!doc || !fs.existsSync(doc.file_path)) { json(res, 404, { error: 'Documento não encontrado.' }); return; }
  res.writeHead(200, { 'Content-Type': doc.mime, 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(doc.file_path));
}

/** Cria o primeiro admin a partir do .env, ou gera credenciais impressas no console. */
function bootstrapAdmin(): void {
  const exists = db.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get() as any;
  if (exists) return;
  const email = process.env.ADMIN_EMAIL || 'admin@assismototaxi.local';
  let password = process.env.ADMIN_PASSWORD;
  let generated = false;
  if (!password) { password = crypto.randomBytes(9).toString('base64url'); generated = true; }
  db.prepare(`INSERT INTO users (id, role, name, email, phone, password_hash, created_at)
    VALUES (?, 'admin', 'Administrador', ?, NULL, ?, ?)`)
    .run(id('usr'), email, hashPassword(password), now());
  console.log('┌──────────────────────────────────────────────────────┐');
  console.log('│  PRIMEIRO ADMINISTRADOR CRIADO                       │');
  console.log(`│  E-mail: ${email.padEnd(43)}│`);
  if (generated) {
    console.log(`│  Senha : ${password.padEnd(43)}│`);
    console.log('│  (gerada agora — anote, não será mostrada de novo)  │');
  } else {
    console.log('│  Senha : definida via ADMIN_PASSWORD no .env         │');
  }
  console.log('│  Acesse /admin e troque os dados com segurança.      │');
  console.log('└──────────────────────────────────────────────────────┘');
}

const ALL_ROUTES: Route[] = [
  ...authRoutes, ...rideRoutes, ...driverRoutes, ...adminRoutes, ...integrationRoutes,
];

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;
  const ip = clientIp(req);
  securityHeaders(req, res);

  try {
    // documentos privados assinados
    const docMatch = /^\/files\/doc\/([^/]+)$/.exec(pathname);
    if (docMatch && req.method === 'GET') { serveSignedDoc(res, docMatch[1], url.searchParams); return; }

    const sess = sessionFromToken(parseCookies(req)['amt_session']);
    const user = sess?.user ?? null;
    // prazo de inatividade renovado: o cookie acompanha (login/logout sobrescrevem)
    if (sess?.renewMaxAgeS) setSessionCookie(req, res, parseCookies(req)['amt_session'], sess.renewMaxAgeS);

    assertSameSiteWrite(req, pathname);

    // SSE — tempo real
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!user) { json(res, 401, { error: 'Faça login para continuar.' }); return; }
      sseConnect(user.id, user.role, res);
      return;
    }

    const match = matchRoute(ALL_ROUTES, req.method || 'GET', pathname);
    if (match) {
      const { route, params } = match;
      if (route.auth !== null) {
        if (!user) throw new ApiError(401, 'Faça login para continuar.');
        if (user.blocked) throw new ApiError(403, 'Conta bloqueada. Fale com o suporte.');
        if (route.auth !== 'any' && user.role !== route.auth) {
          throw new ApiError(403, 'Você não tem permissão para esta operação.');
        }
      }
      const ctx: Ctx = { req, res, params, query: url.searchParams, user, ip };
      await route.handler(ctx);
      return;
    }

    if (pathname.startsWith('/api/')) { json(res, 404, { error: 'Rota não encontrada.' }); return; }

    // Entrada do site: quem já tem sessão cai direto no seu aplicativo (links
    // de notificação e de retorno do pagamento apontam para "/"); visitante
    // vê a Visão Geral do ecossistema.
    if (req.method === 'GET' && pathname === '/' && user) {
      if (user.role === 'passenger') { serveStatic(req, res, '/passageiro'); return; }
      res.writeHead(302, { Location: user.role === 'admin' ? '/admin' : '/motorista' });
      res.end();
      return;
    }

    if (req.method === 'GET' && serveStatic(req, res, pathname)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — página não encontrada');
  } catch (err: any) {
    if (err instanceof ApiError) {
      json(res, err.status, { error: err.message });
    } else {
      // só método e caminho: corpo, parâmetros (coordenadas, buscas) e dados
      // pessoais não vão para o log
      console.error(`[erro] ${req.method} ${pathname}: ${err?.name || 'Error'}: ${String(err?.message || err).slice(0, 300)}`
        + (err?.stack ? `\n${String(err.stack).split('\n').slice(1, 6).join('\n')}` : ''));
      json(res, 500, { error: 'Erro interno. Tente novamente.' });
    }
  }
}

export interface StartOptions { port?: number; dbPath?: string; quiet?: boolean }

export async function start(opts: StartOptions = {}): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  loadEnv();
  initDb(opts.dbPath);
  bootstrapAdmin();

  // confirma automaticamente as corridas cujo prazo de 5 s expirou (no servidor)
  startAutoConfirmSweeper();

  // base de endereços baixada num formato antigo: baixa de novo, em segundo
  // plano, sem atrasar a subida (não roda nos testes / modo sem rede)
  if (process.env.GEO_OFFLINE !== '1') {
    import('./address-base.ts').then(m => m.refreshOutdatedBase()).catch(() => { });
  }

  // limpeza periódica (sessões, cotações, GPS antigo) e cópia diária do banco
  startMaintenance();

  const server = http.createServer((req, res) => { void handle(req, res); });
  const port = opts.port ?? Number(process.env.PORT || 8780);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  const actual = (server.address() as any).port;
  if (!opts.quiet) {
    console.log(`\n🏍️  VAIRO rodando em http://localhost:${actual}`);
    console.log(`   Visão geral: http://localhost:${actual}/`);
    console.log(`   Passageiro:  http://localhost:${actual}/passageiro`);
    console.log(`   Motorista:   http://localhost:${actual}/motorista`);
    console.log(`   Empresa:     http://localhost:${actual}/empresa`);
    console.log(`   Central:     http://localhost:${actual}/admin`);
    console.log(`   (acesse do celular na mesma rede pelo IP desta máquina)\n`);
  }
  return {
    server,
    port: actual,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  start().catch(err => { console.error('Falha ao iniciar:', err); process.exit(1); });
}
