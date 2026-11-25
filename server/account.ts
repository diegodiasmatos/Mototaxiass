/**
 * Conta do usuário: termos de uso e privacidade, troca e redefinição de
 * senha, pedido de exclusão de conta e anonimização (LGPD).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { db, getSetting, getCredential, audit } from './db.ts';
import {
  ApiError, id, now, json, readBody, reqStr, hashPassword, verifyPassword, rateLimit,
  parseCookies,
} from './util.ts';
import { route, type Route, type SessionUser } from './router.ts';
import { notify, notifyAdmins } from './notify.ts';

// ---------------------------------------------------------------
// Termos de uso e política de privacidade
// ---------------------------------------------------------------

/**
 * Versão dos textos em public/termos.html e public/privacidade.html. Trocar
 * este valor quando o texto mudar de forma relevante: todos precisam aceitar
 * de novo na próxima vez que abrirem o app.
 */
export const TERMS_VERSION = '2026-11-25';

/** O usuário aceitou a versão atual? (a central não precisa) */
export function termsOk(u: { role: string; terms_version?: string | null }): boolean {
  return u.role === 'admin' || u.terms_version === TERMS_VERSION;
}

/** Barra ações importantes de quem ainda não aceitou os termos atuais. */
export function assertTermsAccepted(u: SessionUser): void {
  const row = db.prepare('SELECT role, terms_version FROM users WHERE id = ?').get(u.id) as any;
  if (row && !termsOk(row)) {
    throw new ApiError(428, 'Aceite os Termos de Uso e a Política de Privacidade para continuar.');
  }
}

/** Grava o aceite (versão e data). */
export function recordTermsAcceptance(userId: string): void {
  db.prepare('UPDATE users SET terms_version = ?, terms_accepted_at = ? WHERE id = ?')
    .run(TERMS_VERSION, now(), userId);
}

/** Dados da empresa que aparecem nos textos legais (preenchidos na central). */
export const LEGAL_KEYS = ['company_name', 'company_cnpj', 'company_address', 'company_contact',
  'dpo_contact', 'legal_reviewed'] as const;

function legalInfo() {
  const v = (k: string) => getSetting(k) || null;
  return {
    version: TERMS_VERSION,
    company_name: v('company_name'), company_cnpj: v('company_cnpj'),
    company_address: v('company_address'), company_contact: v('company_contact'),
    dpo_contact: v('dpo_contact'),
    city_name: v('city_name'),
    // enquanto um advogado não revisar, as páginas avisam que o texto é preliminar
    reviewed: getSetting('legal_reviewed') === '1',
  };
}

// ---------------------------------------------------------------
// Senha
// ---------------------------------------------------------------

const RESET_TTL = 60 * 60_000;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Situações em que a corrida ainda está acontecendo. */
const ACTIVE_RIDE_STATUSES = ['pending_payment', 'requested', 'accepted', 'in_progress',
  'awaiting_confirmation', 'disputed'];

function hasActiveRide(userId: string): boolean {
  const r = db.prepare(`SELECT COUNT(*) c FROM rides WHERE (passenger_id = ? OR driver_id = ?)
    AND status IN (${ACTIVE_RIDE_STATUSES.map(() => '?').join(',')})`)
    .get(userId, userId, ...ACTIVE_RIDE_STATUSES) as any;
  return r.c > 0;
}

// ---------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------

