import { priceAnthropicUsage } from "./pricing.mjs";
import { collectAnthropicUsage } from "./admin-client.mjs";

export function reconstructAdminUsageCost({
  rows,
  pricingTable,
} = {}) {
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array.");
  const pricedRows = rows.map((row) => {
    if (!row?.model) {
      throw new TypeError("Every grouped Admin usage row must include model.");
    }
    const priced = priceAnthropicUsage({
      usage: row,
      model: row.model,
      pricingTable,
    });
    return Object.freeze({ row: Object.freeze({ ...row }), priced });
  });
  const costCents = pricedRows.reduce(
    (sum, item) => checkedAdd(sum, item.priced.costCents),
    0,
  );
  return Object.freeze({
    costCents,
    rows: Object.freeze(pricedRows),
  });
}

export function reconcileClaimUsage({
  claimResponses,
  adminRows,
  pricingTable,
  toleranceCents,
} = {}) {
  if (!Array.isArray(claimResponses)) {
    throw new TypeError("claimResponses must be an array.");
  }
  const ledgerCostCents = claimResponses.reduce(
    (sum, row) => checkedAdd(sum, nonnegative(row.pricedCostCents, "pricedCostCents")),
    0,
  );
  const tolerance = toleranceCents ?? Math.ceil(
    ledgerCostCents
      * (pricingTable?.safety_margin_basis_points ?? 0)
      / 10_000,
  );
  if (!Number.isSafeInteger(tolerance) || tolerance < 0) {
    throw new TypeError("toleranceCents must be a nonnegative safe integer.");
  }
  const admin = reconstructAdminUsageCost({ rows: adminRows, pricingTable });
  const driftCents = admin.costCents - ledgerCostCents;
  return Object.freeze({
    ledgerCostCents,
    adminCostCents: admin.costCents,
    driftCents,
    absoluteDriftCents: Math.abs(driftCents),
    toleranceCents: tolerance,
    withinTolerance: Math.abs(driftCents) <= tolerance,
    alert: Math.abs(driftCents) > tolerance,
  });
}

export async function runClaimUsageReconciliation({
  ledger,
  adminClient,
  claim,
  apiKeyId,
  pricingTable,
  toleranceCents,
  onAlert = () => {},
  signal,
} = {}) {
  if (!ledger || typeof ledger.listWorkerClaimResponses !== "function") {
    throw new TypeError("ledger must provide listWorkerClaimResponses.");
  }
  if (!adminClient || typeof adminClient.listUsage !== "function") {
    throw new TypeError("adminClient must provide listUsage.");
  }
  const claimTs = positiveInteger(claim?.claimTs, "claim.claimTs");
  if (claim?.settled !== true || !claim?.settledAt) {
    throw new TypeError("Anthropic reconciliation requires a settled claim.");
  }
  const leaseEnd = timestamp(
    claim.settledAt,
    "claim settlement time",
  );
  const startTime = floorMinute(new Date(claimTs).toISOString());
  const endTime = ceilMinute(leaseEnd);
  const adminRows = await collectAnthropicUsage(adminClient, {
    apiKeyId,
    startTime,
    endTime,
    signal,
  });
  const claimResponses = await ledger.listWorkerClaimResponses({
    workerId: claim.workerId,
    startTime,
    endTime,
  });
  const result = reconcileClaimUsage({
    claimResponses,
    adminRows,
    pricingTable,
    toleranceCents,
  });
  if (result.alert) {
    await onAlert(Object.freeze({
      type: "anthropic-usage-drift",
      problemId: claim.problemId,
      direction: claim.direction,
      claimTs,
      apiKeyId,
      ...result,
    }));
  }
  return Object.freeze({
    ...result,
    targetClaim: Object.freeze({
      problemId: claim.problemId,
      direction: claim.direction,
      claimTs,
    }),
    apiKeyId,
    startTime,
    endTime,
    adminRowCount: adminRows.length,
    ledgerResponseCount: claimResponses.length,
    boundaryClaims: Object.freeze(uniqueClaimKeys(claimResponses)),
  });
}

function nonnegative(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer.`);
  }
  return value;
}

function checkedAdd(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError("Cost total exceeds safe cents.");
  return result;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be a timestamp.`);
  }
  return new Date(value).toISOString();
}

function floorMinute(value) {
  const date = new Date(value);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

function ceilMinute(value) {
  const date = new Date(value);
  date.setUTCMinutes(date.getUTCMinutes() + 1, 0, 0);
  return date.toISOString();
}

function uniqueClaimKeys(responses) {
  const seen = new Set();
  const keys = [];
  for (const row of responses) {
    const key = `${row.problemId}/${row.direction}/${row.claimTs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(Object.freeze({
      problemId: row.problemId,
      direction: row.direction,
      claimTs: row.claimTs,
    }));
  }
  return keys;
}
