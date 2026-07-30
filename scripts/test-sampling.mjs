#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FakeAnthropicMessages,
  FakeR2,
} from "#indiemath/fakes";
import { loadAnthropicPricingTable } from "#indiemath/anthropic";
import { openLedger } from "#indiemath/ledger";
import {
  DEFAULT_RUN_BUDGET_CENTS,
  MINIMUM_RUN_BUDGET_CENTS,
} from "#indiemath/shared";
import {
  createWorkerRuntime,
  runSamplingCycle,
  runWorkerLoop,
  secureDraw,
  selectSamplingDecision,
} from "#indiemath/workers";
import {
  readCatalog,
  validateCatalog,
} from "./catalog-lib.mjs";
import { syncCatalog } from "./catalog-ledger.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = validateCatalog(
  await readCatalog(path.join(rootDir, "problems", "catalog.json")),
);
const pricingTable = await loadAnthropicPricingTable(
  path.join(rootDir, "pricing", "anthropic.json"),
);
const [problemA, problemB] = catalog.problems;
const noDelayRetry = Object.freeze({
  maxAttempts: 1,
  sleep: async () => {},
});
let fixtureSequence = 0;

test("the sampling floor tracks request headroom and the default reservation is $50",
  () => {
    assert.equal(
      MINIMUM_RUN_BUDGET_CENTS,
      pricingTable.one_request_headroom_cents + 1,
    );
    assert.equal(DEFAULT_RUN_BUDGET_CENTS, 5_000);
  });

test("Rule A samples eligible balances pro rata and reserves $50 by default", () => {
  const base = snapshot({
    capacityCents: 58_000,
    pairs: [
      pair(problemA.id, "prove", 100_000, 8_000),
      pair(problemB.id, "prove", 50_000, 50_000),
    ],
  });
  const first = selectSamplingDecision(base, {
    draw(upperExclusive) {
      assert.equal(upperExclusive, 150_000);
      return 99_999;
    },
  });
  const second = selectSamplingDecision(base, { draw: () => 100_000 });
  const capacityCapped = selectSamplingDecision({
    ...base,
    spendableCapacityCents: 2_000,
  }, { draw: () => 0 });

  assert.equal(first.rule, "A");
  assert.equal(first.problemId, problemA.id);
  assert.equal(first.runBudgetCents, 5_000);
  assert.equal(first.fundingMode, "pool-only");
  assert.equal(first.candidateCount, 2);
  assert.equal(second.problemId, problemB.id);
  assert.equal(second.runBudgetCents, 5_000);
  assert.equal(capacityCapped.runBudgetCents, 2_000);
});

test("Rule B spends the selected balance when every pool is below $50", () => {
  const base = snapshot({
    capacityCents: 40_000,
    pairs: [
      pair(problemA.id, "prove", 12_345, 4_000),
      pair(problemB.id, "prove", 67_891, 3_000),
    ],
  });
  const firstLastCent = selectSamplingDecision(base, {
    draw(upperExclusive) {
      assert.equal(upperExclusive, 80_236);
      return 12_344;
    },
  });
  const secondFirstCent = selectSamplingDecision(base, {
    draw: () => 12_345,
  });

  assert.equal(firstLastCent.rule, "B");
  assert.equal(firstLastCent.problemId, problemA.id);
  assert.equal(firstLastCent.runBudgetCents, 4_000);
  assert.equal(secondFirstCent.problemId, problemB.id);
  assert.equal(secondFirstCent.runBudgetCents, 3_000);
  assert.equal(secondFirstCent.fundingMode, "pool-only");
});

