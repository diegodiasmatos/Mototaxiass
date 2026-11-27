/**
 * Carteira do mototaxista: resumo, extrato, chave Pix, saques (a cada 48 h)
 * e o módulo de saques da central.
 *
 * Regras (todas calculadas aqui, no servidor):
 *  - comissão de cada corrida = percentual gravado na corrida (15% hoje),
 *    lançado no livro-caixa ao concluir (digital: só com pagamento confirmado);
 *  - corrida em dinheiro: o parceiro fica com 100% e a comissão vira dívida,
 *    descontada INTEIRA no próximo saque;
 *  - saque líquido = saldo disponível − comissão pendente (nunca negativo);
 *  - um saque a cada 48 h (relógio do servidor), contado do pedido aceito;
 *    saque recusado ou cancelado libera o prazo e devolve tudo;
 *  - nada é apagado: reserva/devolução e desconto/estorno são lançamentos.
 */
import { db, audit, getSettingNum } from './db.ts';
import {
  ApiError, json, now, id, readBody, reqStr, rateLimit, isValidCpf, isValidEmail,
  encryptSecret, decryptSecret,
} from './util.ts';
import { route, type Route } from './router.ts';
import { ledger, tx, driverBalance } from './payments.ts';
import { notify, notifyAdmins } from './notify.ts';

