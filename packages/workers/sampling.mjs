import { randomBytes } from "node:crypto";
import {
  addCents,
  assertPort,
  MAX_RUN_BUDGET_CENTS,
  MINIMUM_RUN_BUDGET_CENTS,
  parseDirection,
  parseProblemId,
  parseWorkerId,
  STANDARD_RUN_BUDGET_CENTS,
  WORKER_IDLE_POLL_INTERVAL_MS,
} from "#indiemath/shared";

const CLAIM_RACE_CODES = new Set([
  "insufficient-capacity",
  "insufficient-claimable-balance",
  "insufficient-pool-balance",
  "pair-already-claimed",
  "problem-not-open",
  "worker-already-claimed",
]);
const UINT64_SPACE = 1n << 64n;

export function selectSamplingDecision(snapshot, {
  draw = secureDraw,
  excludedPairs = [],
} = {}) {
  const parsed = parseSamplingSnapshot(snapshot);
  if (typeof draw !== "function") throw new TypeError("draw must be a function.");
  const excluded = parseExcludedPairs(excludedPairs);
  const eligible = parsed.pairs.filter((pair) => (
    pair.status === "Open"
    && pair.unsettledClaim === undefined
    && !excluded.has(samplingPairKey(pair))
  ));
  const capacity = parsed.spendableCapacityCents;
  if (capacity < MINIMUM_RUN_BUDGET_CENTS) {
    return noSelection("treasury-blocked", parsed, eligible, {
      reason: "spendable-capacity-below-minimum-run",
    });
  }

  const ruleA = eligible.filter(
    (pair) => pair.runnableCents >= STANDARD_RUN_BUDGET_CENTS,
  );
  if (capacity >= STANDARD_RUN_BUDGET_CENTS && ruleA.length > 0) {
    return selectedDecision({
      rule: "A",
      pair: weightedChoice(ruleA, draw),
      runBudgetCents: STANDARD_RUN_BUDGET_CENTS,
      fundingMode: "pool-only",
      candidateCount: ruleA.length,
      snapshot: parsed,
    });
  }

  const ruleB = eligible.filter(
    (pair) => pair.runnableCents >= MINIMUM_RUN_BUDGET_CENTS,
  );
  if (ruleB.length > 0) {
    const pair = weightedChoice(ruleB, draw);
    return selectedDecision({
      rule: "B",
      pair,
      runBudgetCents: Math.min(
        pair.runnableCents,
        capacity,
        MAX_RUN_BUDGET_CENTS,
      ),
      fundingMode: "pool-only",
      candidateCount: ruleB.length,
      snapshot: parsed,
    });
  }

  if (
    parsed.claimableGeneralCreditCents >= MINIMUM_RUN_BUDGET_CENTS
    && eligible.length > 0
  ) {
    const pair = uniformChoice(eligible, draw);
    return selectedDecision({
      rule: "B-prime",
      pair,
      runBudgetCents: Math.min(
        parsed.claimableGeneralCreditCents,
        capacity,
        MAX_RUN_BUDGET_CENTS,
      ),
      fundingMode: "general-only",
      candidateCount: eligible.length,
      snapshot: parsed,
    });
  }

  return noSelection("idle", parsed, eligible, {
    reason: eligible.length === 0
      ? "no-eligible-pairs"
      : "no-claimable-balance-at-minimum-run",
  });
}

export async function runSamplingCycle({
  worker,
  ledger,
  draw = secureDraw,
  artifactRetryOptions,
  clock,
  onBoundary,
} = {}) {
  assertPort(worker, "worker", ["settleExpiredClaims"]);
  assertPort(ledger, "ledger", [
    "claim",
    "samplingSnapshot",
    "sweepSolvedProblems",
  ]);
  const cleanup = await worker.settleExpiredClaims({
    ...(artifactRetryOptions ? { artifactRetryOptions } : {}),
    ...(clock ? { clock } : {}),
    ...(onBoundary ? { onBoundary } : {}),
  });
  if (!cleanup.readyToSample) {
    return Object.freeze({
      outcome: "recovery-blocked",
      reason: cleanup.outcome,
      shouldWait: true,
      cleanup,
    });
  }

  const sweep = await ledger.sweepSolvedProblems();
  const snapshot = await ledger.samplingSnapshot();
  const excluded = new Set();
  const claimFailures = [];

  while (true) {
    const decision = selectSamplingDecision(snapshot, {
      draw,
      excludedPairs: excluded,
    });
    if (decision.outcome !== "selected") {
      if (claimFailures.length > 0) {
        return Object.freeze({
          outcome: "resample",
          reason: "claim-snapshot-raced",
          shouldWait: false,
          cleanup,
          sweep,
          snapshot,
          claimFailures: Object.freeze(claimFailures),
        });
      }
      return Object.freeze({
        ...decision,
        shouldWait: true,
        cleanup,
        sweep,
        snapshot,
      });
    }

    try {
      const claim = await ledger.claim({
        problemId: decision.problemId,
        direction: decision.direction,
        runBudgetCents: decision.runBudgetCents,
        workerId: worker.workerId,
        fundingMode: decision.fundingMode,
      });
      return Object.freeze({
        outcome: "claimed",
        shouldWait: false,
        cleanup,
        sweep,
        snapshot,
        decision,
        claim,
        claimFailures: Object.freeze(claimFailures),
      });
    } catch (error) {
      if (!CLAIM_RACE_CODES.has(error?.code)) throw error;
      const failure = Object.freeze({
        problemId: decision.problemId,
        direction: decision.direction,
        rule: decision.rule,
        code: error.code,
        message: error.message,
      });
      claimFailures.push(failure);
      if (error.code === "worker-already-claimed") {
        return Object.freeze({
          outcome: "resample",
          reason: "worker-claim-raced",
          shouldWait: false,
          cleanup,
          sweep,
          snapshot,
          claimFailures: Object.freeze(claimFailures),
        });
      }
      excluded.add(samplingPairKey(decision));
    }
  }
}