test("Rule B-prime is uniform and general-only while protected pool money has no weight", () => {
  const base = snapshot({
    capacityCents: 10_000,
    generalCents: 10_000,
    pairs: [
      pair(problemA.id, "prove", 1_000_000, 0),
      pair(problemB.id, "disprove", 1, 0),
    ],
  });
  const first = selectSamplingDecision(base, { draw: () => 0 });
  const second = selectSamplingDecision(base, { draw: () => 1 });

  assert.equal(first.rule, "B-prime");
  assert.equal(first.problemId, problemA.id);
  assert.equal(second.problemId, problemB.id);
  assert.equal(second.runBudgetCents, 5_000);
  assert.equal(second.fundingMode, "general-only");
});

test("capacity, status, pair locks, and opposite directions define eligibility", () => {
  const blocked = selectSamplingDecision(snapshot({
    capacityCents: 1_600,
    generalCents: 50_000,
    pairs: [pair(problemA.id, "prove", 50_000, 50_000)],
  }));
  assert.equal(blocked.outcome, "treasury-blocked");

  const direction = selectSamplingDecision(snapshot({
    capacityCents: 5_000,
    pairs: [
      pair(problemA.id, "prove", 50_000, 50_000, {
        unsettledClaim: { claimTs: 1, workerId: "worker-4" },
      }),
      pair(problemA.id, "disprove", 4_000, 4_000),
      pair(problemB.id, "prove", 50_000, 50_000, { status: "PendingReview" }),
    ],
  }), { draw: () => 0 });
  assert.equal(direction.rule, "B");
  assert.equal(direction.problemId, problemA.id);
  assert.equal(direction.direction, "disprove");
  assert.equal(direction.runBudgetCents, 4_000);
});

test("the default draw is always inside its exact integer domain", () => {
  for (const upperExclusive of [1, 2, 3, 5_003, Number.MAX_SAFE_INTEGER]) {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const value = secureDraw(upperExclusive);
      assert.ok(value >= 0);
      assert.ok(value < upperExclusive);
      assert.equal(Number.isSafeInteger(value), true);
    }
  }
});

test("ledger sampling snapshot separates donated weight, runnable money, and capacity", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture, {
    problemId: problemA.id,
    direction: "prove",
    amountCents: 10_000,
    creditedOffsetMs: 1,
  });
  let state = fixture.ledger.samplingSnapshot();
  let prove = findPair(state, problemA.id, "prove");
  assert.equal(prove.weightableCents, 10_000);
  assert.equal(prove.runnableCents, 0);
  assert.equal(state.spendableCapacityCents, 0);

  fixture.ledger.treasuryFund({
    amountCents: 5_000,
    externalReference: `snapshot-fund-${fixtureSequence}`,
    settledContributionCents: 10_000,
  });
  state = fixture.ledger.samplingSnapshot();
  prove = findPair(state, problemA.id, "prove");
  assert.equal(prove.weightableCents, 10_000);
  assert.equal(prove.runnableCents, 10_000);
  assert.equal(state.spendableCapacityCents, 5_000);

  const claim = fixture.ledger.claim({
    problemId: problemA.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
  });
  state = fixture.ledger.samplingSnapshot();
  prove = findPair(state, problemA.id, "prove");
  assert.equal(prove.unsettledClaim.claimTs, claim.claimTs);
  assert.equal(
    findPair(state, problemA.id, "disprove").unsettledClaim,
    undefined,
  );
});

