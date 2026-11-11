/**
 * Web Push real (VAPID + aes128gcm), sem dependências externas.
 * RFC 8291 (encriptação) + RFC 8292 (VAPID) + RFC 8188 (aes128gcm).
 *
 * Permite que o mototaxista receba uma chamada de corrida mesmo com o
 * aplicativo fechado (Android/Chrome e iOS 16.4+ com o app instalado).
 * As chaves VAPID são geradas na primeira execução e guardadas em
 * `data/vapid.json` — não precisam de cadastro em nenhum serviço.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { dataDir, id, now } from './util.ts';

interface Vapid { publicKey: string; privateKey: string; jwk: crypto.JsonWebKey }
let _vapid: Vapid | null = null;

const b64url = (b: Buffer): string => b.toString('base64url');

export function vapid(): Vapid {
  if (_vapid) return _vapid;
  const file = path.join(dataDir(), 'vapid.json');
  try {
    _vapid = JSON.parse(fs.readFileSync(file, 'utf8'));
    return _vapid!;
  } catch { /* gera abaixo */ }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as crypto.JsonWebKey;
  const pub = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from(jwk.y!, 'base64url'),
  ]);
  _vapid = {
    publicKey: b64url(pub),
    privateKey: jwk.d!,
    jwk: { ...jwk },
  };
  fs.writeFileSync(file, JSON.stringify(_vapid), { mode: 0o600 });
  return _vapid;
}

export function vapidPublicKey(): string { return vapid().publicKey; }

/** JWT ES256 exigido pelo serviço de push (Google/Mozilla/Apple). */
function vapidJwt(audience: string): string {
  const v = vapid();
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(now() / 1000) + 12 * 3600,
    sub: process.env.PUSH_CONTACT || 'mailto:contato@assismototaxi.local',
  })));
  const key = crypto.createPrivateKey({ key: v.jwk as any, format: 'jwk' });
  const sig = crypto.sign(null, Buffer.from(`${header}.${payload}`), {
    key, dsaEncoding: 'ieee-p1363',   // r||s puro, não DER
  });
  return `${header}.${payload}.${b64url(sig)}`;
}

/** Criptografa o payload no formato aes128gcm (RFC 8291). */
function encryptPayload(p256dh: string, auth: string, plaintext: Buffer): Buffer {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const salt = crypto.randomBytes(16);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'), uaPublic, asPublic,
  ]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt,
    Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt,
    Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([plaintext, Buffer.from([0x02])]); // delimitador de registro final
  const encrypted = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);      // record size
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, encrypted]);
}

export interface PushSub {
  id: string; user_id: string; endpoint: string; p256dh: string; auth: string; failures: number;
}

export function saveSubscription(userId: string, sub: {
  endpoint: string; keys: { p256dh: string; auth: string };
}, userAgent?: string): void {
  db.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id, p256dh = excluded.p256dh,
      auth = excluded.auth, failures = 0`)
    .run(id('sub'), userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth,
      (userAgent || '').slice(0, 200), now());
}

export function removeSubscription(endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

/** Envia para todos os aparelhos do usuário. Remove inscrições mortas (404/410). */
export async function pushToUser(userId: string, data: {
  title: string; body?: string; url?: string; tag?: string; kind?: string; rideId?: string;
}): Promise<number> {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?')
    .all(userId) as any as PushSub[];
  if (!subs.length) return 0;

  const payload = Buffer.from(JSON.stringify(data));
  let sent = 0;
  await Promise.all(subs.map(async sub => {
    try {
      const url = new URL(sub.endpoint);
      const encrypted = encryptPayload(sub.p256dh, sub.auth, payload);
      const r = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `vapid t=${vapidJwt(url.origin)}, k=${vapidPublicKey()}`,
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          'TTL': '600',
          'Urgency': data.kind === 'ride_offer' ? 'high' : 'normal',
        },
        body: encrypted,
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 404 || r.status === 410) { removeSubscription(sub.endpoint); return; }
      if (!r.ok) {
        db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?').run(sub.id);
        return;
      }
      db.prepare('UPDATE push_subscriptions SET failures = 0, last_ok_at = ? WHERE id = ?')
        .run(now(), sub.id);
      sent++;
    } catch {
      db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?').run(sub.id);
    }
  }));
  return sent;
}
