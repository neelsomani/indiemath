import {
  DEFAULT_HARD_STOP_BUFFER_MS,
  parseSubmittedSolution,
  renderSolutionArtifact,
} from "#indiemath/anthropic";
import {
  assertPort,
  parseWorkerId,
  r2ArtifactUri,
  solutionKey,
} from "#indiemath/shared";

const DEFAULT_ARTIFACT_RETRY_ATTEMPTS = 3;
const DEFAULT_ARTIFACT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_ARTIFACT_RETRY_MAX_DELAY_MS = 2_000;

export async function recoverWorkerStartup({
  workerId,
  ledger,
  r2,
  pricingTable,
  runClaim,
  runOptions = {},
  artifactRetryOptions,
  hardStopBufferMs = DEFAULT_HARD_STOP_BUFFER_MS,
  clock = () => Date.now(),
  onBoundary = () => {},
} = {}) {
  const parsedWorkerId = parseWorkerId(workerId);
  assertPort(ledger, "ledger", [
    "getWorkerUnsettledClaim",
    "getClaim",
    "getProblem",
    "listClaimResponses",
    "listUnsettledClaims",
    "settle",
    "resolve",
  ]);
  assertPort(r2, "R2", ["getObject", "putObject"]);
  if (typeof runClaim !== "function") throw new TypeError("runClaim is required.");
  if (!pricingTable || typeof pricingTable !== "object") {
    throw new TypeError("pricingTable is required.");
  }
  const headroomCents = pricingTable.one_request_headroom_cents;
  if (!Number.isSafeInteger(headroomCents) || headroomCents < 0) {
    throw new TypeError("pricingTable.one_request_headroom_cents is invalid.");
  }
  assertRecoveryOptions({
    runOptions,
    hardStopBufferMs,
    clock,
    onBoundary,
  });

  const ownedClaim = await ledger.getWorkerUnsettledClaim(parsedWorkerId);
  const now = readClock(clock);
  if (!ownedClaim || Date.parse(ownedClaim.leaseExpiresAt) <= now) {
    const cleanup = await settleExpiredClaims({
      ledger,
      r2,
      artifactRetryOptions,
      clock,
      onBoundary,
    });
    if (!cleanup.readyToSample) {
      return Object.freeze({
        outcome: "solution_artifact_unavailable",
        resample: false,
        retryStartup: true,
        cleanup,
        failure: cleanup.failure,
      });
    }
    return Object.freeze({
      outcome: ownedClaim ? "expired_claim_released" : "ready_to_sample",
      resample: true,
      retryStartup: false,
      cleanup,
    });
  }

  const terminal = await ensureClaimSolutionArtifact({
    claim: ownedClaim,
    ledger,
    r2,
    retryOptions: artifactRetryOptions,
    onBoundary,
  });
  if (terminal.failure) {
    return Object.freeze({
      outcome: "solution_artifact_unavailable",
      resample: false,
      retryStartup: true,
      claim: ownedClaim,
      failure: terminal.failure,
    });
  }
  if (terminal.solutionUri) {
    return finalizeRecoveredSolution({
      claim: ownedClaim,
      solutionUri: terminal.solutionUri,
      ledger,
      onBoundary,
    });
  }

  const remainingBudgetCents = ownedClaim.budgetCents - ownedClaim.spentCents;
  const hardStopMs = Date.parse(ownedClaim.leaseExpiresAt) - hardStopBufferMs;
  const checkpoints = await ledger.listClaimResponses(ownedClaim);
  if (
    checkpoints.length === 0
    && (now >= hardStopMs || remainingBudgetCents <= headroomCents)
  ) {
    const settlement = await settleClaimAtRecordedSpend({
      claim: ownedClaim,
      ledger,
      onBoundary,
    });
    return Object.freeze({
      outcome: now >= hardStopMs
        ? "recovery_lease_unusable"
        : "recovery_budget_unusable",
      resample: true,
      retryStartup: false,
      claim: settlement.claim,
      settlementOutcome: settlement.outcome,
    });
  }

  const result = await runClaim({
    ...runOptions,
    claim: ownedClaim,
    hardStopBufferMs,
    clock,
    onBoundary,
  });
  return Object.freeze({
    ...result,
    recovery: "resumed",
  });
}

