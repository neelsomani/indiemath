#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  LEDGER_SCHEMA_VERSION,
  openLedger,
} from "#indiemath/ledger";
import {
  readCatalog,
  validateCatalog,
} from "./catalog-lib.mjs";
import { syncCatalog } from "./catalog-ledger.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = validateCatalog(
  await readCatalog(path.join(rootDir, "problems", "catalog.json")),
);
const [firstProblem, secondProblem] = catalog.problems;
const workerScript = new URL("./ledger-concurrency-worker.mjs", import.meta.url);
const execFile = promisify(execFileCallback);

test("ledger schema extends catalog sync and creates both direction pools", async (context) => {
  const fixture = await createFixture(context);
  const health = await fixture.ledger.healthcheck();
  assert.equal(health.schemaVersion, LEDGER_SCHEMA_VERSION);
  assert.equal(health.catalogRevision, catalog.catalog_revision);

  const state = fixture.ledger.inspect();
  assert.equal(state.problems.length, catalog.problems.length);
  assert.equal(state.pools.length, catalog.problems.length * 2);
  assert.ok(state.pools.every((pool) => pool.balanceCents === 0));
  assert.ok(state.pools.every((pool) => pool.claimableBalanceCents === 0));
  fixture.ledger.assertConservation();
});

test("received donations are refundable until the shared waterline reaches them", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture.ledger, {
    dedupId: "transaction-refund",
    problemId: firstProblem.id,
    netCents: 10_000,
  });

  assertPool(fixture.ledger, firstProblem.id, "prove", {
    balanceCents: 10_000,
    claimableBalanceCents: 0,
  });
  const pending = fixture.ledger.beginRefund({
    donationDedupId: "transaction-refund",
    idempotencyReference: "refund-1",
  });
  assert.equal(pending.adjustment.amountCents, -10_000);
  assert.equal(
    fixture.ledger.beginRefund({
      donationDedupId: "transaction-refund",
      idempotencyReference: "refund-1",
    }).outcome,
    "duplicate",
  );
  assertPool(fixture.ledger, firstProblem.id, "prove", {
    balanceCents: 0,
    claimableBalanceCents: 0,
  });
  fixture.ledger.assertConservation();

  fixture.ledger.completeRefund({
    idempotencyReference: "refund-1",
    providerReference: "provider-refund-1",
  });
  const afterRefund = fixture.ledger.getDonation("transaction-refund");
  assert.equal(afterRefund.state, "refunded");
  assert.equal(afterRefund.refundedCents, 10_000);
  assert.equal(afterRefund.refundEligible, false);
  assert.throws(() => fixture.ledger.beginRefund({
    donationDedupId: "transaction-refund",
    idempotencyReference: "refund-too-late",
  }), /has no refundable balance/);

  assert.deepEqual(
    pick(fixture.ledger.treasuryStatus({
      settledContributionCents: 10_000,
    }), [
      "completedRefundCents",
      "pendingRefundCents",
      "fundingEventCents",
      "settledButUnfundedCents",
      "availableToFundCents",
    ]),
    {
      completedRefundCents: 10_000,
      pendingRefundCents: 0,
      fundingEventCents: 0,
      settledButUnfundedCents: 0,
      availableToFundCents: 0,
    },
  );
  fixture.ledger.assertConservation();
});

test("partial refunds are rejected and full refunds consume the exact pool boundary",
  async (context) => {
    const fixture = await createFixture(context);
    donate(fixture.ledger, {
      dedupId: "transaction-full-refund-boundary",
      problemId: firstProblem.id,
      netCents: 10_000,
    });
    assert.throws(() => fixture.ledger.beginRefund({
      donationDedupId: "transaction-full-refund-boundary",
      requestedAmountCents: 4_000,
      idempotencyReference: "refund-boundary-partial",
    }), /Only full refunds are supported/);
    const full = fixture.ledger.quoteRefund({
      donationDedupId: "transaction-full-refund-boundary",
    });
    assert.equal(full.refundableCents, 10_000);
    const final = fixture.ledger.beginRefund({
      donationDedupId: "transaction-full-refund-boundary",
      idempotencyReference: "refund-boundary-final",
    });
    assert.equal(final.adjustment.amountCents, -10_000);
    fixture.ledger.completeRefund({
      idempotencyReference: "refund-boundary-final",
      providerReference: "provider-boundary-final",
    });

    const donation = fixture.ledger.getDonation(
      "transaction-full-refund-boundary",
    );
    assert.equal(donation.state, "refunded");
    assert.equal(donation.refundedCents, 10_000);
    assert.equal(donation.refundEligible, false);
    assertPool(fixture.ledger, firstProblem.id, "prove", {
      balanceCents: 0,
      claimableBalanceCents: 0,
    });
    fixture.ledger.assertConservation();
  });

test("canceled refunds restore their exact destination without opening claimable funds", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture.ledger, {
    dedupId: "transaction-cancel",
    problemId: firstProblem.id,
    netCents: 5_000,
  });
  fixture.ledger.beginRefund({
    donationDedupId: "transaction-cancel",
    idempotencyReference: "refund-cancel",
  });
  fixture.ledger.cancelRefund({
    idempotencyReference: "refund-cancel",
    note: "Provider rejected the refund.",
  });
  assertPool(fixture.ledger, firstProblem.id, "prove", {
    balanceCents: 5_000,
    claimableBalanceCents: 0,
  });
  assert.equal(fixture.ledger.getDonation("transaction-cancel").refundedCents, 0);
  fixture.ledger.assertConservation();
});

