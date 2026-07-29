#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCatalog, validateCatalog } from "./catalog-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [area, command, ...args] = process.argv.slice(2);

try {
  const options = area === "open-collective" && command === "tiers"
    ? parseOptions(args.slice(1))
    : parseOptions(args);
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
      const syncTiers = openCollectiveEnvironmentConfigured();
      const catalog = validateCatalog(await readCatalog(catalogPath));
      const { syncCatalog } = await import("./catalog-ledger.mjs");
      const result = await syncCatalog({ catalog, databasePath });
      console.log(
        `Catalog ${result.outcome}: revision ${result.catalog_revision}, `
        + `${result.problem_count} entries, ${result.added} added, ${result.updated} updated.`,
      );
      if (syncTiers) {
        const [
          { syncOpenCollectiveTiers },
          { openLedger },
          { createOpenCollectiveClient },
        ] = await Promise.all([
          import("#indiemath/admin-cli"),
          import("#indiemath/ledger"),
          import("#indiemath/open-collective"),
        ]);
        const ledger = await openLedger({ databasePath });
        try {
          const tierResult = await syncOpenCollectiveTiers({
            catalog,
            ledger,
            openCollective: createOpenCollectiveClient({
              kind: "graphql",
              endpoint: process.env.OPEN_COLLECTIVE_GRAPHQL_URL,
              collectiveSlug: process.env.OPEN_COLLECTIVE_SLUG,
              apiToken: process.env.OPEN_COLLECTIVE_API_TOKEN,
            }),
          });
          console.log(
            `Open Collective tiers synced: ${tierResult.expectedTierCount} catalog pairs, `
            + `${tierResult.created} created, ${tierResult.updated} updated.`,
          );
        } finally {
          ledger.close();
        }
      }
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
  } else if (area === "open-collective") {
    const [
      { createOpenCollectiveClient },
      { openLedger, readSyncedCatalog },
      {
        executeOpenCollectiveRefund,
        runOpenCollectiveIntakeOnce,
      },
      { syncOpenCollectiveTiers },
    ] = await Promise.all([
      import("#indiemath/open-collective"),
      import("#indiemath/ledger"),
      import("#indiemath/intake-publisher"),
      import("#indiemath/admin-cli"),
    ]);
    const openCollective = createOpenCollectiveClient({
      kind: "graphql",
      endpoint: requiredEnvironment("OPEN_COLLECTIVE_GRAPHQL_URL"),
      collectiveSlug: requiredEnvironment("OPEN_COLLECTIVE_SLUG"),
      apiToken: requiredEnvironment("OPEN_COLLECTIVE_API_TOKEN"),
    });
    const ledger = await openLedger({ databasePath });
    try {
      switch (command) {
      case "tiers": {
        const subcommand = args[0];
        if (subcommand !== "sync") {
          usage(`Unknown open-collective tiers command: ${subcommand ?? "<missing>"}.`);
        }
        rejectUnknownOptions(options, ["db"]);
        const catalog = readSyncedCatalog(databasePath);
        const result = await syncOpenCollectiveTiers({
          catalog,
          ledger,
          openCollective,
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "intake": {
        rejectUnknownOptions(options, ["db", "max-pages", "page-size"]);
        const result = await runOpenCollectiveIntakeOnce({
          ledger,
          openCollective,
          ...(options["page-size"]
            ? { pageSize: parsePositiveInteger(options["page-size"], "--page-size") }
            : {}),
          ...(options["max-pages"]
            ? { maxPages: parsePositiveInteger(options["max-pages"], "--max-pages") }
            : {}),
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "refund": {
        rejectUnknownOptions(options, [
          "amount-cents",
          "cancel-recurring",
          "db",
          "message",
          "ref",
          "transaction",
        ]);
        for (const option of ["ref", "transaction"]) {
          if (!options[option]) usage(`open-collective refund requires --${option}.`);
        }
        const result = await executeOpenCollectiveRefund({
          ledger,
          openCollective,
          donationDedupId: options.transaction,
          idempotencyReference: options.ref,
          ...(options["amount-cents"]
            ? {
                requestedAmountCents: parsePositiveInteger(
                  options["amount-cents"],
                  "--amount-cents",
                ),
              }
            : {}),
          ...(options["cancel-recurring"]
            ? {
                cancelRecurringContribution: parseBoolean(
                  options["cancel-recurring"],
                  "--cancel-recurring",
                ),
              }
            : {}),
          ...(options.message ? { message: options.message } : {}),
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "status": {
        rejectUnknownOptions(options, ["db"]);
        const [health, remoteTiers] = await Promise.all([
          openCollective.healthcheck(),
          openCollective.listAllTiers(),
        ]);
        console.log(JSON.stringify({
          health,
          remoteTierCount: remoteTiers.length,
          ledgerTiers: ledger.listOpenCollectiveTiers(),
          checkpoint: ledger.getIntakeCheckpoint(
            "open-collective-contribution-credits",
          ),
        }, null, 2));
        break;
      }

      default:
        usage(`Unknown open-collective command: ${command ?? "<missing>"}.`);
      }
    } finally {
      ledger.close();
    }
  } else if (area === "stripe") {
    rejectUnknownOptions(options, [
      "amount-cents",
      "db",
      "page-size",
      "ref",
      "through",
      "transaction",
    ]);
    const [{ StripeClient }, { openLedger }, {
      executeStripeRefund,
      reconcileStripeSettlements,
      runStripeDisputeIntakeOnce,
    }] = await Promise.all([
      import("#indiemath/stripe"),
      import("#indiemath/ledger"),
      import("#indiemath/intake-publisher"),
    ]);
    const stripe = new StripeClient({
      secretKey: requiredEnvironment("STRIPE_SECRET_KEY"),
      accountId: process.env.STRIPE_ACCOUNT_ID?.trim() || undefined,
    });
    const ledger = await openLedger({ databasePath });
    try {
      switch (command) {
      case "refund": {
        rejectUnknownOptions(options, ["amount-cents", "db", "ref", "transaction"]);
        for (const option of ["ref", "transaction"]) {
          if (!options[option]) usage(`stripe refund requires --${option}.`);
        }
        const result = await executeStripeRefund({
          ledger,
          stripe,
          donationDedupId: options.transaction,
          idempotencyReference: options.ref,
          ...(options["amount-cents"]
            ? {
                requestedAmountCents: parsePositiveInteger(
                  options["amount-cents"],
                  "--amount-cents",
                ),
              }
            : {}),
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "disputes": {
        rejectUnknownOptions(options, ["db", "page-size", "through"]);
        const result = await runStripeDisputeIntakeOnce({
          ledger,
          stripe,
          ...(options.through ? { through: options.through } : {}),
          ...(options["page-size"]
            ? { pageSize: parsePositiveInteger(options["page-size"], "--page-size") }
            : {}),
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "reconcile": {
        rejectUnknownOptions(options, ["db", "page-size", "through"]);
        const result = await reconcileStripeSettlements({
          ledger,
          stripe,
          ...(options.through ? { through: options.through } : {}),
          ...(options["page-size"]
            ? { pageSize: parsePositiveInteger(options["page-size"], "--page-size") }
            : {}),
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "status":
        rejectUnknownOptions(options, ["db"]);
        console.log(JSON.stringify(await stripe.healthcheck(), null, 2));
        break;

      default:
        usage(`Unknown stripe command: ${command ?? "<missing>"}.`);
      }
    } finally {
      ledger.close();
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

function parseBoolean(value, label) {
  if (value === "true") return true;
  if (value === "false") return false;
  usage(`${label} must be true or false.`);
}

function requiredEnvironment(key) {
  const value = process.env[key];
  if (typeof value !== "string" || !value.trim()) {
    usage(`${key} is required.`);
  }
  return value.trim();
}

function openCollectiveEnvironmentConfigured() {
  const keys = [
    "OPEN_COLLECTIVE_GRAPHQL_URL",
    "OPEN_COLLECTIVE_SLUG",
    "OPEN_COLLECTIVE_API_TOKEN",
  ];
  const present = keys.filter((key) => (
    typeof process.env[key] === "string" && process.env[key].trim()
  ));
  if (present.length > 0 && present.length < keys.length) {
    usage(
      "Catalog tier sync has incomplete Open Collective configuration; "
      + `missing ${keys.filter((key) => !present.includes(key)).join(", ")}.`,
    );
  }
  return present.length === keys.length;
}

function usage(message) {
  if (message) console.error(message);
  console.error(`
Usage:
  ./indiemath catalog validate [--catalog <path>]
  ./indiemath catalog sync [--catalog <path>] [--db <path>]
  ./indiemath catalog status [--db <path>]
  ./indiemath catalog export --output <path> [--db <path>]
  ./indiemath open-collective tiers sync [--db <path>]
  ./indiemath open-collective intake [--db <path>] [--page-size <n>] [--max-pages <n>]
  ./indiemath open-collective status [--db <path>]
  ./indiemath open-collective refund --transaction <transaction-id> --ref <id> \\
    [--amount-cents <n>] [--cancel-recurring <true|false>] [--message <text>] [--db <path>]
  ./indiemath stripe refund --transaction <transaction-id> --ref <id> \\
    [--amount-cents <n>] [--db <path>]
  ./indiemath stripe disputes [--through <timestamp>] [--page-size <n>] [--db <path>]
  ./indiemath stripe reconcile [--through <timestamp>] [--page-size <n>] [--db <path>]
  ./indiemath stripe status [--db <path>]
  ANTHROPIC_ADMIN_API_KEY=... ./indiemath anthropic reconcile \\
    --problem <id> --direction <prove|disprove> --claim-ts <epoch-ms> \\
    --api-key-id <id> [--db <path>] [--pricing <path>] [--tolerance-cents <n>]
`.trim());
  process.exit(2);
}
