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
  rideViewForPassenger, BUSY_STATES, chargeAcceptedRide, ridePaymentOk, chargeAfterAccept,
} from './rides.ts';
import { notify, notifyAdmins, sseSend } from './notify.ts';
import { driverBalance, getPaymentByRide } from './payments.ts';

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

/** Bloqueia o parceiro que acumulou comissão de corridas em dinheiro. */
function assertNoExcessiveDebt(userId: string): void {
  const limit = getSettingNum('driver_debt_limit_cents');
  const { debt_cents } = driverBalance(userId);
  if (debt_cents > limit) {
    throw new ApiError(402,
      `Você tem R$ ${(debt_cents / 100).toFixed(2)} de comissão em aberto (limite R$ ${(limit / 100).toFixed(2)}). ` +
      `Quite com a plataforma para voltar a receber corridas.`);
  }
}

function activeRideOf(driverId: string): any {
  return db.prepare(`SELECT * FROM rides WHERE driver_id = ?
    AND status IN (${BUSY_STATES.map(() => '?').join(',')}) LIMIT 1`)
    .get(driverId, ...BUSY_STATES) as any;
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
    completion_requested_at: r.completion_requested_at, auto_confirm_at: r.auto_confirm_at,
    confirmed_at: r.confirmed_at, confirmed_by: r.confirmed_by,
    pickup_updated_at: r.pickup_updated_at,
    paid_upfront: r.payment_method !== 'dinheiro',
    collect_cash_cents: r.payment_method === 'dinheiro' ? r.price_cents : 0,
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
      balance: d ? driverBalance(user!.id) : null,
      debt_limit_cents: getSettingNum('driver_debt_limit_cents'),
      server_time: now(),
    });
  }),

  route('POST /api/driver/online', 'driver', async ({ req, res, user }) => {
    requireApprovedDriver(user!.id);
    const b = await readBody(req);
    const online = b.online ? 1 : 0;
    if (online) {
      assertNoExcessiveDebt(user!.id);
      if (activeRideOf(user!.id)) throw new ApiError(409, 'Finalize a corrida atual primeiro.');
    }
    db.prepare('UPDATE drivers SET online = ?, last_seen_at = ? WHERE user_id = ?')
      .run(online, now(), user!.id);
    json(res, 200, { ok: true, online: !!online });
  }),

  route('POST /api/driver/location', 'driver', async ({ req, res, user }) => {
    requireApprovedDriver(user!.id);
    const b = await readBody(req);
    const lat = reqNum(b.lat, 'lat'), lng = reqNum(b.lng, 'lng');
    const acc = Number(b.accuracy_m);
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
      throw new ApiError(400, 'Coordenadas inválidas.');
    }
    const maxAcc = getSettingNum('gps_max_accuracy_m');
    const accuracy = Number.isFinite(acc) ? acc : null;
    const t = now();
    db.prepare(`UPDATE drivers SET last_lat = ?, last_lng = ?, last_loc_at = ?,
      last_accuracy_m = ?, last_seen_at = ? WHERE user_id = ?`)
      .run(lat, lng, t, accuracy, t, user!.id);

    const active = activeRideOf(user!.id);
    if (active) {
      db.prepare('INSERT INTO ride_locations (ride_id, who, lat, lng, accuracy_m, at) VALUES (?,?,?,?,?,?)')
        .run(active.id, 'driver', lat, lng, accuracy, t);
      const target = active.status === 'in_progress'
        ? { lat: active.dest_lat, lng: active.dest_lng }
        : { lat: active.origin_lat, lng: active.origin_lng };
      const remaining = haversineM(lat, lng, target.lat, target.lng) * 1.3;
      sseSend(active.passenger_id, 'driver_location', {
        ride_id: active.id, lat, lng, accuracy_m: accuracy,
        remaining_m: Math.round(remaining),
        eta_s: etaSeconds(remaining),
      });
    }
    json(res, 200, {
      ok: true,
      accuracy_ok: accuracy === null || accuracy <= maxAcc,
      max_accuracy_m: maxAcc,
    });
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
  route('POST /api/driver/rides/:id/accept', 'driver', async ({ res, user, params }) => {
    const d = requireApprovedDriver(user!.id);
    if (!d.online) throw new ApiError(409, 'Fique online para aceitar corridas.');
    assertNoExcessiveDebt(user!.id);
    if (activeRideOf(user!.id)) throw new ApiError(409, 'Você já está em uma corrida.');

    const result = db.prepare(`UPDATE rides SET status = 'accepted', driver_id = ?, accepted_at = ?
      WHERE id = ? AND status = 'requested' AND driver_id IS NULL`)
      .run(user!.id, now(), params.id);
    if (result.changes !== 1) {
      throw new ApiError(409, 'Esta corrida já foi aceita por outro mototaxista.');
    }
    const r = getRide(params.id);
    rideEvent(r.id, 'accepted', user!.id, undefined, 'requested', 'accepted');
    notify(r.passenger_id, 'ride_accepted', '🏍️ Mototaxista a caminho!',
      { body: `${user!.name.split(' ')[0]} aceitou sua corrida.`, rideId: r.id, url: '/' });

    // No modo split a cobrança nasce agora, já na conta deste parceiro.
    if (chargeAfterAccept()) {
      try { await chargeAcceptedRide(r); }
      catch (e: any) {
        notifyAdmins('payment_failed', 'Falha ao abrir a cobrança após o aceite',
          { body: `Corrida ${r.id}: ${e?.message || e}`, rideId: r.id });
      }
    }
    notifyRideUpdate(getRide(r.id));
    json(res, 200, { ride: rideViewForDriver(getRide(r.id)) });
  }),

  route('POST /api/driver/rides/:id/arrived', 'driver', ({ res, user, params }) => {
    const r = getRide(params.id);
    if (r.driver_id !== user!.id) throw new ApiError(403, 'Esta corrida não é sua.');
    if (r.status !== 'accepted') throw new ApiError(409, 'A corrida não está no estado correto.');
    db.prepare('UPDATE rides SET arrived_at = ? WHERE id = ? AND status = ?')
      .run(now(), r.id, 'accepted');
    rideEvent(r.id, 'arrived', user!.id);
    notify(r.passenger_id, 'driver_arrived', '🏍️ Seu mototaxista chegou!',
      { body: 'Ele está aguardando no ponto de embarque.', rideId: r.id, url: '/' });
    notifyRideUpdate(getRide(r.id));
    json(res, 200, { ok: true });
  }),

  route('POST /api/driver/rides/:id/start', 'driver', ({ res, user, params }) => {
    const r = getRide(params.id);
    if (r.driver_id !== user!.id) throw new ApiError(403, 'Esta corrida não é sua.');
    assertCanTransition(r.status, 'in_progress');
    // dinheiro garantido: a corrida não começa sem o pagamento confirmado
    if (!ridePaymentOk(r)) {
      throw new ApiError(402, 'O pagamento do passageiro ainda não foi confirmado.');
    }
    const result = db.prepare(`UPDATE rides SET status = 'in_progress', started_at = ?
      WHERE id = ? AND status = 'accepted'`).run(now(), r.id);
    if (result.changes !== 1) throw new ApiError(409, 'A corrida mudou de estado.');
    rideEvent(r.id, 'started', user!.id, undefined, 'accepted', 'in_progress');
    notify(r.passenger_id, 'ride_started', 'Corrida iniciada', { body: 'Boa viagem!', rideId: r.id });
    notifyRideUpdate(getRide(r.id));
    json(res, 200, { ok: true });
  }),

  /**
   * O mototaxista DECLARA a conclusão; quem confirma é o passageiro.
   * A corrida vai para `awaiting_confirmation` com prazo gravado no servidor
   * (`auto_confirm_at`); a varredura em rides.ts confirma sozinha se o
   * passageiro não responder. O mototaxista não conclui nem marca pagamento.
   */
  route('POST /api/driver/rides/:id/complete', 'driver', async ({ res, user, params }) => {
    const r = getRide(params.id);
    if (r.driver_id !== user!.id) throw new ApiError(403, 'Esta corrida não é sua.');
    assertCanTransition(r.status, 'awaiting_confirmation');

    const t = now();
    const windowMs = Math.max(1, getSettingNum('confirm_window_s')) * 1000;
    const result = db.prepare(`UPDATE rides SET status = 'awaiting_confirmation',
        completion_requested_at = ?, auto_confirm_at = ?
      WHERE id = ? AND status = 'in_progress'`).run(t, t + windowMs, r.id);
    if (result.changes !== 1) throw new ApiError(409, 'A corrida mudou de estado.');

    rideEvent(r.id, 'completion_requested', user!.id, undefined, 'in_progress', 'awaiting_confirmation');
    notify(r.passenger_id, 'confirm_required', 'Confirme a chegada ao destino',
      {
        body: 'Seu mototaxista informou que a corrida foi concluída.',
        rideId: r.id, url: '/',
      });
    notifyRideUpdate(getRide(r.id));
    json(res, 200, {
      ride: rideViewForDriver(getRide(r.id)),
      auto_confirm_at: t + windowMs,
      server_time: t,
    });
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
      rideEvent(r.id, 'driver_gave_up', user!.id, reason, 'accepted', 'requested');
      notify(r.passenger_id, 'ride_redispatch', 'Procurando outro mototaxista…',
        { body: 'O parceiro anterior não pôde continuar. Já avisamos os outros.', rideId: r.id });
      const fresh = getRide(r.id);
      dispatchRide(fresh);
      sseSend(r.passenger_id, 'ride_update', { id: r.id });
      json(res, 200, { ok: true, redispatched: true });
      return;
    }
    await cancelRide(r, user!, reason);
    json(res, 200, { ok: true, redispatched: false });
  }),

  route('GET /api/driver/rides', 'driver', ({ res, user, query }) => {
    const limit = Math.min(Number(query.get('limit')) || 30, 100);
    const rows = db.prepare(`SELECT * FROM rides WHERE driver_id = ?
      ORDER BY requested_at DESC LIMIT ?`).all(user!.id, limit) as any[];
    json(res, 200, { rides: rows.map(rideViewForDriver) });
  }),

  /**
   * Ganhos: só corridas CONCLUÍDAS entram. Os saldos vêm do livro-caixa,
   * que é a mesma fonte usada pelo financeiro do administrador.
   */
  route('GET /api/driver/earnings', 'driver', ({ res, user }) => {
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(dayStart); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const monthStart = new Date(dayStart); monthStart.setDate(1);
    const agg = (since: number) => db.prepare(`SELECT
        COUNT(*) rides, COALESCE(SUM(price_cents),0) gross,
        COALESCE(SUM(commission_cents),0) commission, COALESCE(SUM(driver_cents),0) net,
        COALESCE(SUM(CASE WHEN payment_method = 'dinheiro' THEN price_cents ELSE 0 END),0) cash_gross
      FROM rides WHERE driver_id = ? AND status = 'completed' AND completed_at >= ?`)
      .get(user!.id, since) as any;
    const bal = driverBalance(user!.id);
    const payouts = db.prepare(`SELECT id, amount_cents, status, method, reference, created_at, paid_at
      FROM payouts WHERE driver_id = ? ORDER BY created_at DESC LIMIT 20`).all(user!.id);
    json(res, 200, {
      day: agg(dayStart.getTime()),
      week: agg(weekStart.getTime()),
      month: agg(monthStart.getTime()),
      total: agg(0),
      balance: bal,
      pending_cents: bal.pending_cents,
      received_cents: bal.paid_cents,
      debt_cents: bal.debt_cents,
      debt_limit_cents: getSettingNum('driver_debt_limit_cents'),
      payouts,
    });
  }),

  /** Avaliações recebidas, com médias por critério. */
  route('GET /api/driver/ratings', 'driver', ({ res, user }) => {
    const list = db.prepare(`SELECT stars, comment, score_atendimento, score_pontualidade,
        score_educacao, score_seguranca, created_at
      FROM ratings WHERE driver_id = ? ORDER BY created_at DESC LIMIT 50`).all(user!.id) as any[];
    const avg = db.prepare(`SELECT
        COUNT(*) total, AVG(stars) stars,
        AVG(score_atendimento) atendimento, AVG(score_pontualidade) pontualidade,
        AVG(score_educacao) educacao, AVG(score_seguranca) seguranca
      FROM ratings WHERE driver_id = ?`).get(user!.id) as any;
    json(res, 200, { ratings: list, averages: avg });
  }),
];

export { rideViewForDriver };
