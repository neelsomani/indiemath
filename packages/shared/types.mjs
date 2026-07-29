import {
  parseNonnegativeInteger,
  parsePositiveInteger,
  parseProblemId,
  parseWorkerId,
} from "./identifiers.mjs";
import { asCents } from "./money.mjs";

/** @typedef {'prove'|'disprove'} Direction */
/** @typedef {'Open'|'PendingReview'|'Solved'} ProblemStatus */
/** @typedef {'credited'|'partially_refunded'|'refunded'|'disputed'|'reversed'} DonationState */
/** @typedef {'unconditional'|'conditional'|'rejected'} ReviewOutcome */
/** @typedef {'refund'|'dispute'|'reconciliation'} AdjustmentReason */
/** @typedef {'pending'|'completed'|'canceled'} AdjustmentStatus */
/**
 * @typedef {object} Pool
 * @property {string} problemId
 * @property {Direction} direction
 * @property {number} balanceCents
 * @property {number} cumulativeDonationsCents
 */
/**
 * @typedef {object} Donation
 * @property {string} dedupId
 * @property {string} orderId
 * @property {{kind: 'general'}|{kind: 'pool', problemId: string, direction: Direction}} destination
 * @property {{kind: 'general'}|{kind: 'pool', problemId: string, direction: Direction}|undefined} intendedDestination
 * @property {number} grossCents
 * @property {number} feesCents
 * @property {number} netCents
 * @property {number} refundedCents
 * @property {string} donorTag
 * @property {string} creditedAt
 * @property {DonationState} state
 * @property {number|undefined} waterlineExcludedCents
 */
/**
 * @typedef {object} Claim
 * @property {string} problemId
 * @property {Direction} direction
 * @property {number} catalogRevision
 * @property {string} workerId
 * @property {number} claimTs
 * @property {number} budgetCents
 * @property {number} poolFundedCents
 * @property {number} spentCents
 * @property {string} leaseExpiresAt
 * @property {boolean} settled
 * @property {string|undefined} solutionUri
 */
/**
 * @typedef {object} ReviewedResult
 * @property {string} problemId
 * @property {Direction} direction
 * @property {number} claimTs
 * @property {string} solutionUri
 * @property {ReviewOutcome} outcome
 * @property {string} noteUri
 * @property {string|undefined} assumptionLabel
 * @property {string} reviewedAt
 */
/**
 * @typedef {object} FundingEvent
 * @property {string} externalReference
 * @property {number} amountCents
 * @property {string} fundedAt
 */
/**
 * @typedef {object} Adjustment
 * @property {string} adjustmentId
 * @property {AdjustmentReason} reasonCode
 * @property {number} amountCents
 * @property {string|undefined} donationDedupId
 * @property {string} externalReference
 * @property {string|undefined} providerReference
 * @property {AdjustmentStatus} status
 * @property {string} createdAt
 */
/**
 * @typedef {object} PublisherSnapshot
 * @property {1} schemaVersion
 * @property {string} generatedAt
 * @property {number} catalogRevision
 * @property {object} treasury
 * @property {Array<object>} problems
 */

export const DIRECTIONS = Object.freeze(["prove", "disprove"]);
export const PROBLEM_STATUSES = Object.freeze(["Open", "PendingReview", "Solved"]);
export const DONATION_STATES = Object.freeze([
  "credited",
  "partially_refunded",
  "refunded",
  "disputed",
  "reversed",
]);
export const REVIEW_OUTCOMES = Object.freeze([
  "unconditional",
  "conditional",
  "rejected",
]);
export const ADJUSTMENT_REASONS = Object.freeze([
  "refund",
  "dispute",
  "reconciliation",
]);
export const ADJUSTMENT_STATUSES = Object.freeze([
  "pending",
  "completed",
  "canceled",
]);

export function parseDirection(value, label = "direction") {
  return parseEnum(value, DIRECTIONS, label);
}

export function parseProblemStatus(value, label = "status") {
  return parseEnum(value, PROBLEM_STATUSES, label);
}

export function parsePool(value, label = "pool") {
  const input = expectObject(value, label);
  return Object.freeze({
    problemId: parseProblemId(input.problemId, `${label}.problemId`),
    direction: parseDirection(input.direction, `${label}.direction`),
    balanceCents: asCents(input.balanceCents, `${label}.balanceCents`),
    cumulativeDonationsCents: asCents(
      input.cumulativeDonationsCents,
      `${label}.cumulativeDonationsCents`,
    ),
  });
}

