import { assertPort } from "#indiemath/shared";

const DISPUTE_CHECKPOINT_SOURCE = "stripe-disputes";
const DISPUTE_OVERLAP_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
const INITIAL_SCAN_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export async function executeStripeRefund({
  ledger,
  stripe,
  donationDedupId,
  idempotencyReference,
  requestedAmountCents,
}) {
  assertPort(ledger, "ledger", [
    "beginRefund",
    "cancelRefund",
    "completeRefund",
    "getDonation",
  ]);
  assertPort(stripe, "Stripe", ["refundCharge"]);
  const donation = ledger.getDonation(donationDedupId);
  const chargeId = donation.source?.metadata?.stripeChargeId;
  if (!chargeId) {
    throw new Error(
      `Donation ${donationDedupId} has no reconciled Stripe charge reference.`,
    );
  }
  const pending = ledger.beginRefund({
    donationDedupId,
    requestedAmountCents,
    idempotencyReference,
  });
  if (pending.adjustment.status === "completed") {
    return Object.freeze({
      outcome: "duplicate",
      adjustment: pending.adjustment,
    });
  }

  try {
    const provider = await stripe.refundCharge({
      chargeId,
      amountCents: -pending.adjustment.amountCents,
      idempotencyReference,
    });
    return ledger.completeRefund({
      idempotencyReference,
      providerReference: provider.providerReference,
    });
  } catch (error) {
    if (error?.definitive === true) {
      ledger.cancelRefund({
        idempotencyReference,
        note: `Stripe definitively rejected the refund: ${error.message}`,
      });
    }
    throw error;
  }
}

export async function runStripeDisputeIntakeOnce({
  ledger,
  stripe,
  pageSize = 100,
  through = new Date().toISOString(),
}) {
  assertPort(ledger, "ledger", [
    "dispute",
    "findDonationByStripeChargeId",
    "getIntakeCheckpoint",
    "saveIntakeCheckpoint",
  ]);
  assertPort(stripe, "Stripe", ["listDisputes"]);
  const cutoff = timestamp(through, "through");
  const checkpoint = ledger.getIntakeCheckpoint(DISPUTE_CHECKPOINT_SOURCE);
  const since = checkpoint.cursor
    ? checkpoint.scanSince
    : overlapStart(checkpoint.highWaterAt);
  let cursor = checkpoint.cursor;
  let highWaterAt = checkpoint.highWaterAt;
  let observed = 0;
  let recorded = 0;
  let duplicates = 0;
  let pages = 0;

  do {
    const page = await stripe.listDisputes({
      cursor,
      since,
      through: cutoff,
      limit: pageSize,
    });
    for (const dispute of page.disputes) {
      const donation = ledger.findDonationByStripeChargeId(dispute.chargeId);
      if (!donation) {
        throw new Error(
          `Stripe dispute ${dispute.id} references unknown charge ${dispute.chargeId}.`,
        );
      }
      const result = ledger.dispute({
        donationDedupId: donation.dedupId,
        externalReference: `stripe-dispute:${dispute.id}`,
        note: `Stripe dispute ${dispute.id} (${dispute.status}).`,
      });
      observed += 1;
      if (result.outcome === "duplicate") duplicates += 1;
      else recorded += 1;
      highWaterAt = laterTimestamp(highWaterAt, dispute.createdAt);
    }
    pages += 1;
    cursor = page.nextCursor;
    ledger.saveIntakeCheckpoint({
      source: DISPUTE_CHECKPOINT_SOURCE,
      cursor,
      scanSince: cursor === undefined ? undefined : since,
      highWaterAt,
    });
  } while (cursor);

  return Object.freeze({
    pages,
    observed,
    recorded,
    duplicates,
    checkpoint: ledger.getIntakeCheckpoint(DISPUTE_CHECKPOINT_SOURCE),
  });
}

function overlapStart(highWaterAt) {
  if (!highWaterAt) return INITIAL_SCAN_TIMESTAMP;
  const epoch = Date.parse(highWaterAt);
  if (!Number.isFinite(epoch)) {
    throw new TypeError("Stored Stripe dispute high-water timestamp is invalid.");
  }
  return new Date(Math.max(0, epoch - DISPUTE_OVERLAP_MILLISECONDS)).toISOString();
}

function laterTimestamp(left, right) {
  if (!left) return timestamp(right, "createdAt");
  return Date.parse(right) > Date.parse(left) ? timestamp(right, "createdAt") : left;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be a timestamp.`);
  }
  return new Date(Date.parse(value)).toISOString();
}
