#!/usr/bin/env node

import process from "node:process";
import { verifyLedgerDatabase } from "#indiemath/admin-cli";

const databasePath = process.argv[2];
if (!databasePath) {
  console.error("Usage: verify-ledger-restore.mjs <database.sqlite>");
  process.exit(2);
}

try {
  console.log(JSON.stringify(await verifyLedgerDatabase(databasePath)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
