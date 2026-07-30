#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  addCents,
  artifactKeysForClaim,
  calculateAvailableToFundCents,
  calculateOutstandingOwnerAdvanceCents,
  calculateRefundableCents,
  calculateSettledButUnfundedCents,
  deriveDonationWaterline,
  deriveDonationRefundState,
  formatCents,
  humanTranscriptKey,
  parseAdjustment,
  artifactKeyFromR2Uri,
  parseClaim,
  parseDollarAmount,
  parseDonation,
  parseFrontendConfig,
  parseIntakePublisherConfig,
  parseReviewedResult,
  parseWorkerConfig,
  parseWorkerCount,
  publicPublicationLedgerKey,
  publicPublicationStateKey,
  rawTranscriptKey,
  r2ArtifactUri,
  reviewKey,
  validateWorkerFleet,
  WORKER_IDS,
  workerIdsForCount,
} from "#indiemath/shared";
import {
  createFakeApplication,
  FakeAnthropicAdmin,
  FakeAnthropicMessages,
  FakeOpenCollective,
  FakeR2,
  probeFakeApplication,
} from "#indiemath/fakes";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("money helpers accept integer cents and never parse through floats", () => {
  assert.equal(parseDollarAmount("$12.34"), 1234);
  assert.equal(parseDollarAmount("12.3"), 1230);
  assert.equal(parseDollarAmount("$-2.05", { allowNegative: true }), -205);
  assert.equal(formatCents(-205), "-$2.05");
  assert.equal(addCents(100, 25, -5), 120);
  assert.throws(() => addCents(1.5, 2), /integer number of cents/);
  assert.throws(() => parseDollarAmount("1.234"), /at most two decimal places/);
  assert.throws(
    () => addCents(Number.MAX_SAFE_INTEGER, 1),
    /safe integer cents range/,
  );
});

test("shared entity schemas enforce money and review invariants", () => {
  const donation = parseDonation({
    dedupId: "transaction-1",
    orderId: "recurring-order-1",
    destination: {
      kind: "pool",
      problemId: "math-001",
      direction: "prove",
    },
    grossCents: 5000,
    feesCents: 250,
    netCents: 4750,
    refundedCents: 0,
    donorTag: "Ada",
    creditedAt: "2026-07-28T00:00:00.000Z",
    state: "credited",
  });
  assert.equal(donation.netCents, 4750);
  assert.throws(
    () => parseDonation({ ...donation, netCents: 4749 }),
    /must equal feesCents \+ netCents/,
  );
  assert.equal(parseDonation({
    ...donation,
    state: "partially_refunded",
    refundedCents: 1000,
  }).refundedCents, 1000);
  assert.throws(
    () => parseDonation({
      ...donation,
      state: "refunded",
      refundedCents: 1000,
    }),
    /refunded state requires refundedCents = netCents/,
  );

  const claim = parseClaim({
    problemId: "math-001",
    direction: "prove",
    catalogRevision: 4,
    workerId: "worker-1",
    claimTs: 1,
    budgetCents: 50000,
    poolFundedCents: 30000,
    spentCents: 10000,
    leaseExpiresAt: "2026-07-28T01:00:00.000Z",
    settled: false,
  });
  assert.equal(claim.catalogRevision, 4);
  assert.throws(
    () => parseClaim({ ...claim, spentCents: 50000.5 }),
    /integer number of cents/,
  );

  assert.throws(() => parseReviewedResult({
    problemId: "math-001",
    direction: "prove",
    claimTs: 1,
    solutionUri: "r2://solutions/math-001/prove/1.md",
    outcome: "conditional",
    noteUri: "r2://reviews/math-001/2.md",
    reviewedAt: "2026-07-28T02:00:00.000Z",
  }), /assumptionLabel is required/);

  assert.equal(parseAdjustment({
    adjustmentId: "adjustment-1",
    reasonCode: "dispute",
    amountCents: -5000,
    donationDedupId: "transaction-1",
    externalReference: "dispute-1",
    status: "completed",
    createdAt: "2026-07-28T03:00:00.000Z",
  }).amountCents, -5000);
  assert.equal(parseAdjustment({
    adjustmentId: "adjustment-2",
    reasonCode: "refund",
    amountCents: -1000,
    donationDedupId: "transaction-1",
    externalReference: "refund-request-1",
    status: "pending",
    createdAt: "2026-07-28T03:01:00.000Z",
  }).status, "pending");
  assert.throws(() => parseAdjustment({
    adjustmentId: "adjustment-3",
    reasonCode: "refund",
    amountCents: -1000,
    donationDedupId: "transaction-1",
    externalReference: "refund-request-2",
    status: "completed",
    createdAt: "2026-07-28T03:02:00.000Z",
  }), /providerReference is required/);
});

