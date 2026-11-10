import { db, getSettingNum, getSetting } from './db.ts';
import {
  ApiError, id, now, json, readBody, reqStr, reqNum, haversineM, rateLimit,
} from './util.ts';
import { route, type Route, type SessionUser } from './router.ts';
import { getFare, allFares, computePriceCents, splitCommission } from './fares.ts';
import { route as osrmRoute, searchAddress, reverseGeocode, assertInCoverage } from './geo.ts';
import { notify, notifyAdmins, sseSend, sseSendMany } from './notify.ts';

// ---------------------------------------------------------------
// Helpers compartilhados (também usados pelo módulo do mototaxista)
// ---------------------------------------------------------------

export function etaSeconds(distanceM: number): number {
  return Math.round(distanceM / (25000 / 3600)); // ~25 km/h urbano
}

export interface EligibleDriver { user_id: string; lat: number; lng: number; dist_m: number }

/** Mototaxistas aptos a receber corridas agora (aprovados, online, loc recente, livres). */
export function eligibleDrivers(originLat?: number, originLng?: number): EligibleDriver[] {
  const fresh = now() - getSettingNum('loc_fresh_s') * 1000;
  const rows = db.prepare(`
    SELECT d.user_id, d.last_lat lat, d.last_lng lng
    FROM drivers d JOIN users u ON u.id = d.user_id
    WHERE d.status = 'approved' AND d.online = 1 AND u.blocked = 0
      AND d.last_loc_at IS NOT NULL AND d.last_loc_at > ?
      AND d.user_id NOT IN (
        SELECT driver_id FROM rides
        WHERE driver_id IS NOT NULL AND status IN ('accepted','in_progress'))
  `).all(fresh) as any[];
  const radius = getSettingNum('dispatch_radius_km') * 1000;
  return rows
    .map(r => ({
      ...r,
      dist_m: originLat !== undefined
        ? Math.round(haversineM(originLat, originLng!, r.lat, r.lng)) : 0,
    }))
    .filter(r => originLat === undefined || r.dist_m <= radius)
    .sort((a, b) => a.dist_m - b.dist_m);
}

export function getRide(rideId: string): any {
  const r = db.prepare('SELECT * FROM rides WHERE id = ?').get(rideId) as any;
  if (!r) throw new ApiError(404, 'Corrida não encontrada.');
  return r;
}

export function rideEvent(rideId: string, type: string, actorId?: string, details?: string): void {
  db.prepare('INSERT INTO ride_events (ride_id, type, actor_id, details, at) VALUES (?, ?, ?, ?, ?)')
    .run(rideId, type, actorId ?? null, details ?? null, now());
}

function driverCard(driverId: string): any {
  const d = db.prepare(`
    SELECT u.name, u.photo, d.moto_brand, d.moto_model, d.moto_color, d.moto_plate,
           d.rating_sum, d.rating_count, d.rides_count, d.last_lat, d.last_lng, d.last_loc_at
    FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.user_id = ?`).get(driverId) as any;
  if (!d) return null;
  return {
    name: d.name, photo: d.photo,
    moto: { brand: d.moto_brand, model: d.moto_model, color: d.moto_color, plate: d.moto_plate },
    rating: d.rating_count ? Math.round(d.rating_sum / d.rating_count * 10) / 10 : null,
    rides_count: d.rides_count,
    last_lat: d.last_lat, last_lng: d.last_lng, last_loc_at: d.last_loc_at,
  };
}

/** Visão da corrida para o passageiro (inclui cartão do mototaxista e ETA). */
export function rideViewForPassenger(r: any): any {
  let driver = null, eta_s = null;
  if (r.driver_id) {
    driver = driverCard(r.driver_id);
    if (driver?.last_lat != null) {
      const target = r.status === 'in_progress'
        ? { lat: r.dest_lat, lng: r.dest_lng } : { lat: r.origin_lat, lng: r.origin_lng };
      eta_s = etaSeconds(haversineM(driver.last_lat, driver.last_lng, target.lat, target.lng) * 1.3);
    }
  }
  const rated = db.prepare('SELECT stars FROM ratings WHERE ride_id = ?').get(r.id) as any;
  return {
    id: r.id, status: r.status, category: r.category,
    origin: { text: r.origin_text, lat: r.origin_lat, lng: r.origin_lng },
    dest: { text: r.dest_text, lat: r.dest_lat, lng: r.dest_lng },
    distance_m: r.distance_m, duration_s: r.duration_s, price_cents: r.price_cents,
    payment_method: r.payment_method, payment_status: r.payment_status,
    route_geojson: r.route_geojson ? JSON.parse(r.route_geojson) : null,
    requested_at: r.requested_at, accepted_at: r.accepted_at, arrived_at: r.arrived_at,
    started_at: r.started_at, completed_at: r.completed_at,
    cancelled_at: r.cancelled_at, cancelled_by: r.cancelled_by, cancel_reason: r.cancel_reason,
    driver, eta_s, rated: rated ? rated.stars : null,
  };
}