test("one cent of treasury coverage closes the marginal donation's refund window", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture.ledger, {
    dedupId: "transaction-one-cent",
    problemId: firstProblem.id,
    netCents: 5_000,
  });
  fixture.ledger.treasuryFund({
    amountCents: 1,
    externalReference: "fund-one-cent",
    settledContributionCents: 5_000,
  });
  const donation = fixture.ledger.getDonation("transaction-one-cent");
  assert.equal(donation.processed, true);
  assert.equal(donation.refundEligible, false);
  assert.deepEqual(
    fixture.ledger.quoteRefund({
      donationDedupId: "transaction-one-cent",
    }),
    {
      donationDedupId: "transaction-one-cent",
      requestedAmountCents: undefined,
      completedRefundCents: 0,
      pendingRefundCents: 0,
      effectiveNetCents: 5_000,
      remainingDonationCents: 5_000,
      destinationBalanceCents: 5_000,
      processed: true,
      processingStatus: "processed",
      eligible: false,
      refundableCents: 0,
      reason: "donation-processed",
      message: "Donation transaction-one-cent is processed and no longer refundable.",
    },
  );
  assert.equal(
    pool(fixture.ledger, firstProblem.id, "prove").claimableBalanceCents,
    5_000,
  );
  assert.throws(
    () => fixture.ledger.beginRefund({
      donationDedupId: "transaction-one-cent",
      idempotencyReference: "refund-after-cent",
    }),
    (error) => error.code === "donation-processed"
      && /processed and no longer refundable/.test(error.message),
  );
  assert.throws(() => fixture.ledger.claim({
    problemId: firstProblem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
    fundingMode: "pool-only",
  }), /Spendable capacity 1 is below requested budget 5000/);
});

test("claims enforce capacity, exclusion, monotonic spend, and residue attribution", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture.ledger, {
    dedupId: "transaction-claim",
    problemId: firstProblem.id,
    netCents: 10_000,
  });
  fixture.ledger.treasuryFund({
    amountCents: 10_000,
    externalReference: "fund-claim",
    settledContributionCents: 10_000,
  });
  assert.equal(fixture.ledger.treasuryFund({
    amountCents: 10_000,
    externalReference: "fund-claim",
    settledContributionCents: 10_000,
  }).outcome, "duplicate");
  assert.throws(() => fixture.ledger.treasuryFund({
    amountCents: 9_999,
    externalReference: "fund-claim",
    settledContributionCents: 10_000,
  }), /different values/);

  const claim = fixture.ledger.claim({
    problemId: firstProblem.id,
    direction: "prove",
    runBudgetCents: 10_000,
    workerId: "worker-1",
    fundingMode: "pool-only",
  });
  assert.equal(claim.poolFundedCents, 10_000);
  assert.throws(() => fixture.ledger.claim({
    problemId: firstProblem.id,
    direction: "prove",
    runBudgetCents: 1,
    workerId: "worker-2",
  }), /already has an unsettled claim/);
  fixture.ledger.checkpointSpend({
    ...claim,
    newSpentCents: 3_000,
  });
  assert.throws(() => fixture.ledger.checkpointSpend({
    ...claim,
    newSpentCents: 2_999,
  }), /cannot move backward/);

  const settled = fixture.ledger.settle({
    ...claim,
    finalSpentCents: 2_000,
  });
  assert.equal(settled.claim.spentCents, 3_000);
  assert.deepEqual(settled.residue, {
    poolCents: 7_000,
    generalCents: 0,
  });
  assert.equal(fixture.ledger.treasuryStatus({
    settledContributionCents: 10_000,
  }).spendableCapacityCents, 7_000);
  assert.equal(fixture.ledger.settle({
    ...claim,
    finalSpentCents: 3_000,
  }).outcome, "replayed");

  const secondClaim = fixture.ledger.claim({
    problemId: firstProblem.id,
    direction: "prove",
    runBudgetCents: 7_000,
    workerId: "worker-1",
    fundingMode: "pool-only",
  });
  const secondSettlement = fixture.ledger.settle({
    ...secondClaim,
    finalSpentCents: 3_001,
  });
  assert.deepEqual(secondSettlement.residue, {
    poolCents: 3_999,
    generalCents: 0,
  });
  fixture.ledger.assertConservation();
});

test("unprocessed balances cannot be claimed using another pool's capacity", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture.ledger, {
    dedupId: "transaction-funded",
    problemId: firstProblem.id,
    netCents: 5_000,
  });
  donate(fixture.ledger, {
    dedupId: "transaction-received",
    problemId: secondProblem.id,
    netCents: 5_000,
  });
  fixture.ledger.treasuryFund({
    amountCents: 5_000,
    externalReference: "fund-first-only",
    settledContributionCents: 10_000,
  });
  assert.equal(
    pool(fixture.ledger, secondProblem.id, "prove").claimableBalanceCents,
    0,
  );
  assert.throws(() => fixture.ledger.claim({
    problemId: secondProblem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
    fundingMode: "pool-only",
  }), /Claimable pool balance 0/);
  assert.equal(
    fixture.ledger.getDonation("transaction-received").refundEligible,
    true,
  );
});

