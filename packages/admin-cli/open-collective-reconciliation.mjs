import { assertPort } from "#indiemath/shared";

const EPOCH = "1970-01-01T00:00:00.000Z";

export async function reconcileOpenCollectiveCredits({
  ledger,
  openCollective,
  since = EPOCH,
  through = new Date().toISOString(),
  pageSize = 100,
}) {
  assertPort(ledger, "ledger", [
    "findOpenCollectiveTier",
    "inspect",
  ]);
  assertPort(openCollective, "Open Collective", ["listCreditTransactions"]);
  const lowerBound = timestamp(since, "since");
  const upperBound = timestamp(through, "through");
  if (lowerBound > upperBound) throw new RangeError("since must not follow through.");
  positiveInteger(pageSize, "pageSize");

  const providerTransactions = [];
  const seen = new Set();
  let cursor;
  let pages = 0;
  do {
    const page = await openCollective.listCreditTransactions({
      cursor,
      limit: pageSize,
      since: lowerBound,
    });
    validatePage(page);
    for (const transaction of page.transactions) {
      if (transaction.createdAt > upperBound) continue;
      if (seen.has(transaction.id)) {
        throw new Error(`Open Collective returned duplicate transaction ${transaction.id}.`);
      }
      seen.add(transaction.id);
      providerTransactions.push(transaction);
    }
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor);

  const ledgerDonations = ledger.inspect().donations.filter((donation) => (
    donation.source?.kind === "open_collective"
    && donation.creditedAt >= lowerBound
    && donation.creditedAt <= upperBound
  ));
  const providerById = new Map(providerTransactions.map((item) => [item.id, item]));
  const ledgerById = new Map(ledgerDonations.map((item) => [item.dedupId, item]));
  const missingFromLedger = providerTransactions
    .filter((transaction) => !ledgerById.has(transaction.id))
    .map((transaction) => transaction.id)
    .sort();
  const unexpectedInLedger = ledgerDonations
    .filter((donation) => !providerById.has(donation.dedupId))
    .map((donation) => donation.dedupId)
    .sort();
  const mismatches = [];

  for (const transaction of providerTransactions) {
    const donation = ledgerById.get(transaction.id);
    if (!donation) continue;
    const expectedDestination = destinationForTransaction(ledger, transaction);
    const actualDestination = donation.intendedDestination ?? donation.destination;
    const expectedDonor = transaction.account.isIncognito
      ? "anonymous"
      : transaction.account.name || "Guest";
    const differences = {};
    compare(differences, "orderId", donation.orderId, transaction.order.id);
    compare(differences, "grossCents", donation.grossCents, transaction.grossCents);
    compare(differences, "feesCents", donation.feesCents, transaction.feesCents);
    compare(differences, "netCents", donation.netCents, transaction.netCents);
    compare(differences, "donorTag", donation.donorTag, expectedDonor);
    compare(
      differences,
      "destination",
      canonicalDestination(actualDestination),
      canonicalDestination(expectedDestination),
    );
    if (Object.keys(differences).length > 0) {
      mismatches.push(Object.freeze({
        transactionId: transaction.id,
        differences: Object.freeze(differences),
      }));
    }
  }

  return Object.freeze({
    ok: missingFromLedger.length === 0
      && unexpectedInLedger.length === 0
      && mismatches.length === 0,
    since: lowerBound,
    through: upperBound,
    pages,
    providerTransactionCount: providerTransactions.length,
    ledgerDonationCount: ledgerDonations.length,
    missingFromLedger: Object.freeze(missingFromLedger),
    unexpectedInLedger: Object.freeze(unexpectedInLedger),
    mismatches: Object.freeze(mismatches),
  });
}

function destinationForTransaction(ledger, transaction) {
  const tier = transaction.order.tier
    ? ledger.findOpenCollectiveTier({
        providerTierId: transaction.order.tier.id,
        tierSlug: transaction.order.tier.slug,
      })
    : undefined;
  return tier
    ? {
        kind: "pool",
        problemId: tier.problemId,
        direction: tier.direction,
      }
    : { kind: "general" };
}

function canonicalDestination(value) {
  return value?.kind === "pool"
    ? `pool:${value.problemId}:${value.direction}`
    : "general";
}

function compare(target, field, actual, expected) {
  if (actual !== expected) target[field] = Object.freeze({ actual, expected });
}

function validatePage(page) {
  if (
    !page
    || !Array.isArray(page.transactions)
    || (
      page.nextCursor !== undefined
      && (typeof page.nextCursor !== "string" || !page.nextCursor)
    )
  ) {
    throw new TypeError("Open Collective returned an invalid transaction page.");
  }
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be a timestamp.`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}
