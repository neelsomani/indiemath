#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { checkOperationalHealth } from "#indiemath/admin-cli";
import { openLedger } from "#indiemath/ledger";
import { createOpenCollectiveClient } from "#indiemath/open-collective";

const databasePath = requiredEnvironment("INDIEMATH_DB");
const statusPath = process.env.MONITOR_STATUS_PATH?.trim()
  || "/var/lib/indiemath/monitor-status.json";
const ledger = await openLedger({ databasePath });

try {
  const health = await checkOperationalHealth({
    ledger,
    openCollective: createOpenCollectiveClient({
      kind: "graphql",
      endpoint: requiredEnvironment("OPEN_COLLECTIVE_GRAPHQL_URL"),
      collectiveSlug: requiredEnvironment("OPEN_COLLECTIVE_SLUG"),
      apiToken: requiredEnvironment("OPEN_COLLECTIVE_API_TOKEN"),
    }),
    publicDataBaseUrl: requiredEnvironment("PUBLIC_DATA_BASE_URL"),
    publicSiteUrl: process.env.PUBLIC_SITE_URL?.trim() || "https://indiemath.ai",
    maxIntakeLagSeconds: optionalPositiveInteger(
      "MONITOR_MAX_INTAKE_LAG_SECONDS",
      180,
    ),
    maxPublicationLagSeconds: optionalPositiveInteger(
      "MONITOR_MAX_PUBLICATION_LAG_SECONDS",
      180,
    ),
    workerCount: optionalPositiveInteger("WORKER_COUNT", 4),
  });
  const previous = await readStatus(statusPath);
  const incidentFingerprint = health.ok
    ? undefined
    : createHash("sha256")
      .update(health.checks.filter((check) => !check.ok).map((check) => check.id).join("\n"))
      .digest("hex");
  const recovered = health.ok && previous?.health?.ok === false;
  const status = {
    schemaVersion: 1,
    health,
    incidentFingerprint,
  };
  await atomicWrite(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  const output = {
    event: health.ok
      ? recovered
        ? "operational-health-recovered"
        : "operational-health-ok"
      : "operational-health-failed",
    ...health,
  };
  console[health.ok ? "log" : "error"](JSON.stringify(output));
  if (!health.ok) process.exitCode = 1;
} finally {
  ledger.close();
}

async function readStatus(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWrite(destination, body) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} is required.`);
  }
  return value.trim();
}

function optionalPositiveInteger(name, fallback) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return parsed;
}
