import { db, getSettingNum, getSetting } from './db.ts';
import {
  ApiError, id, now, json, readBody, reqStr, reqNum, haversineM, rateLimit,
} from './util.ts';
import { route, type Route, type SessionUser } from './router.ts';
import { getFare, allFares, computePriceCents, splitCommission } from './fares.ts';
import {
  route as computeRoute, searchAddress, reverseGeocode, assertInCoverage, resolvePlace,
} from './geo.ts';
import { notify, notifyAdmins, sseSend, sseSendMany } from './notify.ts';
import {
  createCharge, getPaymentByRide, capturePayment, refundPayment, syncPayment,
  isReleasable, availableMethods, isTestMode, providerName, ledger, driverBalance,
  applyPaymentStatus, splitAvailable, connectedSeller, type Method,
} from './payments.ts';

/** Cobra antes de despachar ou depois do aceite (necessário para o split). */
export function chargeAfterAccept(): boolean {
  return getSetting('charge_timing') === 'apos_aceite';
}

// ---------------------------------------------------------------
// Helpers compartilhados (também usados pelo módulo do mototaxista)
// ---------------------------------------------------------------

export function etaSeconds(distanceM: number): number {
  return Math.round(distanceM / (25000 / 3600)); // ~25 km/h urbano
}

/** Estados em que o mototaxista está ocupado e não recebe novas chamadas. */
export const BUSY_STATES = ['accepted', 'in_progress', 'awaiting_confirmation', 'disputed'];

export interface EligibleDriver { user_id: string; lat: number; lng: number; dist_m: number }

/**
 * Mototaxistas realmente aptos a receber corridas agora: aprovados, conta ativa,
 * online, com localização recente e precisa, sem corrida em andamento e sem
 * dívida de comissão acima do limite.
 */
export function eligibleDrivers(originLat?: number, originLng?: number): EligibleDriver[] {
  const fresh = now() - getSettingNum('loc_fresh_s') * 1000;
  const maxAcc = getSettingNum('gps_max_accuracy_m');
  const rows = db.prepare(`
    SELECT d.user_id, d.last_lat lat, d.last_lng lng
    FROM drivers d JOIN users u ON u.id = d.user_id
    WHERE d.status = 'approved' AND d.online = 1 AND u.blocked = 0
      AND d.last_loc_at IS NOT NULL AND d.last_loc_at > ?
      AND (d.last_accuracy_m IS NULL OR d.last_accuracy_m <= ?)
      AND d.user_id NOT IN (
        SELECT driver_id FROM rides
        WHERE driver_id IS NOT NULL AND status IN (${BUSY_STATES.map(() => '?').join(',')}))
  `).all(fresh, maxAcc, ...BUSY_STATES) as any[];

  const debtLimit = getSettingNum('driver_debt_limit_cents');
  const radius = getSettingNum('dispatch_radius_km') * 1000;
  return rows
    .filter(r => driverBalance(r.user_id).debt_cents <= debtLimit)
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

export function rideEvent(rideId: string, type: string, actorId?: string,
  details?: string, from?: string, to?: string): void {
  const detail = [details, from && to ? `${from} → ${to}` : null].filter(Boolean).join(' | ');
  db.prepare('INSERT INTO ride_events (ride_id, type, actor_id, details, at) VALUES (?, ?, ?, ?, ?)')
    .run(rideId, type, actorId ?? null, detail || null, now());
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
    loc_stale: !d.last_loc_at || (now() - d.last_loc_at) > getSettingNum('loc_fresh_s') * 1000,
  };
}

function paymentView(p: any): any {
  if (!p) return null;
  return {
    id: p.id, method: p.method, status: p.status, amount_cents: p.amount_cents,
    test_mode: !!p.test_mode, provider: p.provider,
    pix_qr_code: p.pix_qr_code, pix_qr_base64: p.pix_qr_base64,
    pix_expires_at: p.pix_expires_at, ticket_url: p.ticket_url,
    failure_reason: p.failure_reason,
  };
}

/** Visão da corrida para o passageiro (cartão do mototaxista, ETA e pagamento). */
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
  const issue = db.prepare(`SELECT id, kind, status FROM ride_issues
    WHERE ride_id = ? ORDER BY created_at DESC LIMIT 1`).get(r.id) as any;
  return {
    id: r.id, status: r.status, category: r.category,
    origin: { text: r.origin_text, lat: r.origin_lat, lng: r.origin_lng },
    dest: { text: r.dest_text, lat: r.dest_lat, lng: r.dest_lng },
    distance_m: r.distance_m, duration_s: r.duration_s, price_cents: r.price_cents,
    payment_method: r.payment_method, payment_status: r.payment_status,
    payment: paymentView(getPaymentByRide(r.id)),
    route_geojson: r.route_geojson ? JSON.parse(r.route_geojson) : null,
    requested_at: r.requested_at, accepted_at: r.accepted_at, arrived_at: r.arrived_at,
    started_at: r.started_at, completed_at: r.completed_at,
    completion_requested_at: r.completion_requested_at, auto_confirm_at: r.auto_confirm_at,
    confirmed_at: r.confirmed_at, confirmed_by: r.confirmed_by,
    cancelled_at: r.cancelled_at, cancelled_by: r.cancelled_by, cancel_reason: r.cancel_reason,
    pickup_updated_at: r.pickup_updated_at,
    driver, eta_s, rated: rated ? rated.stars : null,
    issue: issue ?? null,
  };
}

