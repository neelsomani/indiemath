import { createHash } from "node:crypto";
import {
  addCents,
  artifactKeyFromR2Uri,
  assertPort,
  deriveTreasuryPublication,
  humanTranscriptKey,
  publicLedgerKey,
  publicPublicationLedgerKey,
  publicPublicationStateKey,
  publicStateKey,
  parsePublicLedger,
  parsePublisherSnapshot,
  rawTranscriptKey,
  rawTranscriptPrefix,
  runControlFromPauseReason,
} from "#indiemath/shared";

const PUBLIC_SCHEMA_VERSION = 1;
const RECENT_DONATION_LIMIT = 100;

export function buildPublicDocuments({
  source,
  generatedAt,
  runsPausedReason,
}) {
  requireSourceSnapshot(source);
  const publishedAt = timestamp(generatedAt, "generatedAt");
  const runControl = runControlFromPauseReason(runsPausedReason);
  const publicationId = sha256(canonicalJson({
    generatedAt: publishedAt,
    catalogHash: source.catalogHash,
    runControl,
    source,
  }));
  const ledgerKey = publicPublicationLedgerKey(publicationId);
  const stateKey = publicPublicationStateKey(publicationId);
  const donationIds = new Map(source.donations.map((donation) => [
    donation.dedupId,
    publicDonationId(donation),
  ]));
  const donations = source.donations.map((donation) => (
    publicDonation(donation, source.adjustments, donationIds.get(donation.dedupId))
  ));
  const unprocessedCents = sumCents(
    donations.map((donation) => donation.unprocessedCents),
  );
  const treasury = deriveTreasuryPublication(source.treasury);
  const reviews = source.reviewedResults.map(publicReview);
  const runs = source.claims
    .map((claim) => publicRun(
      claim,
      source.claimResponses.filter((response) => sameClaim(response, claim)),
    ))
    .filter(isPublicResearchRun);
  const catalogProblems = new Map(source.catalog.problems.map((problem) => [
    problem.id,
    problem,
  ]));
  const pools = new Map(source.pools.map((pool) => [
    pairKey(pool.problemId, pool.direction),
    pool,
  ]));
  const tiers = new Map(source.openCollectiveTiers.map((tier) => [
    pairKey(tier.problemId, tier.direction),
    tier,
  ]));

  const problems = source.problems
    .filter((ledgerProblem) => catalogProblems.has(ledgerProblem.problemId))
    .map((ledgerProblem) => {
      const catalogProblem = catalogProblems.get(ledgerProblem.problemId);
      const problemDonations = donations.filter((donation) => (
        displayDestination(donation)?.problemId === ledgerProblem.problemId
      ));
      const problemPools = ["prove", "disprove"].map((direction) => {
        const pool = pools.get(pairKey(ledgerProblem.problemId, direction));
        if (!pool) {
          throw new Error(`Missing pool ${ledgerProblem.problemId}/${direction}.`);
        }
        const tier = tiers.get(pairKey(ledgerProblem.problemId, direction));
        return compact({
          problemId: ledgerProblem.problemId,
          direction,
          balanceCents: pool.balanceCents,
          claimableBalanceCents: pool.claimableBalanceCents,
          cumulativeDonationsCents: pool.cumulativeDonationsCents,
          unprocessedCents: sumCents(problemDonations
            .filter((donation) => (
              displayDestination(donation)?.direction === direction
            ))
            .map((donation) => donation.unprocessedCents)),
          checkoutUrl: tier?.checkoutUrl,
          minimumContributionCents: tier?.minimumAmountCents,
        });
      });
      const liveClaims = runs.filter((run) => (
        run.problemId === ledgerProblem.problemId && run.status === "running"
      ));
      const problemReviews = reviews.filter(
        (review) => review.problemId === ledgerProblem.problemId,
      );
      const totalPoolBalanceCents = sumCents(
        problemPools.map((pool) => pool.balanceCents),
      );
      return compact({
        problemId: ledgerProblem.problemId,
        catalogRevision: ledgerProblem.catalogRevision,
        slug: catalogProblem.slug,
        domain: catalogProblem.domain,
        title: catalogProblem.title,
        statement: catalogProblem.statement,
        directions: catalogProblem.directions,
        source: catalogProblem.source,
        status: ledgerProblem.status,
        totalPoolBalanceCents,
        unprocessedCents: sumCents(
          problemPools.map((pool) => pool.unprocessedCents),
        ),
        pools: problemPools,
        liveClaims,
        pendingSolutions: pendingSolutions(ledgerProblem),
        reviewedResults: problemReviews,
        recentDonations: problemDonations
          .slice()
          .sort(reverseDonationOrder)
          .slice(0, RECENT_DONATION_LIMIT),
        solvedWithResidue: ledgerProblem.status === "Solved"
          && problemPools.some((pool) => pool.claimableBalanceCents > 0),
      });
    }).sort(problemDisplayOrder);

  const publicLedger = compact({
    schemaVersion: PUBLIC_SCHEMA_VERSION,
    publicationId,
    generatedAt: publishedAt,
    catalogRevision: source.catalogRevision,
    catalogHash: source.catalogHash,
    catalogSyncedAt: source.catalogSyncedAt,
    stateKey,
    treasury,
    accounting: source.accounting,
    generalCredit: {
      balanceCents: source.generalCreditCents,
      debtCents: source.generalDebtCents,
      claimableBalanceCents: source.claimableGeneralCreditCents,
      unprocessedCents: sumCents(donations
        .filter((donation) => displayDestination(donation)?.kind === "general")
        .map((donation) => donation.unprocessedCents)),
    },
    donations,
    runs,
    reviews,
    adjustments: source.adjustments.map((adjustment) => (
      publicAdjustment(adjustment, donationIds)
    )),
    fundingEvents: source.fundingEvents.map(publicFundingEvent),
    settlementSnapshots: source.settlementSnapshots.map(publicSettlementSnapshot),
    rampSpend: source.rampSpend
      ? {
          actualSpendCents: source.rampSpend.actualSpendCents,
          sourceTransactionCount: source.rampSpend.sourceTransactionCount,
          cutoffAt: source.rampSpend.cutoffAt,
          lastObservedAt: source.rampSpend.lastObservedAt,
        }
      : undefined,
  });
  const ledgerBody = `${canonicalJson(publicLedger)}\n`;
  const ledgerSha256 = sha256(ledgerBody);
  const publicState = compact({
    schemaVersion: PUBLIC_SCHEMA_VERSION,
    publicationId,
    generatedAt: publishedAt,
    catalogRevision: source.catalogRevision,
    catalog: {
      schemaVersion: source.catalog.schema_version,
      directionContract: source.catalog.direction_contract,
      reviewPolicy: source.catalog.review_policy,
    },
    ledgerKey,
    ledgerSha256,
    unprocessedCents,
    runControl,
    treasury,
    generalCredit: publicLedger.generalCredit,
    problems,
  });
  parsePublicLedger(publicLedger);
  parsePublisherSnapshot(publicState);
  const stateBody = `${canonicalJson(publicState)}\n`;

  return Object.freeze({
    publicationId,
    stateKey,
    ledgerKey,
    state: Object.freeze(publicState),
    ledger: Object.freeze(publicLedger),
    stateBody,
    ledgerBody,
    stateSha256: sha256(stateBody),
    ledgerSha256,
  });
}

