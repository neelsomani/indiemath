import { assertPort } from "#indiemath/shared";

export function createAnthropicClients({ messages, admin }) {
  assertPort(messages, "Anthropic Messages", [
    "healthcheck",
    "createMessage",
    "streamMessage",
  ]);
  assertPort(admin, "Anthropic Admin", ["healthcheck", "listUsage"]);

  return Object.freeze({ messages, admin });
}
