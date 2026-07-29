import { readFile } from "node:fs/promises";

const TOKEN_DENOMINATOR = 1_000_000n;
const BASIS_POINTS_DENOMINATOR = 10_000n;
const REQUEST_DENOMINATOR = 1_000n;

export async function loadAnthropicPricingTable(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new TypeError("Pricing table path must be a nonempty string.");
  }
  const table = JSON.parse(await readFile(filePath, "utf8"));
  return parseAnthropicPricingTable(table);
}

export function parseAnthropicPricingTable(value) {
  const table = object(value, "pricing table");
  positiveInteger(table.schema_version, "pricing.schema_version");
  requiredString(table.pricing_version, "pricing.pricing_version");
  timestamp(table.effective_at, "pricing.effective_at");
  if (table.currency !== "USD") throw new TypeError("Pricing currency must be USD.");
  nonnegativeInteger(
    table.safety_margin_basis_points,
    "pricing.safety_margin_basis_points",
  );
  positiveInteger(
    table.one_request_headroom_cents,
    "pricing.one_request_headroom_cents",
  );
  const models = object(table.models, "pricing.models");
  for (const [model, rates] of Object.entries(models)) {
    requiredString(model, "pricing model ID");
    const parsed = object(rates, `pricing.models.${model}`);
    for (const field of [
      "uncached_input_cents_per_million_tokens",
      "cache_write_5m_cents_per_million_tokens",
      "cache_write_1h_cents_per_million_tokens",
      "cache_read_cents_per_million_tokens",
      "output_cents_per_million_tokens",
    ]) {
      nonnegativeInteger(parsed[field], `pricing.models.${model}.${field}`);
    }
  }
  const serverTools = object(table.server_tools, "pricing.server_tools");
  nonnegativeInteger(
    serverTools.web_search_cents_per_thousand_requests,
    "pricing.server_tools.web_search_cents_per_thousand_requests",
  );
  nonnegativeInteger(
    serverTools.web_fetch_cents_per_thousand_requests,
    "pricing.server_tools.web_fetch_cents_per_thousand_requests",
  );
  const requestProfile = object(table.request_profile, "pricing.request_profile");
  positiveInteger(
    requestProfile.default_max_output_tokens,
    "pricing.request_profile.default_max_output_tokens",
  );
  nonnegativeInteger(
    requestProfile.headroom_input_allowance_tokens,
    "pricing.request_profile.headroom_input_allowance_tokens",
  );
  positiveInteger(
    requestProfile.compaction_trigger_tokens,
    "pricing.request_profile.compaction_trigger_tokens",
  );
  return Object.freeze(structuredClone(table));
}

export function normalizeAnthropicUsage(usage) {
  const source = object(usage, "usage");
  const iterations = Array.isArray(source.iterations) && source.iterations.length
    ? source.iterations
    : [source];
  const tokens = iterations.reduce((total, row) => {
    const normalized = normalizeTokenFields(row);
    for (const key of Object.keys(total)) total[key] += normalized[key];
    return total;
  }, {
    uncachedInputTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
  });
  const server = source.server_tool_use ?? source.serverToolUse ?? {};
  return Object.freeze({
    ...tokens,
    webSearchRequests: usageInteger(
      server.web_search_requests ?? server.webSearchRequests ?? 0,
      "usage.server_tool_use.web_search_requests",
    ),
    webFetchRequests: usageInteger(
      server.web_fetch_requests ?? server.webFetchRequests ?? 0,
      "usage.server_tool_use.web_fetch_requests",
    ),
    codeExecutionRequests: usageInteger(
      server.code_execution_requests ?? server.codeExecutionRequests ?? 0,
      "usage.server_tool_use.code_execution_requests",
    ),
  });
}

