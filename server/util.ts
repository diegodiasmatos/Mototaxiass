import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function dataDir(): string {
  const d = process.env.DATA_DIR || path.join(ROOT, 'data');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Carrega .env simples (KEY=VALUE) sem sobrescrever variáveis já definidas. */
export function loadEnv(file = path.join(ROOT, '.env')): void {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* .env é opcional */ }
}

let _secret: string | null = null;
export function secret(): string {
  if (_secret) return _secret;
  if (process.env.SESSION_SECRET) { _secret = process.env.SESSION_SECRET; return _secret; }
  const f = path.join(dataDir(), '.secret');
  try { _secret = fs.readFileSync(f, 'utf8').trim(); }
  catch {
    _secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, _secret, { mode: 0o600 });
  }
  return _secret!;
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString('hex')}`;
}
export function now(): number { return Date.now(); }

// ---------- senhas (scrypt) ----------
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  try {
    const [alg, saltHex, hashHex] = stored.split('$');
    if (alg !== 'scrypt') return false;
    const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  } catch { return false; }
}

// ---------- assinatura HMAC (links temporários de documentos) ----------
export function sign(data: string): string {
  return crypto.createHmac('sha256', secret()).update(data).digest('hex').slice(0, 40);
}
export function signedDocUrl(docId: string, ttlMs = 10 * 60 * 1000): string {
  const e = now() + ttlMs;
  return `/files/doc/${docId}?e=${e}&s=${sign(`${docId}.${e}`)}`;
}
export function verifySignedDoc(docId: string, e: string, s: string): boolean {
  const exp = Number(e);
  if (!Number.isFinite(exp) || exp < now()) return false;
  const expect = sign(`${docId}.${exp}`);
  return s.length === expect.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expect));
}

// ---------- HTTP helpers ----------
export function json(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function readBody(req: IncomingMessage, limit = 30 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ApiError(413, 'Corpo da requisição muito grande.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'JSON inválido.'); }
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSessionCookie(res: ServerResponse, token: string, maxAgeS = 30 * 24 * 3600): void {
  res.setHeader('Set-Cookie',
    `amt_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}`);
}
export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', 'amt_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

// ---------- geodésia ----------
/** Distância em metros entre dois pontos (haversine). */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000, toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- validações ----------
export function isValidEmail(s: unknown): s is string {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 160;
}
export function isValidCpf(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  const d = s.replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}
export function reqStr(v: unknown, field: string, max = 300): string {
  if (typeof v !== 'string' || !v.trim()) throw new ApiError(400, `Campo obrigatório: ${field}.`);
  if (v.length > max) throw new ApiError(400, `Campo ${field} muito longo.`);
  return v.trim();
}
export function reqNum(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ApiError(400, `Campo numérico inválido: ${field}.`);
  return n;
}

// ---------- rate limiting simples (em memória) ----------
const buckets = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const t = now();
  const b = buckets.get(key);
  if (!b || b.resetAt < t) { buckets.set(key, { count: 1, resetAt: t + windowMs }); return true; }
  b.count++;
  return b.count <= max;
}

export function fmtCents(c: number): string {
  return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