export async function settleExpiredClaims({
  ledger,
  r2,
  artifactRetryOptions,
  clock = () => Date.now(),
  onBoundary = () => {},
} = {}) {
  assertPort(ledger, "ledger", [
    "getClaim",
    "listClaimResponses",
    "listUnsettledClaims",
    "settle",
  ]);
  assertPort(r2, "R2", ["getObject", "putObject"]);
  if (typeof clock !== "function") throw new TypeError("clock must be a function.");
  if (typeof onBoundary !== "function") {
    throw new TypeError("onBoundary must be a function.");
  }
  const now = readClock(clock);
  const expired = (await ledger.listUnsettledClaims()).filter(
    (claim) => Date.parse(claim.leaseExpiresAt) <= now,
  );
  const settlements = [];

  for (const claim of expired) {
    const terminal = await ensureClaimSolutionArtifact({
      claim,
      ledger,
      r2,
      retryOptions: artifactRetryOptions,
      onBoundary,
    });
    if (terminal.failure) {
      return Object.freeze({
        outcome: "solution_artifact_unavailable",
        readyToSample: false,
        retry: true,
        settlements: Object.freeze(settlements),
        blockedClaim: claim,
        failure: terminal.failure,
      });
    }
    const settlement = await settleClaimAtRecordedSpend({
      claim,
      ledger,
      solutionUri: terminal.solutionUri,
      onBoundary,
    });
    settlements.push(Object.freeze({
      claim: settlement.claim,
      settlementOutcome: settlement.outcome,
      solutionUri: terminal.solutionUri,
      solutionSource: terminal.source,
    }));
  }

  return Object.freeze({
    outcome: expired.length ? "expired_claims_settled" : "expired_claims_clear",
    readyToSample: true,
    retry: false,
    settlements: Object.freeze(settlements),
  });
}

export async function ensureClaimSolutionArtifact({
  claim,
  ledger,
  r2,
  retryOptions,
  onBoundary = () => {},
} = {}) {
  assertPort(ledger, "ledger", ["listClaimResponses"]);
  assertPort(r2, "R2", ["getObject", "putObject"]);
  if (typeof onBoundary !== "function") {
    throw new TypeError("onBoundary must be a function.");
  }
  const key = solutionKey(claim);
  const retry = parseArtifactRetryOptions(retryOptions);
  const existing = await retryArtifactOperation(
    async () => {
      try {
        await r2.getObject(key);
        return true;
      } catch (error) {
        if (error?.code === "NoSuchKey") return false;
        throw error;
      }
    },
    retry,
  );
  if (existing.failure) return existing;
  if (existing.value) {
    return Object.freeze({
      solutionUri: r2ArtifactUri(key),
      source: "r2",
    });
  }

  const checkpoints = await ledger.listClaimResponses(claim);
  const checkpoint = checkpoints.at(-1);
  const solution = submittedSolution(checkpoint?.response);
  if (!solution) return Object.freeze({ source: "none" });

  const artifact = renderSolutionArtifact({
    solution,
    problemId: claim.problemId,
    direction: claim.direction,
    claimTs: claim.claimTs,
    model: checkpoint.modelId,
    messageId: checkpoint.messageId,
    requestId: checkpoint.requestId,
  });
  const written = await retryArtifactOperation(
    () => r2.putObject(key, artifact, {
      contentType: "text/markdown; charset=utf-8",
      metadata: {
        problemId: claim.problemId,
        direction: claim.direction,
        claimTs: String(claim.claimTs),
        messageId: checkpoint.messageId,
      },
    }),
    retry,
  );
  if (written.failure) return written;
  await onBoundary(Object.freeze({
    name: "after_recovered_solution_write",
    claim,
    solutionKey: key,
  }));
  return Object.freeze({
    solutionUri: r2ArtifactUri(key),
    source: "checkpoint",
  });
}

async function finalizeRecoveredSolution({
  claim,
  solutionUri,
  ledger,
  onBoundary,
}) {
  const current = await ledger.getClaim(claim);
  let resolution;
  try {
    resolution = await ledger.resolve({
      problemId: current.problemId,
      direction: current.direction,
      claimTs: current.claimTs,
      workerId: current.workerId,
      finalSpentCents: current.spentCents,
      solutionUri,
    });
    await onBoundary(Object.freeze({
      name: "after_recovery_resolve",
      claim: resolution.claim,
      solutionUri,
    }));
  } catch (error) {
    if (!["resolve-race-lost", "claim-settled", "lease-expired"].includes(error?.code)) {
      throw error;
    }
    resolution = await settleClaimAtRecordedSpend({
      claim: current,
      ledger,
      solutionUri,
      onBoundary,
    });
  }
  return Object.freeze({
    outcome: "recovered_solution",
    resample: true,
    retryStartup: false,
    solutionUri,
    resolutionOutcome: resolution.outcome,
    claim: resolution.claim,
  });
}

