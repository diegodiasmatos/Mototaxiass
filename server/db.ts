import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { dataDir, now, encryptSecret, decryptSecret } from './util.ts';

export let db: DatabaseSync;

const MIGRATIONS: { version: number; sql: string; fkOff?: boolean }[] = [
  {
    version: 1,
    sql: `
    CREATE TABLE users (
      id            TEXT PRIMARY KEY,
      role          TEXT NOT NULL CHECK (role IN ('passenger','driver','admin')),
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phone         TEXT,
      cpf           TEXT,
      password_hash TEXT NOT NULL,
      photo         TEXT,
      blocked       INTEGER NOT NULL DEFAULT 0,
      blocked_reason TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX idx_users_role ON users(role);

    CREATE TABLE sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX idx_sessions_user ON sessions(user_id);

    CREATE TABLE drivers (
      user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','correction')),
      birth_date    TEXT,
      address       TEXT,
      moto_plate    TEXT,
      moto_brand    TEXT,
      moto_model    TEXT,
      moto_year     TEXT,
      moto_color    TEXT,
      online        INTEGER NOT NULL DEFAULT 0,
      last_lat      REAL,
      last_lng      REAL,
      last_loc_at   INTEGER,
      submitted_at  INTEGER,
      deadline_at   INTEGER,
      reviewed_at   INTEGER,
      reviewed_by   TEXT,
      review_reason TEXT,
      rating_sum    INTEGER NOT NULL DEFAULT 0,
      rating_count  INTEGER NOT NULL DEFAULT 0,
      rides_count   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_drivers_status ON drivers(status);

    CREATE TABLE driver_documents (
      id          TEXT PRIMARY KEY,
      driver_id   TEXT NOT NULL REFERENCES drivers(user_id) ON DELETE CASCADE,
      kind        TEXT NOT NULL CHECK (kind IN ('cnh','crlv','selfie')),
      file_path   TEXT NOT NULL,
      mime        TEXT NOT NULL,
      size        INTEGER NOT NULL,
      uploaded_at INTEGER NOT NULL
    );
    CREATE INDEX idx_docs_driver ON driver_documents(driver_id);

    CREATE TABLE fare_settings (
      category    TEXT PRIMARY KEY CHECK (category IN ('economica','prioridade')),
      label       TEXT NOT NULL,
      base_cents  INTEGER NOT NULL,
      included_m  INTEGER NOT NULL,
      per_km_cents INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE fare_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      category    TEXT NOT NULL,
      base_cents  INTEGER NOT NULL,
      included_m  INTEGER NOT NULL,
      per_km_cents INTEGER NOT NULL,
      changed_by  TEXT,
      changed_at  INTEGER NOT NULL
    );

    CREATE TABLE app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE ride_quotes (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id),
      category    TEXT NOT NULL CHECK (category IN ('economica','prioridade')),
      origin_text TEXT NOT NULL,
      origin_lat  REAL NOT NULL,
      origin_lng  REAL NOT NULL,
      dest_text   TEXT NOT NULL,
      dest_lat    REAL NOT NULL,
      dest_lng    REAL NOT NULL,
      distance_m  INTEGER NOT NULL,
      duration_s  INTEGER NOT NULL,
      price_cents INTEGER NOT NULL,
      base_cents  INTEGER NOT NULL,
      included_m  INTEGER NOT NULL,
      per_km_cents INTEGER NOT NULL,
      route_geojson TEXT,
      route_estimated INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      used        INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_quotes_user ON ride_quotes(user_id);

    CREATE TABLE rides (
      id            TEXT PRIMARY KEY,
      quote_id      TEXT REFERENCES ride_quotes(id),
      passenger_id  TEXT NOT NULL REFERENCES users(id),
      driver_id     TEXT REFERENCES drivers(user_id),
      category      TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested','accepted','in_progress','completed','cancelled')),
      origin_text   TEXT NOT NULL,
      origin_lat    REAL NOT NULL,
      origin_lng    REAL NOT NULL,
      dest_text     TEXT NOT NULL,
      dest_lat      REAL NOT NULL,
      dest_lng      REAL NOT NULL,
      distance_m    INTEGER NOT NULL,
      duration_s    INTEGER NOT NULL,
      price_cents   INTEGER NOT NULL,
      commission_pct REAL NOT NULL,
      commission_cents INTEGER,
      driver_cents  INTEGER,
      payment_method TEXT NOT NULL DEFAULT 'dinheiro'
                    CHECK (payment_method IN ('dinheiro','pix','cartao')),
      payment_status TEXT NOT NULL DEFAULT 'pendente'
                    CHECK (payment_status IN ('pendente','recebido','nao_aplicavel')),
      route_geojson TEXT,
      requested_at  INTEGER NOT NULL,
      accepted_at   INTEGER,
      arrived_at    INTEGER,
      started_at    INTEGER,
      completed_at  INTEGER,
      cancelled_at  INTEGER,
      cancelled_by  TEXT,
      cancel_reason TEXT,
      cancel_prev_status TEXT
    );
    CREATE INDEX idx_rides_passenger ON rides(passenger_id);
    CREATE INDEX idx_rides_driver ON rides(driver_id);
    CREATE INDEX idx_rides_status ON rides(status);
    CREATE INDEX idx_rides_requested_at ON rides(requested_at);

    CREATE TABLE ride_events (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ride_id  TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
      type     TEXT NOT NULL,
      actor_id TEXT,
      details  TEXT,
      at       INTEGER NOT NULL
    );
    CREATE INDEX idx_ride_events_ride ON ride_events(ride_id);

    CREATE TABLE ride_locations (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ride_id TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
      who     TEXT NOT NULL CHECK (who IN ('driver','passenger')),
      lat     REAL NOT NULL,
      lng     REAL NOT NULL,
      at      INTEGER NOT NULL
    );
    CREATE INDEX idx_ride_locations_ride ON ride_locations(ride_id);

    CREATE TABLE ride_messages (
      id        TEXT PRIMARY KEY,
      ride_id   TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id),
      body      TEXT NOT NULL,
      at        INTEGER NOT NULL
    );
    CREATE INDEX idx_ride_messages_ride ON ride_messages(ride_id);

    CREATE TABLE payments (
      id          TEXT PRIMARY KEY,
      ride_id     TEXT NOT NULL UNIQUE REFERENCES rides(id),
      method      TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('pendente','recebido','cancelado')),
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE ratings (
      id           TEXT PRIMARY KEY,
      ride_id      TEXT NOT NULL UNIQUE REFERENCES rides(id),
      passenger_id TEXT NOT NULL REFERENCES users(id),
      driver_id    TEXT NOT NULL REFERENCES drivers(user_id),
      stars        INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
      comment      TEXT,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX idx_ratings_driver ON ratings(driver_id);

    CREATE TABLE notifications (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT,
      ride_id    TEXT,
      read       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_notifications_user ON notifications(user_id, read);

    CREATE TABLE favorites (
      id      TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label   TEXT NOT NULL,
      text    TEXT NOT NULL,
      lat     REAL NOT NULL,
      lng     REAL NOT NULL
    );

    CREATE TABLE support_messages (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject    TEXT NOT NULL,
      body       TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','respondido','fechado')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE support_replies (
      id         TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES support_messages(id) ON DELETE CASCADE,
      admin_id   TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE admin_audit_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id    TEXT NOT NULL,
      action      TEXT NOT NULL,
      target_type TEXT,
      target_id   TEXT,
      details     TEXT,
      created_at  INTEGER NOT NULL
    );
    `,
  },

  // ----------------------------------------------------------------
  // V2 — confirmação da corrida pelo passageiro, pagamento real com
  // provedor, livro-caixa imutável, repasses, ocorrências, push e GPS.
  // Rebuild de `rides`/`payments` é necessário porque os CHECK de status
  // mudaram; os dados existentes são copiados integralmente.
  // ----------------------------------------------------------------
  {
    version: 2,
    fkOff: true,
    sql: `
    -- ---------- rides: novos estados e campos de confirmação ----------
    CREATE TABLE rides_v2 (
      id            TEXT PRIMARY KEY,
      quote_id      TEXT REFERENCES ride_quotes(id),
      passenger_id  TEXT NOT NULL REFERENCES users(id),
      driver_id     TEXT REFERENCES drivers(user_id),
      category      TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('pending_payment','requested','accepted','in_progress',
                                      'awaiting_confirmation','completed','cancelled','disputed')),
      origin_text   TEXT NOT NULL,
      origin_lat    REAL NOT NULL,
      origin_lng    REAL NOT NULL,
      dest_text     TEXT NOT NULL,
      dest_lat      REAL NOT NULL,
      dest_lng      REAL NOT NULL,
      distance_m    INTEGER NOT NULL,
      duration_s    INTEGER NOT NULL,
      price_cents   INTEGER NOT NULL,
      commission_pct REAL NOT NULL,
      commission_cents INTEGER,
      driver_cents  INTEGER,
      payment_method TEXT NOT NULL DEFAULT 'dinheiro'
                    CHECK (payment_method IN ('dinheiro','pix','cartao')),
      payment_status TEXT NOT NULL DEFAULT 'pendente',
      payment_id    TEXT,
      route_geojson TEXT,
      requested_at  INTEGER NOT NULL,
      accepted_at   INTEGER,
      arrived_at    INTEGER,
      started_at    INTEGER,
      completion_requested_at INTEGER,
      auto_confirm_at INTEGER,
      confirmed_at  INTEGER,
      confirmed_by  TEXT,
      completed_at  INTEGER,
      cancelled_at  INTEGER,
      cancelled_by  TEXT,
      cancel_reason TEXT,
      cancel_prev_status TEXT,
      pickup_updated_at INTEGER
    );
    INSERT INTO rides_v2 (id, quote_id, passenger_id, driver_id, category, status,
      origin_text, origin_lat, origin_lng, dest_text, dest_lat, dest_lng,
      distance_m, duration_s, price_cents, commission_pct, commission_cents, driver_cents,
      payment_method, payment_status, route_geojson, requested_at, accepted_at, arrived_at,
      started_at, completed_at, cancelled_at, cancelled_by, cancel_reason, cancel_prev_status,
      confirmed_at, confirmed_by)
    SELECT id, quote_id, passenger_id, driver_id, category, status,
      origin_text, origin_lat, origin_lng, dest_text, dest_lat, dest_lng,
      distance_m, duration_s, price_cents, commission_pct, commission_cents, driver_cents,
      payment_method, payment_status, route_geojson, requested_at, accepted_at, arrived_at,
      started_at, completed_at, cancelled_at, cancelled_by, cancel_reason, cancel_prev_status,
      completed_at, CASE WHEN status = 'completed' THEN 'legado' ELSE NULL END
    FROM rides;
    DROP TABLE rides;
    ALTER TABLE rides_v2 RENAME TO rides;
    CREATE INDEX idx_rides_passenger ON rides(passenger_id);
    CREATE INDEX idx_rides_driver ON rides(driver_id);
    CREATE INDEX idx_rides_status ON rides(status);
    CREATE INDEX idx_rides_requested_at ON rides(requested_at);
    CREATE INDEX idx_rides_autoconfirm ON rides(auto_confirm_at)
      WHERE status = 'awaiting_confirmation';

    -- ---------- payments: integração real com provedor ----------
    CREATE TABLE payments_v2 (
      id            TEXT PRIMARY KEY,
      ride_id       TEXT NOT NULL REFERENCES rides(id),
      provider      TEXT NOT NULL DEFAULT 'dinheiro',
      provider_payment_id TEXT,
      method        TEXT NOT NULL,
      status        TEXT NOT NULL
                    CHECK (status IN ('criado','aguardando_pagamento','autorizado','pago',
                                      'recusado','estornado','cancelado','dinheiro_pendente',
                                      'dinheiro_recebido','expirado')),
      amount_cents  INTEGER NOT NULL,
      commission_cents INTEGER,
      driver_cents  INTEGER,
      provider_fee_cents INTEGER,
      test_mode     INTEGER NOT NULL DEFAULT 0,
      pix_qr_code   TEXT,
      pix_qr_base64 TEXT,
      pix_expires_at INTEGER,
      ticket_url    TEXT,
      failure_reason TEXT,
      idempotency_key TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      paid_at       INTEGER,
      captured_at   INTEGER,
      refunded_at   INTEGER
    );
    INSERT INTO payments_v2 (id, ride_id, provider, method, status, amount_cents,
      created_at, updated_at, paid_at)
    SELECT id, ride_id, 'dinheiro', method,
      CASE status WHEN 'recebido' THEN 'dinheiro_recebido'
                  WHEN 'cancelado' THEN 'cancelado'
                  ELSE 'dinheiro_pendente' END,
      amount_cents, created_at, updated_at,
      CASE WHEN status = 'recebido' THEN updated_at ELSE NULL END
    FROM payments;
    DROP TABLE payments;
    ALTER TABLE payments_v2 RENAME TO payments;
    CREATE UNIQUE INDEX idx_payments_ride ON payments(ride_id);
    CREATE UNIQUE INDEX idx_payments_provider_id ON payments(provider_payment_id)
      WHERE provider_payment_id IS NOT NULL;
    CREATE INDEX idx_payments_status ON payments(status);

    -- vincula a corrida ao seu pagamento
    UPDATE rides SET payment_id = (SELECT p.id FROM payments p WHERE p.ride_id = rides.id);

    -- ---------- livro-caixa imutável ----------
    CREATE TABLE financial_transactions (
      id          TEXT PRIMARY KEY,
      ride_id     TEXT REFERENCES rides(id),
      payment_id  TEXT REFERENCES payments(id),
      driver_id   TEXT REFERENCES drivers(user_id),
      kind        TEXT NOT NULL
                  CHECK (kind IN ('cobranca','comissao','repasse_devido','repasse_pago',
                                  'estorno','taxa_provedor','divida_comissao','quitacao_divida')),
      amount_cents INTEGER NOT NULL,
      description TEXT,
      test_mode   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_fintx_ride ON financial_transactions(ride_id);
    CREATE INDEX idx_fintx_driver ON financial_transactions(driver_id, kind);
    CREATE INDEX idx_fintx_created ON financial_transactions(created_at);

    -- lança o histórico financeiro das corridas já concluídas
    INSERT INTO financial_transactions (id, ride_id, payment_id, driver_id, kind, amount_cents, description, created_at)
    SELECT 'ftx_c_' || r.id, r.id, r.payment_id, r.driver_id, 'cobranca', r.price_cents,
           'Migrado da V1', COALESCE(r.completed_at, r.requested_at)
    FROM rides r WHERE r.status = 'completed';
    INSERT INTO financial_transactions (id, ride_id, payment_id, driver_id, kind, amount_cents, description, created_at)
    SELECT 'ftx_k_' || r.id, r.id, r.payment_id, r.driver_id, 'comissao', r.commission_cents,
           'Migrado da V1', COALESCE(r.completed_at, r.requested_at)
    FROM rides r WHERE r.status = 'completed' AND r.commission_cents IS NOT NULL;
    INSERT INTO financial_transactions (id, ride_id, payment_id, driver_id, kind, amount_cents, description, created_at)
    SELECT 'ftx_r_' || r.id, r.id, r.payment_id, r.driver_id, 'repasse_devido', r.driver_cents,
           'Migrado da V1', COALESCE(r.completed_at, r.requested_at)
    FROM rides r WHERE r.status = 'completed' AND r.driver_cents IS NOT NULL;

    -- ---------- repasses aos mototaxistas ----------
    CREATE TABLE payouts (
      id          TEXT PRIMARY KEY,
      driver_id   TEXT NOT NULL REFERENCES drivers(user_id),
      amount_cents INTEGER NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('pendente','pago','falhou')),
      method      TEXT,
      reference   TEXT,
      note        TEXT,
      created_by  TEXT,
      created_at  INTEGER NOT NULL,
      paid_at     INTEGER
    );
    CREATE INDEX idx_payouts_driver ON payouts(driver_id, status);

    -- ---------- webhooks: idempotência e auditoria ----------
    CREATE TABLE webhook_events (
      id           TEXT PRIMARY KEY,
      provider     TEXT NOT NULL,
      external_id  TEXT NOT NULL,
      topic        TEXT,
      payload      TEXT,
      signature_ok INTEGER NOT NULL DEFAULT 0,
      processed_at INTEGER,
      result       TEXT,
      received_at  INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_webhook_unique ON webhook_events(provider, external_id, topic);

    -- ---------- ocorrências / disputas ----------
    CREATE TABLE ride_issues (
      id          TEXT PRIMARY KEY,
      ride_id     TEXT NOT NULL REFERENCES rides(id),
      user_id     TEXT NOT NULL REFERENCES users(id),
      role        TEXT NOT NULL,
      kind        TEXT NOT NULL,
      description TEXT,
      status      TEXT NOT NULL DEFAULT 'aberta'
                  CHECK (status IN ('aberta','em_analise','resolvida','rejeitada')),
      resolution  TEXT,
      resolved_by TEXT,
      created_at  INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX idx_issues_status ON ride_issues(status);
    CREATE INDEX idx_issues_ride ON ride_issues(ride_id);

    -- ---------- notificações push (Web Push / VAPID) ----------
    CREATE TABLE push_subscriptions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint   TEXT NOT NULL UNIQUE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      user_agent TEXT,
      failures   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_ok_at INTEGER
    );
    CREATE INDEX idx_push_user ON push_subscriptions(user_id);

    -- ---------- avaliações detalhadas ----------
    ALTER TABLE ratings ADD COLUMN score_atendimento INTEGER;
    ALTER TABLE ratings ADD COLUMN score_pontualidade INTEGER;
    ALTER TABLE ratings ADD COLUMN score_educacao INTEGER;
    ALTER TABLE ratings ADD COLUMN score_seguranca INTEGER;

    -- ---------- notificações: entrega e replay ----------
    ALTER TABLE notifications ADD COLUMN delivered_at INTEGER;
    ALTER TABLE notifications ADD COLUMN pushed_at INTEGER;

    -- ---------- GPS: qualidade e presença ----------
    ALTER TABLE drivers ADD COLUMN last_accuracy_m REAL;
    ALTER TABLE drivers ADD COLUMN last_seen_at INTEGER;
    ALTER TABLE ride_locations ADD COLUMN accuracy_m REAL;
    `,
  },

  // ----------------------------------------------------------------
  // V2.1 — credenciais do provedor guardadas (cifradas) no banco e
  // split automático: o mototaxista conecta a própria conta Mercado Pago
  // e recebe direto, com a comissão retida automaticamente.
  // ----------------------------------------------------------------
  {
    version: 3,
    fkOff: true,
    sql: `
    -- o livro-caixa ganha o lançamento do split automático
    CREATE TABLE financial_transactions_v3 (
      id          TEXT PRIMARY KEY,
      ride_id     TEXT REFERENCES rides(id),
      payment_id  TEXT REFERENCES payments(id),
      driver_id   TEXT REFERENCES drivers(user_id),
      kind        TEXT NOT NULL
                  CHECK (kind IN ('cobranca','comissao','repasse_devido','repasse_pago',
                                  'repasse_automatico','estorno','taxa_provedor',
                                  'divida_comissao','quitacao_divida')),
      amount_cents INTEGER NOT NULL,
      description TEXT,
      test_mode   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    INSERT INTO financial_transactions_v3
      SELECT id, ride_id, payment_id, driver_id, kind, amount_cents, description, test_mode, created_at
      FROM financial_transactions;
    DROP TABLE financial_transactions;
    ALTER TABLE financial_transactions_v3 RENAME TO financial_transactions;
    CREATE INDEX idx_fintx_ride ON financial_transactions(ride_id);
    CREATE INDEX idx_fintx_driver ON financial_transactions(driver_id, kind);
    CREATE INDEX idx_fintx_created ON financial_transactions(created_at);

    -- segredos do provedor (cifrados com AES-256-GCM)
    CREATE TABLE provider_credentials (
      key        TEXT PRIMARY KEY,
      value_enc  TEXT NOT NULL,
      updated_by TEXT,
      updated_at INTEGER NOT NULL
    );

    -- conta do mototaxista conectada via OAuth (split automático)
    ALTER TABLE drivers ADD COLUMN mp_user_id TEXT;
    ALTER TABLE drivers ADD COLUMN mp_access_token_enc TEXT;
    ALTER TABLE drivers ADD COLUMN mp_refresh_token_enc TEXT;
    ALTER TABLE drivers ADD COLUMN mp_expires_at INTEGER;
    ALTER TABLE drivers ADD COLUMN mp_connected_at INTEGER;
    ALTER TABLE drivers ADD COLUMN mp_nickname TEXT;

    -- qual conta recebeu a cobrança (nulo = conta da plataforma)
    ALTER TABLE payments ADD COLUMN seller_driver_id TEXT;
    ALTER TABLE payments ADD COLUMN application_fee_cents INTEGER;
    `,
  },

  // ----------------------------------------------------------------
  // V2.2 — Google Maps Platform: cache de respostas (corta custo) e
  // procedência da rota gravada em cada cotação/corrida.
  // ----------------------------------------------------------------
  {
    version: 4,
    sql: `
    CREATE TABLE geo_cache (
      key        TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      hits       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX idx_geo_cache_exp ON geo_cache(expires_at);
    CREATE INDEX idx_geo_cache_kind ON geo_cache(kind);

    -- de onde veio a rota e em que modo (two_wheeler / drive / estimativa)
    ALTER TABLE ride_quotes ADD COLUMN route_provider TEXT;
    ALTER TABLE ride_quotes ADD COLUMN route_mode TEXT;
    ALTER TABLE rides ADD COLUMN route_provider TEXT;
    ALTER TABLE rides ADD COLUMN route_mode TEXT;
    `,
  },
];