export function priceAnthropicUsage({
  usage,
  model,
  pricingTable,
  applySafetyMargin = true,
} = {}) {
  const table = parseAnthropicPricingTable(pricingTable);
  const modelId = requiredString(model, "model");
  const rates = table.models[modelId];
  if (!rates) throw new RangeError(`No pricing entry exists for model ${modelId}.`);
  const normalized = normalizeAnthropicUsage(usage);

  const tokenNumerator = (
    BigInt(normalized.uncachedInputTokens)
      * BigInt(rates.uncached_input_cents_per_million_tokens)
    + BigInt(normalized.cacheWrite5mTokens)
      * BigInt(rates.cache_write_5m_cents_per_million_tokens)
    + BigInt(normalized.cacheWrite1hTokens)
      * BigInt(rates.cache_write_1h_cents_per_million_tokens)
    + BigInt(normalized.cacheReadTokens)
      * BigInt(rates.cache_read_cents_per_million_tokens)
    + BigInt(normalized.outputTokens)
      * BigInt(rates.output_cents_per_million_tokens)
  );
  const serverToolNumerator = (
    BigInt(normalized.webSearchRequests)
      * BigInt(table.server_tools.web_search_cents_per_thousand_requests)
      * TOKEN_DENOMINATOR / REQUEST_DENOMINATOR
    + BigInt(normalized.webFetchRequests)
      * BigInt(table.server_tools.web_fetch_cents_per_thousand_requests)
      * TOKEN_DENOMINATOR / REQUEST_DENOMINATOR
  );
  const baseNumerator = tokenNumerator + serverToolNumerator;
  const baseCost = ceilDiv(baseNumerator, TOKEN_DENOMINATOR);
  const marginBps = applySafetyMargin
    ? BigInt(table.safety_margin_basis_points)
    : 0n;
  const cost = ceilDiv(
    baseNumerator * (BASIS_POINTS_DENOMINATOR + marginBps),
    TOKEN_DENOMINATOR * BASIS_POINTS_DENOMINATOR,
  );

  return Object.freeze({
    pricingVersion: table.pricing_version,
    model: modelId,
    usage: normalized,
    baseCostCents: safeNumber(baseCost, "base cost"),
    safetyMarginCents: safeNumber(cost - baseCost, "safety margin"),
    costCents: safeNumber(cost, "priced cost"),
  });
}

function normalizeTokenFields(row) {
  const source = object(row, "usage iteration");
  const cache = source.cache_creation ?? source.cacheCreation ?? {};
  const cache5m = (
    cache.ephemeral_5m_input_tokens
    ?? cache.ephemeral5mInputTokens
    ?? source.cache_creation_5m_input_tokens
    ?? source.cacheWrite5mTokens
  );
  const cache1h = (
    cache.ephemeral_1h_input_tokens
    ?? cache.ephemeral1hInputTokens
    ?? source.cache_creation_1h_input_tokens
    ?? source.cacheWrite1hTokens
  );
  const aggregateCache = (
    source.cache_creation_input_tokens
    ?? source.cacheCreationInputTokens
  );
  return {
    uncachedInputTokens: usageInteger(
      source.input_tokens
        ?? source.uncached_input_tokens
        ?? source.uncachedInputTokens
        ?? 0,
      "usage.input_tokens",
    ),
    cacheWrite5mTokens: usageInteger(
      cache5m ?? (cache1h === undefined ? aggregateCache ?? 0 : 0),
      "usage.cache_creation.ephemeral_5m_input_tokens",
    ),
    cacheWrite1hTokens: usageInteger(
      cache1h ?? 0,
      "usage.cache_creation.ephemeral_1h_input_tokens",
    ),
    cacheReadTokens: usageInteger(
      source.cache_read_input_tokens ?? source.cacheReadTokens ?? 0,
      "usage.cache_read_input_tokens",
    ),
    outputTokens: usageInteger(
      source.output_tokens ?? source.outputTokens ?? 0,
      "usage.output_tokens",
    ),
  };
}

function ceilDiv(numerator, denominator) {
  if (numerator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

function safeNumber(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError(`${label} exceeds safe cents.`);
  return number;
}

function usageInteger(value, label) {
  return nonnegativeInteger(value, label);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer.`);
  }
  return value;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value.trim();
}

function timestamp(value, label) {
  const parsed = Date.parse(requiredString(value, label));
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be a timestamp.`);
  return new Date(parsed).toISOString();
}
