#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmod,
  chown,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = new Set(process.argv.slice(2));

if (arguments_.has("--help")) {
  console.log(`
Usage: sudo ./setup-intake.sh

Installs and restarts the supervised Open Collective charge-level intake and
public-ledger publisher. Set INDIEMATH_ENV_FILE to use an environment file other than
/etc/indiemath/indiemath.env.
`.trim());
  process.exit(0);
}
if (arguments_.size > 0) fail(`Unknown option(s): ${[...arguments_].join(", ")}`);
if (typeof process.getuid !== "function" || process.getuid() !== 0) {
  fail("Run this bootstrap as root: sudo ./setup-intake.sh");
}
if (process.platform !== "linux") {
  fail("Intake service setup must run on the Linux deployment host.");
}

const environmentPath = absolutePath(
  process.env.INDIEMATH_ENV_FILE ?? "/etc/indiemath/indiemath.env",
  "INDIEMATH_ENV_FILE",
);
const environmentStat = await stat(environmentPath).catch(() => undefined);
if (!environmentStat?.isFile()) {
  fail(`Intake environment file does not exist: ${environmentPath}.`);
}
const serviceUser = process.env.INDIEMATH_SERVICE_USER ?? "indiemath";
if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(serviceUser)) {
  fail("INDIEMATH_SERVICE_USER is not a valid local user.");
}
commandOutput("id", ["-u", serviceUser]);
const serviceGroup = commandOutput("id", ["-gn", serviceUser]);
const nodeBinary = commandOutput("which", ["node"]);
const systemctlBinary = commandOutput("which", ["systemctl"]);

let unit = await readFile(
  path.join(rootDir, "ops", "indiemath-intake.service"),
  "utf8",
);
unit = replaceUnitDirective(unit, "User", serviceUser);
unit = replaceUnitDirective(unit, "Group", serviceGroup);
unit = replaceUnitDirective(unit, "WorkingDirectory", rootDir);
unit = replaceUnitDirective(unit, "EnvironmentFile", environmentPath);
unit = replaceUnitDirective(
  unit,
  "ExecStart",
  `${nodeBinary} ${path.join(rootDir, "scripts", "run-open-collective-intake.mjs")}`,
);
const installedUnitPath = "/etc/systemd/system/indiemath-intake.service";
await atomicWrite(installedUnitPath, unit, 0o644);

execFileSync(systemctlBinary, ["daemon-reload"], { stdio: "inherit" });
execFileSync(
  systemctlBinary,
  ["enable", "indiemath-intake.service"],
  { stdio: "inherit" },
);
execFileSync(
  systemctlBinary,
  ["restart", "indiemath-intake.service"],
  { stdio: "inherit" },
);
console.log(
  `Enabled Open Collective intake and publisher from ${rootDir} as ${serviceUser}.`,
);

function absolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    fail(`${label} must be an absolute path.`);
  }
  const normalized = path.normalize(value);
  if (normalized === "/") fail(`${label} cannot be the filesystem root.`);
  return normalized;
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
