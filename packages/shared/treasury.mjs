import { addCents, asCents } from "./money.mjs";
import { MINIMUM_RUN_BUDGET_CENTS } from "./run-policy.mjs";

export const MINIMUM_RUN_CAPACITY_CENTS = MINIMUM_RUN_BUDGET_CENTS;

export function calculateSettledButUnfundedCents({
  settledContributionCents,
  completedRefundCents,
  settledCompletedRefundCents = completedRefundCents,
  fundingEventCents,
}) {
  const result = addCents(
    asCents(settledContributionCents, "settledContributionCents"),
    -asCents(
      settledCompletedRefundCents,
      "settledCompletedRefundCents",
    ),
    -asCents(fundingEventCents, "fundingEventCents"),
  );
  return Math.max(0, result);
}

export function calculateOutstandingOwnerAdvanceCents({
  settledContributionCents,
  completedRefundCents,
  settledCompletedRefundCents = completedRefundCents,
  fundingEventCents,
}) {
  return Math.max(0, addCents(
    asCents(fundingEventCents, "fundingEventCents"),
    -asCents(settledContributionCents, "settledContributionCents"),
    asCents(
      settledCompletedRefundCents,
      "settledCompletedRefundCents",
    ),
  ));
}

export function calculateAvailableToFundCents({
  settledContributionCents,
  completedRefundCents,
  settledCompletedRefundCents = completedRefundCents,
  fundingEventCents,
  pendingRefundCents = 0,
  settledPendingRefundCents = pendingRefundCents,
}) {
  const settledButUnfunded = calculateSettledButUnfundedCents({
    settledContributionCents,
    completedRefundCents,
    settledCompletedRefundCents,
    fundingEventCents,
  });
  const available = addCents(
    settledButUnfunded,
    -asCents(settledPendingRefundCents, "settledPendingRefundCents"),
  );
  if (available < 0) {
    throw new RangeError(
      "Settled pending refund reservations cannot exceed settled-but-unfunded cents.",
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
  const settledCompletedRefundCents = asCents(
    status.settledCompletedRefundCents ?? completedRefundCents,
    "treasury.settledCompletedRefundCents",
  );
  const settledPendingRefundCents = asCents(
    status.settledPendingRefundCents ?? pendingRefundCents,
    "treasury.settledPendingRefundCents",
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
    settledCompletedRefundCents,
    fundingEventCents,
  });
  if (settledButUnfundedCents !== expectedSettledButUnfunded) {
    throw new RangeError(
      "treasury.settledButUnfundedCents disagrees with its source totals.",
    );
  }
  const outstandingOwnerAdvanceCents = asCents(
    status.outstandingOwnerAdvanceCents
      ?? calculateOutstandingOwnerAdvanceCents({
        settledContributionCents,
        completedRefundCents,
        settledCompletedRefundCents,
        fundingEventCents,
      }),
    "treasury.outstandingOwnerAdvanceCents",
  );
  const expectedOutstandingOwnerAdvance = calculateOutstandingOwnerAdvanceCents({
    settledContributionCents,
    completedRefundCents,
    settledCompletedRefundCents,
    fundingEventCents,
  });
  if (outstandingOwnerAdvanceCents !== expectedOutstandingOwnerAdvance) {
    throw new RangeError(
      "treasury.outstandingOwnerAdvanceCents disagrees with its source totals.",
    );
  }
  const expectedAvailableToFund = calculateAvailableToFundCents({
    settledContributionCents,
    completedRefundCents,
    settledCompletedRefundCents,
    fundingEventCents,
    pendingRefundCents,
    settledPendingRefundCents,
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
    settledCompletedRefundCents,
    settledPendingRefundCents,
    fundingEventCents,
    settledButUnfundedCents,
    outstandingOwnerAdvanceCents,
    availableToFundCents,
    spendableCapacityCents,
    liveReservationsCents,
    runsPausedPendingSettlement:
      spendableCapacityCents < MINIMUM_RUN_CAPACITY_CENTS,
  });
}