export function parseDonation(value, label = "donation") {
  const input = expectObject(value, label);
  const destination = parseDonationDestination(input.destination, `${label}.destination`);
  const intendedDestination = input.intendedDestination === undefined
    ? undefined
    : parseDonationDestination(
        input.intendedDestination,
        `${label}.intendedDestination`,
      );
  const grossCents = asCents(input.grossCents, `${label}.grossCents`);
  const feesCents = asCents(input.feesCents, `${label}.feesCents`);
  const netCents = asCents(input.netCents, `${label}.netCents`);
  const refundedCents = asCents(input.refundedCents, `${label}.refundedCents`);
  const state = parseEnum(input.state, DONATION_STATES, `${label}.state`);
  const waterlineExcludedCents = input.waterlineExcludedCents === undefined
    ? undefined
    : asCents(
        input.waterlineExcludedCents,
        `${label}.waterlineExcludedCents`,
      );
  if (grossCents !== feesCents + netCents) {
    throw new RangeError(`${label} grossCents must equal feesCents + netCents.`);
  }
  if (refundedCents > netCents) {
    throw new RangeError(`${label}.refundedCents cannot exceed netCents.`);
  }
  if (state === "credited" && refundedCents !== 0) {
    throw new RangeError(`${label}.credited state requires refundedCents = 0.`);
  }
  if (
    state === "partially_refunded"
    && (refundedCents === 0 || refundedCents === netCents)
  ) {
    throw new RangeError(
      `${label}.partially_refunded state requires 0 < refundedCents < netCents.`,
    );
  }
  if (state === "refunded" && refundedCents !== netCents) {
    throw new RangeError(`${label}.refunded state requires refundedCents = netCents.`);
  }
  if (
    waterlineExcludedCents !== undefined
    && waterlineExcludedCents > netCents
  ) {
    throw new RangeError(
      `${label}.waterlineExcludedCents cannot exceed netCents.`,
    );
  }
  return Object.freeze({
    dedupId: expectString(input.dedupId, `${label}.dedupId`),
    orderId: expectString(input.orderId, `${label}.orderId`),
    destination,
    ...(intendedDestination === undefined ? {} : { intendedDestination }),
    grossCents,
    feesCents,
    netCents,
    refundedCents,
    donorTag: expectString(input.donorTag, `${label}.donorTag`),
    creditedAt: parseTimestamp(input.creditedAt, `${label}.creditedAt`),
    state,
    ...(waterlineExcludedCents === undefined ? {} : { waterlineExcludedCents }),
  });
}

export function parseClaim(value, label = "claim") {
  const input = expectObject(value, label);
  const budgetCents = asCents(input.budgetCents, `${label}.budgetCents`);
  const poolFundedCents = asCents(input.poolFundedCents, `${label}.poolFundedCents`);
  const spentCents = asCents(input.spentCents, `${label}.spentCents`);
  if (poolFundedCents > budgetCents) {
    throw new RangeError(`${label}.poolFundedCents cannot exceed budgetCents.`);
  }
  if (spentCents > budgetCents) {
    throw new RangeError(`${label}.spentCents cannot exceed budgetCents.`);
  }
  return Object.freeze({
    problemId: parseProblemId(input.problemId, `${label}.problemId`),
    direction: parseDirection(input.direction, `${label}.direction`),
    catalogRevision: parsePositiveInteger(
      input.catalogRevision,
      `${label}.catalogRevision`,
    ),
    workerId: parseWorkerId(input.workerId, `${label}.workerId`),
    claimTs: parsePositiveInteger(input.claimTs, `${label}.claimTs`),
    budgetCents,
    poolFundedCents,
    spentCents,
    leaseExpiresAt: parseTimestamp(input.leaseExpiresAt, `${label}.leaseExpiresAt`),
    settled: expectBoolean(input.settled, `${label}.settled`),
    solutionUri: optionalString(input.solutionUri, `${label}.solutionUri`),
  });
}

export function parseReviewedResult(value, label = "reviewedResult") {
  const input = expectObject(value, label);
  const outcome = parseEnum(input.outcome, REVIEW_OUTCOMES, `${label}.outcome`);
  const assumptionLabel = optionalString(
    input.assumptionLabel,
    `${label}.assumptionLabel`,
  );
  if (outcome === "conditional" && !assumptionLabel) {
    throw new TypeError(`${label}.assumptionLabel is required for a conditional result.`);
  }
  if (outcome !== "conditional" && assumptionLabel) {
    throw new TypeError(`${label}.assumptionLabel is valid only for a conditional result.`);
  }
  return Object.freeze({
    problemId: parseProblemId(input.problemId, `${label}.problemId`),
    direction: parseDirection(input.direction, `${label}.direction`),
    claimTs: parsePositiveInteger(input.claimTs, `${label}.claimTs`),
    solutionUri: expectString(input.solutionUri, `${label}.solutionUri`),
    outcome,
    noteUri: expectString(input.noteUri, `${label}.noteUri`),
    assumptionLabel,
    reviewedAt: parseTimestamp(input.reviewedAt, `${label}.reviewedAt`),
  });
}