test("claims default to pool-only and require an explicit general-credit mode", async (context) => {
  const fixture = await createFixture(context);
  fixture.ledger.donate({
    dedupId: "transaction-general-default",
    orderId: "order-general-default",
    destination: { kind: "general" },
    grossCents: 5_000,
    feesCents: 0,
    netCents: 5_000,
    donorTag: "Grace",
    creditedAt: "2026-07-28T01:00:00.000Z",
  });
  fixture.ledger.treasuryFund({
    amountCents: 5_000,
    externalReference: "fund-general-default",
    settledContributionCents: 5_000,
  });

  assert.throws(() => fixture.ledger.claim({
    problemId: firstProblem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
  }), /Claimable pool balance 0/);

  const claim = fixture.ledger.claim({
    problemId: firstProblem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
    fundingMode: "general-only",
  });
  assert.equal(claim.poolFundedCents, 0);
  fixture.ledger.assertConservation();
});

test("resolve, competing solutions, conditional review, and unconditional sweep preserve money", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture.ledger, {
    dedupId: "transaction-prove",
    problemId: firstProblem.id,
    direction: "prove",
    netCents: 10_000,
  });
  donate(fixture.ledger, {
    dedupId: "transaction-disprove",
    problemId: firstProblem.id,
    direction: "disprove",
    netCents: 10_000,
  });
  fixture.ledger.treasuryFund({
    amountCents: 20_000,
    externalReference: "fund-review",
    settledContributionCents: 20_000,
  });
  const proveClaim = fixture.ledger.claim({
    problemId: firstProblem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
    fundingMode: "pool-only",
  });
  const disproveClaim = fixture.ledger.claim({
    problemId: firstProblem.id,
    direction: "disprove",
    runBudgetCents: 5_000,
    workerId: "worker-2",
    fundingMode: "pool-only",
  });
  fixture.ledger.resolve({
    ...proveClaim,
    finalSpentCents: 1_000,
    solutionUri: "r2://solutions/prove-1.md",
  });
  assert.equal(fixture.ledger.resolve({
    ...proveClaim,
    finalSpentCents: 1_000,
    solutionUri: "r2://solutions/prove-1.md",
  }).outcome, "replayed");
  assert.throws(() => fixture.ledger.review({
    problemId: firstProblem.id,
    verdict: "unconditional",
    noteUri: "r2://reviews/too-early.md",
  }), /must settle before review/);
  fixture.ledger.settle({
    ...disproveClaim,
    finalSpentCents: 1_000,
    solutionUri: "r2://solutions/disprove-1.md",
  });
  assert.equal(problem(fixture.ledger, firstProblem.id).status, "PendingReview");
  assert.throws(() => fixture.ledger.review({
    problemId: firstProblem.id,
    verdict: "conditional",
    noteUri: "r2://reviews/conditional.md",
    assumptionLabel: "P != NP",
  }), /approveDirection is required/);

  const beforeConditional = balances(fixture.ledger);
  const conditional = fixture.ledger.review({
    problemId: firstProblem.id,
    verdict: "conditional",
    noteUri: "r2://reviews/conditional.md",
    assumptionLabel: "P != NP",
    approveDirection: "prove",
  });
  assert.equal(conditional.problemStatus, "Open");
  assert.deepEqual(balances(fixture.ledger), beforeConditional);
  assert.deepEqual(
    conditional.results.map((result) => result.outcome).sort(),
    ["conditional", "rejected"],
  );
  assert.equal(fixture.ledger.review({
    problemId: firstProblem.id,
    verdict: "conditional",
    noteUri: "r2://reviews/conditional.md",
    assumptionLabel: "P != NP",
    approveDirection: "prove",
  }).outcome, "replayed");
  assert.throws(() => fixture.ledger.review({
    problemId: firstProblem.id,
    verdict: "conditional",
    noteUri: "r2://reviews/conditional.md",
    assumptionLabel: "ETH",
    approveDirection: "prove",
  }), /different disposition/);
  assert.equal(fixture.ledger.settle({
    ...proveClaim,
    finalSpentCents: 1_000,
    solutionUri: "r2://solutions/prove-1.md",
  }).outcome, "replayed");
  assert.equal(problem(fixture.ledger, firstProblem.id).status, "Open");

  const finalClaim = fixture.ledger.claim({
    problemId: firstProblem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
    fundingMode: "pool-only",
  });
  fixture.ledger.resolve({
    ...finalClaim,
    finalSpentCents: 2_000,
    solutionUri: "r2://solutions/prove-final.md",
  });
  fixture.ledger.review({
    problemId: firstProblem.id,
    verdict: "unconditional",
    noteUri: "r2://reviews/unconditional.md",
  });
  assert.equal(problem(fixture.ledger, firstProblem.id).status, "Solved");
  const swept = fixture.ledger.sweep({ problemId: firstProblem.id });
  assert.ok(swept.sweptCents > 0);
  assert.equal(
    fixture.ledger.sweep({ problemId: firstProblem.id }).outcome,
    "unchanged",
  );

  const solvedDonation = {
    dedupId: "transaction-solved-route",
    orderId: "order-solved-route",
    destination: {
      kind: "pool",
      problemId: firstProblem.id,
      direction: "prove",
    },
    grossCents: 5_000,
    feesCents: 0,
    netCents: 5_000,
    donorTag: "Emmy",
    creditedAt: "2026-07-29T00:00:00.000Z",
  };
  const routed = fixture.ledger.donate(solvedDonation).donation;
  assert.deepEqual(routed.destination, { kind: "general" });
  assert.deepEqual(routed.intendedDestination, solvedDonation.destination);
  assert.equal(fixture.ledger.donate(solvedDonation).outcome, "duplicate");
  assert.throws(() => fixture.ledger.donate({
    ...solvedDonation,
    destination: {
      ...solvedDonation.destination,
      direction: "disprove",
    },
  }), /changed destination/);
  fixture.ledger.assertConservation();
});

