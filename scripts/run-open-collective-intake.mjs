#!/usr/bin/env node

import {
  OpenCollectiveIntakeController,
  PublicLedgerPublisherController,
  runStripeDisputeIntakeOnce,
} from "#indiemath/intake-publisher";
import { openLedger } from "#indiemath/ledger";
import { createOpenCollectiveClient } from "#indiemath/open-collective";
import { createR2Client } from "#indiemath/r2";
import { parseIntakePublisherConfig } from "#indiemath/shared";
import { StripeClient } from "#indiemath/stripe";

const config = parseIntakePublisherConfig(process.env);
const ledger = await openLedger({
  databasePath: config.databasePath,
});
const openCollective = createOpenCollectiveClient(config.openCollective);
const r2 = createR2Client({ config });
const stripe = process.env.STRIPE_SECRET_KEY?.trim()
  ? new StripeClient({
      secretKey: process.env.STRIPE_SECRET_KEY.trim(),
      accountId: process.env.STRIPE_ACCOUNT_ID?.trim() || undefined,
    })
  : undefined;
const controller = new OpenCollectiveIntakeController({
  ledger,
  openCollective,
  intervalSeconds: config.publishIntervalSeconds,
});
const publisher = new PublicLedgerPublisherController({
  ledger,
  r2,
  intervalSeconds: config.publishIntervalSeconds,
});
const abortController = new AbortController();
let closed = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    abortController.abort();
    controller.poke();
    publisher.poke();
  });
}

try {
  const [openCollectiveHealth, r2Health] = await Promise.all([
    openCollective.healthcheck(),
    r2.healthcheck(),
  ]);
  console.log(JSON.stringify({
    event: "intake-publisher-started",
    collectiveSlug: openCollectiveHealth.collectiveSlug,
    authenticated: openCollectiveHealth.authenticated,
    artifactBucket: r2Health.bucket,
    stripeDisputesEnabled: Boolean(stripe),
  }));
  const stopAllOnFailure = async (operation) => {
    try {
      return await operation();
    } catch (error) {
      abortController.abort(error);
      controller.poke();
      publisher.poke();
      throw error;
    }
  };
  await Promise.all([
    stopAllOnFailure(() => controller.run({
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
    })),
    stopAllOnFailure(() => publisher.run({
      signal: abortController.signal,
      onPublish: async (result) => {
        console.log(JSON.stringify({
          event: "public-ledger-published",
          ...result,
        }));
      },
    })),
  ]);
} finally {
  if (!closed) {
    closed = true;
    ledger.close();
  }
}
