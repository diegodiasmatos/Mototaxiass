import { db, getSettingNum, getSetting, setSetting, audit } from './db.ts';
import { ApiError, id, now, json, readBody, reqStr, reqNum, signedDocUrl } from './util.ts';
import { route, type Route } from './router.ts';
import { getFare, allFares, computePriceCents, splitCommission } from './fares.ts';
import { eligibleDrivers } from './rides.ts';
import { notify } from './notify.ts';

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const adminRoutes: Route[] = [

  route('GET /api/admin/dashboard', 'admin', ({ res }) => {
    const c = (sql: string, ...args: any[]) => (db.prepare(sql).get(...args) as any);
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const fresh = now() - getSettingNum('loc_fresh_s') * 1000;

    const totals = {
      passengers: c(`SELECT COUNT(*) v FROM users WHERE role='passenger'`).v,
      drivers: c(`SELECT COUNT(*) v FROM drivers`).v,
      drivers_approved: c(`SELECT COUNT(*) v FROM drivers WHERE status='approved'`).v,
      drivers_pending: c(`SELECT COUNT(*) v FROM drivers WHERE status='pending'`).v,
      drivers_rejected: c(`SELECT COUNT(*) v FROM drivers WHERE status IN ('rejected','correction')`).v,
      drivers_online: c(`SELECT COUNT(*) v FROM drivers d JOIN users u ON u.id=d.user_id
        WHERE d.status='approved' AND d.online=1 AND u.blocked=0 AND d.last_loc_at > ?`, fresh).v,
      drivers_available: eligibleDrivers().length,
      drivers_on_ride: c(`SELECT COUNT(DISTINCT driver_id) v FROM rides
        WHERE status IN ('accepted','in_progress') AND driver_id IS NOT NULL`).v,
      rides_today: c(`SELECT COUNT(*) v FROM rides WHERE requested_at >= ?`, dayStart.getTime()).v,
      rides_active: c(`SELECT COUNT(*) v FROM rides WHERE status IN ('requested','accepted','in_progress')`).v,
      rides_completed: c(`SELECT COUNT(*) v FROM rides WHERE status='completed'`).v,
      rides_cancelled: c(`SELECT COUNT(*) v FROM rides WHERE status='cancelled'`).v,
      gross_cents: c(`SELECT COALESCE(SUM(price_cents),0) v FROM rides WHERE status='completed'`).v,
      commission_cents: c(`SELECT COALESCE(SUM(commission_cents),0) v FROM rides WHERE status='completed'`).v,
      drivers_cents: c(`SELECT COALESCE(SUM(driver_cents),0) v FROM rides WHERE status='completed'`).v,
    };

    // série dos últimos 14 dias
    const since = dayStart.getTime() - 13 * 86400_000;
    const rows = db.prepare(`SELECT requested_at, status, price_cents, commission_cents
      FROM rides WHERE requested_at >= ?`).all(since) as any[];
    const series: Record<string, { rides: number; completed: number; gross: number; commission: number }> = {};
    for (let i = 0; i < 14; i++) series[dayKey(since + i * 86400_000)] = { rides: 0, completed: 0, gross: 0, commission: 0 };
    for (const r of rows) {
      const k = dayKey(r.requested_at);
      if (!series[k]) continue;
      series[k].rides++;
      if (r.status === 'completed') {
        series[k].completed++;
        series[k].gross += r.price_cents;
        series[k].commission += r.commission_cents ?? 0;
      }
    }
    json(res, 200, { totals, series });
  }),

  // ---------- mototaxistas ----------
  route('GET /api/admin/drivers', 'admin', ({ res, query }) => {
    const status = query.get('status');
    const where = status ? 'WHERE d.status = ?' : '';
    const rows = db.prepare(`
      SELECT d.*, u.name, u.email, u.phone, u.cpf, u.blocked, u.blocked_reason, u.created_at
      FROM drivers d JOIN users u ON u.id = d.user_id ${where}
      ORDER BY d.submitted_at DESC LIMIT 200`)
      .all(...(status ? [status] : [])) as any[];
    json(res, 200, {
      drivers: rows.map(d => ({
        ...d,
        rating: d.rating_count ? Math.round(d.rating_sum / d.rating_count * 10) / 10 : null,
      })),
    });
  }),

  route('GET /api/admin/drivers/:id', 'admin', ({ res, params }) => {
    const d = db.prepare(`SELECT d.*, u.name, u.email, u.phone, u.cpf, u.photo, u.blocked,
      u.blocked_reason, u.created_at FROM drivers d JOIN users u ON u.id = d.user_id
      WHERE d.user_id = ?`).get(params.id) as any;
    if (!d) throw new ApiError(404, 'Mototaxista não encontrado.');
    const docs = db.prepare('SELECT id, kind, mime, size, uploaded_at FROM driver_documents WHERE driver_id = ?')
      .all(params.id) as any[];
    const rides = db.prepare(`SELECT id, status, origin_text, dest_text, price_cents, requested_at
      FROM rides WHERE driver_id = ? ORDER BY requested_at DESC LIMIT 20`).all(params.id);
    const ratings = db.prepare(`SELECT stars, comment, created_at FROM ratings
      WHERE driver_id = ? ORDER BY created_at DESC LIMIT 20`).all(params.id);
    json(res, 200, {
      driver: { ...d, rating: d.rating_count ? Math.round(d.rating_sum / d.rating_count * 10) / 10 : null },
      // links temporários assinados (10 min) — documentos nunca ficam públicos
      documents: docs.map(doc => ({ ...doc, url: signedDocUrl(doc.id) })),
      rides, ratings,
    });
  }),

  route('POST /api/admin/drivers/:id/review', 'admin', async ({ req, res, user, params }) => {
    const d = db.prepare('SELECT * FROM drivers WHERE user_id = ?').get(params.id) as any;
    if (!d) throw new ApiError(404, 'Mototaxista não encontrado.');
    const b = await readBody(req);
    const action = reqStr(b.action, 'ação', 20);
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 500) : '';
    const map: Record<string, string> = { approve: 'approved', reject: 'rejected', correction: 'correction' };
    const status = map[action];
    if (!status) throw new ApiError(400, 'Ação inválida (approve, reject ou correction).');
    if ((status === 'rejected' || status === 'correction') && !reason) {
      throw new ApiError(400, 'Informe o motivo para o candidato.');
    }
    db.prepare(`UPDATE drivers SET status = ?, reviewed_at = ?, reviewed_by = ?,
      review_reason = ?, online = 0 WHERE user_id = ?`)
      .run(status, now(), user!.id, reason || null, params.id);
    audit(user!.id, `driver_${action}`, 'driver', params.id, reason);

    const titles: Record<string, [string, string]> = {
      approved: ['Cadastro aprovado! 🎉', 'Você já pode ficar online e receber corridas.'],
      rejected: ['Cadastro não aprovado', `Motivo: ${reason}`],
      correction: ['Correção necessária no cadastro', `Reenvie seus documentos. Motivo: ${reason}`],
    };
    notify(params.id, `application_${status}`, titles[status][0], titles[status][1]);
    json(res, 200, { ok: true, status });
  }),

  // ---------- usuários (bloqueio) ----------
  route('POST /api/admin/users/:id/block', 'admin', async ({ req, res, user, params }) => {
    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(params.id) as any;
    if (!target) throw new ApiError(404, 'Usuário não encontrado.');
    if (target.role === 'admin') throw new ApiError(403, 'Não é possível bloquear administradores.');
    const b = await readBody(req);
    const blocked = b.blocked ? 1 : 0;
    const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 300) : '';
    if (blocked && !reason) throw new ApiError(400, 'Informe o motivo do bloqueio.');
    db.prepare('UPDATE users SET blocked = ?, blocked_reason = ? WHERE id = ?')
      .run(blocked, blocked ? reason : null, params.id);
    if (blocked) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(params.id);
      db.prepare('UPDATE drivers SET online = 0 WHERE user_id = ?').run(params.id);
    }
    audit(user!.id, blocked ? 'user_block' : 'user_unblock', 'user', params.id, reason);
    json(res, 200, { ok: true });
  }),

  route('GET /api/admin/passengers', 'admin', ({ res, query }) => {
    const q = (query.get('q') || '').trim();
    const rows = db.prepare(`SELECT u.id, u.name, u.email, u.phone, u.blocked, u.blocked_reason,
        u.created_at,
        (SELECT COUNT(*) FROM rides r WHERE r.passenger_id = u.id) rides_count,
        (SELECT COUNT(*) FROM rides r WHERE r.passenger_id = u.id AND r.status='cancelled'
          AND r.cancelled_by='passenger') cancels_count
      FROM users u WHERE u.role = 'passenger' ${q ? 'AND (u.name LIKE ? OR u.email LIKE ?)' : ''}
      ORDER BY u.created_at DESC LIMIT 200`)
      .all(...(q ? [`%${q}%`, `%${q}%`] : [])) as any[];
    json(res, 200, { passengers: rows });
  }),

  // ---------- corridas ----------
  route('GET /api/admin/rides', 'admin', ({ res, query }) => {
    const status = query.get('status');
    const where = status ? 'WHERE r.status = ?' : '';
    const rows = db.prepare(`SELECT r.*,
        p.name passenger_name, du.name driver_name
      FROM rides r
      JOIN users p ON p.id = r.passenger_id
      LEFT JOIN users du ON du.id = r.driver_id
      ${where} ORDER BY r.requested_at DESC LIMIT 200`)
      .all(...(status ? [status] : [])) as any[];
    json(res, 200, { rides: rows });
  }),

  route('GET /api/admin/rides/:id', 'admin', ({ res, params }) => {
    const r = db.prepare(`SELECT r.*, p.name passenger_name, p.email passenger_email,
        du.name driver_name FROM rides r
      JOIN users p ON p.id = r.passenger_id
      LEFT JOIN users du ON du.id = r.driver_id WHERE r.id = ?`).get(params.id) as any;
    if (!r) throw new ApiError(404, 'Corrida não encontrada.');
    const events = db.prepare('SELECT * FROM ride_events WHERE ride_id = ? ORDER BY at').all(params.id);
    const locations = db.prepare(`SELECT who, lat, lng, at FROM ride_locations
      WHERE ride_id = ? ORDER BY at DESC LIMIT 100`).all(params.id);
    const payment = db.prepare('SELECT * FROM payments WHERE ride_id = ?').get(params.id);
    json(res, 200, { ride: r, events, locations, payment });
  }),

  // ---------- configurações ----------
  route('GET /api/admin/settings', 'admin', ({ res }) => {
    const settings = Object.fromEntries(
      (db.prepare('SELECT key, value FROM app_settings').all() as any[]).map(r => [r.key, r.value]));
    json(res, 200, { settings, fares: allFares() });
  }),

  route('PUT /api/admin/settings', 'admin', async ({ req, res, user }) => {
    const b = await readBody(req);
    const EDITABLE = ['city_name', 'center_lat', 'center_lng', 'coverage_radius_km',
      'dispatch_radius_km', 'commission_pct', 'quote_ttl_min', 'loc_fresh_s',
      'welcome_message', 'review_sla_hours'];
    const changed: string[] = [];
    for (const k of EDITABLE) {
      if (b.settings?.[k] === undefined) continue;
      const v = String(b.settings[k]).slice(0, 500);
      if (['center_lat', 'center_lng', 'coverage_radius_km', 'dispatch_radius_km',
        'commission_pct', 'quote_ttl_min', 'loc_fresh_s', 'review_sla_hours'].includes(k)
        && !Number.isFinite(Number(v))) {
        throw new ApiError(400, `Valor numérico inválido em ${k}.`);
      }
      if (k === 'commission_pct') {
        const n = Number(v);
        if (n < 0 || n > 50) throw new ApiError(400, 'Comissão deve estar entre 0% e 50%.');
      }
      setSetting(k, v);
      changed.push(`${k}=${v}`);
    }
    // tarifas: alterações preservam histórico e NÃO afetam corridas já criadas
    if (Array.isArray(b.fares)) {
      for (const f of b.fares) {
        const cur = getFare(reqStr(f.category, 'categoria', 20));
        const base = Math.round(reqNum(f.base_cents, 'tarifa base'));
        const included = Math.round(reqNum(f.included_m, 'metros inclusos'));
        const perKm = Math.round(reqNum(f.per_km_cents, 'valor por km'));
        if (base < 0 || perKm < 0 || included < 0 || base > 100_000 || perKm > 100_000) {
          throw new ApiError(400, 'Valores de tarifa fora do intervalo permitido.');
        }
        if (base === cur.base_cents && included === cur.included_m && perKm === cur.per_km_cents) continue;
        db.prepare(`INSERT INTO fare_history (category, base_cents, included_m, per_km_cents, changed_by, changed_at)
          VALUES (?,?,?,?,?,?)`)
          .run(cur.category, cur.base_cents, cur.included_m, cur.per_km_cents, user!.id, now());
        db.prepare(`UPDATE fare_settings SET base_cents = ?, included_m = ?, per_km_cents = ?, updated_at = ?
          WHERE category = ?`).run(base, included, perKm, now(), cur.category);
        changed.push(`fare:${cur.category}`);
      }
    }
    if (changed.length) audit(user!.id, 'settings_update', 'settings', undefined, changed.join('; '));
    json(res, 200, { ok: true, changed });
  }),

  // ---------- calculadora ----------
  route('POST /api/admin/calc', 'admin', async ({ req, res }) => {
    const b = await readBody(req);
    const fare = getFare(reqStr(b.category, 'categoria', 20));
    const km = reqNum(b.distance_km, 'distância');
    if (km < 0 || km > 500) throw new ApiError(400, 'Distância inválida.');
    const price = computePriceCents(fare, Math.round(km * 1000));
    const split = splitCommission(price);
    json(res, 200, { price_cents: price, ...split });
  }),

  // ---------- auditoria ----------
  route('GET /api/admin/audit', 'admin', ({ res }) => {
    const rows = db.prepare(`SELECT a.*, u.name admin_name FROM admin_audit_logs a
      LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.created_at DESC LIMIT 200`).all();
    json(res, 200, { logs: rows });
  }),

  // ---------- suporte ----------
  route('GET /api/admin/support', 'admin', ({ res }) => {
    const rows = db.prepare(`SELECT s.*, u.name user_name, u.role user_role
      FROM support_messages s JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC LIMIT 100`).all();
    json(res, 200, { messages: rows });
  }),
  route('POST /api/admin/support/:id/reply', 'admin', async ({ req, res, user, params }) => {
    const msg = db.prepare('SELECT * FROM support_messages WHERE id = ?').get(params.id) as any;
    if (!msg) throw new ApiError(404, 'Mensagem não encontrada.');
    const b = await readBody(req);
    const body = reqStr(b.body, 'resposta', 2000);
    db.prepare(`INSERT INTO support_replies (id, message_id, admin_id, body, created_at)
      VALUES (?,?,?,?,?)`).run(id('rep'), params.id, user!.id, body, now());
    db.prepare(`UPDATE support_messages SET status = 'respondido' WHERE id = ?`).run(params.id);
    notify(msg.user_id, 'support_reply', 'Resposta do suporte', body.slice(0, 120));
    json(res, 201, { ok: true });
  }),
];
