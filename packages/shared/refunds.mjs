import { addCents, asCents, subtractCents } from "./money.mjs";

/**
 * Derive the one FIFO waterline used by the public badge, refund gate, and
 * claimable-balance calculation. A donation becomes processed (and therefore
 * final) as soon as funded capacity reaches any positive part of its effective
 * net amount. A fully uncovered donation remains received and refundable.
 */
export function deriveDonationWaterline({ donations, fundedCents }) {
  if (!Array.isArray(donations)) {
    throw new TypeError("donations must be an array.");
  }
  const funded = asCents(fundedCents, "fundedCents");
  const seenIds = new Set();
  const ordered = donations
    .map((donation, index) => normalizeWaterlineDonation(donation, index))
    .sort((left, right) => (
      left.creditedAt.localeCompare(right.creditedAt)
      || left.dedupId.localeCompare(right.dedupId)
    ));

  let cumulativeEffectiveCents = 0;
  return Object.freeze(ordered.map((donation) => {
    if (seenIds.has(donation.dedupId)) {
      throw new Error(`Duplicate donation dedupId in waterline: ${donation.dedupId}.`);
    }
    seenIds.add(donation.dedupId);

    const effectiveNetCents = subtractCents(
      donation.netCents,
      donation.refundedCents,
    );
    const coverageStartCents = cumulativeEffectiveCents;
    const coveredCents = funded > coverageStartCents
      ? Math.min(effectiveNetCents, funded - coverageStartCents)
      : 0;
    const processed = coveredCents > 0;
    cumulativeEffectiveCents = addCents(
      cumulativeEffectiveCents,
      effectiveNetCents,
    );

    return Object.freeze({
      dedupId: donation.dedupId,
      effectiveNetCents,
      coverageStartCents,
      coveredCents,
      processed,
      refundEligible: effectiveNetCents > 0 && !processed,
    });
  }));
}

export function calculateRefundableCents({
  donationDedupId,
  donations,
  fundedCents,
  pendingRefundCents = 0,
  destinationBalanceCents,
  requestedCents,
}) {
  const status = deriveDonationWaterline({ donations, fundedCents })
    .find((donation) => donation.dedupId === donationDedupId);
  if (!status) {
    throw new Error(`Donation not found in waterline: ${donationDedupId}.`);
  }
  if (status.processed) {
    throw new Error(
      `Donation ${donationDedupId} is processed and no longer refundable.`,
    );
  }

  const pending = asCents(pendingRefundCents, "pendingRefundCents");
  if (pending > status.effectiveNetCents) {
    throw new RangeError(
      "pendingRefundCents cannot exceed the donation's effective net cents.",
    );
  }
  const destinationBalance = asCents(
    destinationBalanceCents,
    "destinationBalanceCents",
  );
  const remainingDonation = status.effectiveNetCents - pending;
  const requested = requestedCents === undefined
    ? remainingDonation
    : asCents(requestedCents, "requestedCents");
  return Math.min(requested, remainingDonation, destinationBalance);
}

export function deriveDonationRefundState({
  donationNetCents,
  completedRefundCents,
}) {
  const net = asCents(donationNetCents, "donationNetCents");
  const refunded = asCents(completedRefundCents, "completedRefundCents");
  if (refunded > net) {
    throw new RangeError("completedRefundCents cannot exceed donationNetCents.");
  }
  if (refunded === 0) return "credited";
  if (refunded === net) return "refunded";
  return "partially_refunded";
}

function normalizeWaterlineDonation(donation, index) {
  if (!donation || typeof donation !== "object") {
    throw new TypeError(`donations[${index}] must be an object.`);
  }
  const dedupId = requiredString(donation.dedupId, `donations[${index}].dedupId`);
  const creditedAt = requiredString(
    donation.creditedAt,
    `donations[${index}].creditedAt`,
  );
  if (!Number.isFinite(Date.parse(creditedAt))) {
    throw new TypeError(`donations[${index}].creditedAt must be a timestamp.`);
  }
  const netCents = asCents(donation.netCents, `donations[${index}].netCents`);
  const refundedCents = asCents(
    donation.refundedCents ?? 0,
    `donations[${index}].refundedCents`,
  );
  if (refundedCents > netCents) {
    throw new RangeError(
      `donations[${index}].refundedCents cannot exceed netCents.`,
    );
  }
  return { dedupId, creditedAt, netCents, refundedCents };
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value;
}
