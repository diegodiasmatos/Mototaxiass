/**
 * Integrações externas: webhook do provedor de pagamento e inscrição em
 * Web Push. Rotas públicas aqui são tratadas com desconfiança: assinatura
 * verificada, idempotência por evento e nenhuma confiança no corpo recebido
 * (o status real é sempre reconsultado na API do provedor).
 */
import { db, getCredential, audit } from './db.ts';
import {
  ApiError, json, readBody, reqStr, now, rateLimit,
  encryptSecret, signedState, verifySignedState,
} from './util.ts';
import { route, type Route } from './router.ts';
import {
  verifyMpSignature, registerWebhookEvent, closeWebhookEvent,
  findPaymentByProviderId, syncPayment, isTestMode, isReleasable, splitAvailable,
  connectedSeller,
} from './payments.ts';
import { releaseRideForDispatch, getRide } from './rides.ts';
import { notify, notifyAdmins, sseSend } from './notify.ts';
import { vapidPublicKey, saveSubscription, removeSubscription } from './push.ts';

function publicUrl(): string {
  return (getCredential('PUBLIC_URL') || process.env.PUBLIC_URL || '').replace(/\/$/, '');
}
function oauthRedirectUri(): string {
  return `${publicUrl()}/api/mp/oauth/callback`;
}

async function handlePaymentNotification(providerPaymentId: string): Promise<string> {
  const payment = findPaymentByProviderId(providerPaymentId);
  if (!payment) return 'pagamento desconhecido';

  const before = payment.status;
  const updated = await syncPayment(payment);
  if (updated.status === before) return `sem mudança (${before})`;

  const ride = getRide(updated.ride_id);
  if (isReleasable(updated) && ride.status === 'pending_payment') {
    releaseRideForDispatch(ride.id);
  } else if (updated.status === 'recusado') {
    notify(ride.passenger_id, 'payment_failed', 'Pagamento não aprovado',
      {
        body: updated.failure_reason
          ? `Motivo: ${updated.failure_reason}. Tente outra forma de pagamento.`
          : 'Tente novamente ou use outra forma de pagamento.',
        rideId: ride.id,
      });
  } else if (updated.status === 'estornado') {
    notify(ride.passenger_id, 'refund', 'Estorno confirmado',
      { body: 'O valor da corrida foi devolvido.', rideId: ride.id });
  }
  sseSend(ride.passenger_id, 'ride_update', { id: ride.id });
  return `${before} → ${updated.status}`;
}

