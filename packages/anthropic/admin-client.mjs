import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_USAGE_PATH,
} from "./constants.mjs";
import { AnthropicApiError } from "./errors.mjs";

export class AnthropicAdminClient {
  #apiKey;
  #baseUrl;
  #fetch;

  constructor({
    apiKey,
    baseUrl = "https://api.anthropic.com",
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.#apiKey = requiredString(apiKey, "apiKey");
    this.#baseUrl = normalizeBaseUrl(baseUrl);
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
    this.#fetch = fetchImpl;
  }

  async healthcheck() {
    return {
      ok: true,
      service: "anthropic-admin",
      configured: true,
      baseUrl: this.#baseUrl,
    };
  }

  async listUsage({
    apiKeyId,
    startTime,
    endTime,
    cursor,
    limit = 1_440,
    signal,
  } = {}) {
    const start = timestamp(startTime, "startTime");
    const end = timestamp(endTime, "endTime");
    if (Date.parse(start) >= Date.parse(end)) {
      throw new RangeError("startTime must be before endTime.");
    }
    const pageLimit = integerInRange(limit, 1, 1_440, "limit");
    const url = new URL(`${this.#baseUrl}${ANTHROPIC_USAGE_PATH}`);
    url.searchParams.set("starting_at", start);
    url.searchParams.set("ending_at", end);
    url.searchParams.set("bucket_width", "1m");
    url.searchParams.set("limit", String(pageLimit));
    url.searchParams.append("group_by[]", "api_key_id");
    url.searchParams.append("group_by[]", "model");
    url.searchParams.append("group_by[]", "context_window");
    if (apiKeyId) url.searchParams.append("api_key_ids[]", requiredString(apiKeyId, "apiKeyId"));
    if (cursor) url.searchParams.set("page", requiredString(cursor, "cursor"));

    const response = await this.#fetch(url, {
      headers: {
        "x-api-key": this.#apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "user-agent": "indiemath/0.0.0",
      },
      signal,
    });
    if (!response.ok) {
      throw new AnthropicApiError({
        status: response.status,
        body: await response.text(),
        headers: response.headers,
        operation: "Admin usage API",
      });
    }
    const payload = await response.json();
    if (!Array.isArray(payload.data)) {
      throw new TypeError("Anthropic Admin usage response is missing data buckets.");
    }
    const rows = payload.data.flatMap((bucket) => normalizeBucket(bucket));
    return Object.freeze({
      data: Object.freeze(rows),
      nextCursor: payload.has_more
        ? requiredString(payload.next_page, "Admin response next_page")
        : undefined,
    });
  }
}

export async function collectAnthropicUsage(client, request) {
  if (!client || typeof client.listUsage !== "function") {
    throw new TypeError("client must provide listUsage.");
  }
  const rows = [];
  const seenCursors = new Set();
  let cursor;
  do {
    const page = await client.listUsage({ ...request, cursor });
    rows.push(...page.data);
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) {
      throw new TypeError("Anthropic Admin pagination repeated the same cursor.");
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return Object.freeze(rows);
}

function normalizeBucket(bucket) {
  if (!bucket || typeof bucket !== "object" || !Array.isArray(bucket.results)) {
    throw new TypeError("Anthropic Admin usage bucket is malformed.");
  }
  const bucketStart = timestamp(bucket.starting_at, "usage bucket starting_at");
  const bucketEnd = timestamp(bucket.ending_at, "usage bucket ending_at");
  return bucket.results.map((result) => Object.freeze({
    bucketStart,
    bucketEnd,
    apiKeyId: result.api_key_id ?? undefined,
    model: result.model ?? undefined,
    contextWindow: result.context_window ?? undefined,
    serviceTier: result.service_tier ?? undefined,
    inferenceGeo: result.inference_geo ?? undefined,
    uncachedInputTokens: nonnegative(
      result.uncached_input_tokens ?? 0,
      "uncached_input_tokens",
    ),
    cacheReadTokens: nonnegative(
      result.cache_read_input_tokens ?? 0,
      "cache_read_input_tokens",
    ),
    cacheWrite5mTokens: nonnegative(
      result.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      "cache_creation.ephemeral_5m_input_tokens",
    ),
    cacheWrite1hTokens: nonnegative(
      result.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      "cache_creation.ephemeral_1h_input_tokens",
    ),
    outputTokens: nonnegative(result.output_tokens ?? 0, "output_tokens"),
    serverToolUse: Object.freeze({
      webSearchRequests: nonnegative(
        result.server_tool_use?.web_search_requests ?? 0,
        "server_tool_use.web_search_requests",
      ),
      webFetchRequests: nonnegative(
        result.server_tool_use?.web_fetch_requests ?? 0,
        "server_tool_use.web_fetch_requests",
      ),
    }),
  }));
}

function normalizeBaseUrl(value) {
  const url = new URL(requiredString(value, "baseUrl"));
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("baseUrl must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}

function timestamp(value, label) {
  const text = requiredString(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be a timestamp.`);
  return new Date(parsed).toISOString();
}

function nonnegative(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer.`);
  }
  return value;
}

function integerInRange(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value.trim();
}