export const accountRoutes: Route[] = [

  /** Textos legais: dados da empresa e versão (público). */
  route('GET /api/legal', null, ({ res }) => { json(res, 200, legalInfo()); }),

  /** Aceite dos termos atuais por quem já tinha conta. */
  route('POST /api/me/accept-terms', 'any', async ({ req, res, user }) => {
    const b = await readBody(req);
    if (b.version !== TERMS_VERSION) {
      throw new ApiError(409, 'Os termos foram atualizados. Recarregue a página e leia a versão atual.');
    }
    recordTermsAcceptance(user!.id);
    json(res, 200, { ok: true, version: TERMS_VERSION });
  }),

  /** Troca de senha: pede a atual e encerra as outras sessões abertas. */
  route('POST /api/me/password', 'any', async ({ req, res, user, ip }) => {
    if (!rateLimit(`pwchange:${user!.id}`, 10, 15 * 60_000)) throw new ApiError(429, 'Muitas tentativas. Aguarde alguns minutos.');
    const b = await readBody(req);
    const current = reqStr(b.current_password, 'senha atual', 200);
    const next = reqStr(b.new_password, 'nova senha', 200);
    if (next.length < 8) throw new ApiError(400, 'A nova senha deve ter pelo menos 8 caracteres.');
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user!.id) as any;
    if (!row || !verifyPassword(current, row.password_hash)) throw new ApiError(400, 'A senha atual está incorreta.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user!.id);
    const token = parseCookies(req)['amt_session'];
    const other = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(user!.id, token || '');
    notify(user!.id, 'security', 'Sua senha foi alterada',
      { body: 'Se não foi você, fale com o suporte imediatamente.' });
    json(res, 200, { ok: true, other_sessions_closed: Number(other.changes) });
  }),

  /**
   * "Esqueci minha senha". Sem serviço de e-mail configurado, o pedido vai
   * para a central, que confere a identidade e envia um link de uso único
   * pelo telefone cadastrado. A resposta é sempre a mesma (não revela se o
   * e-mail existe).
   */
  route('POST /api/auth/forgot', null, async ({ req, res, ip }) => {
    if (!rateLimit(`forgot:${ip}`, 5, 15 * 60_000)) throw new ApiError(429, 'Muitas tentativas. Aguarde alguns minutos.');
    const b = await readBody(req);
    const email = reqStr(b.email, 'e-mail', 160);
    const u = db.prepare(`SELECT id, role, name, phone FROM users WHERE email = ? AND blocked = 0`).get(email) as any;
    if (u && u.role !== 'admin' && rateLimit(`forgot-acc:${u.id}`, 3, 60 * 60_000)) {
      notifyAdmins('password_reset_request', '🔑 Pedido de nova senha',
        { body: `${u.name} (${u.role === 'driver' ? 'motorista' : 'passageiro'}) · tel. ${u.phone || '—'}. `
          + 'Confira a identidade e gere o link em Passageiros/Motoristas → "Link de nova senha".' });
    }
    json(res, 200, {
      ok: true,
      message: 'Pedido recebido. Se este e-mail estiver cadastrado, a central vai falar com você '
        + 'pelo telefone da conta e enviar um link para criar uma nova senha.',
    });
  }),

  /** Redefinição pelo link de uso único (gerado pela central). */
  route('POST /api/auth/reset', null, async ({ req, res, ip }) => {
    if (!rateLimit(`reset:${ip}`, 10, 15 * 60_000)) throw new ApiError(429, 'Muitas tentativas. Aguarde alguns minutos.');
    const b = await readBody(req);
    const token = reqStr(b.token, 'link', 200);
    const pw = reqStr(b.password, 'nova senha', 200);
    if (pw.length < 8) throw new ApiError(400, 'A nova senha deve ter pelo menos 8 caracteres.');
    const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha(token)) as any;
    if (!row || row.used_at || row.expires_at < now()) {
      throw new ApiError(410, 'Este link expirou ou já foi usado. Peça um novo à central.');
    }
    const t = now();
    const used = db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL')
      .run(t, row.token_hash);
    if (used.changes !== 1) throw new ApiError(410, 'Este link já foi usado.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), row.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
    notify(row.user_id, 'security', 'Sua senha foi redefinida',
      { body: 'Se não foi você, fale com o suporte imediatamente.' });
    json(res, 200, { ok: true });
  }),

  /** Pedido de exclusão da conta (confirmado com a senha). A central conclui. */
  route('POST /api/me/delete-request', 'any', async ({ req, res, user }) => {
    if (user!.role === 'admin') throw new ApiError(403, 'Contas da central não são excluídas por aqui.');
    const b = await readBody(req);
    const pw = reqStr(b.password, 'senha', 200);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user!.id) as any;
    if (!row || !verifyPassword(pw, row.password_hash)) throw new ApiError(400, 'Senha incorreta.');
    const open = db.prepare(`SELECT id FROM account_deletion_requests WHERE user_id = ? AND status = 'pendente'`)
      .get(user!.id) as any;
    if (open) { json(res, 200, { ok: true, id: open.id, already: true }); return; }
    const rid = id('del');
    const reason = typeof b.reason === 'string' ? b.reason.slice(0, 500) : null;
    db.prepare(`INSERT INTO account_deletion_requests (id, user_id, reason, created_at) VALUES (?,?,?,?)`)
      .run(rid, user!.id, reason, now());
    notifyAdmins('deletion_request', '🗑️ Pedido de exclusão de conta',
      { body: `${user!.name} (${user!.role === 'driver' ? 'motorista' : 'passageiro'}) pediu a exclusão da conta.` });
    json(res, 201, { ok: true, id: rid, active_ride: hasActiveRide(user!.id) });
  }),

  /** Desistir do pedido de exclusão. */
  route('DELETE /api/me/delete-request', 'any', ({ res, user }) => {
    const r = db.prepare(`UPDATE account_deletion_requests SET status = 'cancelado', handled_at = ?, note = 'cancelado pelo titular'
      WHERE user_id = ? AND status = 'pendente'`).run(now(), user!.id);
    json(res, 200, { ok: true, cancelled: Number(r.changes) });
  }),

  // ---------------- central ----------------

  /** Gera um link de nova senha (uso único, 60 min). Mostrado UMA vez. */
  route('POST /api/admin/users/:id/reset-link', 'admin', async ({ req, res, user, params }) => {
    const target = db.prepare('SELECT id, role, name, phone, email FROM users WHERE id = ?').get(params.id) as any;
    if (!target) throw new ApiError(404, 'Usuário não encontrado.');
    if (target.role === 'admin') throw new ApiError(403, 'Senha da central não é redefinida por aqui.');
    if (/@anonimizado\.invalid$/.test(target.email)) throw new ApiError(409, 'Conta anonimizada.');
    const token = crypto.randomBytes(32).toString('base64url');
    const t = now();
    // links anteriores ainda não usados deixam de valer
    db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(t, target.id);
    db.prepare(`INSERT INTO password_resets (token_hash, user_id, created_by, created_at, expires_at)
      VALUES (?,?,?,?,?)`).run(sha(token), target.id, user!.id, t, t + RESET_TTL);
    audit(user!.id, 'password_reset_link', 'user', target.id, 'link de uso único gerado (60 min)');
    const origin = (getCredential('PUBLIC_URL') || process.env.PUBLIC_URL || '').replace(/\/$/, '')
      || `https://${req.headers.host}`;
    json(res, 201, {
      url: `${origin}/redefinir-senha#t=${token}`,
      expires_at: t + RESET_TTL, name: target.name, phone: target.phone,
    });
  }),

  /** Pedidos de exclusão de conta. */
  route('GET /api/admin/deletion-requests', 'admin', ({ res }) => {
    const rows = db.prepare(`SELECT d.*, u.name user_name, u.role user_role, u.email user_email, u.phone user_phone
      FROM account_deletion_requests d JOIN users u ON u.id = d.user_id
      ORDER BY d.status = 'pendente' DESC, d.created_at DESC LIMIT 200`).all() as any[];
    for (const r of rows) r.active_ride = hasActiveRide(r.user_id);
    json(res, 200, { requests: rows });
  }),

  /**
   * Anonimização de conta (LGPD), a pedido do titular.
   * Apaga ou descaracteriza o que identifica a pessoa: nome, e-mail, telefone,
   * CPF, foto, documentos, dados da moto, favoritos, notificações, mensagens,
   * GPS e endereços das corridas. MANTÉM, sem identificar a pessoa, o que
   * pode ser exigido por lei: corridas (valores e datas), pagamentos,
   * repasses e o livro-caixa. A conta fica bloqueada. Não pode ser desfeito,
   * por isso exige digitar ANONIMIZAR.
   */
  route('POST /api/admin/users/:id/anonymize', 'admin', async ({ req, res, user, params }) => {
    const b = await readBody(req);
    if (b.confirm !== 'ANONIMIZAR') {
      throw new ApiError(400, 'Confirme digitando ANONIMIZAR. Esta ação não pode ser desfeita.');
    }
    const target = db.prepare('SELECT id, role, email FROM users WHERE id = ?').get(params.id) as any;
    if (!target) throw new ApiError(404, 'Usuário não encontrado.');
    if (target.role === 'admin') throw new ApiError(403, 'Contas de administrador não são anonimizadas por aqui.');
    if (/@anonimizado\.invalid$/.test(target.email)) throw new ApiError(409, 'Esta conta já foi anonimizada.');
    if (hasActiveRide(target.id)) {
      throw new ApiError(409, 'Há corrida em andamento ou em disputa com esta conta. Conclua antes de anonimizar.');
    }
    const uid = target.id;
    const files: string[] = [];
    const counts: Record<string, number> = {};
    const run = (k: string, sql: string, ...p: any[]) => {
      counts[k] = (counts[k] || 0) + Number(db.prepare(sql).run(...p).changes);
    };
    db.exec('BEGIN');
    try {
      run('conta', `UPDATE users SET name = 'Usuário removido', email = ?, phone = NULL, cpf = NULL,
        photo = NULL, password_hash = ?, blocked = 1,
        blocked_reason = 'Conta anonimizada a pedido do titular (LGPD)' WHERE id = ?`,
        `removido-${uid}@anonimizado.invalid`, hashPassword(crypto.randomBytes(24).toString('hex')), uid);
      run('sessoes', 'DELETE FROM sessions WHERE user_id = ?', uid);
      run('senhas', 'DELETE FROM password_resets WHERE user_id = ?', uid);
      run('push', 'DELETE FROM push_subscriptions WHERE user_id = ?', uid);
      run('favoritos', 'DELETE FROM favorites WHERE user_id = ?', uid);
      run('notificacoes', 'DELETE FROM notifications WHERE user_id = ?', uid);
      run('cotacoes', 'DELETE FROM ride_quotes WHERE user_id = ? AND used = 0', uid);
      run('cotacoes', `UPDATE ride_quotes SET origin_text = '[endereço removido]', dest_text = '[endereço removido]',
        origin_lat = ROUND(origin_lat, 2), origin_lng = ROUND(origin_lng, 2),
        dest_lat = ROUND(dest_lat, 2), dest_lng = ROUND(dest_lng, 2), route_geojson = NULL
        WHERE user_id = ?`, uid);
      run('mensagens', `UPDATE ride_messages SET body = '[mensagem removida]' WHERE sender_id = ?`, uid);
      run('suporte', `UPDATE support_messages SET subject = '[removido]', body = '[removido]' WHERE user_id = ?`, uid);
      run('ocorrencias', `UPDATE ride_issues SET description = '[removido]' WHERE user_id = ?`, uid);
      run('avaliacoes', 'UPDATE ratings SET comment = NULL WHERE passenger_id = ? OR driver_id = ?', uid, uid);
      run('gps', `DELETE FROM ride_locations WHERE
        (who = 'passenger' AND ride_id IN (SELECT id FROM rides WHERE passenger_id = ?))
        OR (who = 'driver' AND ride_id IN (SELECT id FROM rides WHERE driver_id = ?))`, uid, uid);
      run('corridas', `UPDATE rides SET origin_text = '[endereço removido]', dest_text = '[endereço removido]',
        origin_lat = ROUND(origin_lat, 2), origin_lng = ROUND(origin_lng, 2),
        dest_lat = ROUND(dest_lat, 2), dest_lng = ROUND(dest_lng, 2), route_geojson = NULL
        WHERE passenger_id = ?`, uid);
      run('eventos', `UPDATE ride_events SET details = NULL WHERE actor_id = ?
        OR (type = 'pickup_updated' AND ride_id IN (SELECT id FROM rides WHERE passenger_id = ?))`, uid, uid);
      if (target.role === 'driver') {
        for (const d of db.prepare('SELECT file_path FROM driver_documents WHERE driver_id = ?').all(uid) as any[]) {
          files.push(d.file_path);
        }
        run('documentos', 'DELETE FROM driver_documents WHERE driver_id = ?', uid);
        run('motorista', `UPDATE drivers SET birth_date = NULL, address = NULL, moto_plate = NULL,
          moto_brand = NULL, moto_model = NULL, moto_year = NULL, moto_color = NULL,
          online = 0, last_lat = NULL, last_lng = NULL, last_accuracy_m = NULL, review_reason = NULL,
          mp_user_id = NULL, mp_access_token_enc = NULL, mp_refresh_token_enc = NULL,
          mp_expires_at = NULL, mp_nickname = NULL WHERE user_id = ?`, uid);
      }
      run('pedido', `UPDATE account_deletion_requests SET status = 'concluido', handled_by = ?, handled_at = ?
        WHERE user_id = ? AND status = 'pendente'`, user!.id, now(), uid);
      audit(user!.id, 'user_anonymize', 'user', uid,
        `LGPD: ${Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(', ')}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    // arquivos só depois do COMMIT: se algo falhou acima, nada foi apagado
    let removedFiles = 0;
    for (const f of files) { try { fs.unlinkSync(f); removedFiles++; } catch { /* já não existia */ } }
    json(res, 200, { ok: true, counts, files_removed: removedFiles });
  }),
];
