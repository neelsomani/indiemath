import {
  parseNonnegativeInteger,
  parsePositiveInteger,
  parseProblemId,
  parseWorkerId,
} from "./identifiers.mjs";
import { addCents, asCents } from "./money.mjs";
import { deriveTreasuryPublication } from "./treasury.mjs";

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
 * @typedef {object} TreasurySnapshot
 * @property {number} settledContributionCents
 * @property {number} completedRefundCents
 * @property {number} pendingRefundCents
 * @property {number} fundingEventCents
 * @property {number} settledButUnfundedCents
 * @property {number} availableToFundCents
 * @property {number} spendableCapacityCents
 * @property {number} liveReservationsCents
 * @property {boolean} runsPausedPendingSettlement
 */
/**
 * @typedef {object} PublisherSnapshot
 * @property {1} schemaVersion
 * @property {string} generatedAt
 * @property {number} catalogRevision
 * @property {TreasurySnapshot} treasury
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
  const claimableBalanceCents = optionalCents(
    input.claimableBalanceCents,
    `${label}.claimableBalanceCents`,
  );
  const unprocessedCents = optionalCents(
    input.unprocessedCents,
    `${label}.unprocessedCents`,
  );
  const minimumContributionCents = optionalCents(
    input.minimumContributionCents,
    `${label}.minimumContributionCents`,
  );
  return Object.freeze(compactObject({
    problemId: parseProblemId(input.problemId, `${label}.problemId`),
    direction: parseDirection(input.direction, `${label}.direction`),
    balanceCents: asCents(input.balanceCents, `${label}.balanceCents`),
    cumulativeDonationsCents: asCents(
      input.cumulativeDonationsCents,
      `${label}.cumulativeDonationsCents`,
    ),
    claimableBalanceCents,
    unprocessedCents,
    checkoutUrl: optionalString(input.checkoutUrl, `${label}.checkoutUrl`),
    minimumContributionCents,
  }));
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
  const pendingRefundCents = optionalCents(
    input.pendingRefundCents,
    `${label}.pendingRefundCents`,
  );
  const remainingCents = optionalCents(
    input.remainingCents,
    `${label}.remainingCents`,
  );
  const unprocessedCents = optionalCents(
    input.unprocessedCents,
    `${label}.unprocessedCents`,
  );
  const processingStatus = input.processingStatus === undefined
    ? undefined
    : parseEnum(
        input.processingStatus,
        ["received", "processed", "refunded", "reversed"],
        `${label}.processingStatus`,
      );
  if (
    processingStatus === "processed"
    && unprocessedCents !== undefined
    && unprocessedCents !== 0
  ) {
    throw new RangeError(`${label}.processed donations cannot be unprocessed.`);
  }
  return Object.freeze(compactObject({
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
    pendingRefundCents,
    remainingCents,
    unprocessedCents,
    processingStatus,
  }));
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
  const status = input.status === undefined
    ? undefined
    : parseEnum(input.status, ["running", "settled"], `${label}.status`);
  if (status !== undefined && (status === "settled") !== Boolean(input.settled)) {
    throw new TypeError(`${label}.status must agree with settled.`);
  }
  return Object.freeze(compactObject({
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
    settledAt: optionalString(input.settledAt, `${label}.settledAt`),
    solutionUri: optionalString(input.solutionUri, `${label}.solutionUri`),
    status,
    remainingBudgetCents: optionalCents(
      input.remainingBudgetCents,
      `${label}.remainingBudgetCents`,
    ),
    transcriptPrefix: optionalString(
      input.transcriptPrefix,
      `${label}.transcriptPrefix`,
    ),
    transcriptSegments: input.transcriptSegments === undefined
      ? undefined
      : Object.freeze(parseArray(
          input.transcriptSegments,
          parsePublishedTranscriptSegment,
          `${label}.transcriptSegments`,
        )),
    solutionKey: optionalString(input.solutionKey, `${label}.solutionKey`),
  }));
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
  return Object.freeze(compactObject({
    problemId: parseProblemId(input.problemId, `${label}.problemId`),
    direction: parseDirection(input.direction, `${label}.direction`),
    claimTs: parsePositiveInteger(input.claimTs, `${label}.claimTs`),
    solutionUri: expectString(input.solutionUri, `${label}.solutionUri`),
    outcome,
    noteUri: expectString(input.noteUri, `${label}.noteUri`),
    assumptionLabel,
    reviewedAt: parseTimestamp(input.reviewedAt, `${label}.reviewedAt`),
    solutionKey: optionalString(input.solutionKey, `${label}.solutionKey`),
    noteKey: optionalString(input.noteKey, `${label}.noteKey`),
  }));
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

  const publicationId = input.publicationId === undefined
    ? undefined
    : parseSha256(input.publicationId, `${label}.publicationId`);
  const ledgerSha256 = input.ledgerSha256 === undefined
    ? undefined
    : parseSha256(input.ledgerSha256, `${label}.ledgerSha256`);
  const unprocessedCents = optionalCents(
    input.unprocessedCents,
    `${label}.unprocessedCents`,
  );
  const generalCredit = input.generalCredit === undefined
    ? undefined
    : parsePublishedGeneralCredit(
        input.generalCredit,
        `${label}.generalCredit`,
      );
  if (
    unprocessedCents !== undefined
    && generalCredit !== undefined
    && problems.every((problem) => problem.unprocessedCents !== undefined)
  ) {
    const derivedUnprocessed = problems.reduce(
      (total, problem) => addCents(total, problem.unprocessedCents),
      generalCredit.unprocessedCents,
    );
    if (derivedUnprocessed !== unprocessedCents) {
      throw new RangeError(
        `${label}.unprocessedCents must equal problem and general totals.`,
      );
    }
  }
  return Object.freeze(compactObject({
    schemaVersion: 1,
    publicationId,
    generatedAt: parseTimestamp(input.generatedAt, `${label}.generatedAt`),
    catalogRevision: parsePositiveInteger(
      input.catalogRevision,
      `${label}.catalogRevision`,
    ),
    catalog: input.catalog === undefined
      ? undefined
      : Object.freeze(structuredClone(expectObject(
          input.catalog,
          `${label}.catalog`,
        ))),
    ledgerKey: input.ledgerKey === undefined
      ? undefined
      : parseObjectKey(input.ledgerKey, `${label}.ledgerKey`),
    ledgerSha256,
    unprocessedCents,
    treasury: parseTreasurySnapshot(input.treasury, `${label}.treasury`),
    generalCredit,
    problems: Object.freeze(problems),
  }));
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

  const pendingSolutions = input.pendingSolutions === undefined
    ? undefined
    : Object.freeze(parseArray(
        input.pendingSolutions,
        parsePendingSolution,
        `${label}.pendingSolutions`,
      ));
  const totalPoolBalanceCents = optionalCents(
    input.totalPoolBalanceCents,
    `${label}.totalPoolBalanceCents`,
  );
  const unprocessedCents = optionalCents(
    input.unprocessedCents,
    `${label}.unprocessedCents`,
  );
  if (
    totalPoolBalanceCents !== undefined
    && pools.reduce((total, pool) => addCents(total, pool.balanceCents), 0)
      !== totalPoolBalanceCents
  ) {
    throw new RangeError(`${label}.totalPoolBalanceCents disagrees with pools.`);
  }
  if (
    unprocessedCents !== undefined
    && pools.every((pool) => pool.unprocessedCents !== undefined)
    && pools.reduce(
      (total, pool) => addCents(total, pool.unprocessedCents),
      0,
    )
      !== unprocessedCents
  ) {
    throw new RangeError(`${label}.unprocessedCents disagrees with pools.`);
  }
  return Object.freeze(compactObject({
    problemId,
    catalogRevision: input.catalogRevision === undefined
      ? undefined
      : parsePositiveInteger(
          input.catalogRevision,
          `${label}.catalogRevision`,
        ),
    slug: expectString(input.slug, `${label}.slug`),
    domain: expectString(input.domain, `${label}.domain`),
    title: expectString(input.title, `${label}.title`),
    statement: expectString(input.statement, `${label}.statement`),
    directions: input.directions === undefined
      ? undefined
      : Object.freeze(structuredClone(expectObject(
          input.directions,
          `${label}.directions`,
        ))),
    source: input.source === undefined
      ? undefined
      : Object.freeze(structuredClone(expectObject(
          input.source,
          `${label}.source`,
        ))),
    status,
    totalPoolBalanceCents,
    unprocessedCents,
    pools: Object.freeze(pools),
    liveClaims: Object.freeze(liveClaims),
    pendingSolutions,
    reviewedResults: Object.freeze(reviewedResults),
    recentDonations: Object.freeze(recentDonations),
    solvedWithResidue,
  }));
}

export function parsePublicLedger(value, label = "publicLedger") {
  const input = expectObject(value, label);
  if (input.schemaVersion !== 1) {
    throw new TypeError(`${label}.schemaVersion must be 1.`);
  }
  const publicationId = parseSha256(
    input.publicationId,
    `${label}.publicationId`,
  );
  const donations = parseArray(
    input.donations,
    parseDonation,
    `${label}.donations`,
  );
  const runs = parseArray(input.runs, parseClaim, `${label}.runs`);
  const reviews = parseArray(
    input.reviews,
    parseReviewedResult,
    `${label}.reviews`,
  );
  const adjustments = parseArray(
    input.adjustments,
    parsePublishedAdjustment,
    `${label}.adjustments`,
  );
  const fundingEvents = parseArray(
    input.fundingEvents,
    parsePublishedFundingEvent,
    `${label}.fundingEvents`,
  );
  const settlementSnapshots = parseArray(
    input.settlementSnapshots,
    parsePublishedSettlementSnapshot,
    `${label}.settlementSnapshots`,
  );
  return Object.freeze({
    ...structuredClone(input),
    schemaVersion: 1,
    publicationId,
    generatedAt: parseTimestamp(input.generatedAt, `${label}.generatedAt`),
    catalogRevision: parsePositiveInteger(
      input.catalogRevision,
      `${label}.catalogRevision`,
    ),
    catalogHash: parseSha256(input.catalogHash, `${label}.catalogHash`),
    catalogSyncedAt: parseTimestamp(
      input.catalogSyncedAt,
      `${label}.catalogSyncedAt`,
    ),
    stateKey: parseObjectKey(input.stateKey, `${label}.stateKey`),
    treasury: parseTreasurySnapshot(input.treasury, `${label}.treasury`),
    accounting: parsePublishedAccounting(
      input.accounting,
      `${label}.accounting`,
    ),
    generalCredit: parsePublishedGeneralCredit(
      input.generalCredit,
      `${label}.generalCredit`,
    ),
    donations: Object.freeze(donations),
    runs: Object.freeze(runs),
    reviews: Object.freeze(reviews),
    adjustments: Object.freeze(adjustments),
    fundingEvents: Object.freeze(fundingEvents),
    settlementSnapshots: Object.freeze(settlementSnapshots),
  });
}

function parseTreasurySnapshot(value, label) {
  const input = expectObject(value, label);
  const publication = deriveTreasuryPublication(input);
  const declaredPause = expectBoolean(
    input.runsPausedPendingSettlement,
    `${label}.runsPausedPendingSettlement`,
  );
  if (declaredPause !== publication.runsPausedPendingSettlement) {
    throw new TypeError(
      `${label}.runsPausedPendingSettlement must be derived from spendable capacity.`,
    );
  }
  return publication;
}

function parsePublishedGeneralCredit(value, label) {
  const input = expectObject(value, label);
  return Object.freeze({
    balanceCents: asCents(input.balanceCents, `${label}.balanceCents`),
    debtCents: asCents(input.debtCents, `${label}.debtCents`),
    claimableBalanceCents: asCents(
      input.claimableBalanceCents,
      `${label}.claimableBalanceCents`,
    ),
    unprocessedCents: asCents(
      input.unprocessedCents,
      `${label}.unprocessedCents`,
    ),
  });
}

function parsePublishedAccounting(value, label) {
  const input = expectObject(value, label);
  const result = {
    donationNetCents: asCents(
      input.donationNetCents,
      `${label}.donationNetCents`,
    ),
    adjustmentInflowsCents: asCents(
      input.adjustmentInflowsCents,
      `${label}.adjustmentInflowsCents`,
    ),
    inflowsCents: asCents(input.inflowsCents, `${label}.inflowsCents`),
    poolBalanceCents: asCents(
      input.poolBalanceCents,
      `${label}.poolBalanceCents`,
    ),
    generalCreditCents: asCents(
      input.generalCreditCents,
      `${label}.generalCreditCents`,
    ),
    generalDebtCents: asCents(
      input.generalDebtCents,
      `${label}.generalDebtCents`,
    ),
    settledSpendCents: asCents(
      input.settledSpendCents,
      `${label}.settledSpendCents`,
    ),
    liveReservationCents: asCents(
      input.liveReservationCents,
      `${label}.liveReservationCents`,
    ),
    adjustmentOutflowsCents: asCents(
      input.adjustmentOutflowsCents,
      `${label}.adjustmentOutflowsCents`,
    ),
    accountedCents: asCents(
      input.accountedCents,
      `${label}.accountedCents`,
    ),
    balanced: expectBoolean(input.balanced, `${label}.balanced`),
  };
  if (
    result.inflowsCents !== addCents(
      result.donationNetCents,
      result.adjustmentInflowsCents,
    )
    || result.balanced !== (result.inflowsCents === result.accountedCents)
  ) {
    throw new RangeError(`${label} totals disagree.`);
  }
  return Object.freeze(result);
}

function parsePublishedAdjustment(value, label) {
  const input = expectObject(value, label);
  return Object.freeze(compactObject({
    adjustmentId: parseSha256(input.adjustmentId, `${label}.adjustmentId`),
    reasonCode: parseEnum(
      input.reasonCode,
      ADJUSTMENT_REASONS,
      `${label}.reasonCode`,
    ),
    amountCents: asCents(
      input.amountCents,
      `${label}.amountCents`,
      { allowNegative: true },
    ),
    donationDedupId: optionalString(
      input.donationDedupId,
      `${label}.donationDedupId`,
    ),
    status: parseEnum(
      input.status,
      ADJUSTMENT_STATUSES,
      `${label}.status`,
    ),
    createdAt: parseTimestamp(input.createdAt, `${label}.createdAt`),
    resolvedAt: input.resolvedAt === undefined
      ? undefined
      : parseTimestamp(input.resolvedAt, `${label}.resolvedAt`),
  }));
}

function parsePublishedFundingEvent(value, label) {
  const input = expectObject(value, label);
  const amountCents = asCents(input.amountCents, `${label}.amountCents`);
  if (amountCents === 0) {
    throw new RangeError(`${label}.amountCents must be positive.`);
  }
  return Object.freeze({
    fundingEventId: parseSha256(
      input.fundingEventId,
      `${label}.fundingEventId`,
    ),
    amountCents,
    settledContributionCents: asCents(
      input.settledContributionCents,
      `${label}.settledContributionCents`,
    ),
    fundedAt: parseTimestamp(input.fundedAt, `${label}.fundedAt`),
  });
}

function parsePublishedSettlementSnapshot(value, label) {
  const input = expectObject(value, label);
  return Object.freeze({
    providerKind: parseEnum(
      input.providerKind,
      ["stripe", "open_collective_host"],
      `${label}.providerKind`,
    ),
    cutoffAt: parseTimestamp(input.cutoffAt, `${label}.cutoffAt`),
    settledContributionCents: asCents(
      input.settledContributionCents,
      `${label}.settledContributionCents`,
    ),
    sourceRecordCount: parseNonnegativeInteger(
      input.sourceRecordCount,
      `${label}.sourceRecordCount`,
    ),
    sourceHash: parseSha256(input.sourceHash, `${label}.sourceHash`),
    createdAt: parseTimestamp(input.createdAt, `${label}.createdAt`),
  });
}

function parsePublishedTranscriptSegment(value, label) {
  const input = expectObject(value, label);
  return Object.freeze({
    sequence: parsePositiveInteger(input.sequence, `${label}.sequence`),
    modelId: expectString(input.modelId, `${label}.modelId`),
    stopReason: optionalString(input.stopReason, `${label}.stopReason`),
    usage: Object.freeze(structuredClone(expectObject(
      input.usage,
      `${label}.usage`,
    ))),
    pricedCostCents: asCents(
      input.pricedCostCents,
      `${label}.pricedCostCents`,
    ),
    appliedCostCents: asCents(
      input.appliedCostCents,
      `${label}.appliedCostCents`,
    ),
    overageCents: asCents(input.overageCents, `${label}.overageCents`),
    requestStartedAt: parseTimestamp(
      input.requestStartedAt,
      `${label}.requestStartedAt`,
    ),
    completedAt: parseTimestamp(input.completedAt, `${label}.completedAt`),
    rawTranscriptKey: parseObjectKey(
      input.rawTranscriptKey,
      `${label}.rawTranscriptKey`,
    ),
    humanTranscriptKey: parseObjectKey(
      input.humanTranscriptKey,
      `${label}.humanTranscriptKey`,
    ),
  });
}

function parsePendingSolution(value, label) {
  const input = expectObject(value, label);
  return Object.freeze({
    role: parseEnum(input.role, ["primary", "secondary"], `${label}.role`),
    direction: parseDirection(input.direction, `${label}.direction`),
    claimTs: parsePositiveInteger(input.claimTs, `${label}.claimTs`),
    solutionKey: parseObjectKey(input.solutionKey, `${label}.solutionKey`),
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

function optionalCents(value, label) {
  return value === undefined || value === null
    ? undefined
    : asCents(value, label);
}

function parseSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
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
