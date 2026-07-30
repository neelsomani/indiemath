#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmod,
  chown,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  parseWorkerConfig,
  parseWorkerCount,
  validateWorkerFleet,
  WORKER_IDS,
  workerIdsForCount,
} from "#indiemath/shared";
import { createR2Client } from "#indiemath/r2";
import {
  PRIOR_RESEARCH_MANIFEST_KEY,
  verifyPriorResearchContexts,
} from "#indiemath/workers";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = new Set(process.argv.slice(2));
const checkOnly = arguments_.delete("--check");

if (arguments_.has("--help")) {
  console.log(`
Usage: sudo ./setup-workers.sh [--check]

Reads WORKER_COUNT (1–4, default 4) and validates one unique worker API key for
each active worker from the protected IndieMath environment.
Without --check, verifies the preserved prior-research contexts in R2, writes
one root-only environment per
active worker, installs the systemd template, enables and restarts worker-1
through worker-N, and stops and disables any surplus worker services. Common
service settings load from /etc/indiemath/indiemath.env; staging secrets load
only from /etc/indiemath/workers.env.
`.trim());
  process.exit(0);
}
if (arguments_.size > 0) fail(`Unknown option(s): ${[...arguments_].join(", ")}`);
if (typeof process.getuid !== "function" || process.getuid() !== 0) {
  fail("Run this bootstrap as root: sudo ./setup-workers.sh");
}
if (process.platform !== "linux") {
  fail("Worker service setup must run on the Linux deployment host.");
}

const environmentPath = absolutePath(
  process.env.INDIEMATH_ENV_FILE ?? "/etc/indiemath/indiemath.env",
  "INDIEMATH_ENV_FILE",
);
const environmentStat = await stat(environmentPath).catch(() => undefined);
if (!environmentStat?.isFile()) {
  fail(`Worker environment file does not exist: ${environmentPath}.`);
}
const workerEnvironmentPath = absolutePath(
  process.env.INDIEMATH_WORKER_ENV_FILE ?? "/etc/indiemath/workers.env",
  "INDIEMATH_WORKER_ENV_FILE",
);
const workerEnvironmentStat = await stat(workerEnvironmentPath)
  .catch(() => undefined);
if (!workerEnvironmentStat?.isFile()) {
  fail(`Worker credential file does not exist: ${workerEnvironmentPath}.`);
}
const workerCount = parseWorkerCount(process.env.WORKER_COUNT?.trim() || "4");
const activeWorkerIds = workerIdsForCount(workerCount);
const workerEnvironments = activeWorkerIds.map(workerEnvironment);
const workerConfigs = workerEnvironments.map(parseWorkerConfig);
validateWorkerFleet(workerConfigs, { workerCount });
console.log(
  `Validated ${workerCount} unique IndieMath worker `
    + `${workerCount === 1 ? "identity and Anthropic key" : "identities and Anthropic keys"}.`,
);
if (checkOnly) process.exit(0);

const researchStore = createR2Client({ config: workerConfigs[0] });
const priorResearchManifest = JSON.parse(
  await (await researchStore.getObject(PRIOR_RESEARCH_MANIFEST_KEY)).text(),
);
const priorResearch = await verifyPriorResearchContexts({
  r2: researchStore,
  manifest: priorResearchManifest,
});
console.log(
  `Verified ${priorResearch.total} preserved prior-research contexts in R2.`,
);

const serviceUser = process.env.INDIEMATH_SERVICE_USER ?? "indiemath";
if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(serviceUser)) {
  fail("INDIEMATH_SERVICE_USER is not a valid local user.");
}
commandOutput("id", ["-u", serviceUser]);
const serviceGroup = commandOutput("id", ["-gn", serviceUser]);
const nodeBinary = commandOutput("which", ["node"]);
const systemctlBinary = commandOutput("which", ["systemctl"]);
const workerEnvironmentDirectory = "/etc/indiemath/workers";
await mkdir(workerEnvironmentDirectory, { recursive: true, mode: 0o700 });
await chmod(workerEnvironmentDirectory, 0o700);
await chown(workerEnvironmentDirectory, 0, 0);

for (const environment of workerEnvironments) {
  const destination = path.join(
    workerEnvironmentDirectory,
    `${environment.WORKER_ID}.env`,
  );
  await atomicWrite(
    destination,
    renderEnvironment(environment),
    0o600,
  );
}

