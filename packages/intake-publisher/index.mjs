import {
  assertPort,
  assertRuntimeConfig,
} from "#indiemath/shared";

export function createIntakePublisherRuntime({
  config,
  ledger,
  r2,
  openCollective,
}) {
  assertRuntimeConfig(config, "intake-publisher");
  assertPort(ledger, "ledger", ["healthcheck"]);
  assertPort(r2, "R2", ["healthcheck", "putObject", "getObject"]);
  assertPort(openCollective, "Open Collective", [
    "healthcheck",
    "upsertTier",
    "listCreditTransactions",
  ]);

  return Object.freeze({
    name: "intake-publisher",
    config,
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
