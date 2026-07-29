#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCatalog, validateCatalog } from "./catalog-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [area, command, ...args] = process.argv.slice(2);

try {
  if (area !== "catalog") usage("Expected the catalog command group.");

  const options = parseOptions(args);
  const catalogPath = resolveFromRoot(options.catalog ?? "problems/catalog.json");
  const databasePath = resolveFromRoot(
    options.db ?? process.env.INDIEMATH_DB ?? "data/indiemath.sqlite",
  );

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

function usage(message) {
  if (message) console.error(message);
  console.error(`
Usage:
  ./indiemath catalog validate [--catalog <path>]
  ./indiemath catalog sync [--catalog <path>] [--db <path>]
  ./indiemath catalog status [--db <path>]
  ./indiemath catalog export --output <path> [--db <path>]
`.trim());
  process.exit(2);
}