test("step-zero sweeping is re-callable and retains received-donation liability", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture, {
    problemId: problemA.id,
    direction: "prove",
    amountCents: 10_000,
    creditedOffsetMs: 1,
  });
  donate(fixture, {
    problemId: problemA.id,
    direction: "disprove",
    amountCents: 5_000,
    creditedOffsetMs: 2,
  });
  fixture.ledger.treasuryFund({
    amountCents: 10_000,
    externalReference: `sweep-first-fund-${fixtureSequence}`,
    settledContributionCents: 15_000,
  });
  const claim = fixture.ledger.claim({
    problemId: problemA.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
  });
  fixture.ledger.settle({
    ...claim,
    finalSpentCents: 0,
    solutionUri: "r2://solutions/sampling-sweep-proof.md",
  });
  fixture.ledger.review({
    problemId: problemA.id,
    verdict: "unconditional",
    noteUri: "r2://reviews/sampling-sweep-proof.md",
  });

  const first = fixture.ledger.sweepSolvedProblems();
  assert.equal(first.sweptCents, 10_000);
  let state = fixture.ledger.samplingSnapshot();
  assert.equal(findPair(state, problemA.id, "prove").weightableCents, 0);
  assert.equal(findPair(state, problemA.id, "disprove").weightableCents, 5_000);
  assert.equal(findPair(state, problemA.id, "disprove").runnableCents, 0);
  assert.equal(fixture.ledger.sweepSolvedProblems().outcome, "unchanged");

  fixture.ledger.treasuryFund({
    amountCents: 5_000,
    externalReference: `sweep-second-fund-${fixtureSequence}`,
    settledContributionCents: 15_000,
  });
  const second = fixture.ledger.sweepSolvedProblems();
  assert.equal(second.sweptCents, 5_000);
  state = fixture.ledger.samplingSnapshot();
  assert.equal(findPair(state, problemA.id, "disprove").weightableCents, 0);
});

test("real donor-funded claims reserve $50 without supplementing from general credit", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture, {
    problemId: problemA.id,
    direction: "prove",
    amountCents: 8_000,
    creditedOffsetMs: 1,
  });
  donate(fixture, {
    problemId: problemB.id,
    direction: "prove",
    amountCents: 50_000,
    creditedOffsetMs: 2,
  });
  donate(fixture, {
    problemId: problemA.id,
    direction: "prove",
    amountCents: 92_000,
    creditedOffsetMs: 3,
  });
  fixture.ledger.treasuryFund({
    amountCents: 58_000,
    externalReference: `rules-fund-${fixtureSequence}`,
    settledContributionCents: 150_000,
  });
  const r2 = new FakeR2();
  const worker1 = createRuntime(fixture, r2, "worker-1");

  const ruleA = await runSamplingCycle({
    worker: worker1,
    ledger: fixture.ledger,
    draw: () => 0,
    artifactRetryOptions: noDelayRetry,
    clock: fixture.clock,
  });
  assert.equal(ruleA.outcome, "claimed");
  assert.equal(ruleA.decision.rule, "A");
  assert.equal(ruleA.claim.problemId, problemA.id);
  assert.equal(ruleA.claim.budgetCents, 5_000);
  assert.equal(ruleA.claim.poolFundedCents, 5_000);

  const worker2 = createRuntime(fixture, r2, "worker-2");
  const secondRuleA = await runSamplingCycle({
    worker: worker2,
    ledger: fixture.ledger,
    draw: () => 0,
    artifactRetryOptions: noDelayRetry,
    clock: fixture.clock,
  });
  assert.equal(secondRuleA.outcome, "claimed");
  assert.equal(secondRuleA.decision.rule, "A");
  assert.equal(secondRuleA.claim.problemId, problemB.id);
  assert.equal(secondRuleA.claim.budgetCents, 5_000);
  assert.equal(secondRuleA.claim.poolFundedCents, 5_000);
});