/** Despacha a corrida por SSE aos mototaxistas elegíveis. Prioridade é avisada primeiro. */
export function dispatchRide(ride: any): number {
  const eligible = eligibleDrivers(ride.origin_lat, ride.origin_lng);
  const offer = {
    id: ride.id, category: ride.category,
    origin_text: ride.origin_text, dest_text: ride.dest_text,
    origin_lat: ride.origin_lat, origin_lng: ride.origin_lng,
    distance_m: ride.distance_m, price_cents: ride.price_cents,
    driver_cents: splitCommission(ride.price_cents, ride.commission_pct).driver_cents,
    requested_at: ride.requested_at,
  };
  if (ride.category === 'prioridade') {
    // Prioridade de despacho: os 3 mais próximos recebem imediatamente,
    // os demais após 8s, se a corrida ainda estiver aberta.
    const first = eligible.slice(0, 3), rest = eligible.slice(3);
    sseSendMany(first.map(d => d.user_id), 'ride_offer', offer);
    if (rest.length) {
      setTimeout(() => {
        const still = db.prepare(`SELECT status FROM rides WHERE id = ?`).get(ride.id) as any;
        if (still?.status === 'requested') {
          sseSendMany(rest.map(d => d.user_id), 'ride_offer', offer);
        }
      }, 8000);
    }
  } else {
    sseSendMany(eligible.map(d => d.user_id), 'ride_offer', offer);
  }
  return eligible.length;
}

export function assertCanTransition(from: string, to: string): void {
  const allowed: Record<string, string[]> = {
    requested: ['accepted', 'cancelled'],
    accepted: ['in_progress', 'cancelled', 'requested'], // requested = re-despacho após desistência
    in_progress: ['completed', 'cancelled'],
    completed: [],
    cancelled: [],
  };
  if (!allowed[from]?.includes(to)) {
    throw new ApiError(409, `Transição de estado inválida: ${from} → ${to}.`);
  }
}

export function cancelRide(r: any, user: SessionUser, reason: string): void {
  assertCanTransition(r.status, 'cancelled');
  const states = (user.role === 'driver'
    ? getSetting('driver_cancel_states') : getSetting('passenger_cancel_states'))
    .split(',').map(s => s.trim());
  if (!states.includes(r.status)) {
    throw new ApiError(409, `Não é possível cancelar uma corrida em estado "${r.status}".`);
  }
  const result = db.prepare(`
    UPDATE rides SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?,
      cancel_reason = ?, cancel_prev_status = ?
    WHERE id = ? AND status = ?`)
    .run(now(), user.role, reason, r.status, r.id, r.status);
  if (result.changes !== 1) throw new ApiError(409, 'A corrida mudou de estado. Atualize a tela.');
  db.prepare(`UPDATE payments SET status = 'cancelado', updated_at = ? WHERE ride_id = ?`)
    .run(now(), r.id);
  rideEvent(r.id, 'cancelled', user.id, `por ${user.role}: ${reason}`);

  if (user.role === 'passenger' && r.driver_id) {
    notify(r.driver_id, 'ride_cancelled', 'Corrida cancelada pelo passageiro', r.origin_text, r.id);
  }
  if (user.role === 'driver') {
    notify(r.passenger_id, 'ride_cancelled', 'O mototaxista cancelou a corrida',
      'Você pode solicitar uma nova corrida.', r.id);
  }
  sseSend(r.passenger_id, 'ride_update', { id: r.id });
  if (r.driver_id) sseSend(r.driver_id, 'ride_update', { id: r.id });
  notifyAdmins('ride_cancelled', 'Corrida cancelada',
    `${r.origin_text} → ${r.dest_text} (por ${user.role}: ${reason})`, r.id);
}

// ---------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------

