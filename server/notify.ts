import type { ServerResponse } from 'node:http';
import { db } from './db.ts';
import { id, now } from './util.ts';
import { pushToUser } from './push.ts';
import { kindInfo, ADMIN_KIND_ALIAS, CATEGORIES, type Category } from './notification-catalog.ts';

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
  /** url aberta ao tocar na notificação do sistema (padrão: a tela certa pelo tipo) */
  url?: string;
  /**
   * Chave do evento: a mesma chave para o mesmo usuário nunca gera duas
   * notificações (idempotência). Ex.: `approach:<corrida>`.
   */
  eventKey?: string;
}

/** Tela do app que a notificação abre, por categoria e perfil. */
function linkFor(role: string, category: Category, rideId?: string): string {
  if (role === 'admin') {
    const sec: Record<string, string> = {
      admin_cadastros: 'drivers', admin_ocorrencias: 'issues', admin_pagamentos: 'finance',
      admin_suporte: 'support', admin_seguranca: 'issues', admin_sistema: 'dashboard',
    };
    return `/admin#${sec[category] || 'dashboard'}`;
  }
  const page = role === 'driver' ? '/motorista' : '/passageiro';
  const hash: Record<string, string> = {
    corrida: rideId ? 'corrida' : 'corridas', pagamento: 'corrida', financeiro: 'ganhos',
    cadastro: 'cadastro', suporte: 'suporte', conta: 'perfil', novidades: 'notificacoes',
  };
  return `${page}#${hash[category] || 'notificacoes'}`;
}

/** Preferência do usuário para a categoria (com as travas das críticas). */
export function prefFor(userId: string, category: Category): { inapp: boolean; push: boolean } {
  const info = CATEGORIES[category];
  const row = db.prepare('SELECT inapp, push FROM notification_prefs WHERE user_id = ? AND category = ?')
    .get(userId, category) as any;
  const def = !info?.defaultOff;
  let inapp = row ? !!row.inapp : def;
  let push = row ? !!row.push : def;
  if (info?.lockInApp) inapp = true;
  if (info?.lockPush) push = true;
  if (!inapp) push = false;
  return { inapp, push };
}

/**
 * Cria a notificação (persistente), entrega por SSE e, quando o usuário não
 * está com a tela aberta, dispara Web Push. O histórico fica no banco, então
 * nada se perde se o aparelho estiver offline — a tela recupera no reconectar.
 *
 * Respeita as preferências por categoria (as críticas não desligam), não
 * duplica com a mesma `eventKey` e nunca manda endereço, valor ou conteúdo
 * de mensagem para a tela bloqueada (texto do push vem do catálogo).
 * Devolve o id da notificação, ou '' quando a pessoa desligou a categoria.
 */
export function notify(userId: string, kind: string, title: string,
  bodyOrOpts?: string | NotifyOptions, rideIdLegacy?: string): string {
  const opts: NotifyOptions = typeof bodyOrOpts === 'string' || bodyOrOpts === undefined
    ? { body: bodyOrOpts, rideId: rideIdLegacy }
    : bodyOrOpts;
  const u = db.prepare('SELECT role, blocked FROM users WHERE id = ?').get(userId) as any;
  if (!u) return '';
  const k = u.role === 'admin' && ADMIN_KIND_ALIAS[kind] ? ADMIN_KIND_ALIAS[kind] : kind;
  const info = kindInfo(k);
  const pref = prefFor(userId, info.category);
  if (!pref.inapp) return '';

  if (opts.eventKey) {
    const dup = db.prepare('SELECT id FROM notifications WHERE user_id = ? AND event_key = ?')
      .get(userId, opts.eventKey) as any;
    if (dup) return dup.id;
  }
  const nid = id('ntf');
  const t = now();
  const link = opts.url || linkFor(u.role, info.category, opts.rideId);
  try {
    db.prepare(`INSERT INTO notifications (id, user_id, kind, title, body, ride_id, read, created_at,
        category, priority, link, event_key)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
      .run(nid, userId, k, title, opts.body ?? null, opts.rideId ?? null, t,
        info.category, info.priority, link, opts.eventKey ?? null);
  } catch (e: any) {
    // corrida entre dois envios do mesmo evento: o índice único segura
    if (opts.eventKey && /UNIQUE/i.test(String(e?.message))) {
      return (db.prepare('SELECT id FROM notifications WHERE user_id = ? AND event_key = ?').get(userId, opts.eventKey) as any)?.id || '';
    }
    throw e;
  }

  const payload = {
    id: nid, kind: k, title, body: opts.body, ride_id: opts.rideId, created_at: t,
    category: info.category, priority: info.priority, link,
  };
  const liveDelivered = sseSend(userId, 'notification', payload);

  let status = 'nao_enviado';
  if (opts.push !== false && pref.push && !u.blocked) {
    // Push sempre para os de prioridade alta; para o resto, só sem a tela aberta.
    if (info.priority === 'alta' || !liveDelivered) {
      status = 'enviando';
      const lock = info.push || { title, body: info.bodySafe ? opts.body : 'Toque para ver os detalhes.' };
      void pushToUser(userId, {
        title: lock.title, body: lock.body, url: link, kind: k, rideId: opts.rideId, tag: opts.eventKey || k,
        urgency: info.priority === 'alta' ? 'high' : 'normal',
      }).then(sent => {
        db.prepare('UPDATE notifications SET pushed_at = ?, push_status = ? WHERE id = ?')
          .run(sent ? now() : null, sent ? 'enviado' : 'sem_aparelho', nid);
      }).catch(() => {
        db.prepare(`UPDATE notifications SET push_status = 'falhou' WHERE id = ?`).run(nid);
      });
    } else status = 'na_tela';
  } else if (opts.push !== false && !pref.push) status = 'desligado';
  // 'enviando' é trocado pelo resultado (enviado / sem_aparelho / falhou) quando o envio termina
  db.prepare('UPDATE notifications SET push_status = COALESCE(push_status, ?) WHERE id = ?').run(status, nid);
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