test("capacity exhausted after a snapshot causes bounded resampling", async (context) => {
  const fixture = await createFixture(context);
  for (const [index, problemId] of [problemA.id, problemB.id].entries()) {
    donate(fixture, {
      problemId,
      direction: "prove",
      amountCents: 5_000,
      creditedOffsetMs: index + 1,
    });
  }
  fixture.ledger.treasuryFund({
    amountCents: 10_000,
    externalReference: `capacity-race-fund-${fixtureSequence}`,
    settledContributionCents: 10_000,
  });
  fixture.ledger.reconcileAnthropicSpend({
    cutoffAt: new Date(fixture.now - 1_000).toISOString(),
    actualSpendCents: 5_000,
    externalReference: `capacity-race-spend-${fixtureSequence}`,
    note: "Inject globally reconciled provider spend before the sampling race.",
  });
  assert.equal(
    fixture.ledger.samplingSnapshot().spendableCapacityCents,
    5_000,
  );
  const worker = createRuntime(fixture, new FakeR2(), "worker-1");
  let injected = false;
  const racedLedger = {
    samplingSnapshot: fixture.ledger.samplingSnapshot.bind(fixture.ledger),
    sweepSolvedProblems: fixture.ledger.sweepSolvedProblems.bind(fixture.ledger),
    claim(input) {
      if (!injected) {
        injected = true;
        fixture.ledger.claim({
          problemId: problemB.id,
          direction: "prove",
          runBudgetCents: 5_000,
          workerId: "worker-4",
          fundingMode: "pool-only",
        });
      }
      return fixture.ledger.claim(input);
    },
  };

  const result = await runSamplingCycle({
    worker,
    ledger: racedLedger,
    draw: () => 0,
    artifactRetryOptions: noDelayRetry,
    clock: fixture.clock,
  });

  assert.equal(result.outcome, "resample");
  assert.equal(result.reason, "claim-snapshot-raced");
  assert.deepEqual(
    new Set(result.claimFailures.map((failure) => failure.code)),
    new Set(["insufficient-capacity", "pair-already-claimed"]),
  );
  assert.equal(result.claimFailures.length, 2);
  assert.equal(fixture.ledger.listUnsettledClaims().length, 1);
});

test("Rule B-prime consumes general credit without changing protected pools", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture, {
    problemId: problemA.id,
    direction: "prove",
    amountCents: 50_000,
    creditedOffsetMs: 2,
  });
  fixture.ledger.donate({
    dedupId: `general-${fixtureSequence}`,
    orderId: `general-order-${fixtureSequence}`,
    destination: { kind: "general" },
    grossCents: 10_000,
    feesCents: 0,
    netCents: 10_000,
    donorTag: "General donor",
    creditedAt: new Date(fixture.now + 1).toISOString(),
  });
  fixture.ledger.treasuryFund({
    amountCents: 10_000,
    externalReference: `general-fund-${fixtureSequence}`,
    settledContributionCents: 60_000,
  });
  const poolBefore = findPair(
    fixture.ledger.samplingSnapshot(),
    problemA.id,
    "prove",
  ).weightableCents;
  const cycle = await runSamplingCycle({
    worker: createRuntime(fixture, new FakeR2(), "worker-1"),
    ledger: fixture.ledger,
    draw: () => 0,
    artifactRetryOptions: noDelayRetry,
    clock: fixture.clock,
  });

  assert.equal(cycle.outcome, "claimed");
  assert.equal(cycle.decision.rule, "B-prime");
  assert.equal(cycle.claim.poolFundedCents, 0);
  assert.equal(
    findPair(fixture.ledger.samplingSnapshot(), problemA.id, "prove")
      .weightableCents,
    poolBefore,
  );
});

test("four workers racing the same snapshot converge to four distinct claims", async (context) => {
  const fixture = await createFixture(context);
  const destinations = [
    [problemA.id, "prove"],
    [problemA.id, "disprove"],
    [problemB.id, "prove"],
    [problemB.id, "disprove"],
  ];
  for (const [index, [problemId, direction]] of destinations.entries()) {
    donate(fixture, {
      problemId,
      direction,
      amountCents: 5_000,
      creditedOffsetMs: index + 1,
    });
  }
  fixture.ledger.treasuryFund({
    amountCents: 20_000,
    externalReference: `four-fund-${fixtureSequence}`,
    settledContributionCents: 20_000,
  });
  const r2 = new FakeR2();
  const cycles = await Promise.all(
    ["worker-1", "worker-2", "worker-3", "worker-4"].map((workerId) => (
      runSamplingCycle({
        worker: createRuntime(fixture, r2, workerId),
        ledger: fixture.ledger,
        draw: () => 0,
        artifactRetryOptions: noDelayRetry,
        clock: fixture.clock,
      })
    )),
  );

  assert.ok(cycles.every((cycle) => cycle.outcome === "claimed"));
  assert.equal(
    new Set(cycles.map((cycle) => (
      `${cycle.claim.problemId}:${cycle.claim.direction}`
    ))).size,
    4,
  );
  assert.ok(cycles.every((cycle) => cycle.claim.poolFundedCents === 5_000));
  assert.ok(cycles.some((cycle) => cycle.claimFailures.length > 0));
  assert.equal(fixture.ledger.listUnsettledClaims().length, 4);
});