let unit = await readFile(
  path.join(rootDir, "ops", "indiemath-worker@.service"),
  "utf8",
);
unit = replaceUnitDirective(unit, "User", serviceUser);
unit = replaceUnitDirective(unit, "Group", serviceGroup);
unit = replaceUnitDirective(unit, "WorkingDirectory", rootDir);
unit = replaceUnitDirective(
  unit,
  "ExecStart",
  `${nodeBinary} ${path.join(rootDir, "scripts", "run-worker.mjs")}`,
);
const databaseDirectory = path.dirname(
  absolutePath(required("INDIEMATH_DB"), "INDIEMATH_DB"),
);
unit = replaceUnitDirective(unit, "ReadWritePaths", databaseDirectory);
const installedUnitPath = "/etc/systemd/system/indiemath-worker@.service";
await atomicWrite(installedUnitPath, unit, 0o644);

execFileSync(systemctlBinary, ["daemon-reload"], { stdio: "inherit" });
for (const workerId of activeWorkerIds) {
  const service = `indiemath-worker@${workerId}.service`;
  execFileSync(systemctlBinary, ["enable", service], { stdio: "inherit" });
  execFileSync(systemctlBinary, ["restart", service], { stdio: "inherit" });
}
for (const workerId of WORKER_IDS.filter(
  (candidate) => !activeWorkerIds.includes(candidate),
)) {
  const service = `indiemath-worker@${workerId}.service`;
  execFileSync(
    systemctlBinary,
    ["disable", "--now", service],
    { stdio: "inherit" },
  );
  await unlink(path.join(workerEnvironmentDirectory, `${workerId}.env`))
    .catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
}
console.log(
  `Enabled ${workerCount} supervised IndieMath `
    + `${workerCount === 1 ? "worker" : "workers"} from ${rootDir} as ${serviceUser}.`,
);

function workerEnvironment(workerId) {
  const suffix = workerId.slice("worker-".length);
  const environment = {
    INDIEMATH_RUNTIME: required("INDIEMATH_RUNTIME"),
    INDIEMATH_DB: required("INDIEMATH_DB"),
    R2_ENDPOINT: required("R2_ENDPOINT"),
    R2_BUCKET: required("R2_BUCKET"),
    R2_ACCESS_KEY_ID: required("R2_ACCESS_KEY_ID"),
    R2_SECRET_ACCESS_KEY: required("R2_SECRET_ACCESS_KEY"),
    WORKER_ID: workerId,
    ANTHROPIC_API_KEY: required(`WORKER_${suffix}_ANTHROPIC_API_KEY`),
  };
  const runsPausedReason = process.env.INDIEMATH_RUNS_PAUSED_REASON?.trim();
  if (runsPausedReason) {
    environment.INDIEMATH_RUNS_PAUSED_REASON = runsPausedReason;
  }
  return Object.freeze(environment);
}

function renderEnvironment(environment) {
  return [
    "# Generated by setup-workers.sh. Do not edit or commit.",
    ...Object.entries(environment).map(([name, value]) => (
      `${name}=${environmentFileValue(value, name)}`
    )),
    "",
  ].join("\n");
}

function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !value.trim()) {
    fail(`Missing required worker configuration: ${name}.`);
  }
  return value.trim();
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    fail(`${label} must be an absolute path.`);
  }
  const normalized = path.normalize(value);
  if (normalized === "/") fail(`${label} cannot be the filesystem root.`);
  return normalized;
}

function environmentFileValue(value, label) {
  const text = String(value);
  if (!text || /[\r\n\0]/.test(text)) {
    fail(`${label} cannot be represented in a systemd environment file.`);
  }
  return JSON.stringify(text);
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    fail(`Required command or account is unavailable: ${command} ${args.join(" ")}.`);
  }
}

async function atomicWrite(destination, body, mode) {
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode });
    await chmod(temporary, mode);
    await chown(temporary, 0, 0);
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function replaceUnitDirective(unit, directive, value) {
  const pattern = new RegExp(`^${directive}=.*$`, "m");
  if (!pattern.test(unit)) fail(`Service template is missing ${directive}.`);
  return unit.replace(pattern, `${directive}=${value}`);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