test("the request-headroom residue boundary preserves source attribution exactly",
  async (context) => {
    for (const [suffix, residueCents, expected] of [
      ["floor", 1_601, { poolCents: 1_601, generalCents: 0 }],
      ["dust", 1_600, { poolCents: 0, generalCents: 1_600 }],
    ]) {
      const fixture = await createFixture(context);
      donate(fixture.ledger, {
        dedupId: `transaction-residue-${suffix}`,
        problemId: firstProblem.id,
        netCents: 10_000,
      });
      fixture.ledger.treasuryFund({
        amountCents: 10_000,
        externalReference: `fund-residue-${suffix}`,
        settledContributionCents: 10_000,
      });
      const claim = fixture.ledger.claim({
        problemId: firstProblem.id,
        direction: "prove",
        runBudgetCents: 10_000,
        workerId: "worker-1",
        fundingMode: "pool-only",
      });
      const settlement = fixture.ledger.settle({
        ...claim,
        finalSpentCents: 10_000 - residueCents,
      });
      assert.deepEqual(settlement.residue, expected);
      fixture.ledger.assertConservation();
    }
  });

test("chargeback shortfalls become visible debt without consuming received refunds", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture.ledger, {
    dedupId: "transaction-spent",
    problemId: firstProblem.id,
    netCents: 10_000,
  });
  fixture.ledger.treasuryFund({
    amountCents: 10_000,
    externalReference: "fund-spent",
    settledContributionCents: 15_000,
  });
  const claim = fixture.ledger.claim({
    problemId: firstProblem.id,
    direction: "prove",
    runBudgetCents: 10_000,
    workerId: "worker-1",
    fundingMode: "pool-only",
  });
  fixture.ledger.settle({ ...claim, finalSpentCents: 10_000 });

  donate(fixture.ledger, {
    dedupId: "transaction-still-received",
    problemId: firstProblem.id,
    netCents: 5_000,
  });
  fixture.ledger.dispute({
    donationDedupId: "transaction-spent",
    externalReference: "chargeback-1",
    amountCents: 10_000,
    note: "Lost card dispute.",
  });
  const state = fixture.ledger.inspect();
  assert.equal(state.generalDebtCents, 10_000);
  assertPool(fixture.ledger, firstProblem.id, "prove", {
    balanceCents: 5_000,
    claimableBalanceCents: 0,
  });
  assert.equal(
    fixture.ledger.getDonation("transaction-still-received").refundEligible,
    true,
  );
  fixture.ledger.beginRefund({
    donationDedupId: "transaction-still-received",
    requestedAmountCents: 5_000,
    idempotencyReference: "refund-protected",
  });
  fixture.ledger.completeRefund({
    idempotencyReference: "refund-protected",
    providerReference: "provider-protected",
  });
  fixture.ledger.assertConservation();
});

test("a pre-processing dispute leaves no phantom donation in the waterline", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture.ledger, {
    dedupId: "transaction-disputed-before-processing",
    problemId: firstProblem.id,
    netCents: 5_000,
  });
  donate(fixture.ledger, {
    dedupId: "transaction-valid-after-dispute",
    problemId: firstProblem.id,
    netCents: 5_000,
  });
  fixture.ledger.dispute({
    donationDedupId: "transaction-disputed-before-processing",
    externalReference: "chargeback-before-processing",
    amountCents: 5_000,
    note: "Charge reversed before treasury staging.",
  });
  fixture.ledger.treasuryFund({
    amountCents: 5_000,
    externalReference: "fund-after-early-dispute",
    settledContributionCents: 5_000,
  });

  const reversed = fixture.ledger.getDonation(
    "transaction-disputed-before-processing",
  );
  assert.equal(reversed.state, "reversed");
  assert.equal(reversed.waterlineExcludedCents, 5_000);
  const valid = fixture.ledger.getDonation("transaction-valid-after-dispute");
  assert.equal(valid.processed, true);
  assert.equal(valid.refundEligible, false);
  assertPool(fixture.ledger, firstProblem.id, "prove", {
    balanceCents: 5_000,
    claimableBalanceCents: 5_000,
  });
  fixture.ledger.assertConservation();
});

test("an unprocessed partial dispute cannot make its remainder claimable early", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture.ledger, {
    dedupId: "transaction-partial-dispute-before-processing",
    problemId: firstProblem.id,
    netCents: 5_000,
  });
  fixture.ledger.dispute({
    donationDedupId: "transaction-partial-dispute-before-processing",
    externalReference: "partial-chargeback-before-processing",
    amountCents: 1_000,
    note: "Partial charge reversal before treasury staging.",
  });
  assertPool(fixture.ledger, firstProblem.id, "prove", {
    balanceCents: 4_000,
    claimableBalanceCents: 0,
  });

  fixture.ledger.treasuryFund({
    amountCents: 1,
    externalReference: "fund-partial-dispute-one-cent",
    settledContributionCents: 4_000,
  });
  assertPool(fixture.ledger, firstProblem.id, "prove", {
    balanceCents: 4_000,
    claimableBalanceCents: 4_000,
  });
  assert.throws(() => fixture.ledger.claim({
    problemId: firstProblem.id,
    direction: "prove",
    runBudgetCents: 4_000,
    workerId: "worker-1",
    fundingMode: "pool-only",
  }), /Spendable capacity 1/);
  fixture.ledger.assertConservation();
});

