export const LEDGER_SCHEMA_VERSION = 5;

export function configureLedgerConnection(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
}

export function isLedgerSchemaCurrent(database) {
  const table = database.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'ledger_schema'
  `).get();
  if (!table) return false;

  const row = database.prepare(`
    SELECT schema_version
    FROM ledger_schema
    WHERE singleton = 1
  `).get();
  return row?.schema_version === LEDGER_SCHEMA_VERSION;
}

export function initializeLedgerSchema(database) {
  configureLedgerConnection(database);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;

    CREATE TABLE IF NOT EXISTS ledger_schema (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version > 0),
      migrated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS catalog_sync (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      catalog_revision INTEGER NOT NULL CHECK (catalog_revision > 0),
      catalog_hash TEXT NOT NULL,
      catalog_json TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS problems (
      problem_id TEXT PRIMARY KEY,
      identity_hash TEXT NOT NULL,
      first_catalog_revision INTEGER NOT NULL CHECK (first_catalog_revision > 0),
      catalog_revision INTEGER NOT NULL CHECK (catalog_revision > 0),
      slug TEXT NOT NULL UNIQUE,
      domain TEXT NOT NULL,
      title TEXT NOT NULL,
      statement TEXT NOT NULL,
      prove_prompt TEXT NOT NULL,
      disprove_prompt TEXT NOT NULL,
      source_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Open'
        CHECK (status IN ('Open', 'PendingReview', 'Solved')),
      pending_direction TEXT CHECK (pending_direction IN ('prove', 'disprove')),
      pending_claim_ts INTEGER,
      pending_solution_uri TEXT,
      secondary_direction TEXT CHECK (secondary_direction IN ('prove', 'disprove')),
      secondary_claim_ts INTEGER,
      secondary_solution_uri TEXT
    );
  `);

  ensureColumn(
    database,
    "problems",
    "pending_direction",
    "TEXT CHECK (pending_direction IN ('prove', 'disprove'))",
  );
  ensureColumn(database, "problems", "pending_claim_ts", "INTEGER");
  ensureColumn(database, "problems", "pending_solution_uri", "TEXT");
  ensureColumn(
    database,
    "problems",
    "secondary_direction",
    "TEXT CHECK (secondary_direction IN ('prove', 'disprove'))",
  );
  ensureColumn(database, "problems", "secondary_claim_ts", "INTEGER");
  ensureColumn(database, "problems", "secondary_solution_uri", "TEXT");

  database.exec(`
    CREATE TABLE IF NOT EXISTS pools (
      problem_id TEXT NOT NULL REFERENCES problems(problem_id),
      direction TEXT NOT NULL CHECK (direction IN ('prove', 'disprove')),
      balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
      cumulative_donations_cents INTEGER NOT NULL DEFAULT 0
        CHECK (cumulative_donations_cents >= 0),
      PRIMARY KEY (problem_id, direction)
    );

    CREATE TABLE IF NOT EXISTS donations (
      dedup_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      destination_kind TEXT NOT NULL CHECK (destination_kind IN ('pool', 'general')),
      problem_id TEXT REFERENCES problems(problem_id),
      direction TEXT CHECK (direction IN ('prove', 'disprove')),
      intended_problem_id TEXT REFERENCES problems(problem_id),
      intended_direction TEXT CHECK (intended_direction IN ('prove', 'disprove')),
      gross_cents INTEGER NOT NULL CHECK (gross_cents > 0),
      fees_cents INTEGER NOT NULL CHECK (fees_cents >= 0),
      net_cents INTEGER NOT NULL CHECK (net_cents > 0),
      donor_tag TEXT NOT NULL,
      credited_at TEXT NOT NULL,
      payment_state TEXT NOT NULL DEFAULT 'credited'
        CHECK (payment_state IN ('credited', 'disputed', 'reversed')),
      waterline_excluded_cents INTEGER NOT NULL DEFAULT 0
        CHECK (
          waterline_excluded_cents >= 0
          AND waterline_excluded_cents <= net_cents
        ),
      CHECK (gross_cents = fees_cents + net_cents),
      CHECK (
        (destination_kind = 'pool' AND problem_id IS NOT NULL AND direction IS NOT NULL)
        OR
        (destination_kind = 'general' AND problem_id IS NULL AND direction IS NULL)
      ),
      CHECK (
        (intended_problem_id IS NULL AND intended_direction IS NULL)
        OR
        (intended_problem_id IS NOT NULL AND intended_direction IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS donations_credit_order
      ON donations(credited_at, dedup_id);
    CREATE INDEX IF NOT EXISTS donations_parent_order
      ON donations(order_id);
    CREATE INDEX IF NOT EXISTS donations_destination
      ON donations(destination_kind, problem_id, direction);

    CREATE TABLE IF NOT EXISTS claims (
      problem_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('prove', 'disprove')),
      claim_ts INTEGER NOT NULL CHECK (claim_ts > 0),
      catalog_revision INTEGER NOT NULL CHECK (catalog_revision > 0),
      worker_id TEXT NOT NULL
        CHECK (worker_id IN ('worker-1', 'worker-2', 'worker-3', 'worker-4')),
      budget_cents INTEGER NOT NULL CHECK (budget_cents > 0),
      pool_funded_cents INTEGER NOT NULL CHECK (
        pool_funded_cents >= 0 AND pool_funded_cents <= budget_cents
      ),
      spent_cents INTEGER NOT NULL DEFAULT 0 CHECK (
        spent_cents >= 0 AND spent_cents <= budget_cents
      ),
      lease_expires_at TEXT NOT NULL,
      settled INTEGER NOT NULL DEFAULT 0 CHECK (settled IN (0, 1)),
      settled_at TEXT,
      solution_uri TEXT,
      PRIMARY KEY (problem_id, direction, claim_ts),
      FOREIGN KEY (problem_id, direction) REFERENCES pools(problem_id, direction)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS claims_one_unsettled_pair
      ON claims(problem_id, direction) WHERE settled = 0;
    CREATE UNIQUE INDEX IF NOT EXISTS claims_one_unsettled_worker
      ON claims(worker_id) WHERE settled = 0;

    CREATE TABLE IF NOT EXISTS claim_responses (
      problem_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('prove', 'disprove')),
      claim_ts INTEGER NOT NULL CHECK (claim_ts > 0),
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      message_id TEXT NOT NULL UNIQUE,
      request_id TEXT,
      model_id TEXT NOT NULL,
      stop_reason TEXT,
      stop_details_json TEXT,
      container_id TEXT,
      usage_json TEXT NOT NULL,
      request_json TEXT NOT NULL,
      response_json TEXT NOT NULL,
      priced_cost_cents INTEGER NOT NULL CHECK (priced_cost_cents >= 0),
      applied_cost_cents INTEGER NOT NULL CHECK (applied_cost_cents >= 0),
      overage_cents INTEGER NOT NULL CHECK (overage_cents >= 0),
      request_started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      PRIMARY KEY (problem_id, direction, claim_ts, sequence),
      FOREIGN KEY (problem_id, direction, claim_ts)
        REFERENCES claims(problem_id, direction, claim_ts),
      CHECK (priced_cost_cents = applied_cost_cents + overage_cents)
    );

    CREATE INDEX IF NOT EXISTS claim_responses_claim
      ON claim_responses(problem_id, direction, claim_ts, sequence);
    CREATE INDEX IF NOT EXISTS claim_responses_request
      ON claim_responses(request_id);
    CREATE INDEX IF NOT EXISTS claim_responses_started
      ON claim_responses(request_started_at);

    CREATE TABLE IF NOT EXISTS reviewed_results (
      problem_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('prove', 'disprove')),
      claim_ts INTEGER NOT NULL CHECK (claim_ts > 0),
      solution_uri TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (
        outcome IN ('unconditional', 'conditional', 'rejected')
      ),
      note_uri TEXT NOT NULL,
      assumption_label TEXT,
      reviewed_at TEXT NOT NULL,
      CHECK (
        (outcome = 'conditional' AND assumption_label IS NOT NULL)
        OR
        (outcome <> 'conditional' AND assumption_label IS NULL)
      ),
      PRIMARY KEY (problem_id, direction, claim_ts),
      FOREIGN KEY (problem_id, direction, claim_ts)
        REFERENCES claims(problem_id, direction, claim_ts)
    );

    CREATE INDEX IF NOT EXISTS reviewed_results_note
      ON reviewed_results(problem_id, note_uri);

    CREATE TABLE IF NOT EXISTS funding_events (
      external_reference TEXT PRIMARY KEY,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      settled_contribution_cents INTEGER NOT NULL
        CHECK (settled_contribution_cents >= 0),
      funded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS general_credit (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0),
      debt_cents INTEGER NOT NULL DEFAULT 0 CHECK (debt_cents >= 0)
    );

    CREATE TABLE IF NOT EXISTS adjustments (
      adjustment_id TEXT PRIMARY KEY,
      reason_code TEXT NOT NULL CHECK (
        reason_code IN ('refund', 'dispute', 'reconciliation')
      ),
      amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
      donation_dedup_id TEXT REFERENCES donations(dedup_id),
      external_reference TEXT NOT NULL UNIQUE,
      provider_reference TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'canceled')),
      note TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      CHECK (
        (reason_code IN ('refund', 'dispute') AND donation_dedup_id IS NOT NULL)
        OR reason_code = 'reconciliation'
      ),
      CHECK (
        reason_code = 'reconciliation' OR amount_cents < 0
      ),
      CHECK (
        status = 'completed' OR reason_code = 'refund'
      ),
      CHECK (
        reason_code <> 'refund' OR status <> 'completed'
        OR provider_reference IS NOT NULL
      )
    );

    CREATE INDEX IF NOT EXISTS adjustments_donation
      ON adjustments(donation_dedup_id, reason_code, status);

    CREATE TRIGGER IF NOT EXISTS problems_insert_pools
    AFTER INSERT ON problems
    BEGIN
      INSERT OR IGNORE INTO pools(problem_id, direction)
        VALUES (NEW.problem_id, 'prove');
      INSERT OR IGNORE INTO pools(problem_id, direction)
        VALUES (NEW.problem_id, 'disprove');
    END;

    INSERT OR IGNORE INTO general_credit(singleton, balance_cents) VALUES (1, 0);

    INSERT OR IGNORE INTO pools(problem_id, direction)
      SELECT problem_id, 'prove' FROM problems;
    INSERT OR IGNORE INTO pools(problem_id, direction)
      SELECT problem_id, 'disprove' FROM problems;
  `);

  ensureColumn(
    database,
    "donations",
    "intended_problem_id",
    "TEXT REFERENCES problems(problem_id)",
  );
  ensureColumn(
    database,
    "donations",
    "intended_direction",
    "TEXT CHECK (intended_direction IN ('prove', 'disprove'))",
  );
  ensureColumn(
    database,
    "donations",
    "waterline_excluded_cents",
    "INTEGER NOT NULL DEFAULT 0 CHECK (waterline_excluded_cents >= 0)",
  );
  database.exec(`
    UPDATE donations
    SET intended_problem_id = problem_id,
        intended_direction = direction
    WHERE destination_kind = 'pool'
      AND intended_problem_id IS NULL
      AND intended_direction IS NULL;
  `);

  ensureColumn(
    database,
    "general_credit",
    "debt_cents",
    "INTEGER NOT NULL DEFAULT 0 CHECK (debt_cents >= 0)",
  );

  database.prepare(`
    INSERT INTO ledger_schema(singleton, schema_version, migrated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      schema_version = excluded.schema_version,
      migrated_at = excluded.migrated_at
    WHERE ledger_schema.schema_version <> excluded.schema_version
  `).run(LEDGER_SCHEMA_VERSION, new Date().toISOString());
  database.exec(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION}`);
}

function ensureColumn(database, table, column, definition) {
  const existing = database.prepare(`PRAGMA table_info(${table})`).all();
  if (existing.some((row) => row.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