test("one FIFO waterline controls processed badges and refund eligibility", () => {
  const donations = [
    waterlineDonation("transaction-1", "2026-07-28T00:00:00.000Z"),
    waterlineDonation("transaction-2", "2026-07-28T00:01:00.000Z"),
    waterlineDonation("transaction-3", "2026-07-28T00:02:00.000Z", 1000),
  ];
  const waterline = deriveDonationWaterline({
    donations,
    fundedCents: 4751,
  });
  assert.deepEqual(waterline.map((donation) => ({
    id: donation.dedupId,
    effective: donation.effectiveNetCents,
    covered: donation.coveredCents,
    processed: donation.processed,
    refundEligible: donation.refundEligible,
  })), [
    {
      id: "transaction-1",
      effective: 4750,
      covered: 4750,
      processed: true,
      refundEligible: false,
    },
    {
      id: "transaction-2",
      effective: 4750,
      covered: 1,
      processed: true,
      refundEligible: false,
    },
    {
      id: "transaction-3",
      effective: 3750,
      covered: 0,
      processed: false,
      refundEligible: true,
    },
  ]);
  assert.deepEqual(
    deriveDonationWaterline({ donations, fundedCents: 4750 })
      .map((donation) => donation.processed),
    [true, false, false],
  );
  const afterEarlierRefund = deriveDonationWaterline({
    donations: [
      waterlineDonation("transaction-1", "2026-07-28T00:00:00.000Z"),
      waterlineDonation("transaction-2", "2026-07-28T00:01:00.000Z", 1000),
      waterlineDonation("transaction-3", "2026-07-28T00:02:00.000Z"),
    ],
    fundedCents: 8501,
  });
  assert.equal(afterEarlierRefund[2].coverageStartCents, 8500);
  assert.equal(afterEarlierRefund[2].coveredCents, 1);
  assert.equal(afterEarlierRefund[2].processed, true);

  assert.throws(() => calculateRefundableCents({
    donationDedupId: "transaction-2",
    donations,
    fundedCents: 4751,
    destinationBalanceCents: 5000,
  }), /is processed and no longer refundable/);
  assert.throws(() => calculateRefundableCents({
    donationDedupId: "transaction-3",
    donations,
    fundedCents: 4751,
    pendingRefundCents: 250,
    destinationBalanceCents: 5000,
    requestedCents: 4000,
  }), /Only full refunds are supported.*requested 4000 cents.*3500 cents/);
  assert.equal(calculateRefundableCents({
    donationDedupId: "transaction-3",
    donations,
    fundedCents: 4751,
    pendingRefundCents: 250,
    destinationBalanceCents: 5000,
    requestedCents: 3500,
  }), 3500);
  assert.throws(() => calculateRefundableCents({
    donationDedupId: "transaction-3",
    donations,
    fundedCents: 4751,
    pendingRefundCents: 250,
    destinationBalanceCents: 3000,
  }), /requires 3500 cents.*only 3000 cents available/);

  assert.equal(deriveDonationRefundState({
    donationNetCents: 4750,
    completedRefundCents: 1000,
  }), "partially_refunded");
  assert.equal(deriveDonationRefundState({
    donationNetCents: 4750,
    completedRefundCents: 4750,
  }), "refunded");
  assert.throws(() => calculateRefundableCents({
    donationDedupId: "transaction-3",
    donations,
    fundedCents: 4751,
    pendingRefundCents: 4000,
    destinationBalanceCents: 5000,
  }), /cannot exceed/);
});