/** Despacha a corrida por SSE + push aos mototaxistas elegíveis. */
export function dispatchRide(ride: any): number {
  const eligible = eligibleDrivers(ride.origin_lat, ride.origin_lng);
  const split = splitCommission(ride.price_cents, ride.commission_pct);
  const offer = {
    id: ride.id, category: ride.category,
    origin_text: ride.origin_text, dest_text: ride.dest_text,
    origin_lat: ride.origin_lat, origin_lng: ride.origin_lng,
    distance_m: ride.distance_m, price_cents: ride.price_cents,
    payment_method: ride.payment_method,
    driver_cents: split.driver_cents,
    requested_at: ride.requested_at,
  };
  const send = (list: EligibleDriver[]) => {
    sseSendMany(list.map(d => d.user_id), 'ride_offer', offer);
    for (const d of list) {
      notify(d.user_id, 'ride_offer', '🏍️ Nova corrida disponível!',
        {
          body: `${ride.origin_text} → ${ride.dest_text} · você recebe R$ ${(split.driver_cents / 100).toFixed(2)}`,
          rideId: ride.id, url: '/motorista', push: true,
        });
    }
  };
  if (ride.category === 'prioridade') {
    // Prioridade: os 3 mais próximos recebem primeiro; os demais após 8 s.
    send(eligible.slice(0, 3));
    const rest = eligible.slice(3);
    if (rest.length) {
      setTimeout(() => {
        const still = db.prepare('SELECT status FROM rides WHERE id = ?').get(ride.id) as any;
        if (still?.status === 'requested') send(rest);
      }, 8000).unref?.();
    }
  } else {
    send(eligible);
  }
  return eligible.length;
}

/** Libera a corrida para despacho assim que o pagamento permitir. */
export function releaseRideForDispatch(rideId: string): number {
  const r = getRide(rideId);
  if (r.status !== 'pending_payment') return 0;
  const payment = getPaymentByRide(rideId);
  if (!payment || !isReleasable(payment)) return 0;

  const res = db.prepare(`UPDATE rides SET status = 'requested', requested_at = ?
    WHERE id = ? AND status = 'pending_payment'`).run(now(), rideId);
  if (res.changes !== 1) return 0;

  const fresh = getRide(rideId);
  rideEvent(rideId, 'payment_released', undefined,
    `pagamento ${payment.method} ${payment.status}`, 'pending_payment', 'requested');
  const n = dispatchRide(fresh);
  notify(fresh.passenger_id, 'ride_requested', 'Pagamento confirmado — procurando mototaxista…',
    { body: n ? `${n} mototaxista(s) avisados.` : 'Assim que um parceiro ficar disponível, avisaremos.', rideId });
  sseSend(fresh.passenger_id, 'ride_update', { id: rideId });
  return n;
}

/**
 * Modo split: a cobrança nasce quando o parceiro aceita, já na conta dele,
 * com a comissão retida pela plataforma. Se ele não tiver a conta conectada,
 * cai no modelo normal (plataforma recebe e repassa depois).
 */
export async function chargeAcceptedRide(ride: any): Promise<void> {
  if (ride.payment_method === 'dinheiro') return;
  if (getPaymentByRide(ride.id)) return;

  const passenger = db.prepare('SELECT name, email FROM users WHERE id = ?')
    .get(ride.passenger_id) as any;
  const split = splitCommission(ride.price_cents, ride.commission_pct);
  const seller = splitAvailable() ? await connectedSeller(ride.driver_id) : null;

  const payment = await createCharge({
    rideId: ride.id, method: ride.payment_method as Method, amountCents: ride.price_cents,
    payerEmail: passenger.email, payerName: passenger.name,
    description: `Corrida Assis MotoTáxi ${ride.origin_text} → ${ride.dest_text}`,
    sellerDriverId: seller ? ride.driver_id : undefined,
    applicationFeeCents: split.commission_cents,
    notificationUrl: process.env.PUBLIC_URL
      ? `${process.env.PUBLIC_URL}/api/webhooks/mercadopago` : undefined,
  });

  const deadline = now() + getSettingNum('payment_deadline_min') * 60_000;
  db.prepare('UPDATE rides SET auto_confirm_at = NULL WHERE id = ?').run(ride.id);
  rideEvent(ride.id, 'charge_created', undefined,
    seller ? `split na conta do parceiro (taxa ${split.commission_cents})` : 'conta da plataforma');

  notify(ride.passenger_id, 'payment_pending', 'Mototaxista encontrado — conclua o pagamento',
    {
      body: ride.payment_method === 'pix'
        ? 'Escaneie o Pix para a corrida começar.'
        : 'Estamos confirmando o pagamento do cartão.',
      rideId: ride.id, url: '/',
    });
  sseSend(ride.passenger_id, 'ride_update', { id: ride.id });
  void payment; void deadline;
}

/** O pagamento desta corrida já está garantido? */
export function ridePaymentOk(ride: any): boolean {
  if (ride.payment_method === 'dinheiro') return true;
  const p = getPaymentByRide(ride.id);
  return !!p && isReleasable(p);
}

