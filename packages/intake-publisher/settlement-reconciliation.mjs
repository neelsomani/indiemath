import { createHash } from "node:crypto";
import {
  addCents,
  assertPort,
} from "#indiemath/shared";

export async function reconcileStripeSettlements({
  ledger,
  stripe,
  through = new Date().toISOString(),
  pageSize = 100,
}) {
  assertPort(ledger, "ledger", [
    "findDonationByStripeChargeId",
    "inspect",
    "listSettlementRecords",
    "recordSettlementRecord",
    "recordSettlementSnapshot",
    "treasuryStatus",
  ]);
  assertPort(stripe, "Stripe", [
    "healthcheck",
    "listPaidPayoutSettlementRecords",
  ]);
  const cutoffAt = timestamp(through, "through");
  const health = await stripe.healthcheck();
  const providerAccountId = requiredString(health.accountId, "Stripe account ID");
  let cursor;
  let observed = 0;
  do {
    const page = await stripe.listPaidPayoutSettlementRecords({
      cursor,
      through: cutoffAt,
      limit: pageSize,
    });
    for (const record of page.records) {
      ledger.recordSettlementRecord({
        providerReference: record.providerReference,
        providerKind: "stripe",
        recordKind: record.recordKind,
        amountCents: record.amountCents,
        occurredAt: record.occurredAt,
        payoutReference: record.payoutReference,
        source: {
          chargeId: record.chargeId,
          providerOperationReference: providerOperationReference(record.source),
          raw: record.source,
        },
      });
      observed += 1;
    }
    cursor = page.nextCursor;
  } while (cursor);

  const records = ledger.listSettlementRecords({
    providerKind: "stripe",
    through: cutoffAt,
  });
  const paidPayouts = new Set(records
    .filter((record) => record.recordKind === "payout")
    .map((record) => record.providerReference));
  const contributionRecords = records.filter((record) => (
    record.recordKind === "contribution"
    && record.payoutReference
    && paidPayouts.has(record.payoutReference)
  ));

  const matchedDonations = new Map();
  for (const record of contributionRecords) {
    const chargeId = record.source.chargeId;
    if (!chargeId) {
      throw new Error(
        `Settled Stripe contribution ${record.providerReference} has no charge ID.`,
      );
    }
    const donation = ledger.findDonationByStripeChargeId(chargeId);
    if (!donation) {
      throw new Error(
        `Settled Stripe charge ${chargeId} has no Open Collective donation.`,
      );
    }
    const previous = matchedDonations.get(donation.dedupId);
    if (previous && previous !== chargeId) {
      throw new Error(
        `Donation ${donation.dedupId} matched multiple Stripe charges.`,
      );
    }
    matchedDonations.set(donation.dedupId, chargeId);
  }

  const state = ledger.inspect();
  const donationsById = new Map(state.donations.map((donation) => [
    donation.dedupId,
    donation,
  ]));
  let settledContributionCents = 0;
  for (const donationId of matchedDonations.keys()) {
    settledContributionCents = addCents(
      settledContributionCents,
      donationsById.get(donationId).netCents,
    );
  }

  // This derives both settled cash still available and any explicitly recorded
  // owner advance not yet offset by independently observed settlement.
  const treasury = ledger.treasuryStatus({
    settledContributionCents,
    settledDonationIds: [...matchedDonations.keys()],
  });
  const provenance = {
    provider: "stripe",
    providerAccountId,
    cutoffAt,
    records: records.map((record) => ({
      providerReference: record.providerReference,
      recordKind: record.recordKind,
      amountCents: record.amountCents,
      occurredAt: record.occurredAt,
      payoutReference: record.payoutReference,
      chargeId: record.source.chargeId,
    })),
    matchedDonations: [...matchedDonations.entries()].map(
      ([donationDedupId, chargeId]) => ({ donationDedupId, chargeId }),
    ),
  };
  const sourceJson = canonicalJson(provenance);
  const sourceHash = createHash("sha256").update(sourceJson).digest("hex");
  const snapshotId = `stripe:${providerAccountId}:${sourceHash}`;
  const snapshot = ledger.recordSettlementSnapshot({
    snapshotId,
    providerKind: "stripe",
    providerAccountId,
    cutoffAt,
    settledContributionCents,
    sourceRecordCount: records.length,
    sourceHash,
    source: provenance,
  });
  return Object.freeze({
    observed,
    settledContributionCents,
    matchedDonationCount: matchedDonations.size,
    snapshot: snapshot.snapshot,
    treasury,
  });
}

function providerOperationReference(source) {
  if (!source || typeof source !== "object") return undefined;
  const value = typeof source.source === "object"
    ? source.source.id
    : source.source;
  return typeof value === "string" ? value : undefined;
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be a timestamp.`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value.trim();
}
