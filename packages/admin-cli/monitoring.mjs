import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  assertPort,
  MINIMUM_RUN_BUDGET_CENTS,
  parseWorkerCount,
  workerIdsForCount,
} from "#indiemath/shared";
import { reconcileOpenCollectiveCredits } from "./open-collective-reconciliation.mjs";

const execFile = promisify(execFileCallback);
const CHECKPOINT_SOURCE = "open-collective-contribution-credits";
const EPOCH = "1970-01-01T00:00:00.000Z";

const BASE_PRODUCTION_SERVICES = Object.freeze([
  "indiemath-intake.service",
  "indiemath-litestream.service",
  "indiemath-monitor.timer",
]);
export const REQUIRED_PRODUCTION_SERVICES = requiredProductionServices(4);

export function requiredProductionServices(workerCount) {
  return Object.freeze([
    ...BASE_PRODUCTION_SERVICES,
    ...workerIdsForCount(parseWorkerCount(workerCount)).map(
      (workerId) => `indiemath-worker@${workerId}.service`,
    ),
  ]);
}

export async function checkOperationalHealth({
  ledger,
  openCollective,
  publicDataBaseUrl,
  publicSiteUrl,
  serviceStates,
  fetchImpl = globalThis.fetch,
  now = new Date().toISOString(),
  maxIntakeLagSeconds = 180,
  maxPublicationLagSeconds = 180,
  reconciliationSince = EPOCH,
  workerCount = 4,
}) {
  assertPort(ledger, "ledger", [
    "getIntakeCheckpoint",
    "inspect",
    "samplingSnapshot",
    "treasuryStatus",
  ]);
  assertPort(openCollective, "Open Collective", ["listCreditTransactions"]);
  const observedAt = timestamp(now, "now");
  const publicBase = httpUrl(publicDataBaseUrl, "publicDataBaseUrl");
  const siteBase = httpUrl(publicSiteUrl, "publicSiteUrl");
  const intakeLimit = positiveInteger(
    maxIntakeLagSeconds,
    "maxIntakeLagSeconds",
  );
  const publicationLimit = positiveInteger(
    maxPublicationLagSeconds,
    "maxPublicationLagSeconds",
  );
  const activeWorkerCount = parseWorkerCount(workerCount);
  const requiredServices = requiredProductionServices(activeWorkerCount);
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function.");
  }

  const states = serviceStates ?? await readSystemdServiceStates({
    workerCount: activeWorkerCount,
  });
  const checkpoint = ledger.getIntakeCheckpoint(CHECKPOINT_SOURCE);
  const intakeLagSeconds = checkpoint.updatedAt
    ? elapsedSeconds(checkpoint.updatedAt, observedAt)
    : undefined;
  const serviceCheck = Object.freeze({
    id: "worker-liveness",
    ok: requiredServices.every(
      (service) => states[service] === "active",
    ),
    services: Object.freeze(Object.fromEntries(
      requiredServices.map((service) => [
        service,
        states[service] ?? "unknown",
      ]),
    )),
    workerCount: activeWorkerCount,
  });
  const intakeCheck = Object.freeze({
    id: "intake-lag",
    ok: intakeLagSeconds !== undefined && intakeLagSeconds <= intakeLimit,
    checkpointUpdatedAt: checkpoint.updatedAt,
    lagSeconds: intakeLagSeconds,
    maximumLagSeconds: intakeLimit,
  });

  let treasury;
  let sampling;
  let capacityError;
  try {
    treasury = ledger.treasuryStatus();
    sampling = ledger.samplingSnapshot();
  } catch (error) {
    capacityError = error.message;
  }
  const runnableCents = sampling?.pairs.reduce((total, pair) => (
    pair.status === "Open" && pair.unsettledClaim === undefined
      ? total + pair.runnableCents
      : total
  ), 0) ?? 0;
  const capacityStranded = (
    runnableCents >= MINIMUM_RUN_BUDGET_CENTS
    && (sampling?.spendableCapacityCents ?? 0) < MINIMUM_RUN_BUDGET_CENTS
    && (treasury?.liveReservationsCents ?? 0) === 0
  );
  const fundableButUnstaged = (
    (treasury?.availableToFundCents ?? 0) >= MINIMUM_RUN_BUDGET_CENTS
    && (sampling?.spendableCapacityCents ?? 0) < MINIMUM_RUN_BUDGET_CENTS
  );
  const capacityCheck = Object.freeze({
    id: "capacity",
    ok: !capacityError && !capacityStranded && !fundableButUnstaged,
    error: capacityError,
    runnableCents,
    spendableCapacityCents: sampling?.spendableCapacityCents,
    liveReservationsCents: treasury?.liveReservationsCents,
    availableToFundCents: treasury?.availableToFundCents,
    capacityStranded,
    fundableButUnstaged,
  });

  const reconciliationCheck = await capturedCheck(
    "reconciliation-drift",
    async () => {
      const result = await reconcileOpenCollectiveCredits({
        ledger,
        openCollective,
        since: reconciliationSince,
        through: observedAt,
      });
      return {
        ok: result.ok,
        providerTransactionCount: result.providerTransactionCount,
        ledgerDonationCount: result.ledgerDonationCount,
        missingFromLedger: result.missingFromLedger,
        unexpectedInLedger: result.unexpectedInLedger,
        mismatches: result.mismatches,
      };
    },
  );
  const publicDataCheck = await capturedCheck("public-data", async () => (
    verifyPublicData({
      publicDataBaseUrl: publicBase,
      fetchImpl,
      observedAt,
      maxPublicationLagSeconds: publicationLimit,
    })
  ));
  const termsCheck = await capturedCheck("terms-page", async () => (
    verifyTermsPage({ publicSiteUrl: siteBase, fetchImpl })
  ));
  const checks = Object.freeze([
    serviceCheck,
    intakeCheck,
    capacityCheck,
    reconciliationCheck,
    publicDataCheck,
    termsCheck,
  ]);

  return Object.freeze({
    schemaVersion: 1,
    observedAt,
    ok: checks.every((check) => check.ok),
    checks,
  });
}

