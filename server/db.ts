import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { dataDir, now } from './util.ts';

export let db: DatabaseSync;

const MIGRATIONS: { version: number; sql: string }[] = [
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
];

const DEFAULT_SETTINGS: Record<string, string> = {
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
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(m.version, now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
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

export function audit(adminId: string, action: string, targetType?: string,
  targetId?: string, details?: string): void {
  db.prepare(`INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(adminId, action, targetType ?? null, targetId ?? null, details ?? null, now());
}