test("the worker loop recovers, claims, runs, and stops cleanly", async (context) => {
  const fixture = await createFixture(context);
  donate(fixture, {
    problemId: problemA.id,
    direction: "prove",
    amountCents: 5_000,
    creditedOffsetMs: 1,
  });
  fixture.ledger.treasuryFund({
    amountCents: 5_000,
    externalReference: `loop-fund-${fixtureSequence}`,
    settledContributionCents: 5_000,
  });
  const messages = new FakeAnthropicMessages({
    responses: [refusalMessage("msg_sampling_loop_refusal")],
  });
  const worker = createWorkerRuntime({
    config: fakeWorkerConfig("worker-1"),
    ledger: fixture.ledger,
    r2: new FakeR2(),
    anthropicMessages: messages,
    pricingTable,
  });
  const controller = new AbortController();
  const states = [];

  const stopped = await runWorkerLoop({
    worker,
    ledger: fixture.ledger,
    draw: () => 0,
    artifactRetryOptions: noDelayRetry,
    idlePollIntervalMs: 1,
    clock: fixture.clock,
    signal: controller.signal,
    onState: async (state) => {
      states.push(state);
      if (state.event === "worker-claim-finished") controller.abort();
    },
    sleep: async () => controller.abort(),
  });

  assert.equal(stopped.outcome, "stopped");
  assert.equal(messages.requests.length, 1);
  assert.equal(fixture.ledger.listUnsettledClaims().length, 0);
  assert.ok(states.some((state) => state.event === "worker-startup-recovery"));
  assert.ok(states.some((state) => state.result.outcome === "claimed"));
  assert.ok(states.some((state) => state.event === "worker-claim-finished"));
});