test("adjustment replays are exact or rejected without changing balances", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture.ledger, {
    dedupId: "transaction-adjustment-replays",
    problemId: firstProblem.id,
    netCents: 5_000,
  });

  fixture.ledger.beginRefund({
    donationDedupId: "transaction-adjustment-replays",
    idempotencyReference: "refund-cancel-replay",
  });
  assert.equal(fixture.ledger.beginRefund({
    donationDedupId: "transaction-adjustment-replays",
    idempotencyReference: "refund-cancel-replay",
  }).outcome, "duplicate");
  assert.throws(() => fixture.ledger.beginRefund({
    donationDedupId: "transaction-adjustment-replays",
    requestedAmountCents: 1_999,
    idempotencyReference: "refund-cancel-replay",
  }), /another operation/);
  fixture.ledger.cancelRefund({
    idempotencyReference: "refund-cancel-replay",
    note: "Provider declined.",
  });
  assert.equal(fixture.ledger.cancelRefund({
    idempotencyReference: "refund-cancel-replay",
    note: "Provider declined.",
  }).outcome, "duplicate");
  assert.throws(() => fixture.ledger.cancelRefund({
    idempotencyReference: "refund-cancel-replay",
    note: "Different note.",
  }), /different note/);

  fixture.ledger.beginRefund({
    donationDedupId: "transaction-adjustment-replays",
    idempotencyReference: "refund-complete-replay",
  });
  fixture.ledger.completeRefund({
    idempotencyReference: "refund-complete-replay",
    providerReference: "provider-refund-replay",
  });
  assert.equal(fixture.ledger.completeRefund({
    idempotencyReference: "refund-complete-replay",
    providerReference: "provider-refund-replay",
  }).outcome, "duplicate");
  assert.throws(() => fixture.ledger.completeRefund({
    idempotencyReference: "refund-complete-replay",
    providerReference: "different-provider-refund",
  }), /another provider reference/);

  donate(fixture.ledger, {
    dedupId: "transaction-dispute-replays",
    problemId: firstProblem.id,
    netCents: 5_000,
  });
  fixture.ledger.dispute({
    donationDedupId: "transaction-dispute-replays",
    externalReference: "dispute-replay",
    amountCents: 1_000,
    note: "Partial chargeback.",
  });
  assert.equal(fixture.ledger.dispute({
    donationDedupId: "transaction-dispute-replays",
    externalReference: "dispute-replay",
    amountCents: 1_000,
    note: "Partial chargeback.",
  }).outcome, "duplicate");
  assert.throws(() => fixture.ledger.dispute({
    donationDedupId: "transaction-dispute-replays",
    externalReference: "dispute-replay",
    amountCents: 999,
    note: "Partial chargeback.",
  }), /another operation/);

  fixture.ledger.reconcileGeneralCredit({
    amountCents: 500,
    externalReference: "reconciliation-replay",
    note: "Bank reconciliation.",
  });
  assert.equal(fixture.ledger.reconcileGeneralCredit({
    amountCents: 500,
    externalReference: "reconciliation-replay",
    note: "Bank reconciliation.",
  }).outcome, "duplicate");
  assert.throws(() => fixture.ledger.reconcileGeneralCredit({
    amountCents: 500,
    externalReference: "reconciliation-replay",
    note: "Changed note.",
  }), /different values/);
  fixture.ledger.assertConservation();
});

test("varied operation sequences conserve money after every transition", async (context) => {
  for (let seed = 1; seed <= 16; seed += 1) {
    const random = seededRandom(seed);
    const fixture = await createFixture(context);
    const firstNet = 5_000 + Math.floor(random() * 5_001);
    const secondNet = 5_000 + Math.floor(random() * 5_001);

    donate(fixture.ledger, {
      dedupId: `property-${seed}-first`,
      problemId: firstProblem.id,
      netCents: firstNet,
    });
    fixture.ledger.assertConservation();
    fixture.ledger.beginRefund({
      donationDedupId: `property-${seed}-first`,
      idempotencyReference: `property-${seed}-refund`,
    });
    fixture.ledger.assertConservation();

    let completedRefundCents = 0;
    if (seed % 2 === 0) {
      completedRefundCents = firstNet;
      fixture.ledger.completeRefund({
        idempotencyReference: `property-${seed}-refund`,
        providerReference: `property-${seed}-provider-refund`,
      });
    } else {
      fixture.ledger.cancelRefund({
        idempotencyReference: `property-${seed}-refund`,
        note: "Deterministic property-sequence cancellation.",
      });
    }
    fixture.ledger.assertConservation();

    donate(fixture.ledger, {
      dedupId: `property-${seed}-second`,
      problemId: firstProblem.id,
      netCents: secondNet,
    });
    fixture.ledger.assertConservation();

    const settledContributionCents = firstNet + secondNet;
    const fundableCents = settledContributionCents - completedRefundCents;
    fixture.ledger.treasuryFund({
      amountCents: fundableCents,
      externalReference: `property-${seed}-fund`,
      settledContributionCents,
    });
    fixture.ledger.assertConservation();

    const runBudgetCents = Math.min(50_000, fundableCents);
    const claim = fixture.ledger.claim({
      problemId: firstProblem.id,
      direction: "prove",
      runBudgetCents,
      workerId: "worker-1",
      fundingMode: "pool-only",
    });
    fixture.ledger.assertConservation();
    const finalSpentCents = Math.floor(random() * (runBudgetCents + 1));
    fixture.ledger.checkpointSpend({
      ...claim,
      newSpentCents: Math.floor(finalSpentCents / 2),
    });
    fixture.ledger.assertConservation();
    fixture.ledger.settle({
      ...claim,
      finalSpentCents,
    });
    fixture.ledger.assertConservation();

    const outstandingSecond = secondNet;
    const disputeCents = 1 + Math.floor(random() * outstandingSecond);
    fixture.ledger.dispute({
      donationDedupId: `property-${seed}-second`,
      externalReference: `property-${seed}-dispute`,
      amountCents: disputeCents,
      note: "Deterministic property-sequence dispute.",
    });
    fixture.ledger.assertConservation();

    const reconciliationCents = 1 + Math.floor(random() * 2_000);
    fixture.ledger.reconcileGeneralCredit({
      amountCents: seed % 3 === 0
        ? -reconciliationCents
        : reconciliationCents,
      externalReference: `property-${seed}-reconciliation`,
      note: "Deterministic property-sequence reconciliation.",
    });
    fixture.ledger.assertConservation();
  }
});

