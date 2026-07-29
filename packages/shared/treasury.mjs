import { addCents, asCents } from "./money.mjs";

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
