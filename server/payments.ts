/**
 * Pagamentos — integração real com provedor + livro-caixa imutável.
 *
 * Provedor padrão: Mercado Pago (PIX e cartão, cobertura nacional, conta PJ ou
 * PF, sem mensalidade). Ativado quando `MP_ACCESS_TOKEN` existe no ambiente.
 *
 * Sem credenciais o sistema entra em MODO DE TESTE: as cobranças são criadas e
 * acompanhadas normalmente, porém marcadas com `test_mode = 1` e identificadas
 * na interface. NENHUM valor real é movimentado e nenhum pagamento é dado como
 * aprovado sozinho — a aprovação em teste exige ação explícita no botão
 * "simular aprovação (modo teste)".
 *
 * Modelo financeiro: a plataforma recebe o valor integral na própria conta e o
 * sistema separa automaticamente comissão e valor líquido do mototaxista no
 * livro-caixa. O repasse é registrado em `payouts`. O split automático na conta
 * do parceiro (marketplace) exige que ele conecte a conta via OAuth — os campos
 * estão preparados e a decisão está documentada no README.
 */
import crypto from 'node:crypto';
import { db, getSetting, getSettingNum, getCredential } from './db.ts';
import { ApiError, id, now, decryptSecret, encryptSecret } from './util.ts';

export type Method = 'dinheiro' | 'pix' | 'cartao';

export type PaymentStatus =
  | 'criado' | 'aguardando_pagamento' | 'autorizado' | 'pago' | 'recusado'
  | 'estornado' | 'cancelado' | 'dinheiro_pendente' | 'dinheiro_recebido' | 'expirado';

const MP_API = 'https://api.mercadopago.com';

export function providerName(): 'mercadopago' | 'teste' {
  const forced = getSetting('payment_provider');
  if (forced === 'teste') return 'teste';
  return getCredential('MP_ACCESS_TOKEN') ? 'mercadopago' : 'teste';
}
export function isTestMode(): boolean { return providerName() === 'teste'; }

/** O split automático exige o app OAuth do Mercado Pago configurado. */
export function splitAvailable(): boolean {
  return !!(getCredential('MP_CLIENT_ID') && getCredential('MP_CLIENT_SECRET')
    && getCredential('MP_ACCESS_TOKEN'));
}

export interface ConnectedSeller {
  driver_id: string; mp_user_id: string; access_token: string; nickname: string | null;
}

/** Conta Mercado Pago do mototaxista, se ele conectou (renova o token se preciso). */
export async function connectedSeller(driverId: string): Promise<ConnectedSeller | null> {
  const d = db.prepare(`SELECT user_id, mp_user_id, mp_access_token_enc, mp_refresh_token_enc,
      mp_expires_at, mp_nickname FROM drivers WHERE user_id = ?`).get(driverId) as any;
  if (!d?.mp_user_id || !d.mp_access_token_enc) return null;

  let token = decryptSecret(d.mp_access_token_enc);
  // renova com uma folga de 5 minutos
  if (d.mp_expires_at && d.mp_expires_at - 5 * 60_000 < now()) {
    const refreshed = await refreshSellerToken(driverId, decryptSecret(d.mp_refresh_token_enc));
    if (!refreshed) return null;
    token = refreshed;
  }
  if (!token) return null;
  return { driver_id: d.user_id, mp_user_id: d.mp_user_id, access_token: token, nickname: d.mp_nickname };
}

