import { addCents, asCents } from "./money.mjs";

export const MINIMUM_RUN_CAPACITY_CENTS = 5_000;

export function calculateSettledButUnfundedCents({
  settledContributionCents,
  completedRefundCents,
  fundingEventCents,
}) {
  const result = addCents(
    asCents(settledContributionCents, "settledContributionCents"),
    -asCents(completedRefundCents, "completedRefundCents"),
    -asCents(fundingEventCents, "fundingEventCents"),
  );
  if (result < 0) {
    throw new RangeError(
      "Completed refunds plus funding events cannot exceed settled contributions.",
    );
  }
  return result;
}

export function calculateAvailableToFundCents({
  settledContributionCents,
  completedRefundCents,
  fundingEventCents,
  pendingRefundCents = 0,
}) {
  const settledButUnfunded = calculateSettledButUnfundedCents({
    settledContributionCents,
    completedRefundCents,
    fundingEventCents,
  });
  const available = addCents(
    settledButUnfunded,
    -asCents(pendingRefundCents, "pendingRefundCents"),
  );
  if (available < 0) {
    throw new RangeError(
      "Pending refund reservations cannot exceed settled-but-unfunded cents.",
    );
  }
  return available;
}

/**
 * Build the one treasury view consumed by the admin CLI and publisher.
 * The pause state is derived from capacity rather than accepted as mutable
 * input, so public state cannot disagree with the minimum run threshold.
 */
export function deriveTreasuryPublication(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new TypeError("treasury status must be an object.");
  }
  const settledContributionCents = asCents(
    status.settledContributionCents,
    "treasury.settledContributionCents",
  );
  const completedRefundCents = asCents(
    status.completedRefundCents,
    "treasury.completedRefundCents",
  );
  const pendingRefundCents = asCents(
    status.pendingRefundCents,
    "treasury.pendingRefundCents",
  );
  const fundingEventCents = asCents(
    status.fundingEventCents,
    "treasury.fundingEventCents",
  );
  const settledButUnfundedCents = asCents(
    status.settledButUnfundedCents,
    "treasury.settledButUnfundedCents",
  );
  const availableToFundCents = asCents(
    status.availableToFundCents,
    "treasury.availableToFundCents",
  );
  const spendableCapacityCents = asCents(
    status.spendableCapacityCents,
    "treasury.spendableCapacityCents",
  );
  const liveReservationsCents = asCents(
    status.liveReservationsCents,
    "treasury.liveReservationsCents",
  );
  const expectedSettledButUnfunded = calculateSettledButUnfundedCents({
    settledContributionCents,
    completedRefundCents,
    fundingEventCents,
  });
  if (settledButUnfundedCents !== expectedSettledButUnfunded) {
    throw new RangeError(
      "treasury.settledButUnfundedCents disagrees with its source totals.",
    );
  }
  const expectedAvailableToFund = calculateAvailableToFundCents({
    settledContributionCents,
    completedRefundCents,
    fundingEventCents,
    pendingRefundCents,
  });
  if (availableToFundCents !== expectedAvailableToFund) {
    throw new RangeError(
      "treasury.availableToFundCents disagrees with its source totals.",
    );
  }
  return Object.freeze({
    settledContributionCents,
    completedRefundCents,
    pendingRefundCents,
    fundingEventCents,
    settledButUnfundedCents,
    availableToFundCents,
    spendableCapacityCents,
    liveReservationsCents,
    runsPausedPendingSettlement:
      spendableCapacityCents < MINIMUM_RUN_CAPACITY_CENTS,
  });
}
