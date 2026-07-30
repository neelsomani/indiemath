import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  link,
  mkdir,
  readFile,
  rm,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  LEDGER_SCHEMA_VERSION,
  SQLiteLedger,
} from "#indiemath/ledger";

export async function createLedgerBackup({
  databasePath,
  outputPath,
}) {
  const source = distinctDatabasePath(databasePath, "databasePath");
  const output = distinctDatabasePath(outputPath, "outputPath");
  if (source === output) throw new Error("Backup output cannot be the live database.");
  await access(source, fsConstants.R_OK);
  await mkdir(path.dirname(output), { recursive: true });

  if (await exists(output)) {
    const verification = await verifyLedgerDatabase(output);
    return Object.freeze({
      outcome: "existing",
      outputPath: output,
      verification,
    });
  }

  const temporary = `${output}.tmp-${process.pid}-${Date.now()}`;
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    database.prepare("VACUUM INTO ?").run(temporary);
  } finally {
    database.close();
  }
  try {
    const verification = await verifyLedgerDatabase(temporary);
    await link(temporary, output);
    return Object.freeze({
      outcome: "created",
      outputPath: output,
      verification,
    });
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function restoreLocalLedgerBackup({
  backupPath,
  outputPath,
  liveDatabasePath,
}) {
  const source = distinctDatabasePath(backupPath, "backupPath");
  const output = distinctDatabasePath(outputPath, "outputPath");
  const live = distinctDatabasePath(liveDatabasePath, "liveDatabasePath");
  if (output === source) throw new Error("Restore output cannot equal its source.");
  if (output === live) {
    throw new Error("Restore output cannot overwrite the live database.");
  }
  await mkdir(path.dirname(output), { recursive: true });
  const sourceVerification = await verifyLedgerDatabase(source);
  if (await exists(output)) {
    const verification = await verifyLedgerDatabase(output);
    if (verification.sha256 !== sourceVerification.sha256) {
      throw new Error(
        `Restore destination ${output} already contains a different ledger.`,
      );
    }
    return Object.freeze({
      outcome: "existing",
      outputPath: output,
      verification,
    });
  }
  const temporary = `${output}.tmp-${process.pid}-${Date.now()}`;
  try {
    await copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
    const verification = await verifyLedgerDatabase(temporary);
    if (verification.sha256 !== sourceVerification.sha256) {
      throw new Error("Restored ledger bytes do not match the verified source.");
    }
    try {
      await link(temporary, output);
      return Object.freeze({
        outcome: "restored",
        outputPath: output,
        verification,
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await verifyLedgerDatabase(output);
      if (existing.sha256 !== sourceVerification.sha256) {
        throw new Error(
          `Restore destination ${output} concurrently received a different ledger.`,
        );
      }
      return Object.freeze({
        outcome: "existing",
        outputPath: output,
        verification: existing,
      });
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function verifyLedgerDatabase(databasePath) {
  const resolved = distinctDatabasePath(databasePath, "databasePath");
  const bytes = await readFile(resolved);
  const database = new DatabaseSync(resolved, { readOnly: true });
  const ledger = new SQLiteLedger({ database, databasePath: resolved });
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
        `Expected ledger schema ${LEDGER_SCHEMA_VERSION}; `
        + `found ${schema?.schema_version ?? "none"}.`,
      );
    }
    return Object.freeze({
      ok: true,
      databasePath: resolved,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.length,
      schemaVersion: Number(schema.schema_version),
      conservation: ledger.assertConservation(),
    });
  } finally {
    ledger.close();
  }
}

function distinctDatabasePath(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty path.`);
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`${label} cannot be the filesystem root.`);
  }
  return resolved;
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
