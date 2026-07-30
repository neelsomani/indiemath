import { assertPort } from "#indiemath/shared";

const INSPECTION_ENTITIES = new Set([
  "adjustments",
  "all",
  "capacity",
  "claims",
  "donations",
  "pools",
  "provider-spend",
  "reviews",
]);
const ENTITY_FILTERS = Object.freeze({
  adjustments: new Set(["reason", "reference", "status", "transaction"]),
  all: new Set(),
  capacity: new Set(),
  claims: new Set(["direction", "problemId", "status", "workerId"]),
  donations: new Set(["direction", "problemId", "status", "transaction"]),
  pools: new Set(["direction", "problemId"]),
  "provider-spend": new Set(["reference"]),
  reviews: new Set(["direction", "outcome", "problemId"]),
});

export function inspectLedger({
  ledger,
  entity,
  filters = {},
}) {
  assertPort(ledger, "ledger", ["inspect"]);
  if (!INSPECTION_ENTITIES.has(entity)) {
    throw new TypeError(
      `entity must be one of ${[...INSPECTION_ENTITIES].join(", ")}.`,
    );
  }
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
    throw new TypeError("filters must be an object.");
  }
  const suppliedFilters = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  const unsupportedFilters = suppliedFilters.filter(
    (key) => !ENTITY_FILTERS[entity].has(key),
  );
  if (unsupportedFilters.length > 0) {
    throw new TypeError(
      `${entity} inspection does not support: ${unsupportedFilters.join(", ")}.`,
    );
  }
  const snapshot = ledger.inspect();
  if (entity === "all") return snapshot;
  if (entity === "capacity") {
    assertPort(ledger, "ledger", [
      "accountingSnapshot",
      "samplingSnapshot",
      "treasuryStatus",
    ]);
    let treasury;
    let treasuryError;
    try {
      treasury = ledger.treasuryStatus();
    } catch (error) {
      treasuryError = Object.freeze({
        code: error?.code,
        message: error.message,
      });
    }
    return Object.freeze({
      treasury,
      treasuryError,
      accounting: ledger.accountingSnapshot(),
      sampling: ledger.samplingSnapshot(),
      generalCreditCents: snapshot.generalCreditCents,
      generalDebtCents: snapshot.generalDebtCents,
      claimableGeneralCreditCents: snapshot.claimableGeneralCreditCents,
      spendableCapacityCents: snapshot.spendableCapacityCents,
    });
  }

  const rows = entity === "reviews"
    ? snapshot.reviewedResults
    : entity === "provider-spend"
      ? snapshot.anthropicSpendReconciliations
      : snapshot[entity];
  return Object.freeze({
    entity,
    count: rows.filter((row) => matches(row, filters)).length,
    rows: Object.freeze(rows.filter((row) => matches(row, filters))),
  });
}

function matches(row, filters) {
  return Object.entries(filters).every(([key, expected]) => {
    if (expected === undefined) return true;
    switch (key) {
      case "problemId":
        return row.problemId === expected
          || row.destination?.problemId === expected
          || row.intendedDestination?.problemId === expected;
      case "direction":
        return row.direction === expected
          || row.destination?.direction === expected
          || row.intendedDestination?.direction === expected;
      case "transaction":
        return row.dedupId === expected || row.donationDedupId === expected;
      case "reference":
        return row.externalReference === expected;
      case "workerId":
        return row.workerId === expected;
      case "status":
        return row.status === expected
          || row.processingStatus === expected
          || (
            expected === "running"
            && row.settled === false
          )
          || (
            expected === "settled"
            && row.settled === true
          );
      case "outcome":
        return row.outcome === expected;
      case "reason":
        return row.reasonCode === expected;
      default:
        throw new TypeError(`Unsupported inspection filter: ${key}.`);
    }
  });
}