const OPEN = ['aguardando_aprovacao', 'aprovado', 'em_processamento'];
export const STATUS_PT: Record<string, string> = {
  aguardando_aprovacao: 'Aguardando aprovação', aprovado: 'Aprovado', em_processamento: 'Em processamento',
  pago: 'Pago', rejeitado: 'Rejeitado', cancelado: 'Cancelado',
};
const brl = (c: number) => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`;
const intervalMs = () => Math.max(0, getSettingNum('withdrawal_interval_h') || 48) * 3600_000;

// ---------------- chave Pix ----------------

type PixType = 'cpf' | 'telefone' | 'email' | 'aleatoria';

/** Normaliza e valida a chave; CPF precisa ser o do próprio cadastro (titularidade). */
export function normalizePix(type: string, key: string, ownCpf: string | null): string {
  const k = String(key || '').trim();
  switch (type as PixType) {
    case 'cpf': {
      const d = k.replace(/\D/g, '');
      if (!isValidCpf(d)) throw new ApiError(400, 'CPF da chave Pix inválido.');
      if (!ownCpf || d !== String(ownCpf).replace(/\D/g, '')) {
        throw new ApiError(400, 'A chave CPF precisa ser o mesmo CPF do seu cadastro (a conta deve estar no seu nome).');
      }
      return d;
    }
    case 'telefone': {
      let d = k.replace(/\D/g, '');
      if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
      if (!/^\d{10,11}$/.test(d)) throw new ApiError(400, 'Telefone da chave Pix inválido (DDD + número).');
      return `+55${d}`;
    }
    case 'email':
      if (!isValidEmail(k)) throw new ApiError(400, 'E-mail da chave Pix inválido.');
      return k.toLowerCase();
    case 'aleatoria':
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) {
        throw new ApiError(400, 'Chave aleatória inválida (formato 8-4-4-4-12).');
      }
      return k.toLowerCase();
    default:
      throw new ApiError(400, 'Tipo de chave Pix inválido.');
  }
}

export function maskPix(type: string | null, key: string | null): string | null {
  if (!type || !key) return null;
  if (type === 'cpf') return `***.${key.slice(3, 6)}.${key.slice(6, 9)}-**`;
  if (type === 'telefone') return `(${key.slice(3, 5)}) *****-${key.slice(-4)}`;
  if (type === 'email') { const [u, d] = key.split('@'); return `${u.slice(0, 2)}***@${d}`; }
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function pixOf(driverId: string): { type: string; key: string; holder: string; updated_at: number } | null {
  const d = db.prepare('SELECT pix_type, pix_key_enc, pix_holder, pix_updated_at FROM drivers WHERE user_id = ?')
    .get(driverId) as any;
  const key = d?.pix_key_enc ? decryptSecret(d.pix_key_enc) : null;
  return key ? { type: d.pix_type, key, holder: d.pix_holder, updated_at: d.pix_updated_at } : null;
}

// ---------------- resumo ----------------

/** Próximo saque permitido: 48 h depois do último pedido ACEITO (recusado/cancelado não conta). */
export function nextWithdrawalAt(driverId: string): number | null {
  const last = (db.prepare(`SELECT MAX(created_at) t FROM payouts WHERE driver_id = ? AND origin = 'motorista'
    AND status NOT IN ('rejeitado','cancelado')`).get(driverId) as any).t as number | null;
  return last ? last + intervalMs() : null;
}

export function walletSummary(driverId: string) {
  const bal = driverBalance(driverId);
  const rides = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(price_cents),0) gross,
      COALESCE(SUM(CASE WHEN payment_method <> 'dinheiro' THEN price_cents ELSE 0 END),0) digital_gross,
      COALESCE(SUM(CASE WHEN payment_method = 'dinheiro' THEN price_cents ELSE 0 END),0) cash_gross,
      COALESCE(SUM(commission_cents),0) commission, COALESCE(SUM(driver_cents),0) net
    FROM rides WHERE driver_id = ? AND status = 'completed'`).get(driverId) as any;
  const lastPaid = db.prepare(`SELECT id, amount_cents, paid_at, origin FROM payouts WHERE driver_id = ? AND status = 'pago'
    ORDER BY paid_at DESC LIMIT 1`).get(driverId) as any;
  const open = db.prepare(`SELECT * FROM payouts WHERE driver_id = ? AND origin = 'motorista'
    AND status IN ('aguardando_aprovacao','aprovado','em_processamento')`).get(driverId) as any;
  const next = nextWithdrawalAt(driverId);
  const pix = pixOf(driverId);
  const t = now();
  let blocked: string | null = null;
  if (open) blocked = 'Você já tem um saque em andamento.';
  else if (next && next > t) blocked = 'Aguarde o intervalo de 48 horas entre saques.';
  else if (!pix) blocked = 'Cadastre sua chave Pix para sacar.';
  else if (bal.pending_cents <= 0) blocked = 'Sem saldo disponível para saque.';
  else if (bal.withdrawable_cents <= 0) {
    blocked = `Sua comissão pendente (${brl(bal.debt_cents)}) é maior ou igual ao saldo (${brl(bal.pending_cents)}). `
      + 'Acumule saldo de corridas digitais suficiente para quitá-la.';
  }
  return {
    commission_pct: getSettingNum('commission_pct'),
    totals: {
      rides: rides.n, gross_cents: rides.gross, digital_gross_cents: rides.digital_gross,
      cash_gross_cents: rides.cash_gross, commission_cents: rides.commission, net_cents: rides.net,
      digital_net_cents: bal.earned_cents, cash_net_cents: rides.cash_gross - (db.prepare(`SELECT COALESCE(SUM(commission_cents),0) v
        FROM rides WHERE driver_id = ? AND status = 'completed' AND payment_method = 'dinheiro'`).get(driverId) as any).v,
    },
    balance: bal,
    available_cents: bal.pending_cents,         // saldo bruto
    pending_commission_cents: bal.debt_cents,   // comissão de dinheiro a descontar
    withdrawable_cents: bal.withdrawable_cents, // líquido que pode sacar agora
    last_paid: lastPaid ? { amount_cents: lastPaid.amount_cents, paid_at: lastPaid.paid_at } : null,
    next_withdrawal_at: next && next > t ? next : null,
    interval_hours: intervalMs() / 3600_000,
    open: open ? publicPayout(open) : null,
    can_withdraw: !blocked,
    blocked_reason: blocked,
    pix: pix ? { type: pix.type, masked: maskPix(pix.type, pix.key), holder: pix.holder, updated_at: pix.updated_at } : null,
    server_time: t,
  };
}