test("cumulative Anthropic spend reconciliation applies only the incremental correction",
  async (context) => {
    const fixture = await createFixture(context);
    donate(fixture.ledger, {
      dedupId: "transaction-anthropic-spend",
      problemId: firstProblem.id,
      netCents: 10_000,
    });
    fixture.ledger.treasuryFund({
      amountCents: 10_000,
      externalReference: "fund-anthropic-spend",
      settledContributionCents: 10_000,
    });

    const firstClaim = fixture.ledger.claim({
      problemId: firstProblem.id,
      direction: "prove",
      runBudgetCents: 1_000,
      workerId: "worker-1",
      fundingMode: "pool-only",
    });
    checkpointResponse(fixture.ledger, firstClaim, {
      messageId: "msg-anthropic-spend-1",
      requestStartedAt: "2026-07-27T20:00:00.000Z",
      costCents: 1_000,
    });
    fixture.ledger.settle({
      ...firstClaim,
      finalSpentCents: 1_000,
    });

    const first = fixture.ledger.reconcileAnthropicSpend({
      cutoffAt: "2026-07-27T20:30:00.000Z",
      actualSpendCents: 900,
      externalReference: "anthropic-statement-1",
      note: "Cumulative provider statement 1.",
    });
    assert.equal(first.outcome, "completed");
    assert.deepEqual(
      pick(first.reconciliation, [
        "ledgerAppliedSpendCents",
        "actualSpendCents",
        "targetCorrectionCents",
        "appliedCorrectionCents",
      ]),
      {
        ledgerAppliedSpendCents: 1_000,
        actualSpendCents: 900,
        targetCorrectionCents: 100,
        appliedCorrectionCents: 100,
      },
    );
    assert.equal(first.adjustment.amountCents, 100);
    assert.equal(fixture.ledger.inspect().generalCreditCents, 100);
    assert.equal(fixture.ledger.inspect().spendableCapacityCents, 9_100);
    assert.equal(fixture.ledger.reconcileAnthropicSpend({
      cutoffAt: "2026-07-27T20:30:00.000Z",
      actualSpendCents: 900,
      externalReference: "anthropic-statement-1",
      note: "Cumulative provider statement 1.",
    }).outcome, "duplicate");

    const secondClaim = fixture.ledger.claim({
      problemId: firstProblem.id,
      direction: "prove",
      runBudgetCents: 1_000,
      workerId: "worker-2",
      fundingMode: "pool-only",
    });
    checkpointResponse(fixture.ledger, secondClaim, {
      messageId: "msg-anthropic-spend-2",
      requestStartedAt: "2026-07-27T21:00:00.000Z",
      costCents: 1_000,
    });
    fixture.ledger.settle({
      ...secondClaim,
      finalSpentCents: 1_000,
    });

    const second = fixture.ledger.reconcileAnthropicSpend({
      cutoffAt: "2026-07-27T21:30:00.000Z",
      actualSpendCents: 1_950,
      externalReference: "anthropic-statement-2",
      note: "Cumulative provider statement 2.",
    });
    assert.deepEqual(
      pick(second.reconciliation, [
        "ledgerAppliedSpendCents",
        "actualSpendCents",
        "targetCorrectionCents",
        "appliedCorrectionCents",
      ]),
      {
        ledgerAppliedSpendCents: 2_000,
        actualSpendCents: 1_950,
        targetCorrectionCents: 50,
        appliedCorrectionCents: -50,
      },
    );
    assert.equal(second.adjustment.amountCents, -50);
    assert.equal(fixture.ledger.inspect().generalCreditCents, 50);
    assert.equal(fixture.ledger.inspect().spendableCapacityCents, 8_050);

    const unchanged = fixture.ledger.reconcileAnthropicSpend({
      cutoffAt: "2026-07-27T22:00:00.000Z",
      actualSpendCents: 1_950,
      externalReference: "anthropic-statement-3",
      note: "No new provider usage.",
    });
    assert.equal(unchanged.reconciliation.appliedCorrectionCents, 0);
    assert.equal(unchanged.adjustment, undefined);
    assert.throws(() => fixture.ledger.reconcileAnthropicSpend({
      cutoffAt: "2026-07-27T22:30:00.000Z",
      actualSpendCents: 1_949,
      externalReference: "anthropic-statement-regression",
      note: "Invalid cumulative amount.",
    }), /cannot move backward/);
    assert.throws(() => fixture.ledger.reconcileAnthropicSpend({
      cutoffAt: "2026-07-27T22:00:00.000Z",
      actualSpendCents: 1_950,
      externalReference: "anthropic-statement-cutoff-conflict",
      note: "Conflicting source.",
    }), /already belongs to/);

    const state = fixture.ledger.inspect();
    assert.equal(state.anthropicSpendReconciliations.length, 3);
    assert.equal(state.adjustments.filter(
      (adjustment) => adjustment.reasonCode === "reconciliation",
    ).length, 2);
    assert.equal(fixture.ledger.accountingSnapshot().approximateRunSpendCents, 2_000);
    fixture.ledger.assertConservation();
  });