export async function publishPublicLedgerOnce({
  ledger,
  r2,
  clock = () => new Date(),
  runsPausedReason,
}) {
  assertPort(ledger, "ledger", ["publicationSnapshot"]);
  assertPort(r2, "R2", ["putObject"]);
  if (typeof clock !== "function") throw new TypeError("clock must be a function.");
  const documents = buildPublicDocuments({
    source: ledger.publicationSnapshot(),
    generatedAt: clock(),
    runsPausedReason,
  });
  const immutableOptions = {
    contentType: "application/json; charset=utf-8",
    cacheControl: "public, max-age=31536000, immutable",
    metadata: {
      publicationId: documents.publicationId,
      sha256: documents.ledgerSha256,
      cachePolicy: "immutable",
    },
  };
  await r2.putObject(
    documents.ledgerKey,
    documents.ledgerBody,
    immutableOptions,
  );
  await r2.putObject(
    documents.stateKey,
    documents.stateBody,
    {
      ...immutableOptions,
      metadata: {
        ...immutableOptions.metadata,
        sha256: documents.stateSha256,
      },
    },
  );

  // The fixed ledger mirror is written before state.json. The latter is the
  // publication commit point and links to the immutable ledger generation, so
  // browser readers can never pair state with a half-published ledger.
  await r2.putObject(publicLedgerKey(), documents.ledgerBody, {
    contentType: "application/json; charset=utf-8",
    cacheControl: "no-cache",
    metadata: {
      publicationId: documents.publicationId,
      sha256: documents.ledgerSha256,
      cachePolicy: "revalidate",
    },
  });
  await r2.putObject(publicStateKey(), documents.stateBody, {
    contentType: "application/json; charset=utf-8",
    cacheControl: "no-cache",
    metadata: {
      publicationId: documents.publicationId,
      sha256: documents.stateSha256,
      cachePolicy: "revalidate",
    },
  });

  return Object.freeze({
    publicationId: documents.publicationId,
    generatedAt: documents.state.generatedAt,
    catalogRevision: documents.state.catalogRevision,
    problemCount: documents.state.problems.length,
    donationCount: documents.ledger.donations.length,
    runCount: documents.ledger.runs.length,
    reviewCount: documents.ledger.reviews.length,
    unprocessedCents: documents.state.unprocessedCents,
    stateKey: publicStateKey(),
    ledgerKey: publicLedgerKey(),
    immutableStateKey: documents.stateKey,
    immutableLedgerKey: documents.ledgerKey,
    stateSha256: documents.stateSha256,
    ledgerSha256: documents.ledgerSha256,
  });
}

