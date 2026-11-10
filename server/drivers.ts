import fs from 'node:fs';
import path from 'node:path';
import { db, getSettingNum, getSetting } from './db.ts';
import {
  ApiError, id, now, json, readBody, reqStr, reqNum, dataDir, haversineM,
} from './util.ts';
import { route, type Route } from './router.ts';
import { splitCommission } from './fares.ts';
import {
  getRide, rideEvent, etaSeconds, cancelRide, dispatchRide, assertCanTransition,
  rideViewForPassenger,
} from './rides.ts';
import { notify, notifyAdmins, sseSend } from './notify.ts';

// ---------------- armazenamento privado de documentos ----------------

const DOC_KINDS = ['cnh', 'crlv', 'selfie'] as const;
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
};

function uploadsDir(): string {
  const d = path.join(dataDir(), 'uploads');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Decodifica data URL, valida tipo/tamanho e grava fora da pasta pública. */
function saveDocument(driverId: string, kind: string, dataUrl: string): void {
  const m = /^data:([a-z/+-]+);base64,(.+)$/is.exec(dataUrl || '');
  if (!m) throw new ApiError(400, `Documento ${kind}: arquivo inválido.`);
  const mime = m[1].toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) throw new ApiError(400, `Documento ${kind}: use JPEG, PNG, WebP ou PDF.`);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 1024) throw new ApiError(400, `Documento ${kind}: arquivo muito pequeno/corrompido.`);
  if (buf.length > 8 * 1024 * 1024) throw new ApiError(400, `Documento ${kind}: máximo 8 MB.`);

  const dir = path.join(uploadsDir(), driverId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${kind}-${now()}.${ext}`);
  fs.writeFileSync(file, buf, { mode: 0o600 });

  // substitui documento anterior do mesmo tipo (reenvio)
  const old = db.prepare('SELECT id, file_path FROM driver_documents WHERE driver_id = ? AND kind = ?')
    .all(driverId, kind) as any[];
  for (const o of old) {
    try { fs.unlinkSync(o.file_path); } catch { /* já removido */ }
    db.prepare('DELETE FROM driver_documents WHERE id = ?').run(o.id);
  }
  db.prepare(`INSERT INTO driver_documents (id, driver_id, kind, file_path, mime, size, uploaded_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(id('doc'), driverId, kind, file, mime, buf.length, now());
}

function requireApprovedDriver(userId: string): any {
  const d = db.prepare(`SELECT d.*, u.blocked FROM drivers d
    JOIN users u ON u.id = d.user_id WHERE d.user_id = ?`).get(userId) as any;
  if (!d) throw new ApiError(403, 'Complete seu cadastro de mototaxista primeiro.');
  if (d.blocked) throw new ApiError(403, 'Conta bloqueada. Fale com o suporte.');
  if (d.status !== 'approved') throw new ApiError(403, 'Seu cadastro ainda não foi aprovado.');
  return d;
}

function activeRideOf(driverId: string): any {
  return db.prepare(`SELECT * FROM rides WHERE driver_id = ?
    AND status IN ('accepted','in_progress') LIMIT 1`).get(driverId) as any;
}

/** Visão da corrida para o mototaxista (sem dados sensíveis do passageiro). */
function rideViewForDriver(r: any): any {
  const p = db.prepare('SELECT name, photo FROM users WHERE id = ?').get(r.passenger_id) as any;
  const split = splitCommission(r.price_cents, r.commission_pct);
  return {
    id: r.id, status: r.status, category: r.category,
    origin: { text: r.origin_text, lat: r.origin_lat, lng: r.origin_lng },
    dest: { text: r.dest_text, lat: r.dest_lat, lng: r.dest_lng },
    distance_m: r.distance_m, duration_s: r.duration_s,
    price_cents: r.price_cents,
    commission_cents: r.commission_cents ?? split.commission_cents,
    driver_cents: r.driver_cents ?? split.driver_cents,
    payment_method: r.payment_method, payment_status: r.payment_status,
    route_geojson: r.route_geojson ? JSON.parse(r.route_geojson) : null,
    requested_at: r.requested_at, accepted_at: r.accepted_at, arrived_at: r.arrived_at,
    started_at: r.started_at, completed_at: r.completed_at,
    passenger: { name: p?.name?.split(' ')[0] ?? 'Passageiro', photo: p?.photo ?? null },
  };
}

function notifyRideUpdate(r: any): void {
  sseSend(r.passenger_id, 'ride_update', { id: r.id });
  if (r.driver_id) sseSend(r.driver_id, 'ride_update', { id: r.id });
}

// ---------------- rotas ----------------

export const driverRoutes: Route[] = [

  // Cadastro profissional completo (etapas enviadas de uma vez ao final do wizard).
  route('POST /api/driver/apply', 'driver', async ({ req, res, user }) => {
    const b = await readBody(req);
    const existing = db.prepare('SELECT status FROM drivers WHERE user_id = ?').get(user!.id) as any;
    if (existing && !['correction', 'rejected'].includes(existing.status)) {
      throw new ApiError(409, 'Cadastro já enviado. Aguarde a análise.');
    }

    const birth = reqStr(b.birth_date, 'data de nascimento', 12);
    const address = reqStr(b.address, 'endereço', 300);
    const plate = reqStr(b.moto_plate, 'placa', 10).toUpperCase();
    if (!/^[A-Z]{3}-?\d[A-Z0-9]\d{2}$/.test(plate)) throw new ApiError(400, 'Placa inválida (padrão ABC-1D23 ou ABC-1234).');
    const brand = reqStr(b.moto_brand, 'marca', 40);
    const model = reqStr(b.moto_model, 'modelo', 60);
    const year = reqStr(b.moto_year, 'ano', 6);
    const color = reqStr(b.moto_color, 'cor', 30);
    for (const kind of DOC_KINDS) {
      if (!b.documents?.[kind]) throw new ApiError(400, `Documento obrigatório pendente: ${kind.toUpperCase()}.`);
    }

    const t = now();
    const deadline = t + getSettingNum('review_sla_hours') * 3600_000;
    if (existing) {
      db.prepare(`UPDATE drivers SET status='pending', birth_date=?, address=?, moto_plate=?,
        moto_brand=?, moto_model=?, moto_year=?, moto_color=?, submitted_at=?, deadline_at=?,
        review_reason=NULL, reviewed_at=NULL WHERE user_id=?`)
        .run(birth, address, plate, brand, model, year, color, t, deadline, user!.id);
    } else {
      db.prepare(`INSERT INTO drivers (user_id, status, birth_date, address, moto_plate,
        moto_brand, moto_model, moto_year, moto_color, submitted_at, deadline_at)
        VALUES (?,'pending',?,?,?,?,?,?,?,?,?)`)
        .run(user!.id, birth, address, plate, brand, model, year, color, t, deadline);
    }
    for (const kind of DOC_KINDS) saveDocument(user!.id, kind, b.documents[kind]);

    notifyAdmins('new_driver', 'Novo cadastro de mototaxista para análise',
      `${user!.name} — ${brand} ${model} ${color}, placa ${plate}`);
    notify(user!.id, 'application', 'Cadastro recebido!',
      `Analisaremos seus documentos em até ${getSetting('review_sla_hours')}h.`);
    json(res, 201, { ok: true, status: 'pending', deadline_at: deadline });
  }),

  route('GET /api/driver/me', 'driver', ({ res, user }) => {
    const d = db.prepare('SELECT * FROM drivers WHERE user_id = ?').get(user!.id) as any;
    const docs = d ? db.prepare(`SELECT kind, mime, size, uploaded_at FROM driver_documents
      WHERE driver_id = ?`).all(user!.id) : [];
    const active = d?.status === 'approved' ? activeRideOf(user!.id) : null;
    json(res, 200, {
      driver: d ? { ...d, rating: d.rating_count ? Math.round(d.rating_sum / d.rating_count * 10) / 10 : null } : null,
      documents: docs,
      active_ride: active ? rideViewForDriver(active) : null,
    });
  }),

  route('POST /api/driver/online', 'driver', async ({ req, res, user }) => {
    const d = requireApprovedDriver(user!.id);
    const b = await readBody(req);
    const online = b.online ? 1 : 0;
    if (online && activeRideOf(user!.id)) throw new ApiError(409, 'Finalize a corrida atual primeiro.');
    db.prepare('UPDATE drivers SET online = ? WHERE user_id = ?').run(online, user!.id);
    json(res, 200, { ok: true, online: !!online });
  }),

  route('POST /api/driver/location', 'driver', async ({ req, res, user }) => {
    const d = requireApprovedDriver(user!.id);
    const b = await readBody(req);
    const lat = reqNum(b.lat, 'lat'), lng = reqNum(b.lng, 'lng');
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new ApiError(400, 'Coordenadas inválidas.');
    db.prepare('UPDATE drivers SET last_lat = ?, last_lng = ?, last_loc_at = ? WHERE user_id = ?')
      .run(lat, lng, now(), user!.id);

    const active = activeRideOf(user!.id);
    if (active) {
      db.prepare('INSERT INTO ride_locations (ride_id, who, lat, lng, at) VALUES (?,?,?,?,?)')
        .run(active.id, 'driver', lat, lng, now());
      const target = active.status === 'in_progress'
        ? { lat: active.dest_lat, lng: active.dest_lng }
        : { lat: active.origin_lat, lng: active.origin_lng };
      sseSend(active.passenger_id, 'driver_location', {
        ride_id: active.id, lat, lng,
        eta_s: etaSeconds(haversineM(lat, lng, target.lat, target.lng) * 1.3),
      });
    }
    json(res, 200, { ok: true });
  }),

  // Corridas abertas (reconexão / lista além do SSE)
  route('GET /api/driver/offers', 'driver', ({ res, user }) => {
    const d = requireApprovedDriver(user!.id);
    if (!d.online) { json(res, 200, { offers: [] }); return; }
    const radius = getSettingNum('dispatch_radius_km') * 1000;
    const rows = db.prepare(`SELECT * FROM rides WHERE status = 'requested'
      ORDER BY CASE category WHEN 'prioridade' THEN 0 ELSE 1 END, requested_at
      LIMIT 20`).all() as any[];
    const offers = rows
      .filter(r => d.last_lat == null
        || haversineM(d.last_lat, d.last_lng, r.origin_lat, r.origin_lng) <= radius)
      .map(r => {
        const split = splitCommission(r.price_cents, r.commission_pct);
        return {
          id: r.id, category: r.category, origin_text: r.origin_text, dest_text: r.dest_text,
          origin_lat: r.origin_lat, origin_lng: r.origin_lng,
          distance_m: r.distance_m, price_cents: r.price_cents,
          driver_cents: split.driver_cents, requested_at: r.requested_at,
          pickup_dist_m: d.last_lat == null ? null
            : Math.round(haversineM(d.last_lat, d.last_lng, r.origin_lat, r.origin_lng)),
        };
      });
    json(res, 200, { offers });
  }),

  // ACEITE ATÔMICO: só um mototaxista consegue — UPDATE condicional no servidor.
  route('POST /api/driver/rides/:id/accept', 'driver', ({ res, user, params }) => {
    const d = requireApprovedDriver(user!.id);
    if (!d.online) throw new ApiError(409, 'Fique online para aceitar corridas.');
    if (activeRideOf(user!.id)) throw new ApiError(409, 'Você já está em uma corrida.');

    const result = db.prepare(`UPDATE rides SET status = 'accepted', driver_id = ?, accepted_at = ?
      WHERE id = ? AND status = 'requested' AND driver_id IS NULL`)
      .run(user!.id, now(), params.id);
    if (result.changes !== 1) {
      throw new ApiError(409, 'Esta corrida já foi aceita por outro mototaxista.');
    }
    const r = getRide(params.id);
    rideEvent(r.id, 'accepted', user!.id);
    notify(r.passenger_id, 'ride_accepted', 'Mototaxista a caminho!',
      `${user!.name.split(' ')[0]} aceitou sua corrida.`, r.id);
    notifyRideUpdate(r);
    json(res, 200, { ride: rideViewForDriver(r) });
  }),

  route('POST /api/driver/rides/:id/arrived', 'driver', ({ res, user, params }) => {
    const r = getRide(params.id);
    if (r.driver_id !== user!.id) throw new ApiError(403, 'Esta corrida não é sua.');
    if (r.status !== 'accepted') throw new ApiError(409, 'A corrida não está no estado correto.');
    db.prepare('UPDATE rides SET arrived_at = ? WHERE id = ? AND status = ?')
      .run(now(), r.id, 'accepted');
    rideEvent(r.id, 'arrived', user!.id);
    notify(r.passenger_id, 'driver_arrived', 'Seu mototaxista chegou!',
      'Ele está aguardando no ponto de embarque.', r.id);
    notifyRideUpdate(getRide(r.id));
    json(res, 200, { ok: true });
  }),

  route('POST /api/driver/rides/:id/start', 'driver', ({ res, user, params }) => {
    const r = getRide(params.id);
    if (r.driver_id !== user!.id) throw new ApiError(403, 'Esta corrida não é sua.');
    assertCanTransition(r.status, 'in_progress');
    const result = db.prepare(`UPDATE rides SET status = 'in_progress', started_at = ?
      WHERE id = ? AND status = 'accepted'`).run(now(), r.id);
    if (result.changes !== 1) throw new ApiError(409, 'A corrida mudou de estado.');
    rideEvent(r.id, 'started', user!.id);
    notify(r.passenger_id, 'ride_started', 'Corrida iniciada', 'Boa viagem!', r.id);
    notifyRideUpdate(getRide(r.id));
    json(res, 200, { ok: true });
  }),

  route('POST /api/driver/rides/:id/complete', 'driver', async ({ req, res, user, params }) => {
    const r = getRide(params.id);
    if (r.driver_id !== user!.id) throw new ApiError(403, 'Esta corrida não é sua.');
    assertCanTransition(r.status, 'completed');
    const b = await readBody(req);
    const received = !!b.payment_received;
    const split = splitCommission(r.price_cents, r.commission_pct);
    const t = now();

    db.exec('BEGIN');
    try {
      const result = db.prepare(`UPDATE rides SET status = 'completed', completed_at = ?,
        commission_cents = ?, driver_cents = ?, payment_status = ?
        WHERE id = ? AND status = 'in_progress'`)
        .run(t, split.commission_cents, split.driver_cents,
          received ? 'recebido' : 'pendente', r.id);
      if (result.changes !== 1) throw new ApiError(409, 'A corrida mudou de estado.');
      db.prepare(`INSERT INTO payments (id, ride_id, method, amount_cents, status, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?)`)
        .run(id('pay'), r.id, r.payment_method, r.price_cents,
          received ? 'recebido' : 'pendente', t, t);
      db.prepare('UPDATE drivers SET rides_count = rides_count + 1 WHERE user_id = ?').run(user!.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    rideEvent(r.id, 'completed', user!.id,
      `pagamento ${r.payment_method} ${received ? 'recebido' : 'pendente'}`);
    notify(r.passenger_id, 'ride_completed', 'Corrida concluída!',
      'Obrigado por viajar com o Assis MotoTáxi. Avalie sua corrida!', r.id);
    notifyRideUpdate(getRide(r.id));
    json(res, 200, { ride: rideViewForDriver(getRide(r.id)) });
  }),

  // Cancelamento pelo mototaxista: antes do embarque a corrida VOLTA para a fila.
  route('POST /api/driver/rides/:id/cancel', 'driver', async ({ req, res, user, params }) => {
    const r = getRide(params.id);
    if (r.driver_id !== user!.id) throw new ApiError(403, 'Esta corrida não é sua.');
    const b = await readBody(req);
    const reason = typeof b.reason === 'string' && b.reason.trim()
      ? b.reason.trim().slice(0, 300) : 'Cancelada pelo mototaxista';

    if (r.status === 'accepted') {
      // devolve ao estado requested e re-despacha para outros parceiros
      const result = db.prepare(`UPDATE rides SET status = 'requested', driver_id = NULL,
        accepted_at = NULL, arrived_at = NULL WHERE id = ? AND status = 'accepted'`).run(r.id);
      if (result.changes !== 1) throw new ApiError(409, 'A corrida mudou de estado.');
      rideEvent(r.id, 'driver_gave_up', user!.id, reason);
      notify(r.passenger_id, 'ride_redispatch', 'Procurando outro mototaxista…',
        'O mototaxista anterior não pôde continuar. Já estamos avisando outros parceiros.', r.id);
      const fresh = getRide(r.id);
      dispatchRide(fresh);
      sseSend(r.passenger_id, 'ride_update', { id: r.id });
      json(res, 200, { ok: true, redispatched: true });
      return;
    }
    cancelRide(r, user!, reason);
    json(res, 200, { ok: true, redispatched: false });
  }),

  route('GET /api/driver/rides', 'driver', ({ res, user, query }) => {
    const limit = Math.min(Number(query.get('limit')) || 30, 100);
    const rows = db.prepare(`SELECT * FROM rides WHERE driver_id = ?
      ORDER BY requested_at DESC LIMIT ?`).all(user!.id, limit) as any[];
    json(res, 200, { rides: rows.map(rideViewForDriver) });
  }),

  // Ganhos: apenas corridas CONCLUÍDAS entram nos valores definitivos.
  route('GET /api/driver/earnings', 'driver', ({ res, user }) => {
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(dayStart); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const monthStart = new Date(dayStart); monthStart.setDate(1);
    const agg = (since: number) => db.prepare(`SELECT
        COUNT(*) rides, COALESCE(SUM(price_cents),0) gross,
        COALESCE(SUM(commission_cents),0) commission, COALESCE(SUM(driver_cents),0) net
      FROM rides WHERE driver_id = ? AND status = 'completed' AND completed_at >= ?`)
      .get(user!.id, since) as any;
    const pending = db.prepare(`SELECT COALESCE(SUM(driver_cents),0) v FROM rides
      WHERE driver_id = ? AND status = 'completed' AND payment_status = 'pendente'`)
      .get(user!.id) as any;
    const received = db.prepare(`SELECT COALESCE(SUM(driver_cents),0) v FROM rides
      WHERE driver_id = ? AND status = 'completed' AND payment_status = 'recebido'`)
      .get(user!.id) as any;
    json(res, 200, {
      day: agg(dayStart.getTime()),
      week: agg(weekStart.getTime()),
      month: agg(monthStart.getTime()),
      total: agg(0),
      pending_cents: pending.v,
      received_cents: received.v,
    });
  }),
];

export { rideViewForDriver };