test("the deployment scales one to four supervised workers with isolated credentials", async () => {
  const [
    exampleEnvironment,
    service,
    bootstrap,
    setup,
    runner,
  ] = await Promise.all([
    readFile(path.join(rootDir, ".env.example"), "utf8"),
    readFile(path.join(rootDir, "ops", "indiemath-worker@.service"), "utf8"),
    readFile(path.join(rootDir, "setup-workers.sh"), "utf8"),
    readFile(path.join(rootDir, "scripts", "setup-workers.mjs"), "utf8"),
    readFile(path.join(rootDir, "scripts", "run-worker.mjs"), "utf8"),
  ]);

  for (let workerNumber = 1; workerNumber <= 4; workerNumber += 1) {
    assert.match(
      exampleEnvironment,
      new RegExp(`WORKER_${workerNumber}_ANTHROPIC_API_KEY=`),
    );
  }
  assert.match(exampleEnvironment, /^WORKER_COUNT=4$/m);
  assert.doesNotMatch(exampleEnvironment, /WORKER_\d+_ANTHROPIC_API_KEY_ID=/);
  assert.match(service, /EnvironmentFile=\/etc\/indiemath\/workers\/%i\.env/);
  assert.match(service, /^Restart=always$/m);
  assert.match(service, /^NoNewPrivileges=true$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(
    bootstrap,
    /INDIEMATH_WORKER_ENV_FILE:-\/etc\/indiemath\/workers\.env/,
  );
  assert.match(
    bootstrap,
    /--env-file-if-exists="\$\{common_env_file\}"/,
  );
  assert.match(
    bootstrap,
    /--env-file-if-exists="\$\{worker_env_file\}"/,
  );
  assert.match(setup, /process\.env\.INDIEMATH_WORKER_ENV_FILE/);
  assert.match(setup, /parseWorkerCount\(process\.env\.WORKER_COUNT/);
  assert.match(setup, /workerIdsForCount\(workerCount\)/);
  assert.match(setup, /validateWorkerFleet\(workerConfigs, \{ workerCount \}\)/);
  assert.match(setup, /await verifyPriorResearchContexts\(/);
  assert.match(setup, /createR2Client\(\{ config: workerConfigs\[0\] \}\)/);
  assert.match(
    setup,
    /Verified \$\{priorResearch\.total\} preserved prior-research contexts in R2/,
  );
  assert.match(setup, /mode: 0o700/);
  assert.match(setup, /0o600/);
  assert.match(setup, /for \(const workerId of activeWorkerIds\)/);
  assert.match(setup, /WORKER_IDS\.filter\(/);
  assert.match(setup, /\["disable", "--now", service\]/);
  assert.match(setup, /execFileSync\(systemctlBinary, \["enable", service\]/);
  assert.match(setup, /execFileSync\(systemctlBinary, \["restart", service\]/);
  assert.match(runner, /await runWorkerLoop\(/);
});

function snapshot({
  capacityCents,
  generalCents = 0,
  pairs,
}) {
  return {
    snapshotAt: "2026-07-29T12:00:00.000Z",
    spendableCapacityCents: capacityCents,
    claimableGeneralCreditCents: generalCents,
    pairs,
  };
}

function pair(problemId, direction, weightableCents, runnableCents, extra = {}) {
  return {
    problemId,
    direction,
    status: "Open",
    weightableCents,
    runnableCents,
    unsettledClaim: undefined,
    ...extra,
  };
}

async function createFixture(context) {
  fixtureSequence += 1;
  const directory = await mkdtemp(path.join(os.tmpdir(), "indiemath-sampling-"));
  const databasePath = path.join(directory, "ledger.sqlite");
  const now = Date.parse("2026-07-29T12:00:00.000Z") + fixtureSequence * 100_000;
  const ledger = await openLedger({
    databasePath,
    clock: () => new Date(now),
  });
  await syncCatalog({ databasePath, catalog });
  const fixture = {
    ledger,
    databasePath,
    now,
    clock: () => now,
  };
  context.after(async () => {
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  });
  return fixture;
}

function donate(fixture, {
  problemId,
  direction,
  amountCents,
  creditedOffsetMs,
}) {
  fixture.ledger.donate({
    dedupId:
      `sampling-${fixtureSequence}-${problemId}-${direction}-${creditedOffsetMs}`,
    orderId:
      `sampling-order-${fixtureSequence}-${problemId}-${direction}-${creditedOffsetMs}`,
    destination: { kind: "pool", problemId, direction },
    grossCents: amountCents,
    feesCents: 0,
    netCents: amountCents,
    donorTag: "Sampling test donor",
    creditedAt: new Date(fixture.now + creditedOffsetMs).toISOString(),
  });
}

function createRuntime(fixture, r2, workerId) {
  return createWorkerRuntime({
    config: fakeWorkerConfig(workerId),
    ledger: fixture.ledger,
    r2,
    anthropicMessages: new FakeAnthropicMessages(),
    pricingTable,
  });
}

function fakeWorkerConfig(workerId) {
  return {
    component: "worker",
    runtime: "fake",
    workerId,
    pricingTablePath: path.join(rootDir, "pricing", "anthropic.json"),
  };
}

function findPair(state, problemId, direction) {
  return state.pairs.find((candidate) => (
    candidate.problemId === problemId && candidate.direction === direction
  ));
}

function refusalMessage(id) {
  return {
    id,
    type: "message",
    role: "assistant",
    model: "claude-fable-5",
    content: [{ type: "text", text: "No complete solution was found." }],
    stop_reason: "refusal",
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}
