import type { ServerResponse } from 'node:http';
import { db } from './db.ts';
import { id, now } from './util.ts';

interface Client { res: ServerResponse; role: string }
const clients = new Map<string, Set<Client>>(); // userId -> conexões SSE

export function sseConnect(userId: string, role: string, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': conectado\n\n');
  const client: Client = { res, role };
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId)!.add(client);

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* fechada */ }
  }, 25000);

  res.on('close', () => {
    clearInterval(heartbeat);
    const set = clients.get(userId);
    if (set) { set.delete(client); if (set.size === 0) clients.delete(userId); }
  });
}

export function sseSend(userId: string, event: string, data: unknown): void {
  const set = clients.get(userId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of set) { try { c.res.write(payload); } catch { /* ignora */ } }
}

export function sseSendMany(userIds: string[], event: string, data: unknown): void {
  for (const uid of userIds) sseSend(uid, event, data);
}

export function connectedUserIds(): string[] { return [...clients.keys()]; }

/** Cria notificação persistente e envia por SSE. */
export function notify(userId: string, kind: string, title: string,
  body?: string, rideId?: string): void {
  const nid = id('ntf');
  db.prepare(`INSERT INTO notifications (id, user_id, kind, title, body, ride_id, read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
    .run(nid, userId, kind, title, body ?? null, rideId ?? null, now());
  sseSend(userId, 'notification', { id: nid, kind, title, body, ride_id: rideId, created_at: now() });
}

export function notifyAdmins(kind: string, title: string, body?: string, rideId?: string): void {
  const admins = db.prepare(`SELECT id FROM users WHERE role = 'admin' AND blocked = 0`).all() as any[];
  for (const a of admins) notify(a.id, kind, title, body, rideId);
}