function publicPayout(p: any) {
  return {
    id: p.id, origin: p.origin, status: p.status, status_label: STATUS_PT[p.status] || p.status,
    gross_cents: p.gross_cents, debt_cents: p.debt_cents, amount_cents: p.amount_cents, fees_cents: 0,
    method: p.method, pix_type: p.pix_type, pix_masked: p.pix_key_enc ? maskPix(p.pix_type, decryptSecret(p.pix_key_enc)) : null,
    pix_holder: p.pix_holder, reference: p.reference, reason: p.reason,
    created_at: p.created_at, approved_at: p.approved_at, processing_at: p.processing_at,
    paid_at: p.paid_at, rejected_at: p.rejected_at, cancelled_at: p.cancelled_at,
  };
}

// ---------------- extrato ----------------

const KIND_PT: Record<string, string> = {
  cobranca: 'Corrida concluída (valor total)',
  comissao: 'Comissão VAIRO',
  repasse_devido: 'Ganho líquido na carteira',
  repasse_automatico: 'Recebido direto na sua conta Mercado Pago',
  divida_comissao: 'Comissão pendente (corrida em dinheiro)',
  quitacao_divida: 'Comissão descontada/quitada',
  quitacao_estorno: 'Desconto de comissão devolvido',
  saque_reserva: 'Saque solicitado (valor reservado)',
  saque_devolucao: 'Saque devolvido à carteira',
  saque_pago: 'Saque pago (transferido para você)',
  repasse_pago: 'Repasse feito pela central',
  ajuste_repasse: 'Estorno de corrida (ganho desfeito)',
  estorno_comissao: 'Comissão desfeita por estorno',
};
/** Efeito no saldo disponível (+ entra, − sai, 0 informativo) e na comissão pendente. */
const EFFECT: Record<string, { saldo: number; comissao: number }> = {
  repasse_devido: { saldo: 1, comissao: 0 }, ajuste_repasse: { saldo: 1, comissao: 0 },
  saque_reserva: { saldo: -1, comissao: 0 }, saque_devolucao: { saldo: 1, comissao: 0 },
  repasse_pago: { saldo: -1, comissao: 0 },
  divida_comissao: { saldo: 0, comissao: 1 }, quitacao_divida: { saldo: 0, comissao: -1 },
  quitacao_estorno: { saldo: 0, comissao: 1 },
};

export function statement(driverId: string, before?: number, limit = 50) {
  const rows = db.prepare(`SELECT f.id, f.kind, f.amount_cents, f.description, f.ride_id, f.payout_id, f.created_at,
      r.price_cents ride_price, r.payment_method, r.commission_pct
    FROM financial_transactions f LEFT JOIN rides r ON r.id = f.ride_id
    WHERE f.driver_id = ? AND f.kind <> 'taxa_provedor' ${before ? 'AND f.created_at < ?' : ''}
    ORDER BY f.created_at DESC, f.id DESC LIMIT ?`)
    .all(...[driverId, ...(before ? [before] : []), limit + 1]) as any[];
  return {
    entries: rows.slice(0, limit).map(x => ({
      id: x.id, kind: x.kind, label: KIND_PT[x.kind] || x.kind, amount_cents: x.amount_cents,
      effect: EFFECT[x.kind] || { saldo: 0, comissao: 0 },
      description: x.description, ride_id: x.ride_id, payout_id: x.payout_id, created_at: x.created_at,
      ride: x.ride_id ? { price_cents: x.ride_price, payment_method: x.payment_method, commission_pct: x.commission_pct } : null,
    })),
    has_more: rows.length > limit,
  };
}

// ---------------- saque ----------------