test("Ramp spend snapshots are cumulative, replay-safe observations",
  async (context) => {
    const fixture = await createFixture(context);
    const cardFingerprint = "a".repeat(64);
    const firstHash = "b".repeat(64);
    const secondHash = "c".repeat(64);

    const first = fixture.ledger.recordRampSpendSnapshot({
      cardFingerprint,
      cutoffAt: "2026-07-27T20:00:00.000Z",
      actualSpendCents: 12_345,
      sourceTransactionCount: 2,
      sourceHash: firstHash,
    });
    assert.equal(first.outcome, "recorded");
    assert.equal(fixture.ledger.recordRampSpendSnapshot({
      cardFingerprint,
      cutoffAt: "2026-07-27T20:30:00.000Z",
      actualSpendCents: 12_345,
      sourceTransactionCount: 2,
      sourceHash: firstHash,
    }).outcome, "duplicate");
    const second = fixture.ledger.recordRampSpendSnapshot({
      cardFingerprint,
      cutoffAt: "2026-07-27T21:00:00.000Z",
      actualSpendCents: 15_000,
      sourceTransactionCount: 3,
      sourceHash: secondHash,
    });
    assert.equal(second.outcome, "recorded");
    assert.deepEqual(
      fixture.ledger.latestRampSpendSnapshot(),
      second.snapshot,
    );
    assert.throws(() => fixture.ledger.recordRampSpendSnapshot({
      cardFingerprint,
      cutoffAt: "2026-07-27T20:59:59.000Z",
      actualSpendCents: 15_000,
      sourceTransactionCount: 3,
      sourceHash: "d".repeat(64),
    }), /cannot move backward/);
    assert.throws(() => fixture.ledger.recordRampSpendSnapshot({
      cardFingerprint: "e".repeat(64),
      cutoffAt: "2026-07-27T21:30:00.000Z",
      actualSpendCents: 15_000,
      sourceTransactionCount: 3,
      sourceHash: "f".repeat(64),
    }), /fingerprint changed/);
    assert.equal(fixture.ledger.inspect().rampSpendSnapshots.length, 2);
    fixture.ledger.assertConservation();
  });

test("concurrent claims serialize through the partial unique index", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture.ledger, {
    dedupId: "transaction-concurrent-claim",
    problemId: firstProblem.id,
    netCents: 10_000,
  });
  fixture.ledger.treasuryFund({
    amountCents: 10_000,
    externalReference: "fund-concurrent-claim",
    settledContributionCents: 10_000,
  });
  fixture.ledger.close();
  fixture.closed = true;

  const results = await runConcurrent([
    {
      databasePath: fixture.databasePath,
      operation: "claim",
      arguments: {
        problemId: firstProblem.id,
        direction: "prove",
        runBudgetCents: 5_000,
        workerId: "worker-1",
        fundingMode: "pool-only",
      },
    },
    {
      databasePath: fixture.databasePath,
      operation: "claim",
      arguments: {
        problemId: firstProblem.id,
        direction: "prove",
        runBudgetCents: 5_000,
        workerId: "worker-2",
        fundingMode: "pool-only",
      },
    },
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(
    results.filter((result) => !result.ok).map((result) => result.error.code),
    ["pair-already-claimed"],
  );

  fixture.ledger = await openLedger({ databasePath: fixture.databasePath });
  fixture.closed = false;
  assert.equal(fixture.ledger.listUnsettledClaims().length, 1);
  fixture.ledger.assertConservation();
});

test("concurrent refund and treasury commands have exactly one winner", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture.ledger, {
    dedupId: "transaction-refund-fund-race",
    problemId: firstProblem.id,
    netCents: 5_000,
  });
  fixture.ledger.close();
  fixture.closed = true;

  const results = await runConcurrent([
    {
      databasePath: fixture.databasePath,
      operation: "beginRefund",
      arguments: {
        donationDedupId: "transaction-refund-fund-race",
        requestedAmountCents: 5_000,
        idempotencyReference: "refund-race",
      },
    },
    {
      databasePath: fixture.databasePath,
      operation: "treasuryFund",
      arguments: {
        amountCents: 5_000,
        externalReference: "fund-race",
        settledContributionCents: 5_000,
      },
    },
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);
  assert.ok([
    "insufficient-settled-funds",
    "donation-processed",
  ].includes(results.find((result) => !result.ok).error.code));
  assert.match(
    results.find((result) => !result.ok).error.message,
    /available-to-fund|processed and no longer refundable/,
  );

  fixture.ledger = await openLedger({ databasePath: fixture.databasePath });
  fixture.closed = false;
  fixture.ledger.assertConservation();
});

