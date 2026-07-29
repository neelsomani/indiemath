import {
  assertPort,
  assertRuntimeConfig,
} from "#indiemath/shared";
import { readTreasuryPublication } from "./treasury-publication.mjs";

export {
  executeOpenCollectiveRefund,
  OpenCollectiveIntakeController,
  runOpenCollectiveIntakeOnce,
} from "./open-collective-intake.mjs";
export {
  executeStripeRefund,
  runStripeDisputeIntakeOnce,
} from "./stripe-operations.mjs";
export {
  reconcileStripeSettlements,
} from "./settlement-reconciliation.mjs";
export { readTreasuryPublication };

export function createIntakePublisherRuntime({
  config,
  ledger,
  r2,
  openCollective,
}) {
  assertRuntimeConfig(config, "intake-publisher");
  assertPort(ledger, "ledger", ["healthcheck", "treasuryStatus"]);
  assertPort(r2, "R2", ["healthcheck", "putObject", "getObject"]);
  assertPort(openCollective, "Open Collective", [
    "healthcheck",
    "upsertTier",
    "listTiers",
    "listCreditTransactions",
  ]);

  return Object.freeze({
    name: "intake-publisher",
    config,
    treasurySnapshot() {
      return readTreasuryPublication(ledger);
    },
    async probe() {
      const [ledgerStatus, objectStoreStatus, openCollectiveStatus] = await Promise.all([
        ledger.healthcheck(),
        r2.healthcheck(),
        openCollective.healthcheck(),
      ]);
      return {
        ok: true,
        component: "intake-publisher",
        dependencies: {
          ledger: ledgerStatus,
          r2: objectStoreStatus,
          openCollective: openCollectiveStatus,
        },
      };
    },
  });
}
