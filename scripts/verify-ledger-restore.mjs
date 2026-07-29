#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import {
  LEDGER_SCHEMA_VERSION,
  SQLiteLedger,
} from "#indiemath/ledger";

const databasePath = process.argv[2];
if (!databasePath) {
  console.error("Usage: verify-ledger-restore.mjs <database.sqlite>");
  process.exit(2);
}

const resolvedPath = path.resolve(databasePath);
const database = new DatabaseSync(resolvedPath, { readOnly: true });
const ledger = new SQLiteLedger({ database, databasePath: resolvedPath });

try {
  const integrity = database.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
    throw new Error(`SQLite integrity check failed: ${JSON.stringify(integrity)}`);
  }

  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) {
    throw new Error(
      `SQLite foreign-key check failed: ${JSON.stringify(foreignKeys)}`,
    );
  }

  const schema = database.prepare(`
    SELECT schema_version
    FROM ledger_schema
    WHERE singleton = 1
  `).get();
  if (schema?.schema_version !== LEDGER_SCHEMA_VERSION) {
    throw new Error(
      `Expected ledger schema ${LEDGER_SCHEMA_VERSION}; found ${schema?.schema_version ?? "none"}.`,
    );
  }

  const conservation = ledger.assertConservation();
  console.log(JSON.stringify({
    ok: true,
    databasePath: resolvedPath,
    schemaVersion: schema.schema_version,
    conservation,
  }));
} finally {
  ledger.close();
}
