import {
  assertPort,
  assertRuntimeConfig,
} from "#indiemath/shared";

export {
  buildOpenCollectiveTierSpecification,
  OPEN_COLLECTIVE_MINIMUM_CENTS,
  syncOpenCollectiveTiers,
} from "./open-collective-tiers.mjs";
export {
  fundTreasuryFromReconciliation,
  refreshTreasuryStatus,
} from "./treasury.mjs";
export {
  createLedgerBackup,
  restoreLocalLedgerBackup,
  verifyLedgerDatabase,
} from "./backup.mjs";
export { inspectLedger } from "./inspection.mjs";
export {
  reconcileOpenCollectiveCredits,
} from "./open-collective-reconciliation.mjs";
export {
  checkOperationalHealth,
  readSystemdServiceStates,
  requiredProductionServices,
  REQUIRED_PRODUCTION_SERVICES,
} from "./monitoring.mjs";
export { verifyLaunchReadiness } from "./launch-verification.mjs";
export { applyReviewVerdict } from "./review.mjs";

export function createAdminRuntime({
  config,
  ledger,
  r2,
  openCollective,
  anthropicAdmin,
}) {
  assertRuntimeConfig(config, "admin-cli");
  assertPort(ledger, "ledger", ["healthcheck"]);
  assertPort(r2, "R2", ["healthcheck", "putObject", "getObject"]);
  assertPort(openCollective, "Open Collective", [
    "healthcheck",
    "upsertTier",
    "upsertTiers",
    "listTiers",
    "listCreditTransactions",
  ]);
  assertPort(anthropicAdmin, "Anthropic Admin", ["healthcheck", "listUsage"]);

  return Object.freeze({
    name: "admin-cli",
    config,
    async probe() {
      const [
        ledgerStatus,
        objectStoreStatus,
        openCollectiveStatus,
        anthropicAdminStatus,
      ] = await Promise.all([
        ledger.healthcheck(),
        r2.healthcheck(),
        openCollective.healthcheck(),
        anthropicAdmin.healthcheck(),
      ]);
      return {
        ok: true,
        component: "admin-cli",
        dependencies: {
          ledger: ledgerStatus,
          r2: objectStoreStatus,
          openCollective: openCollectiveStatus,
          anthropicAdmin: anthropicAdminStatus,
        },
      };
    },
  });
}