test("replication assets define the R2 replica and its restore drill", async () => {
  const [
    r2Config,
    replicationScript,
    restoreScript,
    setupWrapper,
    setupImplementation,
  ] = await Promise.all([
    readFile(path.join(rootDir, "ops", "litestream-r2.yml"), "utf8"),
    readFile(path.join(rootDir, "scripts", "replicate-ledger.sh"), "utf8"),
    readFile(path.join(rootDir, "scripts", "restore-ledger.sh"), "utf8"),
    readFile(path.join(rootDir, "setup-litestream.sh"), "utf8"),
    readFile(path.join(rootDir, "scripts", "setup-litestream.mjs"), "utf8"),
  ]);
  assert.match(r2Config, /meta-path:.*\/r2/);
  assert.match(r2Config, /R2_REPLICA_BUCKET/);
  assert.match(r2Config, /r2\.cloudflarestorage\.com|R2_ENDPOINT/);
  assert.match(replicationScript, /litestream-r2\.yml/);
  assert.doesNotMatch(replicationScript, /SECONDARY_|secondary-/);
  assert.match(restoreScript, /restore_arguments=\(/);
  assert.match(restoreScript, /integrity-check full/);
  assert.match(restoreScript, /verify-ledger-restore\.mjs/);
  assert.doesNotMatch(restoreScript, /secondary|SECONDARY_/);
  assert.match(setupWrapper, /--env-file-if-exists=/);
  assert.match(setupImplementation, /\/etc\/indiemath\/litestream\.env/);
  assert.match(setupImplementation, /atomicWrite\(environmentPath, environmentBody, 0o600\)/);
  assert.match(setupImplementation, /\["enable", "indiemath-litestream\.service"\]/);
  assert.match(setupImplementation, /\["restart", "indiemath-litestream\.service"\]/);
  assert.doesNotMatch(setupImplementation, /process\.env\.SUDO_USER/);
});

test("the restore verifier accepts an exact closed-ledger copy", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture.ledger, {
    dedupId: "transaction-restore-verifier",
    problemId: firstProblem.id,
    netCents: 5_000,
  });
  fixture.ledger.assertConservation();
  fixture.ledger.close();
  fixture.closed = true;

  const { stdout } = await execFile(process.execPath, [
    path.join(rootDir, "scripts", "verify-ledger-restore.mjs"),
    fixture.databasePath,
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.schemaVersion, LEDGER_SCHEMA_VERSION);
  assert.equal(result.conservation.balanced, true);
});

async function createFixture(context) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "indiemath-ledger-test-"));
  const databasePath = path.join(scratch, "ledger.sqlite");
  await syncCatalog({ catalog, databasePath });
  const fixture = {
    scratch,
    databasePath,
    closed: false,
    now: Date.parse("2026-07-28T00:00:00.000Z"),
  };
  fixture.ledger = await openLedger({
    databasePath,
    clock: () => new Date(fixture.now),
  });
  context.after(async () => {
    if (!fixture.closed) fixture.ledger.close();
    await rm(scratch, { recursive: true, force: true });
  });
  return fixture;
}

function donate(ledger, {
  dedupId,
  problemId,
  direction = "prove",
  netCents,
}) {
  return ledger.donate({
    dedupId,
    orderId: `order-${dedupId}`,
    destination: { kind: "pool", problemId, direction },
    grossCents: netCents,
    feesCents: 0,
    netCents,
    donorTag: "Ada",
    creditedAt: new Date(
      Date.parse("2026-07-28T00:00:00.000Z")
      + donationSequence++ * 60_000,
    ).toISOString(),
  });
}

let donationSequence = 0;

function checkpointResponse(ledger, claim, {
  messageId,
  requestStartedAt,
  costCents,
}) {
  return ledger.checkpointResponse({
    ...claim,
    request: {
      model: "claude-fable-5",
      messages: [{ role: "user", content: "Private request payload." }],
    },
    response: {
      id: messageId,
      model: "claude-fable-5",
      content: [{ type: "text", text: "Private response payload." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    requestId: `request-${messageId}`,
    requestStartedAt,
    costCents,
  });
}

function pool(ledger, problemId, direction) {
  return ledger.inspect().pools.find((candidate) => (
    candidate.problemId === problemId && candidate.direction === direction
  ));
}

function problem(ledger, problemId) {
  return ledger.inspect().problems.find(
    (candidate) => candidate.problemId === problemId,
  );
}

function assertPool(ledger, problemId, direction, expected) {
  assert.deepEqual(
    pick(pool(ledger, problemId, direction), Object.keys(expected)),
    expected,
  );
}

function balances(ledger) {
  const state = ledger.inspect();
  return {
    pools: state.pools.map((item) => ({
      problemId: item.problemId,
      direction: item.direction,
      balanceCents: item.balanceCents,
    })),
    generalCreditCents: state.generalCreditCents,
    generalDebtCents: state.generalDebtCents,
  };
}

async function runConcurrent(operations) {
  const workers = operations.map((operation) => new Worker(workerScript, {
    workerData: {
      ...operation,
      now: "2026-07-28T00:00:00.000Z",
    },
  }));
  const ready = workers.map((worker) => waitForMessage(
    worker,
    (message) => message.type === "ready",
  ));
  await Promise.all(ready);
  const exits = workers.map(waitForExit);
  const results = workers.map((worker) => waitForMessage(
    worker,
    (message) => message.type === "result",
  ));
  for (const worker of workers) worker.postMessage("go");
  const messages = await Promise.all(results);
  await Promise.all(exits);
  return messages;
}

function waitForExit(worker) {
  return new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Ledger worker exited with code ${code}.`));
      }
    });
  });
}

function waitForMessage(worker, predicate) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code) => {
      if (code === 0) return;
      cleanup();
      reject(new Error(`Ledger worker exited with code ${code}.`));
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