test("completed and pending refunds stay out of treasury funding", () => {
  assert.equal(calculateSettledButUnfundedCents({
    settledContributionCents: 20000,
    completedRefundCents: 3000,
    fundingEventCents: 12000,
  }), 5000);
  assert.equal(calculateAvailableToFundCents({
    settledContributionCents: 20000,
    completedRefundCents: 3000,
    fundingEventCents: 12000,
    pendingRefundCents: 1500,
  }), 3500);
  assert.equal(calculateSettledButUnfundedCents({
    settledContributionCents: 10000,
    completedRefundCents: 3000,
    fundingEventCents: 8000,
  }), 0);
  assert.equal(calculateOutstandingOwnerAdvanceCents({
    settledContributionCents: 10000,
    completedRefundCents: 3000,
    fundingEventCents: 8000,
  }), 1000);
});

test("artifact keys are centralized, exact, and path-safe", () => {
  const input = {
    problemId: "math-001",
    direction: "disprove",
    claimTs: 1722124800000,
  };
  assert.deepEqual(artifactKeysForClaim(input), {
    rawTranscriptPrefix: "transcripts/math-001/disprove/1722124800000/",
    compactedContextKey: "transcripts/math-001/disprove/compacted.md",
    solutionKey: "solutions/math-001/disprove/1722124800000.md",
  });
  assert.equal(
    rawTranscriptKey({ ...input, sequence: 3 }),
    "transcripts/math-001/disprove/1722124800000/raw-3.jsonl",
  );
  assert.equal(
    humanTranscriptKey({ ...input, sequence: 3 }),
    "transcripts/math-001/disprove/1722124800000/response-3.md",
  );
  assert.equal(
    artifactKeyFromR2Uri(r2ArtifactUri(artifactKeysForClaim(input).solutionKey)),
    artifactKeysForClaim(input).solutionKey,
  );
  assert.equal(reviewKey({
    problemId: "math-001",
    reviewTs: 1722124800001,
  }), "reviews/math-001/1722124800001.md");
  const publicationId = "a".repeat(64);
  assert.equal(
    publicPublicationStateKey(publicationId),
    `public/publications/${publicationId}/state.json`,
  );
  assert.equal(
    publicPublicationLedgerKey(publicationId),
    `public/publications/${publicationId}/ledger.json`,
  );
  assert.throws(() => publicPublicationStateKey("../escape"), /SHA-256/);
  assert.throws(
    () => artifactKeysForClaim({ ...input, problemId: "../escape" }),
    /must be 3–64 characters/,
  );
});

test("worker configuration scales from one to four and rejects invalid fleets", () => {
  const configs = WORKER_IDS.map((workerId) => parseWorkerConfig(
    fakeWorkerEnvironment(workerId),
  ));
  assert.equal(validateWorkerFleet(configs).length, 4);
  for (let workerCount = 1; workerCount <= 4; workerCount += 1) {
    assert.deepEqual(
      validateWorkerFleet(configs.slice(0, workerCount), { workerCount })
        .map((config) => config.workerId),
      workerIdsForCount(workerCount),
    );
  }
  assert.equal(parseWorkerCount("1"), 1);
  assert.equal(parseWorkerCount("4"), 4);
  assert.throws(() => parseWorkerCount(0), /integer from 1 to 4/);
  assert.throws(() => parseWorkerCount(5), /integer from 1 to 4/);
  assert.throws(
    () => validateWorkerFleet([configs[0], configs[2]], { workerCount: 2 }),
    /missing: worker-2; unexpected: worker-3/,
  );

  assert.throws(
    () => parseWorkerConfig({
      ...fakeWorkerEnvironment("worker-1"),
      ANTHROPIC_API_KEY: "must-not-enter-fake-runtime",
    }),
    /must not receive production credentials/,
  );
  assert.throws(
    () => validateWorkerFleet([...configs.slice(0, 3), configs[0]]),
    /Duplicate worker ID/,
  );
  assert.throws(
    () => parseWorkerConfig({
      ...productionWorkerEnvironment("worker-1", 1, ""),
    }),
    /Missing required configuration/,
  );

  const productionConfigs = WORKER_IDS.map((workerId, index) => parseWorkerConfig(
    productionWorkerEnvironment(workerId, index + 1, "same-secret"),
  ));
  assert.throws(
    () => validateWorkerFleet(productionConfigs),
    (error) => {
      assert.match(error.message, /Duplicate Anthropic API key secret detected/);
      assert.doesNotMatch(error.message, /same-secret/);
      return true;
    },
  );

  const defaultedPaths = parseWorkerConfig({
    ...fakeWorkerEnvironment("worker-1"),
    INDIEMATH_CATALOG: undefined,
    INDIEMATH_PRICING_TABLE: undefined,
  });
  assert.equal(
    defaultedPaths.catalogPath,
    path.join(rootDir, "problems", "catalog.json"),
  );
  assert.equal(
    defaultedPaths.pricingTablePath,
    path.join(rootDir, "pricing", "anthropic.json"),
  );
  assert.equal(parseWorkerConfig({
    ...fakeWorkerEnvironment("worker-1"),
    INDIEMATH_RUNS_PAUSED_REASON: "anthropic-monthly-plan-limit",
  }).runsPausedReason, "anthropic-monthly-plan-limit");
  assert.throws(() => parseWorkerConfig({
    ...fakeWorkerEnvironment("worker-1"),
    INDIEMATH_RUNS_PAUSED_REASON: "unknown-pause",
  }), /must be one of anthropic-monthly-plan-limit/);
});