export function parseFundingEvent(value, label = "fundingEvent") {
  const input = expectObject(value, label);
  const amountCents = asCents(input.amountCents, `${label}.amountCents`);
  if (amountCents === 0) throw new RangeError(`${label}.amountCents must be positive.`);
  return Object.freeze({
    externalReference: expectString(
      input.externalReference,
      `${label}.externalReference`,
    ),
    amountCents,
    fundedAt: parseTimestamp(input.fundedAt, `${label}.fundedAt`),
  });
}

export function parseAdjustment(value, label = "adjustment") {
  const input = expectObject(value, label);
  const reasonCode = parseEnum(
    input.reasonCode,
    ADJUSTMENT_REASONS,
    `${label}.reasonCode`,
  );
  const status = parseEnum(
    input.status,
    ADJUSTMENT_STATUSES,
    `${label}.status`,
  );
  const amountCents = asCents(
    input.amountCents,
    `${label}.amountCents`,
    { allowNegative: true },
  );
  if (amountCents === 0) throw new RangeError(`${label}.amountCents cannot be zero.`);
  const donationDedupId = optionalString(
    input.donationDedupId,
    `${label}.donationDedupId`,
  );
  const externalReference = expectString(
    input.externalReference,
    `${label}.externalReference`,
  );
  const providerReference = optionalString(
    input.providerReference,
    `${label}.providerReference`,
  );

  if (["refund", "dispute"].includes(reasonCode) && !donationDedupId) {
    throw new TypeError(
      `${label}.donationDedupId is required for ${reasonCode} adjustments.`,
    );
  }
  if (["refund", "dispute"].includes(reasonCode) && amountCents > 0) {
    throw new RangeError(`${label}.${reasonCode} amountCents must be negative.`);
  }
  if (status !== "completed" && reasonCode !== "refund") {
    throw new TypeError(`${label}.${status} status is valid only for refund adjustments.`);
  }
  if (reasonCode === "refund" && status === "completed" && !providerReference) {
    throw new TypeError(
      `${label}.providerReference is required for a completed refund adjustment.`,
    );
  }

  return Object.freeze({
    adjustmentId: expectString(input.adjustmentId, `${label}.adjustmentId`),
    reasonCode,
    amountCents,
    donationDedupId,
    externalReference,
    providerReference,
    status,
    createdAt: parseTimestamp(input.createdAt, `${label}.createdAt`),
  });
}

export function parseArtifactKeys(value, label = "artifactKeys") {
  const input = expectObject(value, label);
  return Object.freeze({
    rawTranscriptPrefix: parseObjectKey(
      input.rawTranscriptPrefix,
      `${label}.rawTranscriptPrefix`,
    ),
    compactedContextKey: parseObjectKey(
      input.compactedContextKey,
      `${label}.compactedContextKey`,
    ),
    solutionKey: parseObjectKey(input.solutionKey, `${label}.solutionKey`),
  });
}

export function parsePublisherSnapshot(value, label = "publisherSnapshot") {
  const input = expectObject(value, label);
  if (input.schemaVersion !== 1) {
    throw new TypeError(`${label}.schemaVersion must be 1.`);
  }
  if (!Array.isArray(input.problems)) {
    throw new TypeError(`${label}.problems must be an array.`);
  }

  const problems = input.problems.map((problem, index) => (
    parsePublishedProblem(problem, `${label}.problems[${index}]`)
  ));
  const problemIds = new Set();
  for (const problem of problems) {
    if (problemIds.has(problem.problemId)) {
      throw new TypeError(`${label}.problems contains duplicate ${problem.problemId}.`);
    }
    problemIds.add(problem.problemId);
  }

  return Object.freeze({
    schemaVersion: 1,
    generatedAt: parseTimestamp(input.generatedAt, `${label}.generatedAt`),
    catalogRevision: parsePositiveInteger(
      input.catalogRevision,
      `${label}.catalogRevision`,
    ),
    treasury: parseTreasurySnapshot(input.treasury, `${label}.treasury`),
    problems: Object.freeze(problems),
  });
}

