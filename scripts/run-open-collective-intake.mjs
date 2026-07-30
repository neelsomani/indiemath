#!/usr/bin/env node

import {
  OpenCollectiveIntakeController,
  PublicLedgerPublisherController,
  RampSpendSyncController,
  runStripeDisputeIntakeOnce,
} from "#indiemath/intake-publisher";
import { openLedger } from "#indiemath/ledger";
import { createOpenCollectiveClient } from "#indiemath/open-collective";
import { createR2Client } from "#indiemath/r2";
import { RampClient } from "#indiemath/ramp";
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
const ramp = config.ramp
  ? new RampClient(config.ramp)
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
  runsPausedReason: config.runsPausedReason,
});
const rampController = ramp
  ? new RampSpendSyncController({
      ledger,
      ramp,
      cardId: config.ramp.cardId,
      intervalSeconds: config.ramp.syncIntervalSeconds,
    })
  : undefined;
const abortController = new AbortController();
let closed = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    abortController.abort();
    controller.poke();
    publisher.poke();
    rampController?.poke();
  });
}

try {
  const [openCollectiveHealth, r2Health, rampHealth] = await Promise.all([
    openCollective.healthcheck(),
    r2.healthcheck(),
    ramp?.healthcheck(),
  ]);
  console.log(JSON.stringify({
    event: "intake-publisher-started",
    collectiveSlug: openCollectiveHealth.collectiveSlug,
    authenticated: openCollectiveHealth.authenticated,
    artifactBucket: r2Health.bucket,
    stripeDisputesEnabled: Boolean(stripe),
    rampSpendEnabled: Boolean(ramp),
    rampScope: rampHealth?.scope,
  }));
  const stopAllOnFailure = async (operation) => {
    try {
      return await operation();
    } catch (error) {
      abortController.abort(error);
      controller.poke();
      publisher.poke();
      rampController?.poke();
      throw error;
    }
  };
  const operations = [
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
  ];
  if (rampController) {
    operations.push(rampController.run({
      signal: abortController.signal,
      onSync(result) {
        console.log(JSON.stringify({
          event: "ramp-spend-synced",
          ...result,
        }));
      },
      onError(error) {
        console.error(JSON.stringify({
          event: "ramp-spend-sync-failed",
          message: error.message,
        }));
      },
    }));
  }
  await Promise.all(operations);
} finally {
  if (!closed) {
    closed = true;
    ledger.close();
  }
}
