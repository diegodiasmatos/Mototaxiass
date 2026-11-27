/**
 * Central de notificações: lista (paginada, com filtro), contador de não
 * lidas, marcar como lida (uma ou todas), excluir, preferências por categoria
 * e comunicados da central. Cada pessoa só vê e mexe nas próprias.
 */
import { db, audit } from './db.ts';
import { ApiError, json, now, readBody, reqStr, rateLimit } from './util.ts';
import { route, type Route } from './router.ts';
import { notify, prefFor, ackNotification } from './notify.ts';
import { CATEGORIES, kindInfo, type Category } from './notification-catalog.ts';

const PUBLIC_FIELDS = `id, kind, title, body, ride_id, read, read_at, created_at, category, priority, link`;

function shape(n: any): any {
  // notificações antigas (antes da v11) não tinham categoria gravada
  if (!n.category) { const k = kindInfo(n.kind); n.category = k.category; n.priority = n.priority || k.priority; }
  n.read = !!n.read;
  return n;
}

function unreadCount(userId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read = 0').get(userId) as any).c;
}

function categoriesFor(role: string): Category[] {
  return (Object.keys(CATEGORIES) as Category[]).filter(c => CATEGORIES[c].roles.includes(role as any));
}

export const notificationRoutes: Route[] = [

  /** Lista: mais novas primeiro. `before` pagina; `filter` = unread ou uma categoria; `since` pega só as novas. */
  route('GET /api/notifications', 'any', ({ res, user, query }) => {
    const limit = Math.min(Math.max(Number(query.get('limit')) || 30, 1), 100);
    const before = Number(query.get('before'));
    const since = Number(query.get('since'));
    const filter = query.get('filter') || '';
    const where = ['user_id = ?'];
    const args: any[] = [user!.id];
    if (Number.isFinite(before) && before > 0) { where.push('created_at < ?'); args.push(before); }
    if (Number.isFinite(since) && since > 0) { where.push('created_at > ?'); args.push(since); }
    if (filter === 'unread') where.push('read = 0');
    else if (filter && (CATEGORIES as any)[filter]) { where.push('category = ?'); args.push(filter); }
    const rows = db.prepare(`SELECT ${PUBLIC_FIELDS} FROM notifications WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, limit + 1) as any[];
    const has_more = rows.length > limit;
    json(res, 200, {
      notifications: rows.slice(0, limit).map(shape), has_more,
      unread: unreadCount(user!.id), server_time: now(),
    });
  }),

  route('GET /api/notifications/unread-count', 'any', ({ res, user }) => {
    json(res, 200, { unread: unreadCount(user!.id) });
  }),

  /** Marca todas como lidas (ou só as de uma categoria). */
  route('POST /api/notifications/read', 'any', async ({ req, res, user }) => {
    const b = await readBody(req);
    const cat = typeof b.category === 'string' && (CATEGORIES as any)[b.category] ? b.category : null;
    db.prepare(`UPDATE notifications SET read = 1, read_at = COALESCE(read_at, ?)
      WHERE user_id = ? AND read = 0 ${cat ? 'AND category = ?' : ''}`).run(now(), user!.id, ...(cat ? [cat] : []));
    json(res, 200, { ok: true, unread: unreadCount(user!.id) });
  }),

  route('POST /api/notifications/:id/read', 'any', ({ res, user, params }) => {
    const r = db.prepare(`UPDATE notifications SET read = 1, read_at = COALESCE(read_at, ?)
      WHERE id = ? AND user_id = ?`).run(now(), params.id, user!.id);
    if (!r.changes) throw new ApiError(404, 'Notificação não encontrada.');
    json(res, 200, { ok: true, unread: unreadCount(user!.id) });
  }),

  route('DELETE /api/notifications/:id', 'any', ({ res, user, params }) => {
    const r = db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(params.id, user!.id);
    if (!r.changes) throw new ApiError(404, 'Notificação não encontrada.');
    json(res, 200, { ok: true, unread: unreadCount(user!.id) });
  }),

  route('POST /api/notifications/:id/ack', 'any', ({ res, user, params }) => {
    ackNotification(user!.id, params.id);
    json(res, 200, { ok: true });
  }),

  /** Preferências do usuário, por categoria do perfil dele. */
  route('GET /api/notifications/prefs', 'any', ({ res, user }) => {
    const devices = (db.prepare('SELECT COUNT(*) c FROM push_subscriptions WHERE user_id = ?').get(user!.id) as any).c;
    json(res, 200, {
      categories: categoriesFor(user!.role).map(c => ({
        key: c, label: CATEGORIES[c].label, description: CATEGORIES[c].description,
        lock_inapp: !!CATEGORIES[c].lockInApp, lock_push: !!CATEGORIES[c].lockPush,
        ...prefFor(user!.id, c),
      })),
      push_devices: devices,
      channels: ['inapp', 'push'],   // e-mail: sem serviço de envio configurado
    });
  }),

  route('PUT /api/notifications/prefs', 'any', async ({ req, res, user }) => {
    if (!rateLimit(`prefs:${user!.id}`, 60, 60_000)) throw new ApiError(429, 'Aguarde um instante.');
    const b = await readBody(req);
    const cat = reqStr(b.category, 'categoria', 40) as Category;
    const info = CATEGORIES[cat];
    if (!info || !info.roles.includes(user!.role as any)) throw new ApiError(400, 'Categoria inválida.');
    const cur = prefFor(user!.id, cat);
    let inapp = typeof b.inapp === 'boolean' ? b.inapp : cur.inapp;
    let push = typeof b.push === 'boolean' ? b.push : cur.push;
    if (info.lockInApp && !inapp) throw new ApiError(400, `"${info.label}" é essencial e não pode ser desligada dentro do app.`);
    if (info.lockPush && !push) throw new ApiError(400, `"${info.label}" é um aviso de segurança e não pode ser desligado.`);
    if (!inapp) push = false;
    db.prepare(`INSERT INTO notification_prefs (user_id, category, inapp, push, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id, category) DO UPDATE SET inapp = excluded.inapp, push = excluded.push, updated_at = excluded.updated_at`)
      .run(user!.id, cat, inapp ? 1 : 0, push ? 1 : 0, now());
    json(res, 200, { ok: true, category: cat, ...prefFor(user!.id, cat) });
  }),

  /**
   * Comunicado da central (categoria "Novidades e promoções"). Só chega a quem
   * ATIVOU essa categoria (consentimento). Até 3 por dia.
   */
  route('POST /api/admin/announcements', 'admin', async ({ req, res, user }) => {
    const b = await readBody(req);
    const title = reqStr(b.title, 'título', 80);
    const body = reqStr(b.body, 'mensagem', 300);
    const audience = ['passenger', 'driver', 'all'].includes(b.audience) ? b.audience : null;
    if (!audience) throw new ApiError(400, 'Escolha o público: passageiros, mototaxistas ou todos.');
    if (!rateLimit(`announce:${user!.id}`, 3, 24 * 3600_000)) throw new ApiError(429, 'Limite de 3 comunicados por dia.');
    const roles = audience === 'all' ? ['passenger', 'driver'] : [audience];
    const users = db.prepare(`SELECT id FROM users WHERE blocked = 0 AND role IN (${roles.map(() => '?').join(',')})`)
      .all(...roles) as any[];
    const key = `announce:${now()}`;
    let sent = 0;
    for (const u of users) if (notify(u.id, 'announcement', title, { body, eventKey: key })) sent++;
    audit(user!.id, 'announcement', 'notifications', undefined, `${title} · público: ${audience} · ${sent} de ${users.length}`);
    json(res, 201, { ok: true, sent, audience_total: users.length });
  }),
];
