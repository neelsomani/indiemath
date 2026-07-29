#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCatalog, validateCatalog } from "./catalog-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [area, command, ...args] = process.argv.slice(2);

try {
  const options = parseOptions(args);
  const databasePath = resolveFromRoot(
    options.db ?? process.env.INDIEMATH_DB ?? "data/indiemath.sqlite",
  );

  if (area === "catalog") {
    const catalogPath = resolveFromRoot(options.catalog ?? "problems/catalog.json");
    switch (command) {
    case "validate": {
      rejectUnknownOptions(options, ["catalog"]);
      const catalog = validateCatalog(await readCatalog(catalogPath));
      console.log(
        `Valid catalog revision ${catalog.catalog_revision}: ${catalog.problems.length} entries.`,
      );
      break;
    }

    case "sync": {
      rejectUnknownOptions(options, ["catalog", "db"]);
      const catalog = validateCatalog(await readCatalog(catalogPath));
      const { syncCatalog } = await import("./catalog-ledger.mjs");
      const result = await syncCatalog({ catalog, databasePath });
      console.log(
        `Catalog ${result.outcome}: revision ${result.catalog_revision}, `
        + `${result.problem_count} entries, ${result.added} added, ${result.updated} updated.`,
      );
      break;
    }

    case "status": {
      rejectUnknownOptions(options, ["db"]);
      const { readCatalogStatus } = await import("./catalog-ledger.mjs");
      console.log(JSON.stringify(readCatalogStatus(databasePath), null, 2));
      break;
    }

    case "export": {
      rejectUnknownOptions(options, ["db", "output"]);
      if (!options.output) usage("catalog export requires --output <path>.");
      const { readSyncedCatalog } = await import("./catalog-ledger.mjs");
      const outputPath = resolveFromRoot(options.output);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(
        outputPath,
        `${JSON.stringify(readSyncedCatalog(databasePath), null, 2)}\n`,
        "utf8",
      );
      console.log(`Exported synced catalog to ${outputPath}.`);
      break;
    }

    default:
      usage(`Unknown catalog command: ${command ?? "<missing>"}.`);
    }
  } else if (area === "anthropic" && command === "reconcile") {
    rejectUnknownOptions(options, [
      "api-key-id",
      "base-url",
      "claim-ts",
      "db",
      "direction",
      "pricing",
      "problem",
      "tolerance-cents",
    ]);
    for (const option of ["api-key-id", "claim-ts", "direction", "problem"]) {
      if (!options[option]) usage(`anthropic reconcile requires --${option}.`);
    }
    const adminApiKey = process.env.ANTHROPIC_ADMIN_API_KEY;
    if (!adminApiKey) {
      usage("ANTHROPIC_ADMIN_API_KEY is required for anthropic reconcile.");
    }
    const [
      { AnthropicAdminClient, loadAnthropicPricingTable, runClaimUsageReconciliation },
      { openLedger },
    ] = await Promise.all([
      import("#indiemath/anthropic"),
      import("#indiemath/ledger"),
    ]);
    const ledger = await openLedger({ databasePath });
    try {
      const claim = ledger.getClaim({
        problemId: options.problem,
        direction: options.direction,
        claimTs: parsePositiveInteger(options["claim-ts"], "--claim-ts"),
      });
      const pricingTable = await loadAnthropicPricingTable(resolveFromRoot(
        options.pricing ?? "pricing/anthropic.json",
      ));
      const adminClient = new AnthropicAdminClient({
        apiKey: adminApiKey,
        ...(options["base-url"] ? { baseUrl: options["base-url"] } : {}),
      });
      const result = await runClaimUsageReconciliation({
        ledger,
        adminClient,
        claim,
        apiKeyId: options["api-key-id"],
        pricingTable,
        ...(options["tolerance-cents"]
          ? {
              toleranceCents: parseNonnegativeInteger(
                options["tolerance-cents"],
                "--tolerance-cents",
              ),
            }
          : {}),
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.alert) process.exitCode = 1;
    } finally {
      ledger.close();
    }
  } else {
    usage(`Unknown command group or command: ${area ?? "<missing>"} ${command ?? ""}.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function parseOptions(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) usage(`Unexpected argument: ${token}.`);
    const separator = token.indexOf("=");
    const rawName = separator === -1 ? token.slice(2) : token.slice(2, separator);
    const inlineValue = separator === -1 ? undefined : token.slice(separator + 1);
    const value = inlineValue ?? values[index + 1];
    if (!value || (inlineValue === undefined && value.startsWith("--"))) {
      usage(`Missing value for --${rawName}.`);
    }
    if (Object.hasOwn(options, rawName)) usage(`Option --${rawName} was provided twice.`);
    options[rawName] = value;
    if (inlineValue === undefined) index += 1;
  }
  return options;
}

function rejectUnknownOptions(options, allowed) {
  const unexpected = Object.keys(options).filter((option) => !allowed.includes(option));
  if (unexpected.length) {
    usage(`Unknown option(s): ${unexpected.map((item) => `--${item}`).join(", ")}.`);
  }
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    usage(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parseNonnegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    usage(`${label} must be a nonnegative integer.`);
  }
  return parsed;
}

function usage(message) {
  if (message) console.error(message);
  console.error(`
Usage:
  ./indiemath catalog validate [--catalog <path>]
  ./indiemath catalog sync [--catalog <path>] [--db <path>]
  ./indiemath catalog status [--db <path>]
  ./indiemath catalog export --output <path> [--db <path>]
  ANTHROPIC_ADMIN_API_KEY=... ./indiemath anthropic reconcile \\
    --problem <id> --direction <prove|disprove> --claim-ts <epoch-ms> \\
    --api-key-id <id> [--db <path>] [--pricing <path>] [--tolerance-cents <n>]
`.trim());
  process.exit(2);
}