export function assertCanTransition(from: string, to: string): void {
  const allowed: Record<string, string[]> = {
    pending_payment: ['requested', 'cancelled'],
    requested: ['accepted', 'cancelled'],
    accepted: ['in_progress', 'cancelled', 'requested'], // requested = re-despacho
    in_progress: ['awaiting_confirmation', 'cancelled'],
    awaiting_confirmation: ['completed', 'disputed'],
    disputed: ['completed', 'cancelled'],
    completed: [],
    cancelled: [],
  };
  if (!allowed[from]?.includes(to)) {
    throw new ApiError(409, `Transição de estado inválida: ${from} → ${to}.`);
  }
}

// ---------------------------------------------------------------
// Conclusão com confirmação do passageiro
// ---------------------------------------------------------------

/**
 * Conclui a corrida de forma atômica (só uma execução vence), captura o
 * pagamento e escreve o livro-caixa. `by` = 'passenger' | 'auto' | 'admin'.
 */
export async function finalizeRide(rideId: string, by: string): Promise<void> {
  const t = now();
  const res = db.prepare(`UPDATE rides SET status = 'completed', completed_at = ?,
      confirmed_at = ?, confirmed_by = ?
    WHERE id = ? AND status = 'awaiting_confirmation'`).run(t, t, by, rideId);
  if (res.changes !== 1) return;  // outra confirmação já venceu a corrida

  const r = getRide(rideId);
  const split = splitCommission(r.price_cents, r.commission_pct);
  db.prepare('UPDATE rides SET commission_cents = ?, driver_cents = ? WHERE id = ?')
    .run(split.commission_cents, split.driver_cents, rideId);
  db.prepare('UPDATE drivers SET rides_count = rides_count + 1 WHERE user_id = ?').run(r.driver_id);
  rideEvent(rideId, 'completed', undefined, `confirmada por ${by}`, 'awaiting_confirmation', 'completed');

  const payment = getPaymentByRide(rideId);
  const test = !!payment?.test_mode;
  if (payment) {
    try { await capturePayment(payment); }
    catch (e: any) {
      notifyAdmins('payment_failed', 'Falha ao capturar pagamento',
        { body: `Corrida ${rideId}: ${e?.message || e}`, rideId });
    }
  }

  // Livro-caixa: separa automaticamente comissão e valor do mototaxista.
  if (payment?.seller_driver_id) {
    // Split automático: o dinheiro já caiu na conta do parceiro e a comissão
    // ficou retida pela plataforma — não há repasse manual a fazer.
    ledger('cobranca', r.price_cents, {
      rideId, paymentId: payment.id, driverId: r.driver_id, testMode: test,
      description: `Recebido na conta do mototaxista via ${r.payment_method} (split)`,
    });
    ledger('comissao', split.commission_cents, {
      rideId, paymentId: payment.id, driverId: r.driver_id, testMode: test,
      description: 'Comissão retida automaticamente pelo provedor',
    });
    ledger('repasse_automatico', split.driver_cents, {
      rideId, paymentId: payment.id, driverId: r.driver_id, testMode: test,
      description: 'Valor creditado direto na conta do mototaxista',
    });
  } else if (r.payment_method === 'dinheiro') {
    ledger('cobranca', r.price_cents, {
      rideId, paymentId: payment?.id, driverId: r.driver_id, testMode: test,
      description: 'Recebido em dinheiro diretamente pelo mototaxista',
    });
    ledger('comissao', split.commission_cents, {
      rideId, paymentId: payment?.id, driverId: r.driver_id, testMode: test,
      description: 'Comissão da plataforma',
    });
    ledger('divida_comissao', split.commission_cents, {
      rideId, paymentId: payment?.id, driverId: r.driver_id, testMode: test,
      description: 'Comissão a cobrar do mototaxista (corrida em dinheiro)',
    });
  } else {
    ledger('cobranca', r.price_cents, {
      rideId, paymentId: payment?.id, driverId: r.driver_id, testMode: test,
      description: `Recebido pela plataforma via ${r.payment_method}`,
    });
    ledger('comissao', split.commission_cents, {
      rideId, paymentId: payment?.id, driverId: r.driver_id, testMode: test,
      description: 'Comissão da plataforma',
    });
    ledger('repasse_devido', split.driver_cents, {
      rideId, paymentId: payment?.id, driverId: r.driver_id, testMode: test,
      description: 'Valor líquido do mototaxista (aguardando repasse)',
    });
  }

  notify(r.passenger_id, 'ride_completed', 'Corrida concluída!',
    { body: 'Obrigado por viajar com o Assis MotoTáxi. Avalie seu mototaxista!', rideId });
  notify(r.driver_id, 'ride_completed', 'Corrida concluída',
    {
      body: payment?.seller_driver_id
        ? `R$ ${(split.driver_cents / 100).toFixed(2)} caíram direto na sua conta Mercado Pago.`
        : r.payment_method === 'dinheiro'
          ? `Receba R$ ${(r.price_cents / 100).toFixed(2)} em dinheiro. Comissão de R$ ${(split.commission_cents / 100).toFixed(2)} fica registrada.`
          : `R$ ${(split.driver_cents / 100).toFixed(2)} entram no seu saldo a receber.`,
      rideId,
    });
  sseSend(r.passenger_id, 'ride_update', { id: rideId });
  sseSend(r.driver_id, 'ride_update', { id: rideId });
}