/** Pedido de saque: tudo numa transação; um por vez; idempotente pela chave do pedido. */
export function requestWithdrawal(driverId: string, amountIn: unknown, idemKey: string) {
  return tx(() => {
    const replay = db.prepare('SELECT * FROM payouts WHERE driver_id = ? AND idem_key = ?').get(driverId, idemKey) as any;
    if (replay) return { payout: replay, replay: true };

    const d = db.prepare(`SELECT d.status, u.name FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.user_id = ?`)
      .get(driverId) as any;
    if (!d || d.status !== 'approved') throw new ApiError(403, 'Seu cadastro precisa estar aprovado.');
    const pix = pixOf(driverId);
    if (!pix) throw new ApiError(400, 'Cadastre sua chave Pix antes de pedir o saque.');
    const open = db.prepare(`SELECT id FROM payouts WHERE driver_id = ? AND origin = 'motorista'
      AND status IN ('aguardando_aprovacao','aprovado','em_processamento')`).get(driverId);
    if (open) throw new ApiError(409, 'Você já tem um saque em andamento.');
    const t = now();
    const next = nextWithdrawalAt(driverId);
    if (next && next > t) {
      const e = new ApiError(429, `Próximo saque liberado em ${new Date(next).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`);
      (e as any).next_withdrawal_at = next;
      throw e;
    }
    const bal = driverBalance(driverId);
    if (bal.pending_cents <= 0) throw new ApiError(400, 'Sem saldo disponível para saque.');
    if (bal.withdrawable_cents <= 0) {
      throw new ApiError(400, `Comissão pendente de ${brl(bal.debt_cents)} é maior ou igual ao saldo de ${brl(bal.pending_cents)}. `
        + 'É preciso acumular saldo suficiente para quitá-la antes de sacar.');
    }
    const net = amountIn === undefined || amountIn === null || amountIn === '' ? bal.withdrawable_cents : Math.round(Number(amountIn));
    if (!Number.isInteger(net) || net <= 0) throw new ApiError(400, 'Valor do saque inválido.');
    if (net > bal.withdrawable_cents) {
      throw new ApiError(400, `O máximo disponível para saque é ${brl(bal.withdrawable_cents)}.`);
    }
    const debt = Math.max(0, bal.debt_cents);
    const gross = net + debt;
    const pid = id('pyo');
    db.prepare(`INSERT INTO payouts (id, driver_id, origin, amount_cents, gross_cents, debt_cents, status, method,
        pix_type, pix_key_enc, pix_holder, idem_key, created_by, created_at, updated_at)
      VALUES (?,?,'motorista',?,?,?,'aguardando_aprovacao','pix',?,?,?,?,?,?,?)`)
      .run(pid, driverId, net, gross, debt, pix.type, encryptSecret(pix.key), pix.holder, idemKey, driverId, t, t);
    ledger('saque_reserva', gross, { driverId, payoutId: pid, description: `Saque ${pid}: ${brl(net)} líquido${debt ? ` + ${brl(debt)} de comissão descontada` : ''}` });
    if (debt) ledger('quitacao_divida', debt, { driverId, payoutId: pid, description: `Comissão das corridas em dinheiro descontada no saque ${pid}` });
    return { payout: db.prepare('SELECT * FROM payouts WHERE id = ?').get(pid) as any, replay: false, name: d.name };
  });
}

/** Saque recusado ou cancelado: devolve a reserva e a dívida descontada (lançamentos compensatórios). */
function releaseWithdrawal(p: any, why: string): void {
  ledger('saque_devolucao', p.gross_cents, { driverId: p.driver_id, payoutId: p.id, description: `Saque ${p.id} ${why}: valor devolvido à carteira` });
  if (p.debt_cents > 0) {
    ledger('quitacao_estorno', p.debt_cents, { driverId: p.driver_id, payoutId: p.id, description: `Saque ${p.id} ${why}: comissão volta a ficar pendente` });
  }
}

/** Troca de status atômica: só vale se o saque ainda estiver num dos estados esperados. */
function transition(pid: string, from: string[], to: string, set: Record<string, any>): any {
  const cols = Object.keys(set);
  const r = db.prepare(`UPDATE payouts SET status = ?, updated_at = ?${cols.map(c => `, ${c} = ?`).join('')}
    WHERE id = ? AND origin = 'motorista' AND status IN (${from.map(() => '?').join(',')})`)
    .run(to, now(), ...cols.map(c => set[c]), pid, ...from);
  if (r.changes !== 1) {
    const cur = db.prepare('SELECT status FROM payouts WHERE id = ?').get(pid) as any;
    if (!cur) throw new ApiError(404, 'Saque não encontrado.');
    throw new ApiError(409, `Este saque está "${STATUS_PT[cur.status] || cur.status}" e não pode passar para "${STATUS_PT[to]}".`);
  }
  return db.prepare('SELECT * FROM payouts WHERE id = ?').get(pid);
}

