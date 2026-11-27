import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ROOT, loadEnv, json, parseCookies, ApiError, verifySignedDoc,
  hashPassword, id, now, clientIp,
} from './util.ts';
import { initDb, db } from './db.ts';
import { matchRoute, type Route, type Ctx } from './router.ts';
import { authRoutes, userFromToken } from './auth.ts';
import { rideRoutes, startAutoConfirmSweeper, startRideDeadlineSweeper } from './rides.ts';
import { driverRoutes } from './drivers.ts';
import { adminRoutes } from './admin.ts';
import { integrationRoutes } from './integrations.ts';
import { accountRoutes, assetLinks } from './account.ts';
import { notificationRoutes } from './notification-routes.ts';
import { locationRoutes } from './location-routes.ts';
import { walletRoutes } from './wallet.ts';
import { startMaintenance } from './maintenance.ts';
import { sseConnect } from './notify.ts';
import { appVersion, injectSwVersion, injectHtmlVersion } from './version.ts';

const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

// ================= cabeçalhos de segurança =================

/**
 * Política de conteúdo completa: só a própria origem e os serviços que o app
 * usa (Leaflet servido pelo próprio app, blocos do OpenStreetMap, Mapbox,
 * Google Maps e o login do Google). Scripts embutidos entram pelo hash.
 * Em produção vai como "Report-Only" (só avisa no console) até ser conferida
 * com o Mapbox no domínio real; CSP_ENFORCE=1 passa a bloquear.
 */
let _inlineHashes: string[] | null = null;
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
function fullCsp(): string {
  const g = ['https://*.googleapis.com', 'https://*.gstatic.com'];
  const d: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", ...inlineScriptHashes(), 'https://api.mapbox.com', ...g, 'https://accounts.google.com/gsi/client'],
    'style-src': ["'self'", "'unsafe-inline'", 'https://api.mapbox.com', 'https://fonts.googleapis.com', 'https://accounts.google.com/gsi/style'],
    'img-src': ["'self'", 'data:', 'blob:', 'https://tile.openstreetmap.org', 'https://*.tile.openstreetmap.org',
      'https://api.mapbox.com', ...g, 'https://*.google.com', 'https://*.googleusercontent.com', 'https://*.ggpht.com'],
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
    'connect-src': ["'self'", 'https://api.mapbox.com', 'https://events.mapbox.com', ...g, 'https://*.google.com', 'https://accounts.google.com'],
    'worker-src': ["'self'", 'blob:'],
    'child-src': ["'self'", 'blob:'],
    'frame-src': ['https://accounts.google.com'],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(d).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}
/** Parte que não quebra nada e vale sempre: ninguém abre o app dentro de outro site. */
const BASE_CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";