/**
 * Varredura que confirma automaticamente as corridas cujo prazo expirou.
 * Roda no servidor (não depende do celular do passageiro) e sobrevive a
 * reinícios, porque o prazo está persistido em `auto_confirm_at`.
 */
export function startAutoConfirmSweeper(): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      const due = db.prepare(`SELECT id FROM rides
        WHERE status = 'awaiting_confirmation' AND auto_confirm_at IS NOT NULL
          AND auto_confirm_at <= ?`).all(now()) as any[];
      for (const r of due) void finalizeRide(r.id, 'auto');
    } catch { /* não derruba o servidor */ }
  }, 1000);
  timer.unref();
  return timer;
}

// ---------------------------------------------------------------
// Cancelamento
// ---------------------------------------------------------------

export async function cancelRide(r: any, user: SessionUser, reason: string): Promise<void> {
  assertCanTransition(r.status, 'cancelled');
  const states = (user.role === 'driver'
    ? getSetting('driver_cancel_states') : getSetting('passenger_cancel_states'))
    .split(',').map(s => s.trim());
  if (user.role !== 'admin' && !states.includes(r.status)) {
    throw new ApiError(409, `Não é possível cancelar uma corrida em estado "${r.status}".`);
  }
  const result = db.prepare(`
    UPDATE rides SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?,
      cancel_reason = ?, cancel_prev_status = ?
    WHERE id = ? AND status = ?`)
    .run(now(), user.role, reason, r.status, r.id, r.status);
  if (result.changes !== 1) throw new ApiError(409, 'A corrida mudou de estado. Atualize a tela.');

  // Estorna o que já foi cobrado — corrida cancelada não gera comissão.
  const payment = getPaymentByRide(r.id);
  if (payment) {
    try {
      if (['pago', 'autorizado', 'aguardando_pagamento'].includes(payment.status)) {
        await refundPayment(payment, `Corrida cancelada por ${user.role}: ${reason}`);
        notify(r.passenger_id, 'refund', 'Estorno em andamento',
          { body: 'O valor da corrida cancelada está sendo devolvido.', rideId: r.id });
      } else {
        applyPaymentStatus(payment, 'cancelado');
      }
    } catch (e: any) {
      notifyAdmins('payment_failed', 'Falha ao estornar pagamento',
        { body: `Corrida ${r.id}: ${e?.message || e}`, rideId: r.id });
    }
  }
  rideEvent(r.id, 'cancelled', user.id, `por ${user.role}: ${reason}`, r.status, 'cancelled');

  if (user.role !== 'driver' && r.driver_id) {
    notify(r.driver_id, 'ride_cancelled', 'Corrida cancelada pelo passageiro',
      { body: r.origin_text, rideId: r.id });
  }
  if (user.role !== 'passenger') {
    notify(r.passenger_id, 'ride_cancelled', 'Sua corrida foi cancelada',
      { body: reason, rideId: r.id });
  }
  sseSend(r.passenger_id, 'ride_update', { id: r.id });
  if (r.driver_id) sseSend(r.driver_id, 'ride_update', { id: r.id });
  notifyAdmins('ride_cancelled', 'Corrida cancelada',
    { body: `${r.origin_text} → ${r.dest_text} (por ${user.role}: ${reason})`, rideId: r.id, push: false });
}

// ---------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------

