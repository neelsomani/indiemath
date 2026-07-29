import {
  assertPort,
  assertRuntimeConfig,
} from "#indiemath/shared";
import {
  loadAnthropicPricingTable,
  runFableClaim,
} from "#indiemath/anthropic";

export function createWorkerRuntime({
  config,
  ledger,
  r2,
  anthropicMessages,
  pricingTable,
}) {
  assertRuntimeConfig(config, "worker");
  assertPort(ledger, "ledger", ["healthcheck"]);
  assertPort(r2, "R2", ["healthcheck", "putObject", "getObject", "listObjects"]);
  assertPort(anthropicMessages, "Anthropic Messages", [
    "healthcheck",
    "createMessage",
    "streamMessage",
  ]);

  return Object.freeze({
    name: "worker",
    workerId: config.workerId,
    config,
    async runClaim(options) {
      const resolvedPricingTable = pricingTable
        ?? await loadAnthropicPricingTable(config.pricingTablePath);
      return runFableClaim({
        ...options,
        messagesClient: anthropicMessages,
        ledger,
        r2,
        pricingTable: resolvedPricingTable,
      });
    },
    async probe() {
      const [ledgerStatus, objectStoreStatus, messagesStatus] = await Promise.all([
        ledger.healthcheck(),
        r2.healthcheck(),
        anthropicMessages.healthcheck(),
      ]);
      return {
        ok: true,
        component: "worker",
        workerId: config.workerId,
        dependencies: {
          ledger: ledgerStatus,
          r2: objectStoreStatus,
          anthropicMessages: messagesStatus,
        },
      };
    },
  });
}
