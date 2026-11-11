import type { ServerResponse } from 'node:http';
import { db } from './db.ts';
import { id, now } from './util.ts';
import { pushToUser } from './push.ts';

interface Client { res: ServerResponse; role: string }
const clients = new Map<string, Set<Client>>(); // userId -> conexões SSE

export function sseConnect(userId: string, role: string, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // reconexão: o navegador espera 3s antes de tentar de novo
  res.write('retry: 3000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ at: now() })}\n\n`);

  const client: Client = { res, role };
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId)!.add(client);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* fechada */ }
  }, 25000);

  const close = () => {
    clearInterval(heartbeat);
    const set = clients.get(userId);
    if (set) { set.delete(client); if (set.size === 0) clients.delete(userId); }
  };
  res.on('close', close);
  res.on('error', close);
}

export function isOnline(userId: string): boolean {
  return (clients.get(userId)?.size ?? 0) > 0;
}

export function sseSend(userId: string, event: string, data: unknown): boolean {
  const set = clients.get(userId);
  if (!set || set.size === 0) return false;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let ok = false;
  for (const c of set) {
    try { c.res.write(payload); ok = true; } catch { /* ignora */ }
  }
  return ok;
}

export function sseSendMany(userIds: string[], event: string, data: unknown): number {
  let n = 0;
  for (const uid of userIds) if (sseSend(uid, event, data)) n++;
  return n;
}

export function connectedUserIds(): string[] { return [...clients.keys()]; }

export interface NotifyOptions {
  body?: string;
  rideId?: string;
  /** envia também push do sistema (app fechado). Padrão: true */
  push?: boolean;
  /** url aberta ao tocar na notificação do sistema */
  url?: string;
}

/**
 * Cria a notificação (persistente), entrega por SSE e, quando o usuário não
 * está com a tela aberta, dispara Web Push. O histórico fica no banco, então
 * nada se perde se o aparelho estiver offline — a tela recupera no reconectar.
 */
export function notify(userId: string, kind: string, title: string,
  bodyOrOpts?: string | NotifyOptions, rideIdLegacy?: string): string {
  const opts: NotifyOptions = typeof bodyOrOpts === 'string' || bodyOrOpts === undefined
    ? { body: bodyOrOpts, rideId: rideIdLegacy }
    : bodyOrOpts;

  const nid = id('ntf');
  const t = now();
  db.prepare(`INSERT INTO notifications (id, user_id, kind, title, body, ride_id, read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(nid, userId, kind, title, opts.body ?? null, opts.rideId ?? null, t);

  const payload = { id: nid, kind, title, body: opts.body, ride_id: opts.rideId, created_at: t };
  const liveDelivered = sseSend(userId, 'notification', payload);

  if (opts.push !== false) {
    // Push sempre para eventos críticos; para o resto, só se não estiver com a tela aberta.
    const critical = ['ride_offer', 'ride_accepted', 'driver_arrived', 'confirm_required',
      'ride_cancelled', 'payment_failed'].includes(kind);
    if (critical || !liveDelivered) {
      void pushToUser(userId, {
        title, body: opts.body, url: opts.url, kind, rideId: opts.rideId, tag: kind,
      }).then(sent => {
        if (sent) db.prepare('UPDATE notifications SET pushed_at = ? WHERE id = ?').run(now(), nid);
      }).catch(() => { /* push é melhor-esforço */ });
    }
  }
  return nid;
}

export function notifyAdmins(kind: string, title: string,
  bodyOrOpts?: string | NotifyOptions, rideIdLegacy?: string): void {
  const admins = db.prepare(`SELECT id FROM users WHERE role = 'admin' AND blocked = 0`).all() as any[];
  for (const a of admins) notify(a.id, kind, title, bodyOrOpts, rideIdLegacy);
}

/** Marca como entregue quando o cliente confirma o recebimento. */
export function ackNotification(userId: string, notificationId: string): void {
  db.prepare(`UPDATE notifications SET delivered_at = COALESCE(delivered_at, ?)
    WHERE id = ? AND user_id = ?`).run(now(), notificationId, userId);
}