export const rideRoutes: Route[] = [

  route('GET /api/public/stats', null, ({ res }) => {
    const drivers = eligibleDrivers();
    json(res, 200, {
      online_drivers: drivers.length,
      // posições aproximadas (~110 m) e anônimas, só para ambientar o mapa
      markers: drivers.slice(0, 30).map(d => ({
        lat: Math.round(d.lat * 1000) / 1000,
        lng: Math.round(d.lng * 1000) / 1000,
      })),
    });
  }),

  route('GET /api/public/fares', null, ({ res }) => {
    json(res, 200, {
      fares: allFares(),
      commission_pct: getSettingNum('commission_pct'),
      payment_methods: availableMethods(),
      test_mode: isTestMode(),
      provider: providerName(),
    });
  }),

  route('GET /api/geo/search', 'any', async ({ res, query, ip }) => {
    if (!rateLimit(`geo:${ip}`, 90, 60_000)) throw new ApiError(429, 'Aguarde um instante.');
    const q = (query.get('q') || '').trim();
    if (q.length < 2) { json(res, 200, { results: [] }); return; }
    // o token de sessão agrupa digitação + escolha numa só cobrança do Google
    const session = (query.get('session') || '').slice(0, 64) || undefined;
    json(res, 200, { results: await searchAddress(q, session) });
  }),

  /** Converte a sugestão escolhida em coordenada (Place Details). */
  route('GET /api/geo/place', 'any', async ({ res, query, ip }) => {
    if (!rateLimit(`place:${ip}`, 60, 60_000)) throw new ApiError(429, 'Aguarde um instante.');
    const placeId = reqStr(query.get('place_id'), 'lugar', 300);
    const session = (query.get('session') || '').slice(0, 64) || undefined;
    json(res, 200, { place: await resolvePlace(placeId, session) });
  }),

  /**
   * O passageiro ajustou o pino de um "rua + número": grava a posição real.
   * Na próxima busca desse endereço (por qualquer pessoa), o ponto é exato.
   */
  route('POST /api/geo/learn', 'any', async ({ req, res, ip }) => {
    if (!rateLimit(`learn:${ip}`, 20, 60_000)) throw new ApiError(429, 'Aguarde um instante.');
    const { learnHouseNumber } = await import('./address-base.ts');
    const b = await readBody(req);
    const street = reqStr(b.street, 'rua', 120);
    const number = reqNum(b.number, 'número');
    const lat = reqNum(b.lat, 'lat'), lng = reqNum(b.lng, 'lng');
    assertInCoverage({ lat, lng }, 'ajuste');
    const r = learnHouseNumber(street, Math.round(number), lat, lng);
    if (!r.ok) throw new ApiError(422, `Não foi possível salvar o ponto (${r.reason}).`);
    json(res, 200, { ok: true });
  }),

  route('GET /api/geo/reverse', 'any', async ({ res, query }) => {
    const lat = reqNum(query.get('lat'), 'lat'), lng = reqNum(query.get('lng'), 'lng');
    const cLat = getSettingNum('center_lat'), cLng = getSettingNum('center_lng');
    const dist = Math.round(haversineM(lat, lng, cLat, cLng));
    const rev = await reverseGeocode(lat, lng);
    json(res, 200, {
      ...rev, lat, lng, distance_m: dist,
      in_coverage: dist <= getSettingNum('coverage_radius_km') * 1000,
    });
  }),

  // Orçamento: rota real e preço calculados NO SERVIDOR; uma cotação por categoria.
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

    // O preço SEMPRE usa a distância da rota calculada pelo serviço,
    // nunca a linha reta (salvo quando nada responde — e aí fica marcado).
    const rt = await computeRoute(origin, dest);
    const ttl = getSettingNum('quote_ttl_min') * 60_000;
    const t = now();
    const quotes = allFares().map(fare => {
      const price = computePriceCents(fare, rt.distance_m);
      const qid = id('qte');
      db.prepare(`INSERT INTO ride_quotes
        (id, user_id, category, origin_text, origin_lat, origin_lng, dest_text, dest_lat, dest_lng,
         distance_m, duration_s, price_cents, base_cents, included_m, per_km_cents,
         route_geojson, route_estimated, route_provider, route_mode, created_at, expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(qid, user!.id, fare.category, origin.text, origin.lat, origin.lng,
          dest.text, dest.lat, dest.lng, rt.distance_m, rt.duration_s, price,
          fare.base_cents, fare.included_m, fare.per_km_cents,
          JSON.stringify(rt.geometry), rt.estimated ? 1 : 0,
          rt.provider, rt.mode, t, t + ttl);
      return {
        id: qid, category: fare.category, label: fare.label,
        price_cents: price, distance_m: rt.distance_m, duration_s: rt.duration_s,
        expires_at: t + ttl,
      };
    });
    json(res, 200, {
      quotes,
      route: {
        geometry: rt.geometry, estimated: rt.estimated,
        provider: rt.provider, mode: rt.mode, mode_fallback: !!rt.mode_fallback,
      },
      online_drivers: eligibleDrivers(origin.lat, origin.lng).length,
      payment_methods: availableMethods(),
      test_mode: isTestMode(),
    });
  }),

  /**
   * Cria a corrida a partir de uma cotação do próprio usuário e abre a cobrança.
   * Pix/cartão: a corrida nasce em `pending_payment` e só vai para os
   * mototaxistas quando o provedor confirmar. Dinheiro: despacha na hora.
   */
  route('POST /api/rides', 'passenger', async ({ req, res, user }) => {
    const b = await readBody(req);
    const quoteId = reqStr(b.quote_id, 'cotação', 60);
    const method = (['dinheiro', 'pix', 'cartao'].includes(b.payment_method)
      ? b.payment_method : 'dinheiro') as Method;

    const methodInfo = availableMethods().find(m => m.method === method);
    if (!methodInfo?.enabled) {
      throw new ApiError(400, `Forma de pagamento indisponível: ${methodInfo?.note || method}.`);
    }

    const active = db.prepare(`SELECT id FROM rides WHERE passenger_id = ?
      AND status IN ('pending_payment','requested','accepted','in_progress','awaiting_confirmation')`)
      .get(user!.id) as any;
    if (active) throw new ApiError(409, 'Você já tem uma corrida em andamento.');

    const q = db.prepare('SELECT * FROM ride_quotes WHERE id = ?').get(quoteId) as any;
    if (!q || q.user_id !== user!.id) throw new ApiError(404, 'Cotação não encontrada.');
    if (q.used) throw new ApiError(409, 'Esta cotação já foi utilizada.');
    if (q.expires_at < now()) throw new ApiError(410, 'Cotação expirada. Calcule novamente.');

    // Reconfere o preço no servidor a partir dos dados persistidos da cotação.
    const expected = computePriceCents(
      {
        category: q.category, label: '', base_cents: q.base_cents,
        included_m: q.included_m, per_km_cents: q.per_km_cents,
      }, q.distance_m);
    if (expected !== q.price_cents) throw new ApiError(500, 'Inconsistência de tarifa. Calcule novamente.');

    const commissionPct = getSettingNum('commission_pct');
    const rid = id('rid');
    const t = now();
    // No modo split a cobrança só pode nascer depois que sabemos QUEM recebe,
    // então a corrida já sai procurando parceiro e o pagamento vem em seguida.
    const payLater = method !== 'dinheiro' && chargeAfterAccept();
    const initialStatus = (method === 'dinheiro' || payLater) ? 'requested' : 'pending_payment';

    db.exec('BEGIN');
    try {
      db.prepare(`INSERT INTO rides
        (id, quote_id, passenger_id, category, status, origin_text, origin_lat, origin_lng,
         dest_text, dest_lat, dest_lng, distance_m, duration_s, price_cents, commission_pct,
         payment_method, payment_status, route_geojson, route_provider, route_mode, requested_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'criado',?,?,?,?)`)
        .run(rid, q.id, user!.id, q.category, initialStatus, q.origin_text, q.origin_lat, q.origin_lng,
          q.dest_text, q.dest_lat, q.dest_lng, q.distance_m, q.duration_s, q.price_cents,
          commissionPct, method, q.route_geojson, q.route_provider, q.route_mode, t);
      db.prepare('UPDATE ride_quotes SET used = 1 WHERE id = ?').run(q.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    rideEvent(rid, 'requested', user!.id, `pagamento: ${method}`);

    if (payLater) {
      const notified = dispatchRide(getRide(rid));
      notify(user!.id, 'ride_requested', 'Procurando mototaxista…',
        {
          body: 'Você paga assim que um parceiro aceitar a corrida.',
          rideId: rid,
        });
      json(res, 201, { ride: rideViewForPassenger(getRide(rid)), notified_drivers: notified });
      return;
    }

    // Abre a cobrança no provedor.
    let payment;
    try {
      payment = await createCharge({
        rideId: rid, method, amountCents: q.price_cents,
        payerEmail: user!.email, payerName: user!.name,
        description: `Corrida Assis MotoTáxi ${q.origin_text} → ${q.dest_text}`,
        cardToken: typeof b.card_token === 'string' ? b.card_token : undefined,
        installments: 1,
        cardPaymentMethodId: typeof b.card_brand === 'string' ? b.card_brand : undefined,
        notificationUrl: process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/api/webhooks/mercadopago` : undefined,
      });
    } catch (e: any) {
      db.prepare(`UPDATE rides SET status='cancelled', cancelled_at=?, cancelled_by='sistema',
        cancel_reason=? WHERE id = ?`).run(now(), `Falha no pagamento: ${e?.message}`, rid);
      throw e;
    }

    let notified = 0;
    if (method === 'dinheiro') {
      notified = dispatchRide(getRide(rid));
      notify(user!.id, 'ride_requested', 'Procurando mototaxista…',
        { body: notified ? `${notified} mototaxista(s) avisados.` : 'Nenhum parceiro livre agora — seguimos tentando.', rideId: rid });
    } else if (isReleasable(payment)) {
      notified = releaseRideForDispatch(rid);
    } else {
      notify(user!.id, 'payment_pending', 'Conclua o pagamento',
        {
          body: method === 'pix'
            ? 'Escaneie o QR Code do Pix para liberar sua corrida.'
            : 'Estamos confirmando o pagamento do cartão.', rideId: rid, push: false,
        });
    }

    json(res, 201, {
      ride: rideViewForPassenger(getRide(rid)),
      notified_drivers: notified,
    });
  }),

  /** Polling do pagamento (Pix) — consulta o provedor e libera a corrida. */
  route('GET /api/rides/:id/payment', 'any', async ({ res, user, params }) => {
    const r = getRide(params.id);
    if (r.passenger_id !== user!.id && user!.role !== 'admin') {
      throw new ApiError(403, 'Esta corrida não é sua.');
    }
    let payment = getPaymentByRide(r.id);
    if (payment && !payment.test_mode && payment.method !== 'dinheiro'
      && ['criado', 'aguardando_pagamento'].includes(payment.status)) {
      try { payment = await syncPayment(payment); } catch { /* mantém o que temos */ }
    }
    if (payment && isReleasable(payment)) releaseRideForDispatch(r.id);
    json(res, 200, { payment: paymentView(payment), ride_status: getRide(r.id).status });
  }),

  /**
   * MODO DE TESTE apenas: simula a aprovação do provedor.
   * Bloqueado quando há credenciais reais configuradas.
   */
  route('POST /api/rides/:id/payment/test-approve', 'passenger', ({ res, user, params }) => {
    if (!isTestMode()) throw new ApiError(403, 'Indisponível: o provedor real está configurado.');
    const r = getRide(params.id);
    if (r.passenger_id !== user!.id) throw new ApiError(403, 'Esta corrida não é sua.');
    const payment = getPaymentByRide(r.id);
    if (!payment || !payment.test_mode) throw new ApiError(404, 'Cobrança de teste não encontrada.');
    applyPaymentStatus(payment, payment.method === 'cartao' ? 'autorizado' : 'pago');
    rideEvent(r.id, 'payment_test_approved', user!.id, 'aprovação simulada (modo de teste)');
    const notified = releaseRideForDispatch(r.id);
    json(res, 200, { ok: true, test_mode: true, notified_drivers: notified });
  }),

  route('GET /api/rides/active', 'passenger', ({ res, user }) => {
    const r = db.prepare(`SELECT * FROM rides WHERE passenger_id = ?
      AND status IN ('pending_payment','requested','accepted','in_progress','awaiting_confirmation','disputed')
      ORDER BY requested_at DESC LIMIT 1`).get(user!.id) as any;
    json(res, 200, { ride: r ? rideViewForPassenger(r) : null, server_time: now() });
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
    json(res, 200, { ride: rideViewForPassenger(r), server_time: now() });
  }),

  /** Confirmação da conclusão pelo passageiro (interrompe a contagem no servidor). */
  route('POST /api/rides/:id/confirm', 'passenger', async ({ res, user, params }) => {
    const r = getRide(params.id);
    if (r.passenger_id !== user!.id) throw new ApiError(403, 'Esta corrida não é sua.');
    if (r.status === 'completed') { json(res, 200, { ok: true, already: true }); return; }
    if (r.status !== 'awaiting_confirmation') {
      throw new ApiError(409, 'A corrida não está aguardando sua confirmação.');
    }
    await finalizeRide(r.id, 'passenger');
    json(res, 200, { ok: true });
  }),

  /** "Informar um problema": abre disputa e segura a liberação do pagamento. */
  route('POST /api/rides/:id/issue', 'passenger', async ({ req, res, user, params }) => {
    const r = getRide(params.id);
    if (r.passenger_id !== user!.id) throw new ApiError(403, 'Esta corrida não é sua.');
    const b = await readBody(req);
    const kind = reqStr(b.kind, 'tipo do problema', 40);
    const description = typeof b.description === 'string' ? b.description.slice(0, 1000) : '';

    if (r.status === 'awaiting_confirmation') {
      const res2 = db.prepare(`UPDATE rides SET status = 'disputed'
        WHERE id = ? AND status = 'awaiting_confirmation'`).run(r.id);
      if (res2.changes !== 1) throw new ApiError(409, 'A corrida já foi confirmada. Use o suporte.');
      rideEvent(r.id, 'disputed', user!.id, kind, 'awaiting_confirmation', 'disputed');
    } else if (!['completed', 'cancelled', 'in_progress'].includes(r.status)) {
      throw new ApiError(409, 'Não é possível abrir ocorrência neste momento.');
    } else {
      rideEvent(r.id, 'issue_opened', user!.id, kind);
    }

    const iid = id('iss');
    db.prepare(`INSERT INTO ride_issues (id, ride_id, user_id, role, kind, description, created_at)
      VALUES (?,?,?,?,?,?,?)`).run(iid, r.id, user!.id, 'passenger', kind, description, now());
    notifyAdmins('issue', '⚠️ Ocorrência aberta pelo passageiro',
      { body: `${kind} — corrida ${r.origin_text} → ${r.dest_text}`, rideId: r.id });
    if (r.driver_id) {
      notify(r.driver_id, 'issue', 'O passageiro registrou uma ocorrência',
        { body: 'Nossa equipe vai analisar. Aguarde o contato.', rideId: r.id });
    }
    sseSend(r.passenger_id, 'ride_update', { id: r.id });
    if (r.driver_id) sseSend(r.driver_id, 'ride_update', { id: r.id });
    json(res, 201, { ok: true, id: iid });
  }),

  /**
   * Atualiza o ponto de embarque quando o passageiro se move.
   * Depois do aceite o mototaxista é notificado — nunca muda em silêncio.
   */
  route('PATCH /api/rides/:id/pickup', 'passenger', async ({ req, res, user, params }) => {
    const r = getRide(params.id);
    if (r.passenger_id !== user!.id) throw new ApiError(403, 'Esta corrida não é sua.');
    if (!['pending_payment', 'requested', 'accepted'].includes(r.status)) {
      throw new ApiError(409, 'O ponto de embarque não pode mais ser alterado.');
    }
    const b = await readBody(req);
    const lat = reqNum(b.lat, 'lat'), lng = reqNum(b.lng, 'lng');
    const text = reqStr(b.text, 'endereço', 300);
    assertInCoverage({ lat, lng }, 'embarque');
    const moved = Math.round(haversineM(r.origin_lat, r.origin_lng, lat, lng));

    db.prepare(`UPDATE rides SET origin_lat = ?, origin_lng = ?, origin_text = ?,
      pickup_updated_at = ? WHERE id = ?`).run(lat, lng, text, now(), r.id);
    rideEvent(r.id, 'pickup_updated', user!.id, `${moved} m — ${text}`);

    if (r.driver_id) {
      notify(r.driver_id, 'pickup_updated', '📍 O passageiro mudou o ponto de embarque',
        { body: `Novo local: ${text} (${moved} m do anterior)`, rideId: r.id });
      sseSend(r.driver_id, 'ride_update', { id: r.id });
    }
    json(res, 200, { ok: true, moved_m: moved });
  }),

  /** Posição do passageiro durante a corrida (visível só ao mototaxista dela). */
  route('POST /api/rides/:id/location', 'passenger', async ({ req, res, user, params }) => {
    const r = getRide(params.id);
    if (r.passenger_id !== user!.id) throw new ApiError(403, 'Esta corrida não é sua.');
    if (!['requested', 'accepted', 'in_progress'].includes(r.status)) {
      json(res, 200, { ok: true, ignored: true }); return;
    }
    const b = await readBody(req);
    const lat = reqNum(b.lat, 'lat'), lng = reqNum(b.lng, 'lng');
    const acc = Number(b.accuracy_m);
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new ApiError(400, 'Coordenadas inválidas.');
    db.prepare('INSERT INTO ride_locations (ride_id, who, lat, lng, accuracy_m, at) VALUES (?,?,?,?,?,?)')
      .run(r.id, 'passenger', lat, lng, Number.isFinite(acc) ? acc : null, now());
    if (r.driver_id) {
      sseSend(r.driver_id, 'passenger_location', { ride_id: r.id, lat, lng, accuracy_m: acc });
    }
    json(res, 200, { ok: true });
  }),

  route('POST /api/rides/:id/cancel', 'passenger', async ({ req, res, user, params }) => {
    const r = getRide(params.id);
    if (r.passenger_id !== user!.id) throw new ApiError(403, 'Esta corrida não é sua.');
    const b = await readBody(req);
    await cancelRide(r, user!, typeof b.reason === 'string' && b.reason.trim()
      ? b.reason.trim().slice(0, 300) : 'Cancelada pelo passageiro');
    json(res, 200, { ok: true });
  }),

  /** Avaliação detalhada do mototaxista (uma por corrida). */
  route('POST /api/rides/:id/rate', 'passenger', async ({ req, res, user, params }) => {
    const r = getRide(params.id);
    if (r.passenger_id !== user!.id) throw new ApiError(403, 'Esta corrida não é sua.');
    if (r.status !== 'completed') throw new ApiError(409, 'Só é possível avaliar corridas concluídas.');
    if (!r.driver_id) throw new ApiError(409, 'Corrida sem mototaxista.');
    const b = await readBody(req);
    const stars = reqNum(b.stars, 'estrelas');
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new ApiError(400, 'Nota deve ser de 1 a 5.');
    const sub = (v: unknown) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
    };
    const exists = db.prepare('SELECT id FROM ratings WHERE ride_id = ?').get(r.id) as any;
    if (exists) throw new ApiError(409, 'Esta corrida já foi avaliada.');

    db.exec('BEGIN');
    try {
      db.prepare(`INSERT INTO ratings (id, ride_id, passenger_id, driver_id, stars, comment,
          score_atendimento, score_pontualidade, score_educacao, score_seguranca, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id('rat'), r.id, user!.id, r.driver_id, stars,
          typeof b.comment === 'string' ? b.comment.slice(0, 500) : null,
          sub(b.atendimento), sub(b.pontualidade), sub(b.educacao), sub(b.seguranca), now());
      db.prepare('UPDATE drivers SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE user_id = ?')
        .run(stars, r.driver_id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    notify(r.driver_id, 'rating', `Você recebeu ${stars} estrela(s) ⭐`,
      { body: typeof b.comment === 'string' && b.comment ? `"${b.comment.slice(0, 80)}"` : undefined, rideId: r.id });
    if (stars <= 2) {
      notifyAdmins('low_rating', 'Avaliação baixa registrada',
        { body: `${stars}★ na corrida ${r.id}`, rideId: r.id, push: false });
    }
    json(res, 201, { ok: true });
  }),

  // ---------- chat da corrida ----------
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
    if (!['accepted', 'in_progress', 'awaiting_confirmation'].includes(r.status)) {
      throw new ApiError(409, 'O chat só fica disponível durante a corrida.');
    }
    const b = await readBody(req);
    const body = reqStr(b.body, 'mensagem', 500);
    const mid = id('msg');
    db.prepare('INSERT INTO ride_messages (id, ride_id, sender_id, body, at) VALUES (?,?,?,?,?)')
      .run(mid, r.id, user!.id, body, now());
    const other = user!.id === r.passenger_id ? r.driver_id : r.passenger_id;
    if (other) {
      sseSend(other, 'ride_message', { ride_id: r.id, sender_name: user!.name, body, at: now() });
      notify(other, 'chat', `💬 ${user!.name.split(' ')[0]}`, { body, rideId: r.id, push: true });
    }
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
  route('GET /api/notifications', 'any', ({ res, user, query }) => {
    const since = Number(query.get('since'));
    const rows = Number.isFinite(since) && since > 0
      ? db.prepare(`SELECT * FROM notifications WHERE user_id = ? AND created_at > ?
          ORDER BY created_at DESC LIMIT 50`).all(user!.id, since)
      : db.prepare(`SELECT * FROM notifications WHERE user_id = ?
          ORDER BY created_at DESC LIMIT 50`).all(user!.id);
    json(res, 200, { notifications: rows, server_time: now() });
  }),
  route('POST /api/notifications/read', 'any', ({ res, user }) => {
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(user!.id);
    json(res, 200, { ok: true });
  }),
  route('POST /api/notifications/:id/ack', 'any', async ({ res, user, params }) => {
    const { ackNotification } = await import('./notify.ts');
    ackNotification(user!.id, params.id);
    json(res, 200, { ok: true });
  }),

  // ---------- suporte ----------
  route('POST /api/support', 'any', async ({ req, res, user }) => {
    const b = await readBody(req);
    const sid = id('sup');
    db.prepare(`INSERT INTO support_messages (id, user_id, subject, body, created_at)
      VALUES (?,?,?,?,?)`)
      .run(sid, user!.id, reqStr(b.subject, 'assunto', 150), reqStr(b.body, 'mensagem', 2000), now());
    notifyAdmins('support', 'Nova mensagem de suporte',
      { body: `${user!.name}: ${b.subject}`, push: false });
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
