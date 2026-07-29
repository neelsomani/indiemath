import { assertPort } from "#indiemath/shared";
import { extractStripeChargeId } from "#indiemath/stripe";

const CHECKPOINT_SOURCE = "open-collective-contribution-credits";
const REPLAY_OVERLAP_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
const INITIAL_SCAN_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export async function runOpenCollectiveIntakeOnce({
  ledger,
  openCollective,
  pageSize = 100,
  maxPages = Number.POSITIVE_INFINITY,
}) {
  assertPort(ledger, "ledger", [
    "donate",
    "dispute",
    "findOpenCollectiveTier",
    "getIntakeCheckpoint",
    "saveIntakeCheckpoint",
  ]);
  assertPort(openCollective, "Open Collective", ["listCreditTransactions"]);
  positiveInteger(pageSize, "pageSize");
  if (
    maxPages !== Number.POSITIVE_INFINITY
    && (!Number.isSafeInteger(maxPages) || maxPages < 1)
  ) {
    throw new TypeError("maxPages must be a positive safe integer or Infinity.");
  }

  const checkpoint = ledger.getIntakeCheckpoint(CHECKPOINT_SOURCE);
  const scanSince = checkpoint.cursor
    ? checkpoint.scanSince
    : overlapStart(checkpoint.highWaterAt);
  let cursor = checkpoint.cursor;
  let highWaterAt = checkpoint.highWaterAt;
  let pageCount = 0;
  const stats = {
    pages: 0,
    observed: 0,
    credited: 0,
    duplicates: 0,
    pool: 0,
    general: 0,
    unattributed: 0,
    disputes: 0,
  };

  while (pageCount < maxPages) {
    const page = await openCollective.listCreditTransactions({
      cursor,
      limit: pageSize,
      since: scanSince,
    });
    validatePage(page);
    for (const transaction of page.transactions) {
      const destination = destinationForTransaction(ledger, transaction);
      const result = ledger.donate({
        dedupId: transaction.id,
        orderId: transaction.order.id,
        destination: destination.destination,
        grossCents: transaction.grossCents,
        feesCents: transaction.feesCents,
        netCents: transaction.netCents,
        donorTag: transaction.account.isIncognito
          ? "anonymous"
          : transaction.account.name || "Guest",
        creditedAt: transaction.createdAt,
        source: {
          kind: "open_collective",
          attribution: destination.attribution,
          metadata: {
            transactionId: transaction.id,
            orderId: transaction.order.id,
            tierId: transaction.order.tier?.id,
            tierSlug: transaction.order.tier?.slug,
            paymentProcessorUrl: transaction.paymentProcessorUrl,
            stripeChargeId: extractStripeChargeId(transaction.paymentProcessorUrl),
            clearedAt: transaction.clearedAt,
          },
        },
      });
      stats.observed += 1;
      stats[result.outcome === "duplicate" ? "duplicates" : "credited"] += 1;
      stats[destination.destination.kind] += 1;
      if (destination.attribution === "unattributed") stats.unattributed += 1;
      highWaterAt = laterTimestamp(highWaterAt, transaction.createdAt);

      if (transaction.isDisputed) {
        const dispute = ledger.dispute({
          donationDedupId: transaction.id,
          externalReference: `open-collective-dispute:${transaction.id}`,
          note: "Dispute reported by the authoritative Open Collective transaction poll.",
        });
        if (dispute.outcome !== "duplicate") stats.disputes += 1;
      }
    }

    pageCount += 1;
    stats.pages = pageCount;
    cursor = page.nextCursor;
    ledger.saveIntakeCheckpoint({
      source: CHECKPOINT_SOURCE,
      cursor,
      scanSince: cursor === undefined ? undefined : scanSince,
      highWaterAt,
    });
    if (cursor === undefined) break;
  }

  return Object.freeze({
    ...stats,
    complete: cursor === undefined,
    checkpoint: ledger.getIntakeCheckpoint(CHECKPOINT_SOURCE),
  });
}

export class OpenCollectiveIntakeController {
  #ledger;
  #openCollective;
  #intervalMilliseconds;
  #wake;