export class PublicLedgerPublisherController {
  #ledger;
  #r2;
  #clock;
  #intervalMilliseconds;
  #runsPausedReason;
  #wake;

  constructor({
    ledger,
    r2,
    clock = () => new Date(),
    intervalSeconds = 30,
    runsPausedReason,
  }) {
    assertPort(ledger, "ledger", ["publicationSnapshot"]);
    assertPort(r2, "R2", ["putObject"]);
    if (typeof clock !== "function") throw new TypeError("clock must be a function.");
    if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1) {
      throw new TypeError("intervalSeconds must be a positive safe integer.");
    }
    this.#ledger = ledger;
    this.#r2 = r2;
    this.#clock = clock;
    this.#intervalMilliseconds = intervalSeconds * 1_000;
    this.#runsPausedReason = runsPausedReason;
  }

  poke() {
    this.#wake?.();
  }

  async publishNow() {
    return publishPublicLedgerOnce({
      ledger: this.#ledger,
      r2: this.#r2,
      clock: this.#clock,
      runsPausedReason: this.#runsPausedReason,
    });
  }

  async run({ signal, onPublish } = {}) {
    while (!signal?.aborted) {
      const result = await this.publishNow();
      await onPublish?.(result);
      await this.#wait(signal);
    }
  }

  async #wait(signal) {
    if (signal?.aborted) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        this.#wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, this.#intervalMilliseconds);
      signal?.addEventListener("abort", finish, { once: true });
      this.#wake = finish;
    });
  }
}

function publicDonation(donation, adjustments, donationId) {
  const pendingRefundCents = sumCents(adjustments
    .filter((adjustment) => (
      adjustment.reasonCode === "refund"
      && adjustment.status === "pending"
      && adjustment.donationDedupId === donation.dedupId
    ))
    .map((adjustment) => -adjustment.amountCents));
  const waterlineExcludedCents = donation.waterlineExcludedCents ?? 0;
  const effectiveNetCents = Math.max(
    0,
    donation.netCents - donation.refundedCents - waterlineExcludedCents,
  );
  const processingStatus = donation.state === "refunded"
    ? "refunded"
    : ["disputed", "reversed"].includes(donation.state)
      ? "reversed"
      : donation.processed
        ? "processed"
        : "received";
  const unprocessedCents = processingStatus === "received"
    ? Math.max(0, effectiveNetCents - pendingRefundCents)
    : 0;
  return compact({
    dedupId: donationId,
    orderId: donation.source?.kind === "open_collective"
      ? donation.orderId
      : undefined,
    destination: donation.destination,
    intendedDestination: donation.intendedDestination,
    grossCents: donation.grossCents,
    feesCents: donation.feesCents,
    netCents: donation.netCents,
    refundedCents: donation.refundedCents,
    pendingRefundCents,
    waterlineExcludedCents,
    remainingCents: unprocessedCents,
    unprocessedCents,
    donorTag: donation.donorTag,
    creditedAt: donation.creditedAt,
    state: donation.state,
    processingStatus,
  });
}

function publicRun(claim, responses) {
  const transcriptSegments = responses.map((response) => ({
    sequence: response.sequence,
    modelId: response.modelId,
    stopReason: response.stopReason,
    usage: response.usage,
    pricedCostCents: response.pricedCostCents,
    appliedCostCents: response.appliedCostCents,
    overageCents: response.overageCents,
    requestStartedAt: response.requestStartedAt,
    completedAt: response.completedAt,
    rawTranscriptKey: rawTranscriptKey({
      ...claim,
      sequence: response.sequence,
    }),
    humanTranscriptKey: humanTranscriptKey({
      ...claim,
      sequence: response.sequence,
    }),
  }));
  return compact({
    problemId: claim.problemId,
    direction: claim.direction,
    claimTs: claim.claimTs,
    catalogRevision: claim.catalogRevision,
    workerId: claim.workerId,
    budgetCents: claim.budgetCents,
    poolFundedCents: claim.poolFundedCents,
    spentCents: claim.spentCents,
    remainingBudgetCents: claim.budgetCents - claim.spentCents,
    leaseExpiresAt: claim.leaseExpiresAt,
    status: claim.settled ? "settled" : "running",
    settled: claim.settled,
    settledAt: claim.settledAt,
    transcriptPrefix: rawTranscriptPrefix(claim),
    transcriptSegments,
    solutionKey: claim.solutionUri
      ? artifactKeyFromR2Uri(claim.solutionUri)
      : undefined,
    solutionUri: claim.solutionUri,
  });
}