export async function runWorkerLoop({
  worker,
  ledger,
  runOptions = {},
  recoveryOptions = {},
  artifactRetryOptions,
  draw = secureDraw,
  idlePollIntervalMs = WORKER_IDLE_POLL_INTERVAL_MS,
  sleep = waitForNextSamplingCycle,
  clock,
  signal,
  onState = () => {},
} = {}) {
  assertPort(worker, "worker", [
    "recoverStartup",
    "runClaim",
    "settleExpiredClaims",
  ]);
  assertPort(ledger, "ledger", [
    "claim",
    "samplingSnapshot",
    "sweepSolvedProblems",
  ]);
  if (!runOptions || typeof runOptions !== "object" || Array.isArray(runOptions)) {
    throw new TypeError("runOptions must be an object.");
  }
  if (
    !recoveryOptions
    || typeof recoveryOptions !== "object"
    || Array.isArray(recoveryOptions)
  ) {
    throw new TypeError("recoveryOptions must be an object.");
  }
  if (!Number.isSafeInteger(idlePollIntervalMs) || idlePollIntervalMs < 1) {
    throw new TypeError("idlePollIntervalMs must be a positive safe integer.");
  }
  if (typeof sleep !== "function") throw new TypeError("sleep must be a function.");
  if (typeof onState !== "function") throw new TypeError("onState must be a function.");
  const loopClock = clock ?? runOptions.clock ?? recoveryOptions.clock ?? (() => Date.now());
  if (typeof loopClock !== "function") throw new TypeError("clock must be a function.");

  let startupRequired = true;
  while (!signal?.aborted) {
    if (startupRequired) {
      const startup = await worker.recoverStartup({
        ...recoveryOptions,
        ...(artifactRetryOptions ? { artifactRetryOptions } : {}),
        runOptions,
        clock: loopClock,
      });
      await onState(Object.freeze({
        event: "worker-startup-recovery",
        workerId: worker.workerId,
        result: startup,
      }));
      if (startup.retryStartup) {
        await sleep(idlePollIntervalMs, { signal });
        continue;
      }
      startupRequired = false;
    }

    const cycle = await runSamplingCycle({
      worker,
      ledger,
      draw,
      artifactRetryOptions,
      clock: loopClock,
    });
    await onState(Object.freeze({
      event: "worker-sampling-cycle",
      workerId: worker.workerId,
      result: cycle,
    }));

    if (cycle.outcome === "claimed") {
      const result = await worker.runClaim({
        ...runOptions,
        claim: cycle.claim,
        clock: loopClock,
      });
      await onState(Object.freeze({
        event: "worker-claim-finished",
        workerId: worker.workerId,
        claim: cycle.claim,
        result,
      }));
      continue;
    }
    if (cycle.outcome === "resample") {
      if (cycle.reason === "worker-claim-raced") startupRequired = true;
      continue;
    }
    await sleep(idlePollIntervalMs, { signal });
  }

  return Object.freeze({
    outcome: "stopped",
    workerId: worker.workerId,
  });
}

export function samplingPairKey({ problemId, direction }) {
  return `${parseProblemId(problemId)}:${parseDirection(direction)}`;
}

export function secureDraw(upperExclusive) {
  if (!Number.isSafeInteger(upperExclusive) || upperExclusive < 1) {
    throw new TypeError("upperExclusive must be a positive safe integer.");
  }
  const bound = BigInt(upperExclusive);
  const ceiling = UINT64_SPACE - (UINT64_SPACE % bound);
  while (true) {
    const candidate = randomBytes(8).readBigUInt64BE();
    if (candidate < ceiling) return Number(candidate % bound);
  }
}