export async function readSystemdServiceStates({
  execFileImpl = execFile,
  workerCount = 4,
} = {}) {
  if (typeof execFileImpl !== "function") {
    throw new TypeError("execFileImpl must be a function.");
  }
  const requiredServices = requiredProductionServices(workerCount);
  const states = {};
  await Promise.all(requiredServices.map(async (service) => {
    try {
      const result = await execFileImpl(
        "systemctl",
        ["is-active", service],
        { encoding: "utf8" },
      );
      states[service] = String(result.stdout ?? result).trim() || "unknown";
    } catch (error) {
      states[service] = String(error?.stdout ?? "inactive").trim() || "inactive";
    }
  }));
  return Object.freeze(states);
}

async function verifyPublicData({
  publicDataBaseUrl,
  fetchImpl,
  observedAt,
  maxPublicationLagSeconds,
}) {
  const stateUrl = objectUrl(publicDataBaseUrl, "public/state.json");
  const stateText = await responseText(await fetchImpl(stateUrl, {
    headers: { "cache-control": "no-cache" },
  }), "public state");
  const state = JSON.parse(stateText);
  if (!state.ledgerKey || !state.ledgerSha256 || !state.generatedAt) {
    throw new Error("Public state is missing its ledger pointer or generation metadata.");
  }
  const ledgerText = await responseText(await fetchImpl(
    objectUrl(publicDataBaseUrl, state.ledgerKey),
    { headers: { "cache-control": "no-cache" } },
  ), "public ledger");
  const digest = createHash("sha256").update(ledgerText).digest("hex");
  if (digest !== state.ledgerSha256) {
    throw new Error("Public ledger digest does not match the state commit point.");
  }
  const publicLedger = JSON.parse(ledgerText);
  if (
    publicLedger.publicationId !== state.publicationId
    || publicLedger.catalogRevision !== state.catalogRevision
  ) {
    throw new Error("Public state and ledger generations disagree.");
  }
  const lagSeconds = elapsedSeconds(state.generatedAt, observedAt);
  return {
    ok: lagSeconds <= maxPublicationLagSeconds,
    publicationId: state.publicationId,
    catalogRevision: state.catalogRevision,
    generatedAt: state.generatedAt,
    lagSeconds,
    maximumLagSeconds: maxPublicationLagSeconds,
  };
}

async function verifyTermsPage({
  publicSiteUrl,
  fetchImpl,
}) {
  const termsUrl = new URL("terms", withTrailingSlash(publicSiteUrl));
  const body = await responseText(await fetchImpl(termsUrl, {
    headers: { "cache-control": "no-cache" },
  }), "terms page");
  const required = [
    "Lipschitz Strategies LLC",
    "Refund",
    "Dispute",
    "Cancellation",
  ];
  const missing = required.filter((text) => !body.includes(text));
  if (!containsEmailAddress(body, "contact@indiemath.ai")) {
    missing.push("contact@indiemath.ai");
  }
  return {
    ok: missing.length === 0,
    url: termsUrl.toString(),
    missing,
  };
}

function containsEmailAddress(body, expected) {
  if (body.includes(expected)) return true;
  const encodedValues = [...body.matchAll(
    /\bdata-cfemail=["']([a-fA-F0-9]+)["']/g,
  )].map((match) => match[1]);
  return encodedValues.some((value) => decodeCloudflareEmail(value) === expected);
}

function decodeCloudflareEmail(value) {
  if (value.length < 4 || value.length % 2 !== 0) return undefined;
  const key = Number.parseInt(value.slice(0, 2), 16);
  if (!Number.isFinite(key)) return undefined;
  let decoded = "";
  for (let index = 2; index < value.length; index += 2) {
    const byte = Number.parseInt(value.slice(index, index + 2), 16);
    if (!Number.isFinite(byte)) return undefined;
    decoded += String.fromCodePoint(byte ^ key);
  }
  return decoded;
}

async function capturedCheck(id, operation) {
  try {
    return Object.freeze({ id, ...await operation() });
  } catch (error) {
    return Object.freeze({
      id,
      ok: false,
      error: error.message,
    });
  }
}

async function responseText(response, label) {
  if (!response?.ok) {
    throw new Error(`${label} returned HTTP ${response?.status ?? "unknown"}.`);
  }
  return response.text();
}

function objectUrl(baseUrl, key) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${String(key).replace(/^\/+/, "")}`;
  return url;
}

function withTrailingSlash(url) {
  const value = new URL(url);
  if (!value.pathname.endsWith("/")) value.pathname += "/";
  return value;
}

function elapsedSeconds(earlier, later) {
  const difference = Date.parse(timestamp(later, "later"))
    - Date.parse(timestamp(earlier, "earlier"));
  return Math.max(0, Math.floor(difference / 1_000));
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be a timestamp.`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function httpUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an HTTP(S) URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError(`${label} must be an HTTP(S) URL.`);
  }
  return url;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return parsed;
}