async function settleClaimAtRecordedSpend({
  claim,
  ledger,
  solutionUri,
  onBoundary,
}) {
  const current = await ledger.getClaim(claim);
  if (current.settled && (!solutionUri || current.solutionUri === solutionUri)) {
    return Object.freeze({ outcome: "replayed", claim: current });
  }
  await onBoundary(Object.freeze({
    name: "before_recovery_settle",
    claim: current,
    solutionUri,
  }));
  const settlement = await ledger.settle({
    problemId: current.problemId,
    direction: current.direction,
    claimTs: current.claimTs,
    finalSpentCents: current.spentCents,
    ...(solutionUri ? { solutionUri } : {}),
  });
  await onBoundary(Object.freeze({
    name: "after_recovery_settle",
    claim: settlement.claim,
    solutionUri,
  }));
  return settlement;
}

async function retryArtifactOperation(operation, retry) {
  let lastError;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    try {
      return Object.freeze({
        value: await operation(),
        attempts: attempt,
      });
    } catch (error) {
      lastError = error;
      if (attempt === retry.maxAttempts) break;
      const delayMs = Math.min(
        retry.maxDelayMs,
        retry.baseDelayMs * (2 ** (attempt - 1)),
      );
      try {
        await retry.sleep(delayMs, { signal: retry.signal });
      } catch {
        break;
      }
    }
  }
  return Object.freeze({
    failure: Object.freeze({
      name: lastError?.name ?? "Error",
      code: lastError?.code,
      message: lastError?.message ?? String(lastError),
    }),
  });
}

function parseArtifactRetryOptions(value) {
  if (value !== undefined && (!value || typeof value !== "object")) {
    throw new TypeError("artifactRetryOptions must be an object.");
  }
  const options = value ?? {};
  const maxAttempts = options.maxAttempts ?? DEFAULT_ARTIFACT_RETRY_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_ARTIFACT_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_ARTIFACT_RETRY_MAX_DELAY_MS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("artifactRetryOptions.maxAttempts must be a positive integer.");
  }
  for (const [name, amount] of [
    ["baseDelayMs", baseDelayMs],
    ["maxDelayMs", maxDelayMs],
  ]) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new TypeError(`artifactRetryOptions.${name} must be a nonnegative integer.`);
    }
  }
  if (options.sleep !== undefined && typeof options.sleep !== "function") {
    throw new TypeError("artifactRetryOptions.sleep must be a function.");
  }
  if (
    options.signal !== undefined
    && !(options.signal instanceof AbortSignal)
  ) {
    throw new TypeError("artifactRetryOptions.signal must be an AbortSignal.");
  }
  return Object.freeze({
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    signal: options.signal,
    sleep: options.sleep ?? waitForArtifactRetry,
  });
}

function submittedSolution(response) {
  if (!response) return undefined;
  for (const block of response.content ?? []) {
    if (block?.type !== "tool_use" || block.name !== "submit_solution") continue;
    try {
      return parseSubmittedSolution(block.input);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function assertRecoveryOptions({
  runOptions,
  hardStopBufferMs,
  clock,
  onBoundary,
}) {
  if (!runOptions || typeof runOptions !== "object" || Array.isArray(runOptions)) {
    throw new TypeError("runOptions must be an object.");
  }
  if (Object.hasOwn(runOptions, "claim")) {
    throw new TypeError("runOptions.claim is controlled by startup recovery.");
  }
  if (!Number.isSafeInteger(hardStopBufferMs) || hardStopBufferMs < 0) {
    throw new TypeError("hardStopBufferMs must be a nonnegative safe integer.");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function.");
  if (typeof onBoundary !== "function") {
    throw new TypeError("onBoundary must be a function.");
  }
}

function readClock(clock) {
  const now = clock();
  if (!Number.isFinite(now)) {
    throw new TypeError("clock must return epoch milliseconds.");
  }
  return now;
}

function waitForArtifactRetry(delayMs, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, delayMs);
    signal?.addEventListener("abort", aborted, { once: true });

    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }

    function aborted() {
      clearTimeout(timeout);
      reject(signal.reason);
    }
  });
}