function weightedChoice(candidates, draw) {
  const ordered = [...candidates].sort(comparePair);
  const total = ordered.reduce(
    (sum, pair) => addCents(sum, pair.weightableCents),
    0,
  );
  if (total < 1) throw new Error("Weighted candidate set has zero total weight.");
  let ticket = checkedDraw(draw, total);
  for (const pair of ordered) {
    if (ticket < pair.weightableCents) return pair;
    ticket -= pair.weightableCents;
  }
  throw new Error("Weighted sampling ticket exceeded the candidate set.");
}

function uniformChoice(candidates, draw) {
  const ordered = [...candidates].sort(comparePair);
  return ordered[checkedDraw(draw, ordered.length)];
}

function checkedDraw(draw, upperExclusive) {
  const value = draw(upperExclusive);
  if (!Number.isSafeInteger(value) || value < 0 || value >= upperExclusive) {
    throw new RangeError(
      `draw(${upperExclusive}) must return an integer from 0 through ${
        upperExclusive - 1
      }.`,
    );
  }
  return value;
}

function selectedDecision({
  rule,
  pair,
  runBudgetCents,
  fundingMode,
  candidateCount,
  snapshot,
}) {
  if (
    !Number.isSafeInteger(runBudgetCents)
    || runBudgetCents < MINIMUM_RUN_BUDGET_CENTS
    || runBudgetCents > MAX_RUN_BUDGET_CENTS
  ) {
    throw new Error(`Rule ${rule} selected an invalid run budget ${runBudgetCents}.`);
  }
  return Object.freeze({
    outcome: "selected",
    rule,
    problemId: pair.problemId,
    direction: pair.direction,
    runBudgetCents,
    fundingMode,
    candidateCount,
    snapshotAt: snapshot.snapshotAt,
    spendableCapacityCents: snapshot.spendableCapacityCents,
  });
}

function noSelection(outcome, snapshot, eligible, extra) {
  return Object.freeze({
    outcome,
    ...extra,
    eligiblePairCount: eligible.length,
    snapshotAt: snapshot.snapshotAt,
    spendableCapacityCents: snapshot.spendableCapacityCents,
    claimableGeneralCreditCents: snapshot.claimableGeneralCreditCents,
  });
}

function parseSamplingSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("sampling snapshot must be an object.");
  }
  if (typeof value.snapshotAt !== "string" || !Number.isFinite(Date.parse(value.snapshotAt))) {
    throw new TypeError("sampling snapshot requires snapshotAt.");
  }
  const spendableCapacityCents = nonnegativeCents(
    value.spendableCapacityCents,
    "snapshot.spendableCapacityCents",
  );
  const claimableGeneralCreditCents = nonnegativeCents(
    value.claimableGeneralCreditCents,
    "snapshot.claimableGeneralCreditCents",
  );
  if (!Array.isArray(value.pairs)) throw new TypeError("snapshot.pairs must be an array.");
  const keys = new Set();
  const pairs = value.pairs.map((pair, index) => {
    if (!pair || typeof pair !== "object" || Array.isArray(pair)) {
      throw new TypeError(`snapshot.pairs[${index}] must be an object.`);
    }
    const parsed = Object.freeze({
      problemId: parseProblemId(pair.problemId, `snapshot.pairs[${index}].problemId`),
      direction: parseDirection(pair.direction, `snapshot.pairs[${index}].direction`),
      status: pair.status,
      weightableCents: nonnegativeCents(
        pair.weightableCents,
        `snapshot.pairs[${index}].weightableCents`,
      ),
      runnableCents: nonnegativeCents(
        pair.runnableCents,
        `snapshot.pairs[${index}].runnableCents`,
      ),
      unsettledClaim: pair.unsettledClaim,
    });
    if (!["Open", "PendingReview", "Solved"].includes(parsed.status)) {
      throw new TypeError(`snapshot.pairs[${index}].status is invalid.`);
    }
    if (parsed.runnableCents > parsed.weightableCents) {
      throw new Error(`snapshot pair ${samplingPairKey(parsed)} has runnable above weightable.`);
    }
    const key = samplingPairKey(parsed);
    if (keys.has(key)) throw new Error(`Duplicate sampling pair ${key}.`);
    keys.add(key);
    return parsed;
  });
  return Object.freeze({
    snapshotAt: value.snapshotAt,
    spendableCapacityCents,
    claimableGeneralCreditCents,
    pairs: Object.freeze(pairs),
  });
}

function parseExcludedPairs(value) {
  if (
    !(value instanceof Set)
    && !Array.isArray(value)
  ) {
    throw new TypeError("excludedPairs must be a Set or array.");
  }
  const excluded = new Set();
  for (const item of value) {
    if (typeof item === "string") excluded.add(item);
    else excluded.add(samplingPairKey(item));
  }
  return excluded;
}

function nonnegativeCents(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be nonnegative integer cents.`);
  }
  return value;
}

function comparePair(left, right) {
  return samplingPairKey(left).localeCompare(samplingPairKey(right));
}

function waitForNextSamplingCycle(delayMs, { signal } = {}) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, delayMs);
    signal?.addEventListener("abort", done, { once: true });

    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