export const integrationRoutes: Route[] = [

  /**
   * Webhook do Mercado Pago. Responde 200 rapidamente mesmo em caso de
   * duplicata (exigência do provedor) e nunca marca pagamento como aprovado
   * a partir do corpo recebido — sempre reconsulta a API.
   */
  route('POST /api/webhooks/mercadopago', null, async ({ req, res, query }) => {
    const body = await readBody(req).catch(() => ({}));
    const topic = String(query.get('type') || query.get('topic') || body?.type || 'payment');
    const dataId = String(
      query.get('data.id') || query.get('id') || body?.data?.id || body?.id || '');
    if (!dataId) { json(res, 200, { ok: true, ignored: 'sem id' }); return; }

    const signatureOk = verifyMpSignature(req.headers as any, dataId);
    const isNew = registerWebhookEvent('mercadopago', dataId, topic, body, signatureOk);
    if (!isNew) { json(res, 200, { ok: true, duplicate: true }); return; }

    // Em produção a assinatura é obrigatória; sem ela o evento fica registrado
    // para auditoria, mas não altera nada.
    if (!signatureOk && process.env.MP_WEBHOOK_SECRET) {
      closeWebhookEvent(dataId, topic, 'assinatura inválida — ignorado');
      notifyAdmins('webhook', '⚠️ Webhook com assinatura inválida',
        { body: `Pagamento ${dataId}`, push: false });
      json(res, 401, { error: 'assinatura inválida' });
      return;
    }

    let result = 'ignorado';
    try {
      if (topic === 'payment') result = await handlePaymentNotification(dataId);
    } catch (e: any) {
      result = `erro: ${e?.message || e}`;
    }
    closeWebhookEvent(dataId, topic, result);
    json(res, 200, { ok: true, result });
  }),

  // Mercado Pago também faz GET de verificação ao cadastrar a URL.
  route('GET /api/webhooks/mercadopago', null, ({ res }) => {
    json(res, 200, { ok: true, service: 'assis-mototaxi', test_mode: isTestMode() });
  }),

  // ---------------- OAuth: conta do mototaxista (split automático) ----------------

  /** Situação da conexão do parceiro com o Mercado Pago. */
  route('GET /api/driver/mp/status', 'driver', async ({ res, user }) => {
    const d = db.prepare(`SELECT mp_user_id, mp_nickname, mp_connected_at
      FROM drivers WHERE user_id = ?`).get(user!.id) as any;
    json(res, 200, {
      available: splitAvailable(),
      configured: !!publicUrl(),
      connected: !!d?.mp_user_id,
      nickname: d?.mp_nickname ?? null,
      connected_at: d?.mp_connected_at ?? null,
    });
  }),

  /** Monta o link de autorização (state assinado evita CSRF). */
  route('GET /api/driver/mp/connect-url', 'driver', ({ res, user }) => {
    if (!splitAvailable()) {
      throw new ApiError(503,
        'O recebimento direto ainda não foi habilitado pela administração.');
    }
    if (!publicUrl()) {
      throw new ApiError(503, 'A plataforma precisa estar publicada com endereço fixo (HTTPS).');
    }
    const url = new URL('https://auth.mercadopago.com.br/authorization');
    url.searchParams.set('client_id', getCredential('MP_CLIENT_ID')!);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('platform_id', 'mp');
    url.searchParams.set('redirect_uri', oauthRedirectUri());
    url.searchParams.set('state', signedState(user!.id));
    json(res, 200, { url: url.toString() });
  }),

  /**
   * Retorno do Mercado Pago. Troca o código pelos tokens do parceiro e os
   * guarda cifrados. A partir daqui as corridas dele podem ser cobradas
   * direto na sua conta, com a comissão retida pela plataforma.
   */
  route('GET /api/mp/oauth/callback', null, async ({ res, query }) => {
    const page = (titulo: string, msg: string, ok: boolean) => {
      const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>${titulo}</title><link rel="stylesheet" href="/css/app.css"></head>
        <body><main class="app"><div class="card center" style="margin-top:22vh">
        <div style="font-size:3rem">${ok ? '✅' : '⚠️'}</div>
        <h2 class="mt">${titulo}</h2><p class="muted mt">${msg}</p>
        <a class="btn btn-primary mt" href="/motorista">Voltar ao aplicativo</a>
        </div></main></body></html>`;
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    };

    const code = query.get('code');
    const driverId = verifySignedState(query.get('state') || '');
    if (!code || !driverId) {
      page('Não foi possível conectar', 'O link expirou ou é inválido. Tente de novo pelo aplicativo.', false);
      return;
    }
    try {
      const r = await fetch('https://api.mercadopago.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: getCredential('MP_CLIENT_ID'),
          client_secret: getCredential('MP_CLIENT_SECRET'),
          grant_type: 'authorization_code',
          code,
          redirect_uri: oauthRedirectUri(),
        }),
        signal: AbortSignal.timeout(15000),
      });
      const d: any = await r.json();
      if (!r.ok || !d.access_token) {
        page('Não foi possível conectar', d?.message || 'O Mercado Pago recusou a autorização.', false);
        return;
      }
      db.prepare(`UPDATE drivers SET mp_user_id = ?, mp_access_token_enc = ?,
          mp_refresh_token_enc = ?, mp_expires_at = ?, mp_connected_at = ?, mp_nickname = ?
        WHERE user_id = ?`)
        .run(String(d.user_id), encryptSecret(d.access_token),
          encryptSecret(d.refresh_token || ''), now() + (Number(d.expires_in) || 15552000) * 1000,
          now(), d.nickname ?? null, driverId);
      notify(driverId, 'mp_connected', '✅ Conta Mercado Pago conectada',
        { body: 'A partir de agora o valor das corridas cai direto na sua conta.' });
      notifyAdmins('mp_connected', 'Mototaxista conectou a conta Mercado Pago',
        { body: `Parceiro ${driverId}`, push: false });
      page('Conta conectada!', 'O valor das suas corridas passa a cair direto na sua conta Mercado Pago.', true);
    } catch (e: any) {
      page('Não foi possível conectar', e?.message || 'Falha de comunicação com o Mercado Pago.', false);
    }
  }),

  route('POST /api/driver/mp/disconnect', 'driver', ({ res, user }) => {
    db.prepare(`UPDATE drivers SET mp_user_id = NULL, mp_access_token_enc = NULL,
      mp_refresh_token_enc = NULL, mp_expires_at = NULL, mp_connected_at = NULL,
      mp_nickname = NULL WHERE user_id = ?`).run(user!.id);
    json(res, 200, { ok: true });
  }),

  // ---------------- Web Push ----------------
  route('GET /api/push/key', 'any', ({ res }) => {
    json(res, 200, { publicKey: vapidPublicKey() });
  }),

  route('POST /api/push/subscribe', 'any', async ({ req, res, user, ip }) => {
    if (!rateLimit(`push:${ip}`, 30, 60_000)) throw new ApiError(429, 'Aguarde um instante.');
    const b = await readBody(req);
    const endpoint = reqStr(b.endpoint, 'endpoint', 600);
    if (!/^https:\/\//.test(endpoint)) throw new ApiError(400, 'Endpoint inválido.');
    const p256dh = reqStr(b.keys?.p256dh, 'chave p256dh', 200);
    const auth = reqStr(b.keys?.auth, 'chave auth', 100);
    saveSubscription(user!.id, { endpoint, keys: { p256dh, auth } },
      String(req.headers['user-agent'] || ''));
    json(res, 201, { ok: true });
  }),

  route('POST /api/push/unsubscribe', 'any', async ({ req, res }) => {
    const b = await readBody(req);
    if (typeof b.endpoint === 'string') removeSubscription(b.endpoint);
    json(res, 200, { ok: true });
  }),

  /** Envia uma notificação de teste para os aparelhos do próprio usuário. */
  route('POST /api/push/test', 'any', async ({ res, user }) => {
    const { pushToUser } = await import('./push.ts');
    const sent = await pushToUser(user!.id, {
      title: 'VAIRO 🏍️',
      body: 'Notificações ativadas! Você será avisado das corridas por aqui.',
      kind: 'test',
    });
    const subs = (db.prepare('SELECT COUNT(*) c FROM push_subscriptions WHERE user_id = ?')
      .get(user!.id) as any).c;
    json(res, 200, { ok: true, sent, devices: subs });
  }),
];