  constructor({
    ledger,
    openCollective,
    intervalSeconds = 30,
  }) {
    this.#ledger = ledger;
    this.#openCollective = openCollective;
    if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1) {
      throw new TypeError("intervalSeconds must be a positive safe integer.");
    }
    this.#intervalMilliseconds = intervalSeconds * 1_000;
  }

  // A webhook handler may call poke. It only wakes the poller; webhook payloads
  // never become authoritative ledger writes.
  poke() {
    this.#wake?.();
  }

  async run({ signal, onPoll } = {}) {
    while (!signal?.aborted) {
      const result = await runOpenCollectiveIntakeOnce({
        ledger: this.#ledger,
        openCollective: this.#openCollective,
      });
      await onPoll?.(result);
      await this.#wait(signal);
    }
  }

  async #wait(signal) {
    if (signal?.aborted) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        this.#wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, this.#intervalMilliseconds);
      signal?.addEventListener("abort", finish, { once: true });
      this.#wake = finish;
    });
  }
}

export async function executeOpenCollectiveRefund({
  ledger,
  openCollective,
  donationDedupId,
  idempotencyReference,
  requestedAmountCents,
  cancelRecurringContribution = false,
  message,
}) {
  assertPort(ledger, "ledger", [
    "beginRefund",
    "cancelRefund",
    "completeRefund",
    "getAdjustment",
    "getDonation",
  ]);
  assertPort(openCollective, "Open Collective", ["refundTransaction"]);
  try {
    const existing = ledger.getAdjustment(idempotencyReference);
    if (existing.status === "completed") {
      return Object.freeze({ outcome: "duplicate", adjustment: existing });
    }
  } catch (error) {
    if (error?.code !== "adjustment-not-found") throw error;
  }
  const donation = ledger.getDonation(donationDedupId);
  const outstandingCents = donation.netCents - donation.refundedCents;
  const requested = requestedAmountCents ?? outstandingCents;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new TypeError("requestedAmountCents must be positive integer cents.");
  }
  if (requested !== outstandingCents) {
    throw new Error(
      "Open Collective's refund API supports full transaction refunds only; "
      + "use the Stripe refund provider for a partial amount.",
    );
  }

  const pending = ledger.beginRefund({
    donationDedupId,
    requestedAmountCents: requested,
    idempotencyReference,
  });
  if (pending.adjustment.status === "completed") {
    return Object.freeze({
      outcome: "duplicate",
      adjustment: pending.adjustment,
    });
  }

  try {
    const provider = await openCollective.refundTransaction({
      transactionId: donationDedupId,
      cancelRecurringContribution,
      message,
    });
    return ledger.completeRefund({
      idempotencyReference,
      providerReference: provider.providerReference,
    });
  } catch (error) {
    if (isDefinitiveProviderFailure(error)) {
      ledger.cancelRefund({
        idempotencyReference,
        note: `Open Collective definitively rejected the refund: ${error.message}`,
      });
    }
    throw error;
  }
}

function destinationForTransaction(ledger, transaction) {
  const tier = transaction.order.tier
    ? ledger.findOpenCollectiveTier({
        providerTierId: transaction.order.tier.id,
        tierSlug: transaction.order.tier.slug,
      })
    : undefined;
  if (!tier) {
    return Object.freeze({
      destination: Object.freeze({ kind: "general" }),
      attribution: "unattributed",
    });
  }
  return Object.freeze({
    destination: Object.freeze({
      kind: "pool",
      problemId: tier.problemId,
      direction: tier.direction,
    }),
    attribution: "mapped",
  });
}

function validatePage(page) {
  if (!page || !Array.isArray(page.transactions)) {
    throw new TypeError("Open Collective transaction page is malformed.");
  }
  if (page.nextCursor !== undefined && typeof page.nextCursor !== "string") {
    throw new TypeError("Open Collective nextCursor must be a string.");
  }
}

function overlapStart(highWaterAt) {
  if (!highWaterAt) return INITIAL_SCAN_TIMESTAMP;
  const epoch = Date.parse(highWaterAt);
  if (!Number.isFinite(epoch)) {
    throw new TypeError("Stored Open Collective high-water timestamp is invalid.");
  }
  return new Date(Math.max(0, epoch - REPLAY_OVERLAP_MILLISECONDS)).toISOString();
}

function laterTimestamp(left, right) {
  if (!left) return new Date(Date.parse(right)).toISOString();
  return Date.parse(right) > Date.parse(left)
    ? new Date(Date.parse(right)).toISOString()
    : left;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function isDefinitiveProviderFailure(error) {
  if (error?.definitive === true) return true;
  const status = error?.status;
  return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408
    && status !== 409
    && status !== 429;
}
