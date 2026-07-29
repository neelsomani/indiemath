import {
  assertPort,
  assertRuntimeConfig,
} from "#indiemath/shared";

export function createWorkerRuntime({
  config,
  ledger,
  r2,
  anthropicMessages,
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