export const rideRoutes: Route[] = [

  route('GET /api/public/stats', null, ({ res }) => {
    const drivers = eligibleDrivers();
    json(res, 200, {
      online_drivers: drivers.length,
      // posições aproximadas (~110 m) apenas para ambientação do mapa — sem identidade
      markers: drivers.slice(0, 30).map(d => ({
        lat: Math.round(d.lat * 1000) / 1000,
        lng: Math.round(d.lng * 1000) / 1000,
      })),
    });
  }),

  route('GET /api/public/fares', null, ({ res }) => {
    json(res, 200, { fares: allFares(), commission_pct: getSettingNum('commission_pct') });
  }),

  route('GET /api/geo/search', 'any', async ({ res, query, ip }) => {
    if (!rateLimit(`geo:${ip}`, 60, 60_000)) throw new ApiError(429, 'Aguarde um instante.');
    const q = (query.get('q') || '').trim();
    if (q.length < 2) { json(res, 200, { results: [] }); return; }
    json(res, 200, { results: await searchAddress(q) });
  }),

  route('GET /api/geo/reverse', 'any', async ({ res, query }) => {
    const lat = reqNum(query.get('lat'), 'lat'), lng = reqNum(query.get('lng'), 'lng');
    json(res, 200, { text: await reverseGeocode(lat, lng) });
  }),

  // Orçamento: calcula rota real e preço NO SERVIDOR, salva uma cotação por categoria.
  route('POST /api/quotes', 'passenger', async ({ req, res, user }) => {
    const b = await readBody(req);
    const origin = {
      lat: reqNum(b.origin?.lat, 'origem.lat'), lng: reqNum(b.origin?.lng, 'origem.lng'),
      text: reqStr(b.origin?.text, 'origem', 300),
    };
    const dest = {
      lat: reqNum(b.dest?.lat, 'destino.lat'), lng: reqNum(b.dest?.lng, 'destino.lng'),
      text: reqStr(b.dest?.text, 'destino', 300),
    };
    assertInCoverage(origin, 'embarque');
    assertInCoverage(dest, 'destino');
    if (haversineM(origin.lat, origin.lng, dest.lat, dest.lng) < 80) {
      throw new ApiError(422, 'Origem e destino são praticamente o mesmo ponto.');
    }

    const rt = await osrmRoute(origin, dest);
    const ttl = getSettingNum('quote_ttl_min') * 60_000;
    const t = now();
    const quotes = allFares().map(fare => {
      const price = computePriceCents(fare, rt.distance_m);
      const qid = id('qte');
      db.prepare(`INSERT INTO ride_quotes
        (id, user_id, category, origin_text, origin_lat, origin_lng, dest_text, dest_lat, dest_lng,
         distance_m, duration_s, price_cents, base_cents, included_m, per_km_cents,
         route_geojson, route_estimated, created_at, expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(qid, user!.id, fare.category, origin.text, origin.lat, origin.lng,
          dest.text, dest.lat, dest.lng, rt.distance_m, rt.duration_s, price,
          fare.base_cents, fare.included_m, fare.per_km_cents,
          JSON.stringify(rt.geometry), rt.estimated ? 1 : 0, t, t + ttl);
      return {
        id: qid, category: fare.category, label: fare.label,
        price_cents: price, distance_m: rt.distance_m, duration_s: rt.duration_s,
        expires_at: t + ttl,
      };
    });
    json(res, 200, {
      quotes,
      route: { geometry: rt.geometry, estimated: rt.estimated },
      online_drivers: eligibleDrivers(origin.lat, origin.lng).length,
    });
  }),

  // Criação da corrida: SEMPRE a partir de uma cotação do próprio usuário,
  // com preço reconferido contra a tarifa gravada na cotação.
  route('POST /api/rides', 'passenger', async ({ req, res, user }) => {
    const b = await readBody(req);
    const quoteId = reqStr(b.quote_id, 'cotação', 60);
    const method = ['dinheiro', 'pix', 'cartao'].includes(b.payment_method)
      ? b.payment_method : 'dinheiro';

    const active = db.prepare(`SELECT id FROM rides WHERE passenger_id = ?
      AND status IN ('requested','accepted','in_progress')`).get(user!.id) as any;
    if (active) throw new ApiError(409, 'Você já tem uma corrida em andamento.');

    const q = db.prepare('SELECT * FROM ride_quotes WHERE id = ?').get(quoteId) as any;
    if (!q || q.user_id !== user!.id) throw new ApiError(404, 'Cotação não encontrada.');
    if (q.used) throw new ApiError(409, 'Esta cotação já foi utilizada.');
    if (q.expires_at < now()) throw new ApiError(410, 'Cotação expirada. Calcule novamente.');

    // Reconfere o preço no servidor a partir dos dados persistidos da cotação.
    const expected = computePriceCents(
      { category: q.category, label: '', base_cents: q.base_cents,
        included_m: q.included_m, per_km_cents: q.per_km_cents }, q.distance_m);
    if (expected !== q.price_cents) throw new ApiError(500, 'Inconsistência de tarifa. Calcule novamente.');

    const commissionPct = getSettingNum('commission_pct');
    const rid = id('rid');
    const t = now();
    db.exec('BEGIN');
    try {
      db.prepare(`INSERT INTO rides
        (id, quote_id, passenger_id, category, status, origin_text, origin_lat, origin_lng,
         dest_text, dest_lat, dest_lng, distance_m, duration_s, price_cents, commission_pct,
         payment_method, payment_status, route_geojson, requested_at)
        VALUES (?,?,?,?,'requested',?,?,?,?,?,?,?,?,?,?,?,'pendente',?,?)`)
        .run(rid, q.id, user!.id, q.category, q.origin_text, q.origin_lat, q.origin_lng,
          q.dest_text, q.dest_lat, q.dest_lng, q.distance_m, q.duration_s, q.price_cents,
          commissionPct, method, q.route_geojson, t);
      db.prepare('UPDATE ride_quotes SET used = 1 WHERE id = ?').run(q.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    const ride = getRide(rid);
    rideEvent(rid, 'requested', user!.id);
    const notified = dispatchRide(ride);
    notify(user!.id, 'ride_requested', 'Procurando mototaxista…',
      notified ? `${notified} mototaxista(s) avisados.` : 'Nenhum mototaxista disponível agora — seguiremos tentando.', rid);
    json(res, 201, { ride: rideViewForPassenger(ride), notified_drivers: notified });
  }),

  route('GET /api/rides/active', 'passenger', ({ res, user }) => {
    const r = db.prepare(`SELECT * FROM rides WHERE passenger_id = ?
      AND status IN ('requested','accepted','in_progress')
      ORDER BY requested_at DESC LIMIT 1`).get(user!.id) as any;
    json(res, 200, { ride: r ? rideViewForPassenger(r) : null });
  }),

  route('GET /api/rides', 'passenger', ({ res, user, query }) => {
    const limit = Math.min(Number(query.get('limit')) || 30, 100);
    const rows = db.prepare(`SELECT * FROM rides WHERE passenger_id = ?
      ORDER BY requested_at DESC LIMIT ?`).all(user!.id, limit) as any[];
    json(res, 200, { rides: rows.map(rideViewForPassenger) });
  }),

  route('GET /api/rides/:id', 'passenger', ({ res, user, params }) => {
    const r = getRide(params.id);
    if (r.passenger_id !== user!.id) throw new ApiError(403, 'Esta corrida não é sua.');
    json(res, 200, { ride: rideViewForPassenger(r) });
  }),

  route('POST /api/rides/:id/cancel', 'passenger', async ({ req, res, user, params }) => {
    const r = getRide(params.id);
    if (r.passenger_id !== user!.id) throw new ApiError(403, 'Esta corrida não é sua.');
    const b = await readBody(req);
    cancelRide(r, user!, typeof b.reason === 'string' && b.reason.trim()
      ? b.reason.trim().slice(0, 300) : 'Cancelada pelo passageiro');
    json(res, 200, { ok: true });
  }),

  route('POST /api/rides/:id/rate', 'passenger', async ({ req, res, user, params }) => {
    const r = getRide(params.id);
    if (r.passenger_id !== user!.id) throw new ApiError(403, 'Esta corrida não é sua.');
    if (r.status !== 'completed') throw new ApiError(409, 'Só é possível avaliar corridas concluídas.');
    if (!r.driver_id) throw new ApiError(409, 'Corrida sem mototaxista.');
    const b = await readBody(req);
    const stars = reqNum(b.stars, 'estrelas');
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new ApiError(400, 'Nota deve ser de 1 a 5.');
    const exists = db.prepare('SELECT id FROM ratings WHERE ride_id = ?').get(r.id) as any;
    if (exists) throw new ApiError(409, 'Esta corrida já foi avaliada.');
    db.exec('BEGIN');
    try {
      db.prepare(`INSERT INTO ratings (id, ride_id, passenger_id, driver_id, stars, comment, created_at)
        VALUES (?,?,?,?,?,?,?)`)
        .run(id('rat'), r.id, user!.id, r.driver_id, stars,
          typeof b.comment === 'string' ? b.comment.slice(0, 500) : null, now());
      db.prepare('UPDATE drivers SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE user_id = ?')
        .run(stars, r.driver_id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    notify(r.driver_id, 'rating', `Você recebeu ${stars} estrela(s)`, undefined, r.id);
    json(res, 201, { ok: true });
  }),

  // ---------- chat da corrida (comunicação sem expor telefone) ----------
  route('GET /api/rides/:id/messages', 'any', ({ res, user, params }) => {
    const r = getRide(params.id);
    if (r.passenger_id !== user!.id && r.driver_id !== user!.id && user!.role !== 'admin') {
      throw new ApiError(403, 'Sem acesso a esta corrida.');
    }
    const rows = db.prepare(`SELECT m.id, m.sender_id, m.body, m.at, u.name sender_name
      FROM ride_messages m JOIN users u ON u.id = m.sender_id
      WHERE m.ride_id = ? ORDER BY m.at LIMIT 200`).all(params.id) as any[];
    json(res, 200, { messages: rows });
  }),

  route('POST /api/rides/:id/messages', 'any', async ({ req, res, user, params }) => {
    const r = getRide(params.id);
    if (r.passenger_id !== user!.id && r.driver_id !== user!.id) {
      throw new ApiError(403, 'Sem acesso a esta corrida.');
    }
    if (!['accepted', 'in_progress'].includes(r.status)) {
      throw new ApiError(409, 'O chat só fica disponível durante a corrida.');
    }
    const b = await readBody(req);
    const body = reqStr(b.body, 'mensagem', 500);
    const mid = id('msg');
    db.prepare('INSERT INTO ride_messages (id, ride_id, sender_id, body, at) VALUES (?,?,?,?,?)')
      .run(mid, r.id, user!.id, body, now());
    const other = user!.id === r.passenger_id ? r.driver_id : r.passenger_id;
    if (other) sseSend(other, 'ride_message', { ride_id: r.id, sender_name: user!.name, body, at: now() });
    json(res, 201, { ok: true, id: mid });
  }),

  // ---------- favoritos ----------
  route('GET /api/favorites', 'passenger', ({ res, user }) => {
    json(res, 200, { favorites: db.prepare('SELECT * FROM favorites WHERE user_id = ?').all(user!.id) });
  }),
  route('POST /api/favorites', 'passenger', async ({ req, res, user }) => {
    const b = await readBody(req);
    const fid = id('fav');
    db.prepare('INSERT INTO favorites (id, user_id, label, text, lat, lng) VALUES (?,?,?,?,?,?)')
      .run(fid, user!.id, reqStr(b.label, 'nome', 60), reqStr(b.text, 'endereço', 300),
        reqNum(b.lat, 'lat'), reqNum(b.lng, 'lng'));
    json(res, 201, { ok: true, id: fid });
  }),
  route('DELETE /api/favorites/:id', 'passenger', ({ res, user, params }) => {
    db.prepare('DELETE FROM favorites WHERE id = ? AND user_id = ?').run(params.id, user!.id);
    json(res, 200, { ok: true });
  }),

  // ---------- notificações ----------
  route('GET /api/notifications', 'any', ({ res, user }) => {
    const rows = db.prepare(`SELECT * FROM notifications WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 50`).all(user!.id) as any[];
    json(res, 200, { notifications: rows });
  }),
  route('POST /api/notifications/read', 'any', ({ res, user }) => {
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(user!.id);
    json(res, 200, { ok: true });
  }),

  // ---------- suporte ----------
  route('POST /api/support', 'any', async ({ req, res, user }) => {
    const b = await readBody(req);
    const sid = id('sup');
    db.prepare(`INSERT INTO support_messages (id, user_id, subject, body, created_at)
      VALUES (?,?,?,?,?)`)
      .run(sid, user!.id, reqStr(b.subject, 'assunto', 150), reqStr(b.body, 'mensagem', 2000), now());
    notifyAdmins('support', 'Nova mensagem de suporte', `${user!.name}: ${b.subject}`);
    json(res, 201, { ok: true, id: sid });
  }),
  route('GET /api/support', 'any', ({ res, user }) => {
    const msgs = db.prepare(`SELECT * FROM support_messages WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 30`).all(user!.id) as any[];
    const replies = db.prepare(`SELECT r.* FROM support_replies r
      JOIN support_messages m ON m.id = r.message_id WHERE m.user_id = ?`).all(user!.id) as any[];
    json(res, 200, { messages: msgs, replies });
  }),
];
