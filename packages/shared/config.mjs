import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  publicLedgerKey,
  publicStateKey,
} from "./artifact-keys.mjs";
import {
  parsePositiveInteger,
  parseWorkerId,
  WORKER_IDS,
} from "./identifiers.mjs";

export const RUNTIMES = Object.freeze(["fake", "production"]);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const defaultCatalogPath = path.join(repositoryRoot, "problems", "catalog.json");
const defaultPricingTablePath = path.join(
  repositoryRoot,
  "pricing",
  "anthropic.json",
);

export function parseLedgerConfig(environment) {
  const runtime = parseRuntime(environment);
  return Object.freeze({
    component: "ledger",
    runtime,
    databasePath: parseAbsolutePath(
      required(environment, "INDIEMATH_DB"),
      "INDIEMATH_DB",
    ),
  });
}

export function parseWorkerConfig(environment) {
  const runtime = parseRuntime(environment);
  const workerId = parseWorkerId(required(environment, "WORKER_ID"), "WORKER_ID");

  const anthropic = {};
  if (runtime === "production") {
    anthropic.apiKey = required(environment, "ANTHROPIC_API_KEY");
  } else {
    rejectPresent(environment, ["ANTHROPIC_API_KEY"]);
  }

  return Object.freeze({
    component: "worker",
    runtime,
    workerId,
    databasePath: parseAbsolutePath(
      required(environment, "INDIEMATH_DB"),
      "INDIEMATH_DB",
    ),
    catalogPath: parseAbsolutePath(
      environment.INDIEMATH_CATALOG?.trim() || defaultCatalogPath,
      "INDIEMATH_CATALOG",
    ),
    pricingTablePath: parseAbsolutePath(
      environment.INDIEMATH_PRICING_TABLE?.trim() || defaultPricingTablePath,
      "INDIEMATH_PRICING_TABLE",
    ),
    r2: parseR2Config(environment, runtime),
    anthropic: Object.freeze(anthropic),
  });
}

export function parseIntakePublisherConfig(environment) {
  const runtime = parseRuntime(environment);
  return Object.freeze({
    component: "intake-publisher",
    runtime,
    databasePath: parseAbsolutePath(
      required(environment, "INDIEMATH_DB"),
      "INDIEMATH_DB",
    ),
    publishIntervalSeconds: optionalPositiveInteger(
      environment,
      "PUBLISH_INTERVAL_SECONDS",
      30,
    ),
    r2: parseR2Config(environment, runtime),
    openCollective: parseOpenCollectiveConfig(environment, runtime),
  });
}

export function parseAdminConfig(environment) {
  const runtime = parseRuntime(environment);
  const admin = {};
  if (runtime === "production") {
    admin.apiKey = required(environment, "ANTHROPIC_ADMIN_API_KEY");
  } else {
    rejectPresent(environment, ["ANTHROPIC_ADMIN_API_KEY"]);
  }

  return Object.freeze({
    component: "admin-cli",
    runtime,
    databasePath: parseAbsolutePath(
      required(environment, "INDIEMATH_DB"),
      "INDIEMATH_DB",
    ),
    catalogPath: parseAbsolutePath(
      environment.INDIEMATH_CATALOG?.trim() || defaultCatalogPath,
      "INDIEMATH_CATALOG",
    ),
    r2: parseR2Config(environment, runtime),
    openCollective: parseOpenCollectiveConfig(environment, runtime),
    anthropicAdmin: Object.freeze(admin),
  });
}

export function parseFrontendConfig(environment) {
  const runtime = parseRuntime(environment);
  const publicDataBaseUrl = parseHttpUrl(
    required(environment, "PUBLIC_DATA_BASE_URL"),
    "PUBLIC_DATA_BASE_URL",
  );
  return Object.freeze({
    component: "frontend",
    runtime,
    publicDataBaseUrl,
    stateUrl: appendUrlPath(publicDataBaseUrl, publicStateKey()),
    ledgerUrl: appendUrlPath(publicDataBaseUrl, publicLedgerKey()),
  });
}

