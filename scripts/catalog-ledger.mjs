import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeLedgerSchema } from "../packages/ledger/schema.mjs";
import {
  catalogContentHash,
  problemIdentityHash,
  stableStringify,
  validateCatalog,
} from "./catalog-lib.mjs";

export async function syncCatalog({ catalog, databasePath }) {
  validateCatalog(catalog);
  await mkdir(path.dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(databasePath);
  try {
    initializeLedgerSchema(database);
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = syncInsideTransaction(database, catalog);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export function readCatalogStatus(databasePath) {
  const database = openSyncedDatabase(databasePath);
  try {
    requireCatalogSyncTable(database, databasePath);

    const sync = database.prepare(
      `SELECT schema_version, catalog_revision, catalog_hash, synced_at
       FROM catalog_sync WHERE singleton = 1`,
    ).get();
    if (!sync) throw new Error(`No catalog has been synced to ${databasePath}.`);

    const counts = database.prepare(
      "SELECT COUNT(*) AS problem_count FROM problems WHERE catalog_present = 1",
    ).get();
    return {
      schema_version: Number(sync.schema_version),
      catalog_revision: Number(sync.catalog_revision),
      catalog_hash: sync.catalog_hash,
      synced_at: sync.synced_at,
      problem_count: Number(counts.problem_count),
    };
  } finally {
    database.close();
  }
}

export function readSyncedCatalog(databasePath) {
  const database = openSyncedDatabase(databasePath);
  try {
    requireCatalogSyncTable(database, databasePath);
    const row = database.prepare(
      "SELECT catalog_json FROM catalog_sync WHERE singleton = 1",
    ).get();
    if (!row) throw new Error(`No catalog has been synced to ${databasePath}.`);
    return JSON.parse(row.catalog_json);
  } finally {
    database.close();
  }
}

function syncInsideTransaction(database, catalog) {
  const incomingHash = catalogContentHash(catalog);
  const previousSync = database.prepare(
    `SELECT schema_version, catalog_revision, catalog_hash
     FROM catalog_sync WHERE singleton = 1`,
  ).get();

  if (previousSync && previousSync.catalog_hash === incomingHash) {
    return {
      outcome: "unchanged",
      catalog_revision: Number(previousSync.catalog_revision),
      problem_count: catalog.problems.length,
      added: 0,
      updated: 0,
    };
  }

  if (previousSync && catalog.catalog_revision <= Number(previousSync.catalog_revision)) {
    throw new Error(
      `Catalog content changed but revision ${catalog.catalog_revision} is not greater than `
      + `last synced revision ${previousSync.catalog_revision}.`,
    );
  }

  const existingRows = database.prepare(
    "SELECT problem_id, identity_hash, metadata_json FROM problems ORDER BY problem_id",
  ).all();
  const incomingById = new Map(catalog.problems.map((problem) => [problem.id, problem]));
  const omittedIds = existingRows
    .filter((existing) => !incomingById.has(existing.problem_id))
    .map((existing) => existing.problem_id);

  let added = 0;
  let updated = 0;
  const existingById = new Map(existingRows.map((row) => [row.problem_id, row]));

  for (const problem of catalog.problems) {
    const existing = existingById.get(problem.id);
    const identityHash = problemIdentityHash(problem);
    if (existing && existing.identity_hash !== identityHash) {
      throw new Error(
        `problem_id ${problem.id} is already bound to a different canonical statement. `
        + "Create a new problem_id for a material claim change.",
      );
    }
    const metadataJson = stableStringify(problem);
    if (!existing) added += 1;
    else if (existing.metadata_json !== metadataJson) updated += 1;
  }

  // Avoid transient UNIQUE(slug) conflicts when existing entries swap slugs.
  database.prepare(
    "UPDATE problems SET slug = '__catalog_sync__-' || rowid",
  ).run();
  database.prepare("UPDATE problems SET catalog_present = 0").run();
  const removeTierMappings = database.prepare(
    "DELETE FROM open_collective_tiers WHERE problem_id = ?",
  );
  for (const problemId of omittedIds) removeTierMappings.run(problemId);

  const upsert = database.prepare(`
    INSERT INTO problems (
      problem_id,
      identity_hash,
      first_catalog_revision,
      catalog_revision,
      slug,
      domain,
      title,
      statement,
      prove_prompt,
      disprove_prompt,
      source_json,
      metadata_json,
      catalog_present
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(problem_id) DO UPDATE SET
      catalog_revision = CASE
        WHEN problems.metadata_json = excluded.metadata_json
          THEN problems.catalog_revision
        ELSE excluded.catalog_revision
      END,
      slug = excluded.slug,
      domain = excluded.domain,
      title = excluded.title,
      statement = excluded.statement,
      prove_prompt = excluded.prove_prompt,
      disprove_prompt = excluded.disprove_prompt,
      source_json = excluded.source_json,
      metadata_json = excluded.metadata_json,
      catalog_present = 1
  `);

  for (const problem of catalog.problems) {
    upsert.run(
      problem.id,
      problemIdentityHash(problem),
      catalog.catalog_revision,
      catalog.catalog_revision,
      problem.slug,
      problem.domain,
      problem.title,
      problem.statement,
      problem.directions.prove,
      problem.directions.disprove,
      stableStringify(problem.source),
      stableStringify(problem),
    );
  }

  const syncedAt = new Date().toISOString();
  database.prepare(`
    INSERT INTO catalog_sync (
      singleton,
      schema_version,
      catalog_revision,
      catalog_hash,
      catalog_json,
      synced_at
    ) VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      schema_version = excluded.schema_version,
      catalog_revision = excluded.catalog_revision,
      catalog_hash = excluded.catalog_hash,
      catalog_json = excluded.catalog_json,
      synced_at = excluded.synced_at
  `).run(
    catalog.schema_version,
    catalog.catalog_revision,
    incomingHash,
    stableStringify(catalog),
    syncedAt,
  );

  return {
    outcome: previousSync ? "synced" : "initialized",
    catalog_revision: catalog.catalog_revision,
    problem_count: catalog.problems.length,
    added,
    updated,
  };
}

function openSyncedDatabase(databasePath) {
  if (!existsSync(databasePath)) {
    throw new Error(`No catalog has been synced to ${databasePath}.`);
  }

  try {
    return new DatabaseSync(databasePath, { readOnly: true });
  } catch (error) {
    throw new Error(
      `Cannot open catalog ledger ${databasePath}: ${error.message}`,
      { cause: error },
    );
  }
}

function requireCatalogSyncTable(database, databasePath) {
  const table = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'catalog_sync'",
  ).get();
  if (!table) throw new Error(`No catalog has been synced to ${databasePath}.`);
}
