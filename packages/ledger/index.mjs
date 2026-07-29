import {
  assertPort,
  assertRuntimeConfig,
} from "#indiemath/shared";

export {
  readCatalogStatus,
  readSyncedCatalog,
  syncCatalog,
} from "../../scripts/catalog-ledger.mjs";
export {
  LedgerError,
  openLedger,
  SQLiteLedger,
} from "./sqlite-ledger.mjs";
export {
  configureLedgerConnection,
  initializeLedgerSchema,
  isLedgerSchemaCurrent,
  LEDGER_SCHEMA_VERSION,
} from "./schema.mjs";

export function createLedgerRuntime({ config, ledger }) {
  assertRuntimeConfig(config, "ledger");
  assertPort(ledger, "ledger", ["healthcheck"]);

  return Object.freeze({
    name: "ledger",
    config,
    async probe() {
      return ledger.healthcheck();
    },
  });
}