export function validateWorkerFleet(configs, { requireComplete = true } = {}) {
  if (!Array.isArray(configs)) throw new TypeError("Worker fleet must be an array.");
  const workerIds = new Set();
  const apiKeys = new Set();

  for (const [index, config] of configs.entries()) {
    if (!config || config.component !== "worker") {
      throw new TypeError(`Worker fleet entry ${index} is not a parsed worker config.`);
    }
    recordUnique(workerIds, config.workerId, "worker ID");
    if (config.anthropic.apiKey) {
      recordUnique(
        apiKeys,
        config.anthropic.apiKey,
        "Anthropic API key secret",
        { sensitive: true },
      );
    }
  }

  if (requireComplete) {
    const missing = WORKER_IDS.filter((workerId) => !workerIds.has(workerId));
    if (missing.length || configs.length !== WORKER_IDS.length) {
      throw new Error(
        `Worker fleet must contain exactly ${WORKER_IDS.join(", ")}; `
        + `missing: ${missing.join(", ") || "none"}.`,
      );
    }
  }

  return Object.freeze([...configs]);
}

export function redactConfig(value) {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (
      /secret|token/i.test(key)
      || /^(apiKey|accessKeyId)$/i.test(key)
    ) {
      return [key, item === undefined ? undefined : "[REDACTED]"];
    }
    return [key, redactConfig(item)];
  }));
}

function parseR2Config(environment, runtime) {
  if (runtime === "fake") {
    rejectPresent(environment, ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]);
    return Object.freeze({
      kind: "fake",
      bucket: environment.R2_BUCKET?.trim() || "indiemath-fake",
    });
  }
  return Object.freeze({
    kind: "r2",
    endpoint: parseHttpUrl(required(environment, "R2_ENDPOINT"), "R2_ENDPOINT"),
    bucket: required(environment, "R2_BUCKET"),
    accessKeyId: required(environment, "R2_ACCESS_KEY_ID"),
    secretAccessKey: required(environment, "R2_SECRET_ACCESS_KEY"),
  });
}

function parseOpenCollectiveConfig(environment, runtime) {
  const collectiveSlug = required(environment, "OPEN_COLLECTIVE_SLUG");
  if (runtime === "fake") {
    rejectPresent(environment, ["OPEN_COLLECTIVE_API_TOKEN"]);
    return Object.freeze({ kind: "fake", collectiveSlug });
  }
  return Object.freeze({
    kind: "graphql",
    endpoint: parseHttpUrl(
      required(environment, "OPEN_COLLECTIVE_GRAPHQL_URL"),
      "OPEN_COLLECTIVE_GRAPHQL_URL",
    ),
    collectiveSlug,
    apiToken: required(environment, "OPEN_COLLECTIVE_API_TOKEN"),
  });
}

function parseRuntime(environment) {
  const runtime = required(environment, "INDIEMATH_RUNTIME");
  if (!RUNTIMES.includes(runtime)) {
    throw new TypeError(`INDIEMATH_RUNTIME must be one of ${RUNTIMES.join(", ")}.`);
  }
  return runtime;
}

function required(environment, key) {
  const value = environment?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Missing required configuration: ${key}.`);
  }
  return value.trim();
}

function rejectPresent(environment, keys) {
  const present = keys.filter((key) => (
    typeof environment?.[key] === "string" && environment[key].trim()
  ));
  if (present.length) {
    throw new Error(
      `Fake runtime must not receive production credentials: ${present.join(", ")}.`,
    );
  }
}

function parseAbsolutePath(value, label) {
  if (!path.isAbsolute(value)) throw new TypeError(`${label} must be an absolute path.`);
  return path.normalize(value);
}

function parseHttpUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be a valid URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError(`${label} must use http or https.`);
  }
  return url.toString();
}

function appendUrlPath(baseUrl, objectKey) {
  const url = new URL(baseUrl);
  if (url.search || url.hash) {
    throw new TypeError("PUBLIC_DATA_BASE_URL must not contain a query or fragment.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${objectKey}`;
  return url.toString();
}

function optionalPositiveInteger(environment, key, fallback) {
  if (environment?.[key] === undefined) return fallback;
  const value = Number(environment[key]);
  return parsePositiveInteger(value, key);
}

function recordUnique(seen, value, label, { sensitive = false } = {}) {
  if (seen.has(value)) {
    throw new Error(
      sensitive ? `Duplicate ${label} detected.` : `Duplicate ${label}: ${value}.`,
    );
  }
  seen.add(value);
}