function isPublicResearchRun(run) {
  return run.status === "running"
    || run.spentCents > 0
    || run.transcriptSegments.length > 0
    || Boolean(run.solutionKey);
}

function publicReview(review) {
  return compact({
    problemId: review.problemId,
    direction: review.direction,
    claimTs: review.claimTs,
    outcome: review.outcome,
    assumptionLabel: review.assumptionLabel,
    solutionUri: review.solutionUri,
    noteUri: review.noteUri,
    solutionKey: artifactKeyFromR2Uri(review.solutionUri),
    noteKey: artifactKeyFromR2Uri(review.noteUri),
    reviewedAt: review.reviewedAt,
  });
}

function pendingSolutions(problem) {
  return [
    problem.pendingSolution
      ? { role: "primary", ...publicPendingSolution(problem.pendingSolution) }
      : undefined,
    problem.secondarySolution
      ? { role: "secondary", ...publicPendingSolution(problem.secondarySolution) }
      : undefined,
  ].filter(Boolean);
}

function publicPendingSolution(solution) {
  return {
    direction: solution.direction,
    claimTs: solution.claimTs,
    solutionKey: artifactKeyFromR2Uri(solution.solutionUri),
  };
}

function publicAdjustment(adjustment, donationIds) {
  return compact({
    adjustmentId: sha256(`adjustment:${adjustment.adjustmentId}`),
    reasonCode: adjustment.reasonCode,
    amountCents: adjustment.amountCents,
    donationDedupId: adjustment.donationDedupId
      ? donationIds.get(adjustment.donationDedupId)
      : undefined,
    status: adjustment.status,
    createdAt: adjustment.createdAt,
    resolvedAt: adjustment.resolvedAt,
  });
}

function publicDonationId(donation) {
  return donation.source?.kind === "open_collective"
    ? donation.dedupId
    : sha256(`donation:${donation.dedupId}`);
}

function publicFundingEvent(event) {
  return {
    fundingEventId: sha256(`funding-event:${event.externalReference}`),
    amountCents: event.amountCents,
    settledContributionCents: event.settledContributionCents,
    fundingSource: event.fundingSource,
    fundedAt: event.fundedAt,
  };
}

function publicSettlementSnapshot(snapshot) {
  return {
    providerKind: snapshot.providerKind,
    cutoffAt: snapshot.cutoffAt,
    settledContributionCents: snapshot.settledContributionCents,
    sourceRecordCount: snapshot.sourceRecordCount,
    sourceHash: snapshot.sourceHash,
    createdAt: snapshot.createdAt,
  };
}

function displayDestination(donation) {
  return donation.intendedDestination?.kind === "pool"
    ? donation.intendedDestination
    : donation.destination;
}

function problemDisplayOrder(left, right) {
  const leftRunning = left.liveClaims.length > 0 ? 1 : 0;
  const rightRunning = right.liveClaims.length > 0 ? 1 : 0;
  return (
    rightRunning - leftRunning
    || right.totalPoolBalanceCents - left.totalPoolBalanceCents
    || left.problemId.localeCompare(right.problemId)
  );
}

function reverseDonationOrder(left, right) {
  return (
    right.creditedAt.localeCompare(left.creditedAt)
    || right.dedupId.localeCompare(left.dedupId)
  );
}

function sameClaim(response, claim) {
  return response.problemId === claim.problemId
    && response.direction === claim.direction
    && response.claimTs === claim.claimTs;
}

function pairKey(problemId, direction) {
  return `${problemId}\u0000${direction}`;
}

function sumCents(amounts) {
  return amounts.reduce((total, amount) => addCents(total, amount), 0);
}

function requireSourceSnapshot(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("source must be a ledger publication snapshot.");
  }
  for (const key of [
    "catalog",
    "problems",
    "pools",
    "donations",
    "claims",
    "claimResponses",
    "reviewedResults",
    "fundingEvents",
    "adjustments",
    "openCollectiveTiers",
    "settlementSnapshots",
    "treasury",
    "accounting",
  ]) {
    if (source[key] === undefined) {
      throw new TypeError(`source.${key} is required.`);
    }
  }
  if (!Array.isArray(source.catalog.problems)) {
    throw new TypeError("source.catalog.problems must be an array.");
  }
}

function timestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${label} must be a valid timestamp.`);
  }
  return date.toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : sortJson(item));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => [key, sortJson(value[key])]));
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}