test("frontend derives its fixed public object URLs from one base URL", () => {
  const config = parseFrontendConfig({
    INDIEMATH_RUNTIME: "fake",
    PUBLIC_DATA_BASE_URL: "https://public.example.test/artifacts",
  });
  assert.equal(
    config.stateUrl,
    "https://public.example.test/artifacts/public/state.json",
  );
  assert.equal(
    config.ledgerUrl,
    "https://public.example.test/artifacts/public/ledger.json",
  );
  assert.throws(
    () => parseFrontendConfig({
      INDIEMATH_RUNTIME: "fake",
      PUBLIC_DATA_BASE_URL: "https://public.example.test/?version=1",
    }),
    /must not contain a query or fragment/,
  );
});

test("Ramp sync is optional but rejects partial or fake-runtime credentials", () => {
  const productionBase = {
    INDIEMATH_RUNTIME: "production",
    INDIEMATH_DB: "/var/lib/indiemath/ledger.sqlite",
    R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    R2_BUCKET: "indiemath-artifacts",
    R2_ACCESS_KEY_ID: "r2-access",
    R2_SECRET_ACCESS_KEY: "r2-secret",
    OPEN_COLLECTIVE_SLUG: "indiemath",
    OPEN_COLLECTIVE_GRAPHQL_URL: "https://api.opencollective.com/graphql/v2",
    OPEN_COLLECTIVE_API_TOKEN: "oc-token",
  };
  assert.equal(parseIntakePublisherConfig(productionBase).ramp, undefined);
  assert.equal(parseIntakePublisherConfig({
    ...productionBase,
    INDIEMATH_RUNS_PAUSED_REASON: "anthropic-monthly-plan-limit",
  }).runsPausedReason, "anthropic-monthly-plan-limit");
  assert.throws(() => parseIntakePublisherConfig({
    ...productionBase,
    RAMP_CLIENT_ID: "ramp-client",
  }), /Incomplete Ramp configuration; missing RAMP_CLIENT_SECRET, RAMP_CARD_ID/);
  assert.deepEqual(parseIntakePublisherConfig({
    ...productionBase,
    RAMP_CLIENT_ID: "ramp-client",
    RAMP_CLIENT_SECRET: "ramp-secret",
    RAMP_CARD_ID: "anthropic-card",
  }).ramp, {
    clientId: "ramp-client",
    clientSecret: "ramp-secret",
    cardId: "anthropic-card",
    baseUrl: "https://api.ramp.com/",
    syncIntervalSeconds: 300,
  });
  assert.throws(() => parseIntakePublisherConfig({
    INDIEMATH_RUNTIME: "fake",
    INDIEMATH_DB: "/tmp/indiemath.sqlite",
    R2_BUCKET: "fake",
    OPEN_COLLECTIVE_SLUG: "indiemath",
    RAMP_CLIENT_ID: "must-not-enter-fake-runtime",
  }), /Fake runtime must not receive production credentials: RAMP_CLIENT_ID/);
});

