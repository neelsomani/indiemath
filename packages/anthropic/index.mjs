import { assertPort } from "#indiemath/shared";
import { AnthropicAdminClient } from "./admin-client.mjs";
import { AnthropicMessagesClient } from "./messages-client.mjs";

export * from "./admin-client.mjs";
export * from "./constants.mjs";
export * from "./errors.mjs";
export * from "./fable-runner.mjs";
export * from "./messages-client.mjs";
export * from "./pricing.mjs";
export * from "./protocol.mjs";
export * from "./reconciliation.mjs";
export * from "./retry.mjs";
export * from "./stream.mjs";

export function createAnthropicClients({ messages, admin }) {
  assertPort(messages, "Anthropic Messages", [
    "healthcheck",
    "createMessage",
    "streamMessage",
  ]);
  assertPort(admin, "Anthropic Admin", ["healthcheck", "listUsage"]);

  return Object.freeze({ messages, admin });
}

export function createWorkerAnthropicClient({
  config,
  baseUrl,
  fetchImpl,
} = {}) {
  requireProductionConfig(config, "worker");
  return new AnthropicMessagesClient({
    apiKey: config.anthropic.apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

export function createAdminAnthropicClient({
  config,
  baseUrl,
  fetchImpl,
} = {}) {
  requireProductionConfig(config, "admin-cli");
  return new AnthropicAdminClient({
    apiKey: config.anthropicAdmin.apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

function requireProductionConfig(config, component) {
  if (!config || config.component !== component) {
    throw new TypeError(`Expected parsed ${component} configuration.`);
  }
  if (config.runtime !== "production") {
    throw new TypeError(`Real Anthropic clients require ${component} production runtime.`);
  }
}