/** Sinais para a central conferir antes de pagar. */
function flagsFor(p: any): string[] {
  const out: string[] = [];
  const recentPaid = db.prepare(`SELECT COUNT(*) c FROM payouts WHERE driver_id = ? AND id <> ? AND status = 'pago'
    AND paid_at > ?`).get(p.driver_id, p.id, now() - intervalMs()) as any;
  if (recentPaid.c) out.push('Outro saque deste mototaxista foi pago nas últimas 48 h.');
  const d = db.prepare('SELECT pix_updated_at FROM drivers WHERE user_id = ?').get(p.driver_id) as any;
  if (d?.pix_updated_at && d.pix_updated_at > p.created_at - 24 * 3600_000) out.push('A chave Pix foi alterada menos de 24 h antes do pedido.');
  const bal = driverBalance(p.driver_id);
  if (bal.pending_cents < 0) out.push('Saldo da carteira negativo (estorno depois de saque).');
  return out;
}

// ---------------- rotas ----------------

export const walletRoutes: Route[] = [

  route('GET /api/driver/wallet', 'driver', ({ res, user }) => {
    const s = walletSummary(user!.id);
    const history = (db.prepare(`SELECT * FROM payouts WHERE driver_id = ? ORDER BY created_at DESC LIMIT 30`)
      .all(user!.id) as any[]).map(publicPayout);
    json(res, 200, { ...s, history });
  }),

  route('GET /api/driver/wallet/statement', 'driver', ({ res, user, query }) => {
    const before = Number(query.get('before')) || undefined;
    const limit = Math.min(Math.max(Number(query.get('limit')) || 50, 1), 200);
    json(res, 200, statement(user!.id, before, limit));
  }),

  route('PUT /api/driver/wallet/pix', 'driver', async ({ req, res, user }) => {
    if (!rateLimit(`pix:${user!.id}`, 5, 3600_000)) throw new ApiError(429, 'Muitas alterações. Tente mais tarde.');
    const b = await readBody(req);
    const type = reqStr(b.type, 'tipo de chave', 20);
    const holder = reqStr(b.holder_name, 'nome do titular', 120);
    if (holder.trim().length < 5 || !/\s/.test(holder.trim())) throw new ApiError(400, 'Informe o nome completo do titular da conta.');
    const u = db.prepare('SELECT name, cpf FROM users WHERE id = ?').get(user!.id) as any;
    const key = normalizePix(type, b.key, u?.cpf);
    db.prepare('UPDATE drivers SET pix_type = ?, pix_key_enc = ?, pix_holder = ?, pix_updated_at = ? WHERE user_id = ?')
      .run(type, encryptSecret(key), holder.trim(), now(), user!.id);
    // aviso de segurança: troca de chave é o alvo nº 1 de golpe
    notify(user!.id, 'security', 'Chave Pix alterada', `Sua chave Pix de saque foi alterada para ${maskPix(type, key)}. Se não foi você, fale com o suporte agora.`);
    json(res, 200, { ok: true, pix: { type, masked: maskPix(type, key), holder: holder.trim() } });
  }),

  route('POST /api/driver/withdrawals', 'driver', async ({ req, res, user }) => {
    if (!rateLimit(`wd:${user!.id}`, 10, 3600_000)) throw new ApiError(429, 'Muitas tentativas. Aguarde.');
    const b = await readBody(req);
    const idem = String(b.idempotency_key || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (idem.length < 8) throw new ApiError(400, 'Pedido sem identificação. Atualize o app e tente de novo.');
    let r;
    try { r = requestWithdrawal(user!.id, b.amount_cents, idem); }
    catch (e: any) {
      if (/UNIQUE/i.test(String(e?.message))) throw new ApiError(409, 'Você já tem um saque em andamento.');
      if (e?.next_withdrawal_at) { json(res, 429, { error: e.message, next_withdrawal_at: e.next_withdrawal_at }); return; }
      throw e;
    }
    if (!r.replay) {
      notifyAdmins('withdrawal_requested', 'Novo pedido de saque',
        { body: `${r.name}: ${brl(r.payout.amount_cents)} via Pix.`, url: '/admin#finance', eventKey: `wd:${r.payout.id}` });
    }
    json(res, r.replay ? 200 : 201, { ok: true, replay: r.replay, withdrawal: publicPayout(r.payout), wallet: walletSummary(user!.id) });
  }),

  route('POST /api/driver/withdrawals/:id/cancel', 'driver', ({ res, user, params }) => {
    const own = db.prepare('SELECT driver_id FROM payouts WHERE id = ?').get(params.id) as any;
    if (!own || own.driver_id !== user!.id) throw new ApiError(404, 'Saque não encontrado.');
    const p = tx(() => {
      const p = transition(params.id, ['aguardando_aprovacao'], 'cancelado', { cancelled_at: now(), reason: 'Cancelado pelo mototaxista' });
      releaseWithdrawal(p, 'cancelado');
      return p;
    });
    json(res, 200, { ok: true, withdrawal: publicPayout(p), wallet: walletSummary(user!.id) });
  }),

  // ---------- central ----------

  route('GET /api/admin/withdrawals', 'admin', ({ res, query }) => {
    const st = query.get('status') || '';
    const where = st === 'abertos' ? `status IN ('aguardando_aprovacao','aprovado','em_processamento')`
      : STATUS_PT[st] ? 'status = ?' : '1=1';
    const rows = db.prepare(`SELECT p.*, u.name driver_name, u.phone driver_phone FROM payouts p JOIN users u ON u.id = p.driver_id
      WHERE p.origin = 'motorista' AND ${where} ORDER BY p.created_at DESC LIMIT 200`)
      .all(...(STATUS_PT[st] ? [st] : [])) as any[];
    const totals = db.prepare(`SELECT
        (SELECT COALESCE(SUM(amount_cents),0) FROM financial_transactions WHERE kind = 'comissao' AND test_mode = 0)
          - (SELECT COALESCE(SUM(amount_cents),0) FROM financial_transactions WHERE kind = 'estorno_comissao' AND test_mode = 0) commission,
        (SELECT COALESCE(SUM(amount_cents),0) FROM financial_transactions WHERE kind = 'comissao' AND test_mode = 1)
          - (SELECT COALESCE(SUM(amount_cents),0) FROM financial_transactions WHERE kind = 'estorno_comissao' AND test_mode = 1) commission_test,
        (SELECT COALESCE(SUM(amount_cents),0) FROM financial_transactions WHERE kind = 'divida_comissao')
          - (SELECT COALESCE(SUM(amount_cents),0) FROM financial_transactions WHERE kind = 'quitacao_divida')
          + (SELECT COALESCE(SUM(amount_cents),0) FROM financial_transactions WHERE kind = 'quitacao_estorno') debt,
        (SELECT COALESCE(SUM(amount_cents),0) FROM payouts WHERE origin = 'motorista' AND status IN ('aguardando_aprovacao','aprovado','em_processamento')) open_net,
        (SELECT COUNT(*) FROM payouts WHERE origin = 'motorista' AND status IN ('aguardando_aprovacao','aprovado','em_processamento')) open_count
    `).get() as any;
    const drivers = db.prepare(`SELECT user_id FROM drivers WHERE status = 'approved'`).all() as any[];
    const owed = drivers.reduce((s, d) => s + Math.max(0, driverBalance(d.user_id).pending_cents), 0);
    json(res, 200, {
      withdrawals: rows.map(p => ({ ...publicPayout(p), driver_id: p.driver_id, driver_name: p.driver_name, driver_phone: p.driver_phone, flags: OPEN.includes(p.status) ? flagsFor(p) : [] })),
      totals: { commission_cents: totals.commission, commission_test_cents: totals.commission_test, cash_commission_pending_cents: totals.debt,
        open_withdrawals_cents: totals.open_net, open_withdrawals: totals.open_count, owed_to_drivers_cents: owed },
    });
  }),

  /** Detalhe com a chave Pix completa (só a central; o acesso fica na auditoria). */
  route('GET /api/admin/withdrawals/:id', 'admin', ({ res, user, params }) => {
    const p = db.prepare(`SELECT p.*, u.name driver_name, u.cpf driver_cpf, u.phone driver_phone FROM payouts p
      JOIN users u ON u.id = p.driver_id WHERE p.id = ?`).get(params.id) as any;
    if (!p) throw new ApiError(404, 'Saque não encontrado.');
    audit(user!.id, 'withdrawal_view', 'payout', p.id, 'chave Pix exibida');
    json(res, 200, {
      withdrawal: { ...publicPayout(p), driver_id: p.driver_id, driver_name: p.driver_name, driver_phone: p.driver_phone,
        pix_key: p.pix_key_enc ? decryptSecret(p.pix_key_enc) : null, flags: flagsFor(p) },
      wallet: walletSummary(p.driver_id),
      statement: statement(p.driver_id, undefined, 30).entries,
    });
  }),

  route('POST /api/admin/withdrawals/:id/approve', 'admin', ({ res, user, params }) => {
    const p = transition(params.id, ['aguardando_aprovacao'], 'aprovado', { approved_at: now(), approved_by: user!.id });
    audit(user!.id, 'withdrawal_approve', 'payout', p.id, brl(p.amount_cents));
    notify(p.driver_id, 'withdrawal_approved', 'Saque aprovado', { body: `Seu saque de ${brl(p.amount_cents)} foi aprovado e será transferido.`, eventKey: `wd-ok:${p.id}` });
    json(res, 200, { ok: true, withdrawal: publicPayout(p) });
  }),

  route('POST /api/admin/withdrawals/:id/processing', 'admin', ({ res, user, params }) => {
    const p = transition(params.id, ['aprovado'], 'em_processamento', { processing_at: now(), processing_by: user!.id });
    audit(user!.id, 'withdrawal_processing', 'payout', p.id, brl(p.amount_cents));
    json(res, 200, { ok: true, withdrawal: publicPayout(p) });
  }),

  /** Registra o pagamento FEITO (com comprovante). Aprovar não é pagar. */
  route('POST /api/admin/withdrawals/:id/pay', 'admin', async ({ req, res, user, params }) => {
    const b = await readBody(req);
    const ref = reqStr(b.reference, 'comprovante (identificação do Pix)', 120).trim();
    if (ref.length < 6) throw new ApiError(400, 'Informe a identificação do Pix (comprovante).');
    const p = tx(() => {
      const dup = db.prepare(`SELECT id FROM payouts WHERE reference = ? AND status = 'pago'`).get(ref) as any;
      if (dup) throw new ApiError(409, `Este comprovante já foi usado no saque ${dup.id}.`);
      const p = transition(params.id, ['aprovado', 'em_processamento'], 'pago',
        { paid_at: now(), paid_by: user!.id, reference: ref, note: typeof b.note === 'string' ? b.note.slice(0, 300) : null });
      ledger('saque_pago', p.amount_cents, { driverId: p.driver_id, payoutId: p.id, description: `Pix enviado · comprovante ${ref}` });
      return p;
    });
    audit(user!.id, 'withdrawal_paid', 'payout', p.id, `${brl(p.amount_cents)} · ${ref}`);
    notify(p.driver_id, 'payout', '💸 Saque pago', { body: `${brl(p.amount_cents)} foram enviados para sua chave Pix.`, eventKey: `wd-paid:${p.id}` });
    json(res, 200, { ok: true, withdrawal: publicPayout(p) });
  }),

  route('POST /api/admin/withdrawals/:id/reject', 'admin', async ({ req, res, user, params }) => {
    const b = await readBody(req);
    const reason = reqStr(b.reason, 'justificativa', 300).trim();
    if (reason.length < 5) throw new ApiError(400, 'Escreva a justificativa da recusa.');
    const p = tx(() => {
      const p = transition(params.id, OPEN, 'rejeitado', { rejected_at: now(), rejected_by: user!.id, reason });
      releaseWithdrawal(p, 'recusado');
      return p;
    });
    audit(user!.id, 'withdrawal_reject', 'payout', p.id, reason);
    notify(p.driver_id, 'withdrawal_rejected', 'Saque recusado', { body: `Motivo: ${reason}. O valor voltou para sua carteira e você já pode pedir de novo.`, eventKey: `wd-no:${p.id}` });
    json(res, 200, { ok: true, withdrawal: publicPayout(p) });
  }),
];