test("external-service fakes are deterministic and paginated", async () => {
  const r2 = new FakeR2();
  await r2.putObject("public/z.json", "z");
  await r2.putObject("public/a.json", "a");
  const firstObjects = await r2.listObjects({ prefix: "public/", limit: 1 });
  const secondObjects = await r2.listObjects({
    prefix: "public/",
    limit: 1,
    cursor: firstObjects.nextCursor,
  });
  assert.equal(firstObjects.objects[0].key, "public/a.json");
  assert.equal(secondObjects.objects[0].key, "public/z.json");

  const transactions = [
    fakeTransaction("transaction-2", "order-recurring", "2026-08-28T00:00:00.000Z"),
    fakeTransaction("transaction-1", "order-recurring", "2026-07-28T00:00:00.000Z"),
    {
      ...fakeTransaction("transaction-debit", "order-recurring", "2026-09-28T00:00:00.000Z"),
      type: "DEBIT",
    },
  ];
  const openCollective = new FakeOpenCollective({ transactions });
  const firstTransactions = await openCollective.listCreditTransactions({ limit: 1 });
  const secondTransactions = await openCollective.listCreditTransactions({
    limit: 1,
    cursor: firstTransactions.nextCursor,
  });
  assert.equal(firstTransactions.transactions[0].id, "transaction-1");
  assert.equal(secondTransactions.transactions[0].id, "transaction-2");
  assert.equal(firstTransactions.transactions[0].order.id, "order-recurring");
  assert.equal(secondTransactions.transactions[0].order.id, "order-recurring");
  assert.notEqual(
    firstTransactions.transactions[0].id,
    secondTransactions.transactions[0].id,
  );
  assert.equal(openCollective.listPaidOrders, undefined);
  assert.throws(
    () => openCollective.seedTransaction(transactions[0]),
    /Duplicate fake Open Collective transaction ID/,
  );

  const messages = new FakeAnthropicMessages();
  const request = { model: "claude-fake", messages: [{ role: "user", content: "test" }] };
  assert.equal((await messages.createMessage(request)).id, "msg_fake_0001");
  assert.equal((await messages.createMessage(request)).id, "msg_fake_0002");

  const admin = new FakeAnthropicAdmin({
    usage: [
      fakeUsage("key-2", "2026-07-28T00:00:00.000Z"),
      fakeUsage("key-1", "2026-07-28T00:00:00.000Z"),
    ],
  });
  const usage = await admin.listUsage({ apiKeyId: "key-1" });
  assert.deepEqual(usage.data.map((row) => row.apiKeyId), ["key-1"]);
});

test("every component starts and probes against fakes without production credentials", async () => {
  const application = await createFakeApplication();
  const results = await probeFakeApplication(application);
  assert.equal(results.length, 8);
  assert.deepEqual(
    application.components.workers.map((worker) => worker.workerId),
    WORKER_IDS,
  );
  assert.equal(
    application.components.intakePublisher
      .treasurySnapshot()
      .runsPausedPendingSettlement,
    true,
  );
  assert.ok(results.every((result) => result.ok));
});

