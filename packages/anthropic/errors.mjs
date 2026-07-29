const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 429]);
const RETRYABLE_STREAM_TYPES = new Set([
  "api_error",
  "overloaded_error",
  "rate_limit_error",
  "timeout_error",
]);

export class AnthropicApiError extends Error {
  constructor({ status, body = "", headers, operation = "request" } = {}) {
    const parsed = parseErrorBody(body);
    super(
      `Anthropic ${operation} failed with HTTP ${status}: ${parsed.message}`,
    );
    this.name = "AnthropicApiError";
    this.status = status;
    this.type = parsed.type;
    this.requestId = header(headers, "request-id")
      ?? header(headers, "anthropic-request-id");
    this.retryAfterMs = parseRetryAfter(header(headers, "retry-after"));
    const reset = selectRateLimitReset(parsed.message, headers);
    if (this.retryAfterMs === undefined && reset) {
      this.retryAfterMs = reset.delayMs;
      this.retryAfterSource = reset.header;
    } else if (this.retryAfterMs !== undefined) {
      this.retryAfterSource = "retry-after";
    }
    this.rateLimitResetAt = reset?.resetAt;
    this.responseBody = body;
    this.retryable = (
      RETRYABLE_HTTP_STATUSES.has(status)
      || (Number.isInteger(status) && status >= 500)
    );
  }
}

export class AnthropicStreamError extends Error {
  constructor(error = {}) {
    super(error.message ?? "Anthropic returned an error inside the event stream.");
    this.name = "AnthropicStreamError";
    this.type = error.type ?? "stream_error";
    this.retryable = RETRYABLE_STREAM_TYPES.has(this.type);
  }
}

export class AnthropicProtocolError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "AnthropicProtocolError";
    this.retryable = false;
  }
}

export class AnthropicDeadlineError extends Error {
  constructor(
    message = "Anthropic operation cannot complete before the hard stop.",
    options,
  ) {
    super(message, options);
    this.name = "AnthropicDeadlineError";
    this.retryable = false;
  }
}

export function isRetryableAnthropicError(error) {
  if (error?.name === "AbortError" || error instanceof AnthropicDeadlineError) {
    return false;
  }
  if (typeof error?.retryable === "boolean") return error.retryable;
  return error instanceof TypeError;
}

function parseErrorBody(body) {
  const text = typeof body === "string" ? body : "";
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error ?? parsed;
    return {
      type: typeof error?.type === "string" ? error.type : "api_error",
      message: typeof error?.message === "string"
        ? error.message
        : text.slice(0, 1_000) || "unknown API error",
    };
  } catch {
    return {
      type: "api_error",
      message: text.slice(0, 1_000) || "unknown API error",
    };
  }
}

function parseRetryAfter(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, timestamp - Date.now())
    : undefined;
}

function selectRateLimitReset(details, headers) {
  const lower = details.toLowerCase();
  const preferred = lower.includes("input token")
    ? ["anthropic-ratelimit-input-tokens-reset", "anthropic-ratelimit-tokens-reset"]
    : lower.includes("output token")
      ? ["anthropic-ratelimit-output-tokens-reset", "anthropic-ratelimit-tokens-reset"]
      : lower.includes("request")
        ? ["anthropic-ratelimit-requests-reset"]
        : [];
  const candidates = [
    ...preferred,
    "anthropic-ratelimit-input-tokens-reset",
    "anthropic-ratelimit-output-tokens-reset",
    "anthropic-ratelimit-tokens-reset",
    "anthropic-ratelimit-requests-reset",
  ];
  for (const name of new Set(candidates)) {
    const value = header(headers, name);
    const timestamp = value ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(timestamp)) continue;
    return {
      header: name,
      resetAt: new Date(timestamp).toISOString(),
      delayMs: Math.max(0, timestamp - Date.now()),
    };
  }
  return undefined;
}

function header(headers, name) {
  if (!headers) return undefined;
  const value = typeof headers.get === "function"
    ? headers.get(name)
    : headers[name] ?? headers[name.toLowerCase()];
  return typeof value === "string" && value ? value : undefined;
}