const DEFAULT_SETTINGS: Record<string, string> = {
  // --- V2 ---
  confirm_window_s: '5',
  payment_provider: 'auto',        // auto = mercadopago se houver credencial, senão teste
  pix_enabled: '1',
  card_enabled: '1',
  cash_enabled: '1',
  pix_expires_min: '15',
  driver_debt_limit_cents: '5000', // dívida de comissão (corridas em dinheiro) que bloqueia novas corridas
  pickup_move_alert_m: '80',       // distância que dispara "você mudou de local?"
  gps_max_accuracy_m: '150',       // acima disso a posição é considerada imprecisa
  // Quando cobrar: 'antes' = cobra antes de chamar o parceiro (dinheiro garantido,
  // repasse manual) | 'apos_aceite' = cobra depois do aceite, permitindo o split
  // automático direto na conta do mototaxista.
  charge_timing: 'antes',
  payment_deadline_min: '10',      // prazo para pagar depois do aceite (modo split)
  // Mapas: 'auto' usa Google quando há chave de servidor; 'osm' força OpenStreetMap
  maps_provider: 'auto',
  cache_route_hours: '72',         // rota entre dois pontos muda pouco
  cache_places_hours: '168',       // endereços mudam muito pouco
  cache_geocode_hours: '168',

  city_name: 'Assis Chateaubriand - PR',
  center_lat: '-24.4156',
  center_lng: '-53.5216',
  coverage_radius_km: '12',
  dispatch_radius_km: '10',
  commission_pct: '15',
  quote_ttl_min: '10',
  loc_fresh_s: '120',
  welcome_message: 'Olá! Para onde vamos?',
  review_sla_hours: '48',
  passenger_cancel_states: 'requested,accepted',
  driver_cancel_states: 'accepted,in_progress',
};

