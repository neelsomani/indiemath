#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertCatalogRevisionAdvance,
  CatalogValidationError,
  readCatalog,
  stableStringify,
  validateCatalog,
} from "./catalog-lib.mjs";
import {
  readCatalogStatus,
  readSyncedCatalog,
  syncCatalog,
} from "./catalog-ledger.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(rootDir, "problems", "catalog.json");

test("the checked-in catalog satisfies the complete contract", async () => {
  const catalog = validateCatalog(await readCatalog(catalogPath));
  assert.ok(catalog.problems.length > 0);
  assert.ok(catalog.problems.every((problem) => problem.source));
});

test("validation rejects unsafe IDs, question statements, missing sources, and unsupported active fields", async () => {
  const catalog = await readCatalog(catalogPath);
  const invalid = structuredClone(catalog);
  invalid.problems[0].id = "../unsafe";
  invalid.problems[1].statement = "Is this a conjecture?";
  delete invalid.problems[2].source;
  invalid.problems[3].active = true;

  assert.throws(
    () => validateCatalog(invalid),
    (error) => {
      assert.ok(error instanceof CatalogValidationError);
      assert.match(error.message, /must be 3–64 characters/);
      assert.match(error.message, /canonical positive statement/);
      assert.match(error.message, /source must be an object/);
      assert.match(error.message, /\.active is unsupported/);
      return true;
    },
  );
});

test("repository revision comparison requires content changes to advance the revision", async () => {
  const catalog = validateCatalog(await readCatalog(catalogPath));
  const unchanged = structuredClone(catalog);
  assert.deepEqual(
    assertCatalogRevisionAdvance(catalog, unchanged),
    {
      baseRevision: catalog.catalog_revision,
      candidateRevision: catalog.catalog_revision,
      contentChanged: false,
    },
  );

  const changedWithoutRevision = structuredClone(catalog);
  changedWithoutRevision.problems[0].title = "Changed without a revision";
  assert.throws(
    () => assertCatalogRevisionAdvance(catalog, changedWithoutRevision),
    /content changed but revision .* is not greater than base revision/,
  );

  const changedWithRevision = structuredClone(changedWithoutRevision);
  changedWithRevision.catalog_revision += 1;
  assert.equal(
    assertCatalogRevisionAdvance(catalog, changedWithRevision).contentChanged,
    true,
  );

  const rollback = structuredClone(catalog);
  rollback.catalog_revision -= 1;
  assert.throws(
    () => assertCatalogRevisionAdvance(catalog, rollback),
    /revision moved backward/,
  );
});

test("sync is idempotent and permits non-semantic metadata revisions", async (context) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "indiemath-catalog-test-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const databasePath = path.join(scratch, "ledger.sqlite");
  const catalog = validateCatalog(await readCatalog(catalogPath));

  const initialized = await syncCatalog({ catalog, databasePath });
  assert.deepEqual(
    pick(initialized, ["outcome", "problem_count", "added", "updated"]),
    {
      outcome: "initialized",
      problem_count: catalog.problems.length,
      added: catalog.problems.length,
      updated: 0,
    },
  );

  const unchanged = await syncCatalog({ catalog, databasePath });
  assert.equal(unchanged.outcome, "unchanged");

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const stored = database.prepare(
      "SELECT catalog_json FROM catalog_sync WHERE singleton = 1",
    ).get();
    assert.equal(stored.catalog_json, stableStringify(catalog));
  } finally {
    database.close();
  }

  const revised = structuredClone(catalog);
  revised.catalog_revision += 1;
  revised.problems[0].title = "Riemann Hypothesis";
  const synced = await syncCatalog({ catalog: revised, databasePath });
  assert.deepEqual(
    pick(synced, ["outcome", "problem_count", "added", "updated"]),
    { outcome: "synced", problem_count: catalog.problems.length, added: 0, updated: 1 },
  );

  const status = readCatalogStatus(databasePath);
  assert.equal(status.catalog_revision, revised.catalog_revision);
  assert.equal(status.problem_count, catalog.problems.length);
  assert.deepEqual(readSyncedCatalog(databasePath), revised);
});