test("the business terms remain reachable as a page and footer modal", async () => {
  const [indexHtml, ledgerHtml, termsHtml, termsCss, termsScript] = await Promise.all([
    readFile(path.join(rootDir, "index.html"), "utf8"),
    readFile(path.join(rootDir, "ledger.html"), "utf8"),
    readFile(path.join(rootDir, "terms.html"), "utf8"),
    readFile(path.join(rootDir, "assets", "terms.css"), "utf8"),
    readFile(path.join(rootDir, "assets", "terms.js"), "utf8"),
  ]);
  assert.match(indexHtml, /href="terms\.html" data-terms-link/);
  assert.match(indexHtml, /class="terms-dialog" id="terms-dialog"/);
  assert.match(indexHtml, /src="terms\.html\?embedded=1"/);
  assert.match(ledgerHtml, /href="terms\.html" data-terms-link/);
  assert.match(ledgerHtml, /class="terms-dialog" id="terms-dialog"/);
  assert.match(
    indexHtml,
    /href="https:\/\/github\.com\/neelsomani\/indiemath"[^>]+aria-label="View IndieMath on GitHub"/,
  );
  assert.match(termsCss, /body\.embedded \.back-link/);
  assert.match(termsScript, /URLSearchParams\(window\.location\.search\)/);
  for (const requiredSection of [
    "Business and service",
    "Refund policy and process",
    "Disputes and chargebacks",
    "Cancellation policy",
    "Project wind-down",
    "Customer service",
  ]) {
    assert.match(termsHtml, new RegExp(requiredSection));
  }
  assert.match(termsHtml, /contact@indiemath\.ai/);
  assert.match(
    termsHtml,
    /full net amount after Open Collective and Stripe processing fees/,
  );
  assert.match(termsHtml, /partial refunds are not offered/);
  assert.match(
    termsHtml,
    /Lipschitz Strategies LLC, the operator of and counterparty for the IndieMath service/,
  );
  assert.match(
    termsHtml,
    /processes contributions within 1&ndash;2 business days after receipt; for this policy, business days are Monday through Friday/,
  );
  assert.match(
    indexHtml,
    /processed within 1–2 business days after receipt \(Monday through Friday\)/,
  );
});

test("the repository workflow enforces the complete foundation suite", async () => {
  const workflow = await readFile(
    path.join(rootDir, ".github", "workflows", "catalog.yml"),
    "utf8",
  );
  const validateIndex = workflow.indexOf("- run: npm run validate");
  const checkIndex = workflow.indexOf("- run: npm run check");
  const testIndex = workflow.indexOf("- run: npm test");
  assert.ok(validateIndex >= 0, "workflow must validate the catalog");
  assert.ok(checkIndex > validateIndex, "workflow must run the foundation probe");
  assert.ok(testIndex > checkIndex, "workflow must run tests after the probe");
});

function fakeWorkerEnvironment(workerId) {
  return {
    INDIEMATH_RUNTIME: "fake",
    INDIEMATH_DB: "/tmp/indiemath-test/ledger.sqlite",
    INDIEMATH_CATALOG: "/tmp/indiemath-test/catalog.json",
    INDIEMATH_PRICING_TABLE: "/tmp/indiemath-test/pricing.json",
    R2_BUCKET: "indiemath-fake",
    WORKER_ID: workerId,
  };
}

function productionWorkerEnvironment(workerId, keyNumber, apiKey) {
  return {
    INDIEMATH_RUNTIME: "production",
    INDIEMATH_DB: "/var/lib/indiemath/ledger.sqlite",
    INDIEMATH_CATALOG: "/opt/indiemath/problems/catalog.json",
    INDIEMATH_PRICING_TABLE: "/opt/indiemath/pricing.json",
    R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
    R2_BUCKET: "indiemath",
    R2_ACCESS_KEY_ID: `r2-access-${keyNumber}`,
    R2_SECRET_ACCESS_KEY: `r2-secret-${keyNumber}`,
    WORKER_ID: workerId,
    ANTHROPIC_API_KEY: apiKey,
  };
}

function fakeTransaction(id, orderId, createdAt) {
  return {
    id,
    type: "CREDIT",
    kind: "CONTRIBUTION",
    createdAt,
    grossCents: 5000,
    feesCents: 250,
    netCents: 4750,
    order: {
      id: orderId,
      tier: { slug: "math-001-prove" },
    },
    account: { name: "Ada", isIncognito: false },
  };
}

function waterlineDonation(dedupId, creditedAt, refundedCents = 0) {
  return {
    dedupId,
    creditedAt,
    netCents: 4750,
    refundedCents,
  };
}

function fakeUsage(apiKeyId, bucketStart) {
  return {
    apiKeyId,
    bucketStart,
    model: "claude-fake",
    uncachedInputTokens: 10,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 5,
  };
}