export function initDb(dbPath?: string): DatabaseSync {
  const file = dbPath || process.env.DB_PATH || path.join(dataDir(), 'assis.db');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as any[]).map(r => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    // Rebuild de tabela: as chaves estrangeiras precisam ficar desligadas
    // (fora da transação) para que o DROP não apague as linhas filhas.
    if (m.fkOff) db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(m.version, now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      if (m.fkOff) db.exec('PRAGMA foreign_keys = ON;');
      throw e;
    }
    if (m.fkOff) {
      db.exec('PRAGMA foreign_keys = ON;');
      const broken = db.prepare('PRAGMA foreign_key_check').all() as any[];
      if (broken.length) {
        throw new Error(`Migração ${m.version} deixou ${broken.length} referência(s) inválida(s).`);
      }
    }
  }
  seed();
  return db;
}

function seed(): void {
  const t = now();
  const insFare = db.prepare(`INSERT OR IGNORE INTO fare_settings
    (category, label, base_cents, included_m, per_km_cents, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
  insFare.run('economica', 'Econômica', 550, 2000, 200, t);
  insFare.run('prioridade', 'Prioridade', 650, 2000, 300, t);

  const insSetting = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);
}

export function getSetting(key: string): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as any;
  return row ? row.value : (DEFAULT_SETTINGS[key] ?? '');
}
export function getSettingNum(key: string): number {
  const n = Number(getSetting(key));
  return Number.isFinite(n) ? n : Number(DEFAULT_SETTINGS[key] ?? 0);
}
export function setSetting(key: string, value: string): void {
  db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/**
 * Credenciais do provedor: lidas primeiro do banco (configuradas pelo
 * administrador na central), depois das variáveis de ambiente.
 */
export function getCredential(key: string): string | null {
  const row = db.prepare('SELECT value_enc FROM provider_credentials WHERE key = ?').get(key) as any;
  if (row) {
    const v = decryptSecret(row.value_enc);
    if (v) return v;
  }
  return process.env[key] || null;
}

export function setCredential(key: string, value: string, adminId: string): void {
  if (!value) {
    db.prepare('DELETE FROM provider_credentials WHERE key = ?').run(key);
    return;
  }
  db.prepare(`INSERT INTO provider_credentials (key, value_enc, updated_by, updated_at)
    VALUES (?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(key, encryptSecret(value), adminId, now());
}

/** De onde veio cada credencial — mostrado na central para evitar confusão. */
export function credentialSource(key: string): 'banco' | 'ambiente' | 'ausente' {
  const row = db.prepare('SELECT 1 FROM provider_credentials WHERE key = ?').get(key);
  if (row) return 'banco';
  return process.env[key] ? 'ambiente' : 'ausente';
}

export function audit(adminId: string, action: string, targetType?: string,
  targetId?: string, details?: string): void {
  db.prepare(`INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(adminId, action, targetType ?? null, targetId ?? null, details ?? null, now());
}
