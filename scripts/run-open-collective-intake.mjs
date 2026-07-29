#!/usr/bin/env node

import {
  OpenCollectiveIntakeController,
  runStripeDisputeIntakeOnce,
} from "#indiemath/intake-publisher";
import { openLedger } from "#indiemath/ledger";
import { createOpenCollectiveClient } from "#indiemath/open-collective";
import { StripeClient } from "#indiemath/stripe";

const ledger = await openLedger({
  databasePath: requiredEnvironment("INDIEMATH_DB"),
});
const openCollective = createOpenCollectiveClient({
  kind: "graphql",
  endpoint: requiredEnvironment("OPEN_COLLECTIVE_GRAPHQL_URL"),
  collectiveSlug: requiredEnvironment("OPEN_COLLECTIVE_SLUG"),
  apiToken: requiredEnvironment("OPEN_COLLECTIVE_API_TOKEN"),
});
const stripe = process.env.STRIPE_SECRET_KEY?.trim()
  ? new StripeClient({
      secretKey: process.env.STRIPE_SECRET_KEY.trim(),
      accountId: process.env.STRIPE_ACCOUNT_ID?.trim() || undefined,
    })
  : undefined;
const controller = new OpenCollectiveIntakeController({
  ledger,
  openCollective,
  intervalSeconds: positiveIntegerEnvironment(
    "PUBLISH_INTERVAL_SECONDS",
    30,
  ),
});
const abortController = new AbortController();
let closed = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    abortController.abort();
    controller.poke();
  });
}

try {
  const health = await openCollective.healthcheck();
  console.log(JSON.stringify({
    event: "open-collective-intake-started",
    collectiveSlug: health.collectiveSlug,
    authenticated: health.authenticated,
    stripeDisputesEnabled: Boolean(stripe),
  }));
  await controller.run({
    signal: abortController.signal,
    onPoll: async (result) => {
      console.log(JSON.stringify({
        event: "open-collective-intake-poll",
        ...result,
      }));
      if (stripe) {
        const disputes = await runStripeDisputeIntakeOnce({ ledger, stripe });
        console.log(JSON.stringify({
          event: "stripe-dispute-intake-poll",
          ...disputes,
        }));
      }
    },
  });
} finally {
  if (!closed) {
    closed = true;
    ledger.close();
  }
}

function requiredEnvironment(key) {
  const value = process.env[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Missing required configuration: ${key}.`);
  }
  return value.trim();
}

function positiveIntegerEnvironment(key, fallback) {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${key} must be a positive safe integer.`);
  }
  return value;
}
