import {
  asCents,
  assertPort,
  deriveTreasuryPublication,
} from "#indiemath/shared";
import { reconcileStripeSettlements } from "../intake-publisher/settlement-reconciliation.mjs";

export async function refreshTreasuryStatus({
  ledger,
  stripe,
  through,
  pageSize,
}) {
  const reconciliation = await reconcileStripeSettlements({
    ledger,
    stripe,
    ...(through === undefined ? {} : { through }),
    ...(pageSize === undefined ? {} : { pageSize }),
  });
  return Object.freeze({
    reconciliation: settlementEvidence(reconciliation),
    treasury: deriveTreasuryPublication(reconciliation.treasury),
  });
}

export async function fundTreasuryFromReconciliation({
  ledger,
  stripe,
  amountCents,
  externalReference,
  through,
  pageSize,
}) {
  assertPort(ledger, "ledger", ["treasuryFund", "treasuryStatus"]);
  const amount = asCents(amountCents, "amountCents");
  if (amount === 0) throw new RangeError("amountCents must be positive.");
  const refreshed = await refreshTreasuryStatus({
    ledger,
    stripe,
    through,
    pageSize,
  });
  const funding = ledger.treasuryFund({
    amountCents: amount,
    externalReference,
    settledContributionCents:
      refreshed.reconciliation.settledContributionCents,
  });
  return Object.freeze({
    reconciliation: refreshed.reconciliation,
    funding,
    treasury: deriveTreasuryPublication(ledger.treasuryStatus()),
  });
}

function settlementEvidence(reconciliation) {
  return Object.freeze({
    observed: reconciliation.observed,
    matchedDonationCount: reconciliation.matchedDonationCount,
    settledContributionCents: reconciliation.settledContributionCents,
    snapshot: reconciliation.snapshot,
  });
}