async function refreshSellerToken(driverId: string, refreshToken: string | null): Promise<string | null> {
  if (!refreshToken) return null;
  try {
    const r = await fetch(`${MP_API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: getCredential('MP_CLIENT_ID'),
        client_secret: getCredential('MP_CLIENT_SECRET'),
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    const d: any = await r.json();
    db.prepare(`UPDATE drivers SET mp_access_token_enc = ?, mp_refresh_token_enc = ?,
      mp_expires_at = ? WHERE user_id = ?`)
      .run(encryptSecret(d.access_token), encryptSecret(d.refresh_token || refreshToken),
        now() + (Number(d.expires_in) || 15552000) * 1000, driverId);
    return d.access_token;
  } catch { return null; }
}

/** Métodos realmente disponíveis agora (o cartão exige chave pública no front). */
export function availableMethods(): { method: Method; label: string; enabled: boolean; note?: string }[] {
  const test = isTestMode();
  const hasPublicKey = !!getCredential('MP_PUBLIC_KEY');
  return [
    {
      method: 'pix', label: 'Pix', enabled: getSetting('pix_enabled') === '1',
      note: test ? 'modo de teste — nenhum valor real é cobrado' : undefined,
    },
    {
      method: 'cartao', label: 'Cartão de crédito',
      enabled: getSetting('card_enabled') === '1' && (test || hasPublicKey),
      note: test ? 'modo de teste — nenhum valor real é cobrado'
        : (!hasPublicKey ? 'indisponível: falta a chave pública do Mercado Pago' : undefined),
    },
    {
      method: 'dinheiro', label: 'Dinheiro', enabled: getSetting('cash_enabled') === '1',
      note: 'pago direto ao mototaxista; a comissão fica registrada como dívida sua na plataforma',
    },
  ];
}

// ---------------------------------------------------------------
// HTTP do provedor
// ---------------------------------------------------------------

async function mpFetch(path: string,
  init: RequestInit & { idempotency?: string; token?: string } = {}): Promise<any> {
  const token = init.token || getCredential('MP_ACCESS_TOKEN');
  if (!token) throw new ApiError(503, 'Provedor de pagamento não configurado.');
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (init.idempotency) headers['X-Idempotency-Key'] = init.idempotency;
  const r = await fetch(MP_API + path, {
    ...init, headers: { ...headers, ...(init.headers as any) },
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    const msg = data?.message || data?.error || `HTTP ${r.status}`;
    throw new ApiError(r.status === 400 ? 400 : 502, `Provedor de pagamento: ${msg}`);
  }
  return data;
}

/** Converte o status do Mercado Pago para o nosso vocabulário. */
function mapMpStatus(s: string, captured: boolean): PaymentStatus {
  switch (s) {
    case 'approved': return captured ? 'pago' : 'autorizado';
    case 'authorized': return 'autorizado';
    case 'pending': case 'in_process': return 'aguardando_pagamento';
    case 'rejected': return 'recusado';
    case 'refunded': case 'charged_back': return 'estornado';
    case 'cancelled': return 'cancelado';
    default: return 'aguardando_pagamento';
  }
}

// ---------------------------------------------------------------
// Livro-caixa (imutável: só inserts, nunca update/delete)
// ---------------------------------------------------------------

export function ledger(kind: string, amountCents: number, opts: {
  rideId?: string; paymentId?: string; driverId?: string; description?: string; testMode?: boolean;
} = {}): void {
  db.prepare(`INSERT INTO financial_transactions
    (id, ride_id, payment_id, driver_id, kind, amount_cents, description, test_mode, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id('ftx'), opts.rideId ?? null, opts.paymentId ?? null, opts.driverId ?? null,
      kind, Math.round(amountCents), opts.description ?? null, opts.testMode ? 1 : 0, now());
}

export interface DriverBalance {
  earned_cents: number;      // repasses devidos (cobrados pela plataforma)
  paid_cents: number;        // repasses já efetuados
  pending_cents: number;     // a receber da plataforma
  debt_cents: number;        // comissão devida por corridas em dinheiro
  auto_cents: number;        // recebido direto na conta dele (split automático)
}

export function driverBalance(driverId: string): DriverBalance {
  const sum = (kind: string) => (db.prepare(
    `SELECT COALESCE(SUM(amount_cents),0) v FROM financial_transactions
     WHERE driver_id = ? AND kind = ?`).get(driverId, kind) as any).v as number;
  const earned = sum('repasse_devido');
  const paid = sum('repasse_pago');
  const debt = sum('divida_comissao') - sum('quitacao_divida');
  return {
    earned_cents: earned, paid_cents: paid,
    pending_cents: earned - paid, debt_cents: debt,
    auto_cents: sum('repasse_automatico'),
  };
}

// ---------------------------------------------------------------
// Criação da cobrança
// ---------------------------------------------------------------

export interface ChargeInput {
  rideId: string;
  method: Method;
  amountCents: number;
  payerEmail: string;
  payerName: string;
  description: string;
  cardToken?: string;
  installments?: number;
  cardPaymentMethodId?: string;
  notificationUrl?: string;
  /** mototaxista que recebe direto (split automático), quando já definido */
  sellerDriverId?: string;
  /** comissão retida pela plataforma no split */
  applicationFeeCents?: number;
}

export interface PaymentRow {
  id: string; ride_id: string; provider: string; provider_payment_id: string | null;
  method: Method; status: PaymentStatus; amount_cents: number;
  test_mode: number; pix_qr_code: string | null; pix_qr_base64: string | null;
  pix_expires_at: number | null; ticket_url: string | null; failure_reason: string | null;
  [k: string]: any;
}

export function getPaymentByRide(rideId: string): PaymentRow | null {
  return (db.prepare('SELECT * FROM payments WHERE ride_id = ?').get(rideId) as any) ?? null;
}

/**
 * Cria a cobrança da corrida. Dinheiro não gera cobrança no provedor:
 * registra a dívida de comissão do mototaxista no livro-caixa ao concluir.
 */
export async function createCharge(input: ChargeInput): Promise<PaymentRow> {
  const existing = getPaymentByRide(input.rideId);
  if (existing) return existing;              // idempotente por corrida

  const pid = id('pay');
  const test = isTestMode();
  const t = now();
  const idem = crypto.createHash('sha256').update(`${input.rideId}|${input.amountCents}`).digest('hex');

  let status: PaymentStatus = 'criado';
  let providerPaymentId: string | null = null;
  let splitSeller: string | null = null;
  let pixQr: string | null = null, pixQrB64: string | null = null, ticket: string | null = null;
  let pixExpires: number | null = null;
  let failure: string | null = null;

  if (input.method === 'dinheiro') {
    status = 'dinheiro_pendente';
  } else if (test) {
    // Modo de teste: cobrança registrada, aguardando aprovação explícita.
    status = 'aguardando_pagamento';
    providerPaymentId = `teste_${pid}`;
    if (input.method === 'pix') {
      pixExpires = t + getSettingNum('pix_expires_min') * 60_000;
      pixQr = `MODO-DE-TESTE-SEM-VALOR-REAL|${pid}|${input.amountCents}`;
    }
  } else {
    const expires = new Date(t + getSettingNum('pix_expires_min') * 60_000);
    const body: any = {
      transaction_amount: Number((input.amountCents / 100).toFixed(2)),
      description: input.description,
      external_reference: input.rideId,
      notification_url: input.notificationUrl,
      payer: { email: input.payerEmail, first_name: input.payerName.split(' ')[0] },
    };
    if (input.method === 'pix') {
      body.payment_method_id = 'pix';
      body.date_of_expiration = expires.toISOString().replace('Z', '-00:00');
    } else {
      if (!input.cardToken) throw new ApiError(400, 'Dados do cartão ausentes.');
      body.token = input.cardToken;
      body.installments = input.installments || 1;
      body.payment_method_id = input.cardPaymentMethodId;
      body.capture = false;                   // autoriza agora, captura ao concluir
    }

    // Split automático: cobra NA CONTA do mototaxista e retém a comissão.
    // O dinheiro cai direto para ele; a plataforma recebe a taxa na hora.
    let sellerToken: string | undefined;
    if (input.sellerDriverId) {
      const seller = await connectedSeller(input.sellerDriverId);
      if (seller) {
        sellerToken = seller.access_token;
        splitSeller = seller.driver_id;
        body.application_fee = Number(((input.applicationFeeCents ?? 0) / 100).toFixed(2));
      }
    }

    const resp = await mpFetch('/v1/payments', {
      method: 'POST', body: JSON.stringify(body), idempotency: idem, token: sellerToken,
    });
    providerPaymentId = String(resp.id);
    status = mapMpStatus(resp.status, false);
    failure = resp.status_detail && resp.status === 'rejected' ? String(resp.status_detail) : null;
    const tx = resp.point_of_interaction?.transaction_data;
    pixQr = tx?.qr_code ?? null;
    pixQrB64 = tx?.qr_code_base64 ?? null;
    ticket = tx?.ticket_url ?? resp.transaction_details?.external_resource_url ?? null;
    if (input.method === 'pix') pixExpires = expires.getTime();
  }

  db.prepare(`INSERT INTO payments
    (id, ride_id, provider, provider_payment_id, method, status, amount_cents,
     test_mode, pix_qr_code, pix_qr_base64, pix_expires_at, ticket_url, failure_reason,
     idempotency_key, seller_driver_id, application_fee_cents, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(pid, input.rideId, input.method === 'dinheiro' ? 'dinheiro' : providerName(),
      providerPaymentId, input.method, status, input.amountCents, test ? 1 : 0,
      pixQr, pixQrB64, pixExpires, ticket, failure, idem,
      splitSeller, splitSeller ? (input.applicationFeeCents ?? 0) : null, t, t);

  db.prepare('UPDATE rides SET payment_id = ?, payment_status = ? WHERE id = ?')
    .run(pid, status, input.rideId);

  return getPaymentByRide(input.rideId)!;
}

/** Atualiza o status de um pagamento de forma idempotente e registra o caixa. */
export function applyPaymentStatus(payment: PaymentRow, status: PaymentStatus,
  extra: { feeCents?: number; failure?: string } = {}): PaymentRow {
  if (payment.status === status) return payment;
  // estados finais não retrocedem
  const FINAL: PaymentStatus[] = ['estornado', 'cancelado'];
  if (FINAL.includes(payment.status as PaymentStatus)) return payment;

  const t = now();
  db.prepare(`UPDATE payments SET status = ?, updated_at = ?,
      provider_fee_cents = COALESCE(?, provider_fee_cents),
      failure_reason = COALESCE(?, failure_reason),
      paid_at = CASE WHEN ? IN ('pago','dinheiro_recebido') AND paid_at IS NULL THEN ? ELSE paid_at END,
      refunded_at = CASE WHEN ? = 'estornado' THEN ? ELSE refunded_at END
    WHERE id = ?`)
    .run(status, t, extra.feeCents ?? null, extra.failure ?? null,
      status, t, status, t, payment.id);
  db.prepare('UPDATE rides SET payment_status = ? WHERE id = ?').run(status, payment.ride_id);

  if (extra.feeCents) {
    ledger('taxa_provedor', extra.feeCents, {
      rideId: payment.ride_id, paymentId: payment.id,
      description: 'Tarifa do provedor de pagamento', testMode: !!payment.test_mode,
    });
  }
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id) as any;
}

/** Token da conta que processou a cobrança (parceiro no split, senão plataforma). */
async function tokenFor(payment: PaymentRow): Promise<string | undefined> {
  if (!payment.seller_driver_id) return undefined;
  return (await connectedSeller(payment.seller_driver_id))?.access_token;
}

/** Captura (cartão) ou confirma o recebimento, ao concluir a corrida. */
export async function capturePayment(payment: PaymentRow): Promise<PaymentRow> {
  if (payment.method === 'dinheiro') {
    return applyPaymentStatus(payment, 'dinheiro_recebido');
  }
  if (payment.status === 'pago') return payment;

  if (payment.test_mode) {
    // Em teste só captura o que foi "aprovado" explicitamente antes.
    return payment.status === 'autorizado' ? applyPaymentStatus(payment, 'pago') : payment;
  }
  if (payment.method === 'cartao' && payment.status === 'autorizado') {
    const resp = await mpFetch(`/v1/payments/${payment.provider_payment_id}`, {
      method: 'PUT', body: JSON.stringify({ capture: true }), token: await tokenFor(payment),
    });
    const st = mapMpStatus(resp.status, true);
    const fee = Math.round((resp.fee_details?.reduce((s: number, f: any) => s + (f.amount || 0), 0) || 0) * 100);
    const updated = applyPaymentStatus(payment, st, { feeCents: fee || undefined });
    db.prepare('UPDATE payments SET captured_at = ? WHERE id = ?').run(now(), payment.id);
    return updated;
  }
  return payment;
}

export async function refundPayment(payment: PaymentRow, reason: string): Promise<PaymentRow> {
  if (payment.method === 'dinheiro') {
    throw new ApiError(400, 'Pagamento em dinheiro não passou pela plataforma; não há o que estornar.');
  }
  if (!['pago', 'autorizado', 'aguardando_pagamento'].includes(payment.status)) {
    throw new ApiError(409, `Não é possível estornar um pagamento com status "${payment.status}".`);
  }
  if (!payment.test_mode) {
    await mpFetch(`/v1/payments/${payment.provider_payment_id}/refunds`, {
      method: 'POST', body: JSON.stringify({}), idempotency: `refund_${payment.id}`,
      token: await tokenFor(payment),
    });
  }
  const updated = applyPaymentStatus(payment, 'estornado', { failure: reason });
  ledger('estorno', payment.amount_cents, {
    rideId: payment.ride_id, paymentId: payment.id,
    description: reason, testMode: !!payment.test_mode,
  });
  return updated;
}

/** Consulta o provedor e sincroniza (usado por polling e pelo webhook). */
export async function syncPayment(payment: PaymentRow): Promise<PaymentRow> {
  if (payment.test_mode || payment.method === 'dinheiro' || !payment.provider_payment_id) return payment;
  const resp = await mpFetch(`/v1/payments/${payment.provider_payment_id}`,
    { token: await tokenFor(payment) });
  const captured = resp.captured !== false;
  const fee = Math.round((resp.fee_details?.reduce((s: number, f: any) => s + (f.amount || 0), 0) || 0) * 100);
  return applyPaymentStatus(payment, mapMpStatus(resp.status, captured), {
    feeCents: fee || undefined,
    failure: resp.status === 'rejected' ? String(resp.status_detail || '') : undefined,
  });
}

/** O pagamento já permite despachar a corrida para os mototaxistas? */
export function isReleasable(payment: PaymentRow): boolean {
  return payment.method === 'dinheiro'
    ? payment.status === 'dinheiro_pendente'
    : ['pago', 'autorizado'].includes(payment.status);
}

// ---------------------------------------------------------------
// Webhook do Mercado Pago (assinatura obrigatória em produção)
// ---------------------------------------------------------------

/**
 * Valida `x-signature` conforme a documentação do Mercado Pago:
 * manifest = "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" e
 * HMAC-SHA256 com MP_WEBHOOK_SECRET.
 */
export function verifyMpSignature(headers: Record<string, any>, dataId: string): boolean {
  const secret = getCredential('MP_WEBHOOK_SECRET');
  if (!secret) return false;
  const sig = String(headers['x-signature'] || '');
  const requestId = String(headers['x-request-id'] || '');
  const parts = Object.fromEntries(sig.split(',').map(p => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  if (!parts.ts || !parts.v1) return false;
  // rejeita repetições antigas (> 10 min)
  const tsMs = Number(parts.ts) * (String(parts.ts).length > 10 ? 1 : 1000);
  if (Number.isFinite(tsMs) && Math.abs(now() - tsMs) > 10 * 60_000) return false;

  const manifest = `id:${dataId};request-id:${requestId};ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(parts.v1));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Registra o evento e devolve false se já tiver sido processado (idempotência). */
export function registerWebhookEvent(provider: string, externalId: string,
  topic: string, payload: unknown, signatureOk: boolean): boolean {
  try {
    db.prepare(`INSERT INTO webhook_events
      (id, provider, external_id, topic, payload, signature_ok, received_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run(id('whk'), provider, externalId, topic,
        JSON.stringify(payload).slice(0, 8000), signatureOk ? 1 : 0, now());
    return true;
  } catch {
    return false; // UNIQUE(provider, external_id, topic) → duplicado
  }
}

export function closeWebhookEvent(externalId: string, topic: string, result: string): void {
  db.prepare(`UPDATE webhook_events SET processed_at = ?, result = ?
    WHERE external_id = ? AND topic = ? AND processed_at IS NULL`)
    .run(now(), result.slice(0, 300), externalId, topic);
}

export function findPaymentByProviderId(providerId: string): PaymentRow | null {
  return (db.prepare('SELECT * FROM payments WHERE provider_payment_id = ?')
    .get(providerId) as any) ?? null;
}
