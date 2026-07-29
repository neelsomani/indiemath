import {
  assertPort,
  assertRuntimeConfig,
} from "#indiemath/shared";
import {
  createWorkerAnthropicClient,
  loadAnthropicPricingTable,
  runFableClaim,
} from "#indiemath/anthropic";
import { createR2Client } from "#indiemath/r2";
import {
  assembleWorkerClaimContext,
  WorkerContextError,
} from "./claim-context.mjs";
import {
  recoverWorkerStartup,
  settleExpiredClaims as settleExpiredWorkerClaims,
} from "./recovery.mjs";

export {
  assembleWorkerClaimContext,
  WorkerContextError,
} from "./claim-context.mjs";
export {
  ensureClaimSolutionArtifact,
  recoverWorkerStartup,
  settleExpiredClaims,
} from "./recovery.mjs";
export {
  bootstrapFableMathContexts,
} from "./fable-context-bootstrap.mjs";
export {
  runSamplingCycle,
  runWorkerLoop,
  samplingPairKey,
  secureDraw,
  selectSamplingDecision,
} from "./sampling.mjs";

export function createWorkerRuntime({
  config,
  ledger,
  r2,
  anthropicMessages,
  pricingTable,
}) {
  assertRuntimeConfig(config, "worker");
  assertPort(ledger, "ledger", ["healthcheck"]);
  assertPort(r2, "R2", ["healthcheck", "putObject", "getObject", "listObjects"]);
  assertPort(anthropicMessages, "Anthropic Messages", [
    "healthcheck",
    "createMessage",
    "streamMessage",
  ]);

  const resolvePricingTable = async () => (
    pricingTable ?? loadAnthropicPricingTable(config.pricingTablePath)
  );
  const runClaim = async ({ claim, contextRetryOptions, ...options } = {}) => {
    const resolvedPricingTable = await resolvePricingTable();
    const contextResult = await assembleContextForDispatch({
      claim,
      ledger,
      r2,
      retryOptions: contextRetryOptions,
      signal: options.signal,
    });
    if (contextResult.failure) {
      return settleContextFailure({
        claim,
        failure: contextResult.failure,
        attempts: contextResult.attempts,
        ledger,
      });
    }
    return runFableClaim({
      ...options,
      claim,
      ...contextResult.context,
      messagesClient: anthropicMessages,
      ledger,
      r2,
      pricingTable: resolvedPricingTable,
    });
  };

  return Object.freeze({
    name: "worker",
    workerId: config.workerId,
    config,
    runClaim,
    async recoverStartup(options = {}) {
      return recoverWorkerStartup({
        ...options,
        workerId: config.workerId,
        ledger,
        r2,
        pricingTable: await resolvePricingTable(),
        runClaim,
      });
    },
    async settleExpiredClaims(options = {}) {
      return settleExpiredWorkerClaims({
        ...options,
        ledger,
        r2,
      });
    },
    async probe() {
      const [ledgerStatus, objectStoreStatus, messagesStatus] = await Promise.all([
        ledger.healthcheck(),
        r2.healthcheck(),
        anthropicMessages.healthcheck(),
      ]);
      return {
        ok: true,
        component: "worker",
        workerId: config.workerId,
        dependencies: {
          ledger: ledgerStatus,
          r2: objectStoreStatus,
          anthropicMessages: messagesStatus,
        },
      };
    },
  });
}

export function createProductionWorkerRuntime({
  config,
  ledger,
  fetchImpl,
  pricingTable,
} = {}) {
  if (config?.runtime !== "production") {
    throw new TypeError("Production worker composition requires production config.");
  }
  return createWorkerRuntime({
    config,
    ledger,
    r2: createR2Client({ config, ...(fetchImpl ? { fetchImpl } : {}) }),
    anthropicMessages: createWorkerAnthropicClient({
      config,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
    pricingTable,
  });
}

const DEFAULT_CONTEXT_RETRY_ATTEMPTS = 3;
const DEFAULT_CONTEXT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_CONTEXT_RETRY_MAX_DELAY_MS = 2_000;

async function assembleContextForDispatch({
  claim,
  ledger,
  r2,
  retryOptions,
  signal,
}) {
  const retry = parseContextRetryOptions(retryOptions);
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    try {
      const context = await assembleWorkerClaimContext({ claim, ledger, r2 });
      return Object.freeze({ context, attempts: attempt });
    } catch (error) {
      if (!(error instanceof WorkerContextError)) throw error;
      if (error.code !== "review-artifact-unavailable") {
        return Object.freeze({ failure: error, attempts: attempt });
      }
      if (attempt === retry.maxAttempts) {
        return Object.freeze({ failure: error, attempts: attempt });
      }
      const delayMs = Math.min(
        retry.maxDelayMs,
        retry.baseDelayMs * (2 ** (attempt - 1)),
      );
      try {
        await retry.sleep(delayMs, { signal });
      } catch {
        return Object.freeze({ failure: error, attempts: attempt });
      }
    }
  }
  throw new Error("Unreachable worker context retry state.");
}

async function settleContextFailure({
  claim,
  failure,
  attempts,
  ledger,
}) {
  const storedClaim = await ledger.getClaim(claim);
  const settlement = storedClaim.settled
    ? { outcome: "replayed", claim: storedClaim }
    : await ledger.settle({
      problemId: storedClaim.problemId,
      direction: storedClaim.direction,
      claimTs: storedClaim.claimTs,
      finalSpentCents: storedClaim.spentCents,
    });
  return Object.freeze({
    outcome: failure.code.replaceAll("-", "_"),
    reason: failure.code,
    resample: true,
    attempts,
    settlementOutcome: settlement.outcome,
    claim: settlement.claim,
    failure: Object.freeze({
      name: failure.name,
      code: failure.code,
      message: failure.message,
    }),
  });
}

function parseContextRetryOptions(value) {
  if (value !== undefined && (!value || typeof value !== "object")) {
    throw new TypeError("contextRetryOptions must be an object.");
  }
  const options = value ?? {};
  const maxAttempts = options.maxAttempts ?? DEFAULT_CONTEXT_RETRY_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_CONTEXT_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_CONTEXT_RETRY_MAX_DELAY_MS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("contextRetryOptions.maxAttempts must be a positive integer.");
  }
  for (const [name, amount] of [
    ["baseDelayMs", baseDelayMs],
    ["maxDelayMs", maxDelayMs],
  ]) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new TypeError(`contextRetryOptions.${name} must be a nonnegative integer.`);
    }
  }
  if (options.sleep !== undefined && typeof options.sleep !== "function") {
    throw new TypeError("contextRetryOptions.sleep must be a function.");
  }
  return Object.freeze({
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    sleep: options.sleep ?? waitForContextRetry,
  });
}

function waitForContextRetry(delayMs, { signal } = {}) {
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