test("sync permits slug swaps and preserves problem status", async (context) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "indiemath-catalog-test-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const databasePath = path.join(scratch, "ledger.sqlite");
  const catalog = validateCatalog(await readCatalog(catalogPath));
  await syncCatalog({ catalog, databasePath });

  const [first, second] = catalog.problems;
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare(
      "UPDATE problems SET status = 'PendingReview' WHERE problem_id = ?",
    ).run(first.id);
  } finally {
    database.close();
  }

  const revised = structuredClone(catalog);
  revised.catalog_revision += 1;
  [revised.problems[0].slug, revised.problems[1].slug] = [
    revised.problems[1].slug,
    revised.problems[0].slug,
  ];

  const result = await syncCatalog({ catalog: revised, databasePath });
  assert.equal(result.updated, 2);

  const syncedDatabase = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = syncedDatabase.prepare(
      `SELECT problem_id, slug, status
       FROM problems
       WHERE problem_id IN (?, ?)
       ORDER BY problem_id`,
    ).all(first.id, second.id);
    const byId = new Map(rows.map((row) => [row.problem_id, row]));
    assert.equal(byId.get(first.id).slug, second.slug);
    assert.equal(byId.get(second.id).slug, first.slug);
    assert.equal(byId.get(first.id).status, "PendingReview");
    assert.equal(byId.get(second.id).status, "Open");
  } finally {
    syncedDatabase.close();
  }
});

test("sync refuses revision rollback and ID reuse while tombstoning omissions", async (context) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "indiemath-catalog-test-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const databasePath = path.join(scratch, "ledger.sqlite");
  const catalog = validateCatalog(await readCatalog(catalogPath));
  await syncCatalog({ catalog, databasePath });

  const sameRevisionChange = structuredClone(catalog);
  sameRevisionChange.problems[0].title = "Changed without a revision";
  await assert.rejects(
    syncCatalog({ catalog: sameRevisionChange, databasePath }),
    /revision .* is not greater than last synced revision/,
  );

  const reusedId = structuredClone(catalog);
  reusedId.catalog_revision += 1;
  reusedId.problems[0].statement = "A materially different mathematical claim.";
  await assert.rejects(
    syncCatalog({ catalog: reusedId, databasePath }),
    /already bound to a different canonical statement/,
  );

  const removed = structuredClone(catalog);
  removed.catalog_revision += 1;
  const omittedProblem = removed.problems.pop();
  const removal = await syncCatalog({ catalog: removed, databasePath });
  assert.deepEqual(removal, {
    outcome: "synced",
    catalog_revision: removed.catalog_revision,
    problem_count: removed.problems.length,
    added: 0,
    updated: 0,
  });
  assert.equal(readCatalogStatus(databasePath).problem_count, removed.problems.length);
  assert.equal(
    readSyncedCatalog(databasePath).problems.some(
      (problem) => problem.id === omittedProblem.id,
    ),
    false,
  );
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tombstone = database.prepare(
      "SELECT identity_hash, catalog_present FROM problems WHERE problem_id = ?",
    ).get(omittedProblem.id);
    assert.equal(tombstone.catalog_present, 0);
    assert.equal(typeof tombstone.identity_hash, "string");
  } finally {
    database.close();
  }
});

test("catalog readers report a friendly error for a missing ledger", async (context) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "indiemath-catalog-test-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const databasePath = path.join(scratch, "missing.sqlite");

  assert.throws(
    () => readCatalogStatus(databasePath),
    /No catalog has been synced/,
  );
  assert.throws(
    () => readSyncedCatalog(databasePath),
    /No catalog has been synced/,
  );
});

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
