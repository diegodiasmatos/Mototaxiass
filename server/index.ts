import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ROOT, loadEnv, json, parseCookies, ApiError, verifySignedDoc,
  hashPassword, id, now,
} from './util.ts';
import { initDb, db } from './db.ts';
import { matchRoute, type Route, type Ctx } from './router.ts';
import { authRoutes, userFromToken } from './auth.ts';
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
};

function serveStatic(res: http.ServerResponse, urlPath: string): boolean {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  // páginas amigáveis
  if (rel === '/motorista' || rel === '/mototaxista') rel = '/motorista.html';
  if (rel === '/admin') rel = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return false; // path traversal
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file).toLowerCase();
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
  const ip = (req.socket.remoteAddress || '0.0.0.0').replace('::ffff:', '');

  try {
    // documentos privados assinados
    const docMatch = /^\/files\/doc\/([^/]+)$/.exec(pathname);
    if (docMatch && req.method === 'GET') { serveSignedDoc(res, docMatch[1], url.searchParams); return; }

    const user = userFromToken(parseCookies(req)['amt_session']);

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

export async function start(opts: StartOptions = {}): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  loadEnv();
  initDb(opts.dbPath);
  bootstrapAdmin();

  // confirma automaticamente as corridas cujo prazo de 5 s expirou (no servidor)
  startAutoConfirmSweeper();

  // limpeza periódica: sessões e cotações expiradas
  const cleanup = setInterval(() => {
    try {
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
      db.prepare('DELETE FROM ride_quotes WHERE expires_at < ? AND used = 0').run(now() - 86400_000);
    } catch { /* não crítico */ }
  }, 10 * 60_000);
  cleanup.unref();

  const server = http.createServer((req, res) => { void handle(req, res); });
  const port = opts.port ?? Number(process.env.PORT || 8780);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  const actual = (server.address() as any).port;
  if (!opts.quiet) {
    console.log(`\n🏍️  Assis MotoTáxi rodando em http://localhost:${actual}`);
    console.log(`   Passageiro:  http://localhost:${actual}/`);
    console.log(`   Mototaxista: http://localhost:${actual}/motorista`);
    console.log(`   Admin:       http://localhost:${actual}/admin`);
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