function securityHeaders(res: http.ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=(), payment=(), usb=()');
  if (process.env.APP_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function serveStatic(res: http.ServerResponse, urlPath: string): boolean {
  let rel = urlPath;
  // páginas amigáveis
  if (rel === '/' || rel === '/visao-geral') rel = '/visao-geral.html';
  if (rel === '/passageiro') rel = '/index.html';
  if (rel === '/motorista' || rel === '/mototaxista') rel = '/motorista.html';
  if (rel === '/empresa') rel = '/empresa.html';
  if (rel === '/admin') rel = '/admin.html';
  if (rel === '/termos') rel = '/termos.html';
  if (rel === '/privacidade') rel = '/privacidade.html';
  if (rel === '/redefinir-senha') rel = '/redefinir-senha.html';
  if (rel === '/excluir-conta') rel = '/excluir-conta.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return false; // path traversal
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  let body: Buffer | string = fs.readFileSync(file);
  // a versão do app vai dentro do sw.js e de cada página (ver server/version.ts)
  if (rel === '/sw.js') body = injectSwVersion(body.toString('utf8'), appVersion(PUBLIC_DIR));
  else if (ext === '.html') body = injectHtmlVersion(body.toString('utf8'), appVersion(PUBLIC_DIR));
  if (ext === '.html') {
    if (process.env.CSP_ENFORCE === '1') res.setHeader('Content-Security-Policy', fullCsp());
    else {
      res.setHeader('Content-Security-Policy', BASE_CSP);
      res.setHeader('Content-Security-Policy-Report-Only', fullCsp());
    }
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    // HTML e sw.js: o navegador sempre confere com o servidor antes de usar
    'Cache-Control': rel === '/sw.js' || ext === '.html' ? 'no-cache, must-revalidate' : 'no-cache',
  });
  res.end(body);
  return true;
}

/** A requisição veio de uma página de outro site? (Sec-Fetch-Site ou Origin diferente do host) */
export function isCrossSite(req: http.IncomingMessage): boolean {
  const sfs = String(req.headers['sec-fetch-site'] || '');
  if (sfs === 'cross-site') return true;
  const origin = String(req.headers.origin || '');
  if (!origin || origin === 'null') return origin === 'null';
  try {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
    return new URL(origin).host !== host;
  } catch { return true; }
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
  // sandbox: mesmo um arquivo malicioso não roda script na origem do app
  res.writeHead(200, {
    'Content-Type': doc.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'",
    'Content-Disposition': 'inline',
  });
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
  ...authRoutes, ...accountRoutes, ...notificationRoutes, ...locationRoutes, ...walletRoutes, ...rideRoutes, ...driverRoutes, ...adminRoutes, ...integrationRoutes,
];

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;
  const ip = clientIp(req);

  securityHeaders(res);
  try {
    // documentos privados assinados
    const docMatch = /^\/files\/doc\/([^/]+)$/.exec(pathname);
    if (docMatch && req.method === 'GET') { serveSignedDoc(res, docMatch[1], url.searchParams); return; }

    const user = userFromToken(parseCookies(req)['amt_session']);

    // Digital Asset Links: prova para o Android que o app da Play Store
    // (pacote + impressão digital da chave) pertence a este site. Sem isso o
    // app abre com a barra de endereço do navegador.
    if (pathname === '/.well-known/assetlinks.json' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      res.end(JSON.stringify(assetLinks()));
      return;
    }

    // saúde do serviço para monitores externos (UptimeRobot, Better Stack etc.):
    // 200 quando o banco responde, 503 quando não. Sem dados pessoais.
    if (pathname === '/api/health' && req.method === 'GET') {
      let dbOk = false;
      try { dbOk = (db.prepare('SELECT 1 AS ok').get() as any)?.ok === 1; } catch { /* banco fora */ }
      res.writeHead(dbOk ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: dbOk, version: appVersion(PUBLIC_DIR), time: new Date().toISOString() }));
      return;
    }

    // versão publicada do app: a página aberta compara com a dela (sem login)
    if (pathname === '/api/version' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ version: appVersion(PUBLIC_DIR) }));
      return;
    }

    // SSE — tempo real
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!user) { json(res, 401, { error: 'Faça login para continuar.' }); return; }
      sseConnect(user.id, user.role, res);
      return;
    }

    // Proteção extra contra CSRF (além do cookie SameSite=Lax): ação vinda de
    // OUTRO site é recusada. Integrações servidor→servidor (webhooks) não
    // mandam Origin e seguem normalmente.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method || 'GET') && pathname.startsWith('/api/')
        && isCrossSite(req)) {
      json(res, 403, { error: 'Requisição de outro site recusada.' });
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
    // vê a Visão Geral do app.
    if (req.method === 'GET' && pathname === '/' && user) {
      if (user.role === 'passenger') { serveStatic(res, '/passageiro'); return; }
      res.writeHead(302, { Location: user.role === 'admin' ? '/admin' : '/motorista' });
      res.end();
      return;
    }

    if (req.method === 'GET' && serveStatic(res, pathname)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — página não encontrada');
  } catch (err: any) {
    if (err instanceof ApiError) {
      json(res, err.status, { error: err.message });
    } else {
      console.error(`[erro] ${req.method} ${pathname}:`, err);
      json(res, 500, { error: 'Erro interno. Tente novamente.' });
    }
  }
}

export interface StartOptions { port?: number; dbPath?: string; quiet?: boolean }

/**
 * Rede de segurança do processo. Uma promessa rejeitada sem tratamento (ex.:
 * falha de rede ao enviar um push) encerraria o Node inteiro — o app saía do
 * ar para todo mundo. Agora o erro é registrado e o servidor continua.
 * Exceção síncrona não tratada deixa o processo num estado incerto: registra
 * e sai com erro, para a plataforma (Fly.io: restart "always") reiniciar.
 */
let _guardsInstalled = false;
function installProcessGuards(): void {
  if (_guardsInstalled) return;
  _guardsInstalled = true;
  process.on('unhandledRejection', (reason: any) => {
    console.error(`[erro não tratado] ${reason?.name || 'Error'}: ${String(reason?.message || reason).slice(0, 300)}`
      + (reason?.stack ? `\n${String(reason.stack).split('\n').slice(1, 6).join('\n')}` : ''));
    void import('./notify-events.ts').then(m => m.alertSystemError(`Erro não tratado (${reason?.name || 'Error'})`)).catch(() => {});
  });
  process.on('uncaughtException', (err: any) => {
    console.error(`[falha grave] ${err?.name || 'Error'}: ${String(err?.message || err).slice(0, 300)}`
      + (err?.stack ? `\n${String(err.stack).split('\n').slice(1, 6).join('\n')}` : ''));
    process.exit(1);
  });
}

export async function start(opts: StartOptions = {}): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  installProcessGuards();
  loadEnv();
  initDb(opts.dbPath);
  bootstrapAdmin();

  // confirma automaticamente as corridas cujo prazo de 5 s expirou (no servidor)
  startAutoConfirmSweeper();
  // corridas sem pagamento ou sem aceite não ficam paradas para sempre
  startRideDeadlineSweeper();

  // base de endereços baixada num formato antigo: baixa de novo, em segundo
  // plano, sem atrasar a subida (não roda nos testes / modo sem rede)
  const baseReady: Promise<unknown> = process.env.GEO_OFFLINE !== '1'
    ? import('./address-base.ts').then(m => m.refreshOutdatedBase()).catch(() => { })
    : Promise.resolve();

  // endereços oficiais (IBGE) e locais conferidos da pasta seed/: importados
  // UMA vez no app publicado, depois da base do OpenStreetMap
  import('./seed.ts').then(m => {
    if (!m.seedImportsEnabled()) return;
    return baseReady.then(() => m.runSeedImports());
  }).catch(e => console.error(`[importação automática] ${e?.message || e}`));

  // manutenção: sessões e cotações vencidas, cópia diária do banco e prazos
  // de guarda (desligados até a central definir)
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