function parsePublishedProblem(value, label) {
  const input = expectObject(value, label);
  const problemId = parseProblemId(input.problemId, `${label}.problemId`);
  const pools = parseArray(input.pools, parsePool, `${label}.pools`);
  const poolDirections = new Set(pools.map((pool) => pool.direction));
  if (
    pools.length !== DIRECTIONS.length
    || poolDirections.size !== DIRECTIONS.length
  ) {
    throw new TypeError(`${label}.pools must contain exactly one pool per direction.`);
  }
  if (pools.some((pool) => pool.problemId !== problemId)) {
    throw new TypeError(`${label}.pools must belong to ${problemId}.`);
  }

  const liveClaims = parseArray(input.liveClaims, parseClaim, `${label}.liveClaims`);
  if (liveClaims.some((claim) => claim.problemId !== problemId)) {
    throw new TypeError(`${label}.liveClaims must belong to ${problemId}.`);
  }
  if (new Set(liveClaims.map((claim) => claim.direction)).size !== liveClaims.length) {
    throw new TypeError(`${label}.liveClaims contains duplicate directions.`);
  }

  const reviewedResults = parseArray(
    input.reviewedResults,
    parseReviewedResult,
    `${label}.reviewedResults`,
  );
  if (reviewedResults.some((result) => result.problemId !== problemId)) {
    throw new TypeError(`${label}.reviewedResults must belong to ${problemId}.`);
  }

  const recentDonations = parseArray(
    input.recentDonations,
    parseDonation,
    `${label}.recentDonations`,
  );
  if (recentDonations.some((donation) => (
    donation.destination.kind === "pool"
    && donation.destination.problemId !== problemId
  ))) {
    throw new TypeError(`${label}.recentDonations must belong to ${problemId}.`);
  }
  const status = parseProblemStatus(input.status, `${label}.status`);
  const solvedWithResidue = expectBoolean(
    input.solvedWithResidue,
    `${label}.solvedWithResidue`,
  );
  if (solvedWithResidue && status !== "Solved") {
    throw new TypeError(`${label}.solvedWithResidue requires Solved status.`);
  }

  return Object.freeze({
    problemId,
    slug: expectString(input.slug, `${label}.slug`),
    domain: expectString(input.domain, `${label}.domain`),
    title: expectString(input.title, `${label}.title`),
    statement: expectString(input.statement, `${label}.statement`),
    status,
    pools: Object.freeze(pools),
    liveClaims: Object.freeze(liveClaims),
    reviewedResults: Object.freeze(reviewedResults),
    recentDonations: Object.freeze(recentDonations),
    solvedWithResidue,
  });
}

function parseTreasurySnapshot(value, label) {
  const input = expectObject(value, label);
  return Object.freeze({
    settledButUnfundedCents: asCents(
      input.settledButUnfundedCents,
      `${label}.settledButUnfundedCents`,
    ),
    spendableCapacityCents: asCents(
      input.spendableCapacityCents,
      `${label}.spendableCapacityCents`,
    ),
    liveReservationsCents: asCents(
      input.liveReservationsCents,
      `${label}.liveReservationsCents`,
    ),
    runsPausedPendingSettlement: expectBoolean(
      input.runsPausedPendingSettlement,
      `${label}.runsPausedPendingSettlement`,
    ),
  });
}

function parseDonationDestination(value, label) {
  const input = expectObject(value, label);
  const kind = parseEnum(input.kind, ["pool", "general"], `${label}.kind`);
  if (kind === "general") return Object.freeze({ kind });
  return Object.freeze({
    kind,
    problemId: parseProblemId(input.problemId, `${label}.problemId`),
    direction: parseDirection(input.direction, `${label}.direction`),
  });
}

function parseArray(value, parser, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value.map((item, index) => parser(item, `${label}[${index}]`));
}

function parseEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${label} must be one of ${allowed.join(", ")}.`);
  }
  return value;
}

function parseTimestamp(value, label) {
  if (
    typeof value !== "string"
    || !value.includes("T")
    || Number.isNaN(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be an ISO-8601 timestamp string.`);
  }
  return value;
}

function parseObjectKey(value, label) {
  const key = expectString(value, label);
  if (key.startsWith("/") || key.includes("\\") || key.split("/").includes("..")) {
    throw new TypeError(`${label} must be a safe object-store key.`);
  }
  return key;
}

function optionalString(value, label) {
  return value === undefined || value === null ? undefined : expectString(value, label);
}

function expectObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function expectString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value;
}

function expectBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean.`);
  return value;
}
