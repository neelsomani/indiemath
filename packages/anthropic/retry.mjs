import {
  AnthropicDeadlineError,
  isRetryableAnthropicError,
} from "./errors.mjs";

export async function retryAnthropicOperation(operation, {
  signal,
  hardStopMs = Number.POSITIVE_INFINITY,
  maxAttempts = 6,
  baseDelayMs = 500,
  maximumDelayMs = 30_000,
  clock = () => Date.now(),
  random = Math.random,
  sleep = sleepWithSignal,
  onRetry = () => {},
} = {}) {
  if (typeof operation !== "function") throw new TypeError("operation must be a function.");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("maxAttempts must be a positive safe integer.");
  }

  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    if (clock() >= hardStopMs) throw new AnthropicDeadlineError();
    try {
      return await operation({ attempt, signal });
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableAnthropicError(error)) throw error;
      const exponential = Math.min(
        maximumDelayMs,
        baseDelayMs * (2 ** (attempt - 1)),
      );
      const jittered = Math.max(0, Math.round(exponential * (0.75 + random() * 0.5)));
      const delayMs = Math.max(error?.retryAfterMs ?? 0, jittered);
      if (clock() + delayMs >= hardStopMs) {
        throw new AnthropicDeadlineError(
          "The next Anthropic retry would cross the claim lease hard stop.",
          { cause: error },
        );
      }
      await onRetry({ error, attempt, delayMs });
      await sleep(delayMs, signal);
    }
  }
}

export function sleepWithSignal(delayMs, signal) {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new TypeError("delayMs must be a nonnegative finite number.");
  }
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timeout = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

