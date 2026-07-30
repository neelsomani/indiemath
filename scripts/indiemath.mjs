#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDollarAmount } from "#indiemath/shared";
import {
  diffCatalogs,
  readCatalog,
  validateCatalog,
} from "./catalog-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [area, command, ...args] = process.argv.slice(2);

try {
  const treasuryAmount = area === "treasury" && command === "fund"
    ? args[0]
    : undefined;
  const optionArguments = area === "open-collective" && command === "tiers"
    ? args.slice(1)
    : area === "treasury" && command === "fund"
      ? args.slice(1)
      : args;
  const options = parseOptions(optionArguments, {
    booleanOptions: area === "treasury" && command === "fund"
      ? ["owner-prefunded"]
      : [],
  });
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

    case "diff": {
      rejectUnknownOptions(options, ["base", "catalog", "db"]);
      if (options.base && options.db) {
        usage("catalog diff accepts only one of --base or --db.");
      }
      const candidate = validateCatalog(await readCatalog(catalogPath));
      let base;
      if (options.base) {
        base = validateCatalog(await readCatalog(resolveFromRoot(options.base)));
      } else {
        const { readSyncedCatalog } = await import("./catalog-ledger.mjs");
        base = validateCatalog(readSyncedCatalog(databasePath));
      }
      const result = diffCatalogs(base, candidate);
      console.log(JSON.stringify(result, null, 2));
      if (!result.safeToSync) process.exitCode = 1;
      break;
    }

    case "tiers": {
      rejectUnknownOptions(options, ["catalog"]);
      const catalog = validateCatalog(await readCatalog(catalogPath));
      const { buildOpenCollectiveTierSpecification } = await import(
        "#indiemath/admin-cli"
      );
      const tiers = catalog.problems.flatMap((problem) => (
        ["prove", "disprove"].map((direction) => (
          buildOpenCollectiveTierSpecification(problem, direction)
        ))
      ));
      console.log(JSON.stringify({
        catalogRevision: catalog.catalog_revision,
        tierCount: tiers.length,
        tiers,
      }, null, 2));
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
  } else if (area === "review") {
    if (!["unconditional", "conditional", "rejected"].includes(command)) {
      usage(`Unknown review verdict: ${command ?? "<missing>"}.`);
    }
    rejectUnknownOptions(options, [
      "approve-direction",
      "assumption",
      "db",
      "note-file",
      "note-uri",
      "problem",
      "reject-all",
      "review-ts",
    ]);
    if (!options.problem) usage("review requires --problem <id>.");
    if (!options["note-file"] && !options["note-uri"]) {
      usage("review requires --note-file <path> or --note-uri <r2-uri>.");
    }
    if (options["note-file"] && options["note-uri"]) {
      usage("review accepts only one of --note-file or --note-uri.");
    }
    if (options["note-file"] && !options["review-ts"]) {
      usage("review with --note-file requires --review-ts <epoch-ms>.");
    }
    if (command === "conditional" && !options.assumption) {
      usage("conditional review requires --assumption <label>.");
    }
    const [
      { applyReviewVerdict },
      { openLedger },
    ] = await Promise.all([
      import("#indiemath/admin-cli"),
      import("#indiemath/ledger"),
    ]);
    const ledger = await openLedger({ databasePath });
    try {
      const result = await applyReviewVerdict({
        ledger,
        r2: await createArtifactR2(),
        problemId: options.problem,
        verdict: command,
        ...(options["note-file"]
          ? { noteFile: resolveFromRoot(options["note-file"]) }
          : { noteUri: options["note-uri"] }),
        ...(options["review-ts"]
          ? {
              reviewTs: parsePositiveInteger(
                options["review-ts"],
                "--review-ts",
              ),
            }
          : {}),
        ...(options.assumption ? { assumptionLabel: options.assumption } : {}),
        ...(options["approve-direction"]
          ? { approveDirection: options["approve-direction"] }
          : {}),
        ...(options["reject-all"]
          ? { rejectAll: parseBoolean(options["reject-all"], "--reject-all") }
          : {}),
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      ledger.close();
    }
  } else if (area === "open-collective") {
    const [
      { createOpenCollectiveClient },
      { openLedger, readSyncedCatalog },
      {
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

      case "reconcile": {
        rejectUnknownOptions(options, [
          "db",
          "page-size",
          "since",
          "through",
        ]);
        const { reconcileOpenCollectiveCredits } = await import(
          "#indiemath/admin-cli"
        );
        const result = await reconcileOpenCollectiveCredits({
          ledger,
          openCollective,
          ...(options.since ? { since: options.since } : {}),
          ...(options.through ? { through: options.through } : {}),
          ...(options["page-size"]
            ? { pageSize: parsePositiveInteger(options["page-size"], "--page-size") }
            : {}),
        });
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
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
      ...(process.env.STRIPE_API_BASE_URL?.trim()
        ? { baseUrl: process.env.STRIPE_API_BASE_URL.trim() }
        : {}),
    });
    const ledger = await openLedger({ databasePath });
    try {
      switch (command) {
      case "refund": {
        rejectUnknownOptions(options, ["db", "ref", "transaction"]);
        for (const option of ["ref", "transaction"]) {
          if (!options[option]) usage(`stripe refund requires --${option}.`);
        }
        const result = await executeStripeRefund({
          ledger,
          stripe,
          donationDedupId: options.transaction,
          idempotencyReference: options.ref,
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
  } else if (area === "refund") {
    const { openLedger } = await import("#indiemath/ledger");
    const ledger = await openLedger({ databasePath });
    try {
      switch (command) {
      case "quote": {
        rejectUnknownOptions(options, ["db", "transaction"]);
        if (!options.transaction) usage("refund quote requires --transaction <id>.");
        const result = ledger.quoteRefund({
          donationDedupId: options.transaction,
        });
        console.log(JSON.stringify(result, null, 2));
        if (!result.eligible) process.exitCode = 1;
        break;
      }

      case "begin": {
        rejectUnknownOptions(options, [
          "db",
          "ref",
          "transaction",
        ]);
        requireOptions(options, ["ref", "transaction"], "refund begin");
        const result = ledger.beginRefund({
          donationDedupId: options.transaction,
          idempotencyReference: options.ref,
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "status": {
        rejectUnknownOptions(options, ["db", "ref", "transaction"]);
        if (Boolean(options.ref) === Boolean(options.transaction)) {
          usage("refund status requires exactly one of --ref or --transaction.");
        }
        if (options.ref) {
          const adjustment = ledger.getAdjustment(options.ref);
          console.log(JSON.stringify({
            adjustment,
            donation: ledger.getDonation(adjustment.donationDedupId),
          }, null, 2));
        } else {
          const state = ledger.inspect();
          const adjustments = state.adjustments.filter((adjustment) => (
            adjustment.reasonCode === "refund"
            && adjustment.donationDedupId === options.transaction
          ));
          console.log(JSON.stringify({
            donation: ledger.getDonation(options.transaction),
            adjustments,
          }, null, 2));
        }
        break;
      }

      case "retry": {
        rejectUnknownOptions(options, [
          "db",
          "ref",
          "transaction",
        ]);
        requireOptions(
          options,
          ["ref", "transaction"],
          "refund retry",
        );
        const { executeStripeRefund } = await import(
          "#indiemath/intake-publisher"
        );
        const result = await executeStripeRefund({
          ledger,
          stripe: await createStripe(),
          donationDedupId: options.transaction,
          idempotencyReference: options.ref,
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "complete": {
        rejectUnknownOptions(options, ["db", "provider-ref", "ref"]);
        requireOptions(options, ["provider-ref", "ref"], "refund complete");
        console.log(JSON.stringify(ledger.completeRefund({
          idempotencyReference: options.ref,
          providerReference: options["provider-ref"],
        }), null, 2));
        break;
      }

      case "cancel": {
        rejectUnknownOptions(options, ["db", "note", "ref"]);
        requireOptions(options, ["note", "ref"], "refund cancel");
        console.log(JSON.stringify(ledger.cancelRefund({
          idempotencyReference: options.ref,
          note: options.note,
        }), null, 2));
        break;
      }

      default:
        usage(`Unknown refund command: ${command ?? "<missing>"}.`);
      }
    } finally {
      ledger.close();
    }
  } else if (area === "dispute") {
    if (command !== "enter") {
      usage(`Unknown dispute command: ${command ?? "<missing>"}.`);
    }
    rejectUnknownOptions(options, [
      "amount-cents",
      "db",
      "note",
      "ref",
      "transaction",
    ]);
    requireOptions(options, ["ref", "transaction"], "dispute enter");
    const { openLedger } = await import("#indiemath/ledger");
    const ledger = await openLedger({ databasePath });
    try {
      console.log(JSON.stringify(ledger.dispute({
        donationDedupId: options.transaction,
        externalReference: options.ref,
        ...(options["amount-cents"]
          ? {
              amountCents: parsePositiveInteger(
                options["amount-cents"],
                "--amount-cents",
              ),
            }
          : {}),
        ...(options.note ? { note: options.note } : {}),
      }), null, 2));
    } finally {
      ledger.close();
    }
  } else if (area === "treasury") {
    let treasuryFundAmountCents;
    if (command === "status") {
      rejectUnknownOptions(options, ["db", "page-size", "through"]);
    } else if (command === "fund") {
      rejectUnknownOptions(options, [
        "db",
        "owner-prefunded",
        "page-size",
        "ref",
        "through",
      ]);
      if (!treasuryAmount || treasuryAmount.startsWith("--")) {
        usage("treasury fund requires a positive dollar amount.");
      }
      if (!options.ref) usage("treasury fund requires --ref <id>.");
      try {
        treasuryFundAmountCents = parseDollarAmount(treasuryAmount);
      } catch (error) {
        usage(error.message);
      }
      if (treasuryFundAmountCents === 0) {
        usage("treasury fund amount must be positive.");
      }
    } else {
      usage(`Unknown treasury command: ${command ?? "<missing>"}.`);
    }
    const [
      {
        fundTreasuryFromReconciliation,
        refreshTreasuryStatus,
      },
      { openLedger },
      { StripeClient },
    ] = await Promise.all([
      import("#indiemath/admin-cli"),
      import("#indiemath/ledger"),
      import("#indiemath/stripe"),
    ]);
    const stripe = new StripeClient({
      secretKey: requiredEnvironment("STRIPE_SECRET_KEY"),
      accountId: requiredEnvironment("STRIPE_ACCOUNT_ID"),
      ...(process.env.STRIPE_API_BASE_URL?.trim()
        ? { baseUrl: process.env.STRIPE_API_BASE_URL.trim() }
        : {}),
    });
    const ledger = await openLedger({ databasePath });
    try {
      switch (command) {
      case "status": {
        const result = await refreshTreasuryStatus({
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

      case "fund": {
        const result = await fundTreasuryFromReconciliation({
          ledger,
          stripe,
          amountCents: treasuryFundAmountCents,
          externalReference: options.ref,
          ownerPrefunded: options["owner-prefunded"] === true,
          ...(options.through ? { through: options.through } : {}),
          ...(options["page-size"]
            ? { pageSize: parsePositiveInteger(options["page-size"], "--page-size") }
            : {}),
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      }
    } finally {
      ledger.close();
    }
  } else if (area === "inspect") {
    rejectUnknownOptions(options, [
      "db",
      "direction",
      "outcome",
      "problem",
      "reason",
      "ref",
      "status",
      "transaction",
      "worker",
    ]);
    const [
      { inspectLedger },
      { openLedger },
    ] = await Promise.all([
      import("#indiemath/admin-cli"),
      import("#indiemath/ledger"),
    ]);
    const ledger = await openLedger({ databasePath });
    try {
      const result = inspectLedger({
        ledger,
        entity: command,
        filters: {
          problemId: options.problem,
          direction: options.direction,
          status: options.status,
          transaction: options.transaction,
          reference: options.ref,
          workerId: options.worker,
          outcome: options.outcome,
          reason: options.reason,
        },
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      ledger.close();
    }
  } else if (area === "sweep") {
    rejectUnknownOptions(options, ["db", "problem"]);
    if (!["all", "problem"].includes(command)) {
      usage(`Unknown sweep command: ${command ?? "<missing>"}.`);
    }
    if (command === "problem" && !options.problem) {
      usage("sweep problem requires --problem <id>.");
    }
    if (command === "all" && options.problem) {
      usage("sweep all does not accept --problem.");
    }
    const { openLedger } = await import("#indiemath/ledger");
    const ledger = await openLedger({ databasePath });
    try {
      const result = command === "all"
        ? ledger.sweepSolvedProblems()
        : ledger.sweep({ problemId: options.problem });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      ledger.close();
    }
  } else if (area === "backup") {
    const {
      createLedgerBackup,
      restoreLocalLedgerBackup,
      verifyLedgerDatabase,
    } = await import("#indiemath/admin-cli");
    switch (command) {
    case "create": {
      rejectUnknownOptions(options, ["db", "output"]);
      if (!options.output) usage("backup create requires --output <path>.");
      console.log(JSON.stringify(await createLedgerBackup({
        databasePath,
        outputPath: resolveFromRoot(options.output),
      }), null, 2));
      break;
    }

    case "verify": {
      rejectUnknownOptions(options, ["file"]);
      if (!options.file) usage("backup verify requires --file <path>.");
      console.log(JSON.stringify(
        await verifyLedgerDatabase(resolveFromRoot(options.file)),
        null,
        2,
      ));
      break;
    }

    case "restore": {
      rejectUnknownOptions(options, [
        "db",
        "output",
        "source",
        "timestamp",
      ]);
      if (!options.output) usage("backup restore requires --output <path>.");
      const outputPath = resolveFromRoot(options.output);
      if (options.source) {
        if (options.timestamp) {
          usage("backup restore --timestamp is valid only for the R2 replica.");
        }
        console.log(JSON.stringify(await restoreLocalLedgerBackup({
          backupPath: resolveFromRoot(options.source),
          outputPath,
          liveDatabasePath: databasePath,
        }), null, 2));
      } else {
        const restoreArguments = [outputPath];
        if (options.timestamp) restoreArguments.push(options.timestamp);
        execFileSync(
          path.join(rootDir, "scripts", "restore-ledger.sh"),
          restoreArguments,
          {
            env: {
              ...process.env,
              INDIEMATH_DB_PATH: databasePath,
            },
            stdio: "inherit",
          },
        );
      }
      break;
    }

    default:
      usage(`Unknown backup command: ${command ?? "<missing>"}.`);
    }
  } else if (area === "ramp") {
    if (!["status", "sync"].includes(command)) {
      usage(`Unknown Ramp command: ${command ?? "<missing>"}.`);
    }
    rejectUnknownOptions(options, command === "sync"
      ? ["base-url", "db", "through"]
      : ["db"]);
    const { openLedger } = await import("#indiemath/ledger");
    const ledger = await openLedger({ databasePath });
    try {
      if (command === "status") {
        console.log(JSON.stringify(
          ledger.latestRampSpendSnapshot() ?? { status: "not-synced" },
          null,
          2,
        ));
      } else {
        const [
          { syncRampSpendOnce },
          { RampClient },
        ] = await Promise.all([
          import("#indiemath/intake-publisher"),
          import("#indiemath/ramp"),
        ]);
        console.log(JSON.stringify(await syncRampSpendOnce({
          ledger,
          ramp: new RampClient({
            clientId: requiredEnvironment("RAMP_CLIENT_ID"),
            clientSecret: requiredEnvironment("RAMP_CLIENT_SECRET"),
            baseUrl: options["base-url"]
              ?? process.env.RAMP_API_BASE_URL
              ?? "https://api.ramp.com",
          }),
          cardId: requiredEnvironment("RAMP_CARD_ID"),
          through: options.through ?? new Date(),
        }), null, 2));
      }
    } finally {
      ledger.close();
    }
  } else if (area === "launch" && command === "verify") {
    rejectUnknownOptions(options, [
      "db",
      "evidence",
      "max-intake-lag-seconds",
      "max-publication-lag-seconds",
      "public-data-url",
      "since",
      "site-url",
      "worker-count",
    ]);
    const [
      {
        checkOperationalHealth,
        verifyLaunchReadiness,
        verifyLedgerDatabase,
      },
      { openLedger },
    ] = await Promise.all([
      import("#indiemath/admin-cli"),
      import("#indiemath/ledger"),
    ]);
    const evidencePath = resolveFromRoot(
      options.evidence
        ?? process.env.LAUNCH_EVIDENCE_PATH
        ?? "/var/lib/indiemath/launch-evidence.json",
    );
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    const ledger = await openLedger({ databasePath });
    try {
      const health = await checkOperationalHealth({
        ledger,
        openCollective: await createOpenCollective(),
        publicDataBaseUrl: options["public-data-url"]
          ?? requiredEnvironment("PUBLIC_DATA_BASE_URL"),
        publicSiteUrl: options["site-url"]
          ?? process.env.PUBLIC_SITE_URL?.trim()
          ?? "https://indiemath.ai",
        ...(options["max-intake-lag-seconds"]
          ? {
              maxIntakeLagSeconds: parsePositiveInteger(
                options["max-intake-lag-seconds"],
                "--max-intake-lag-seconds",
              ),
            }
          : {}),
        ...(options["max-publication-lag-seconds"]
          ? {
              maxPublicationLagSeconds: parsePositiveInteger(
                options["max-publication-lag-seconds"],
                "--max-publication-lag-seconds",
              ),
            }
          : {}),
        ...(options.since ? { reconciliationSince: options.since } : {}),
        workerCount: options["worker-count"]
          ? parsePositiveInteger(options["worker-count"], "--worker-count")
          : Number(process.env.WORKER_COUNT?.trim() || "4"),
      });
      const anthropicReports = await Promise.all(
        evidence.anthropicReportPaths.map(async (reportPath) => (
          JSON.parse(await readFile(resolveFromRoot(reportPath), "utf8"))
        )),
      );
      const restoreVerification = await verifyLedgerDatabase(
        resolveFromRoot(evidence.litestreamRestore.databasePath),
      );
      const result = verifyLaunchReadiness({
        ledger,
        health,
        evidence: {
          ...evidence,
          litestreamRestore: {
            ...evidence.litestreamRestore,
            databasePath: resolveFromRoot(
              evidence.litestreamRestore.databasePath,
            ),
          },
        },
        restoreVerification,
        anthropicReports,
        liveDatabasePath: databasePath,
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } finally {
      ledger.close();
    }
  } else if (area === "monitor" && command === "check") {
    rejectUnknownOptions(options, [
      "db",
      "max-intake-lag-seconds",
      "max-publication-lag-seconds",
      "public-data-url",
      "since",
      "site-url",
      "worker-count",
    ]);
    const [
      { checkOperationalHealth },
      { openLedger },
    ] = await Promise.all([
      import("#indiemath/admin-cli"),
      import("#indiemath/ledger"),
    ]);
    const ledger = await openLedger({ databasePath });
    try {
      const result = await checkOperationalHealth({
        ledger,
        openCollective: await createOpenCollective(),
        publicDataBaseUrl: options["public-data-url"]
          ?? requiredEnvironment("PUBLIC_DATA_BASE_URL"),
        publicSiteUrl: options["site-url"]
          ?? process.env.PUBLIC_SITE_URL?.trim()
          ?? "https://indiemath.ai",
        ...(options["max-intake-lag-seconds"]
          ? {
              maxIntakeLagSeconds: parsePositiveInteger(
                options["max-intake-lag-seconds"],
                "--max-intake-lag-seconds",
              ),
            }
          : {}),
        ...(options["max-publication-lag-seconds"]
          ? {
              maxPublicationLagSeconds: parsePositiveInteger(
                options["max-publication-lag-seconds"],
                "--max-publication-lag-seconds",
              ),
            }
          : {}),
        ...(options.since ? { reconciliationSince: options.since } : {}),
        workerCount: options["worker-count"]
          ? parsePositiveInteger(options["worker-count"], "--worker-count")
          : Number(process.env.WORKER_COUNT?.trim() || "4"),
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } finally {
      ledger.close();
    }
  } else if (area === "anthropic" && command === "reconcile-spend") {
    rejectUnknownOptions(options, [
      "actual-dollars",
      "db",
      "note",
      "ref",
      "through",
    ]);
    requireOptions(
      options,
      ["actual-dollars", "ref", "through"],
      "anthropic reconcile-spend",
    );
    const { openLedger } = await import("#indiemath/ledger");
    const ledger = await openLedger({ databasePath });
    try {
      console.log(JSON.stringify(ledger.reconcileAnthropicSpend({
        cutoffAt: options.through,
        actualSpendCents: parseDollarAmount(options["actual-dollars"]),
        externalReference: options.ref,
        note: options.note
          ?? "Operator-recorded cumulative Anthropic model-usage spend.",
      }), null, 2));
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

function parseOptions(values, { booleanOptions = [] } = {}) {
  const options = {};
  const booleans = new Set(booleanOptions);
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) usage(`Unexpected argument: ${token}.`);
    const separator = token.indexOf("=");
    const rawName = separator === -1 ? token.slice(2) : token.slice(2, separator);
    const inlineValue = separator === -1 ? undefined : token.slice(separator + 1);
    if (booleans.has(rawName)) {
      if (inlineValue !== undefined) {
        usage(`Option --${rawName} does not accept a value.`);
      }
      if (Object.hasOwn(options, rawName)) {
        usage(`Option --${rawName} was provided twice.`);
      }
      options[rawName] = true;
      continue;
    }
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

function requireOptions(options, required, commandLabel) {
  for (const option of required) {
    if (!options[option]) usage(`${commandLabel} requires --${option}.`);
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

async function createArtifactR2() {
  const { R2Client } = await import("#indiemath/r2");
  return new R2Client({
    endpoint: requiredEnvironment("R2_ENDPOINT"),
    bucket: requiredEnvironment("R2_BUCKET"),
    accessKeyId: requiredEnvironment("R2_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnvironment("R2_SECRET_ACCESS_KEY"),
  });
}

async function createOpenCollective() {
  const { createOpenCollectiveClient } = await import(
    "#indiemath/open-collective"
  );
  return createOpenCollectiveClient({
    kind: "graphql",
    endpoint: requiredEnvironment("OPEN_COLLECTIVE_GRAPHQL_URL"),
    collectiveSlug: requiredEnvironment("OPEN_COLLECTIVE_SLUG"),
    apiToken: requiredEnvironment("OPEN_COLLECTIVE_API_TOKEN"),
  });
}

async function createStripe() {
  const { StripeClient } = await import("#indiemath/stripe");
  return new StripeClient({
    secretKey: requiredEnvironment("STRIPE_SECRET_KEY"),
    accountId: process.env.STRIPE_ACCOUNT_ID?.trim() || undefined,
    ...(process.env.STRIPE_API_BASE_URL?.trim()
      ? { baseUrl: process.env.STRIPE_API_BASE_URL.trim() }
      : {}),
  });
}

function usage(message) {
  if (message) console.error(message);
  console.error(`
Usage:
  ./indiemath catalog validate [--catalog <path>]
  ./indiemath catalog diff [--base <path> | --db <path>] [--catalog <path>]
  ./indiemath catalog tiers [--catalog <path>]
  ./indiemath catalog sync [--catalog <path>] [--db <path>]
  ./indiemath catalog status [--db <path>]
  ./indiemath catalog export --output <path> [--db <path>]
  ./indiemath review <unconditional|conditional|rejected> --problem <id> \\
    (--note-file <path> --review-ts <epoch-ms> | --note-uri <r2-uri>) \\
    [--assumption <label>] [--approve-direction <prove|disprove>] \\
    [--reject-all <true|false>] [--db <path>]
  ./indiemath open-collective tiers sync [--db <path>]
  ./indiemath open-collective intake [--db <path>] [--page-size <n>] [--max-pages <n>]
  ./indiemath open-collective reconcile [--since <timestamp>] \\
    [--through <timestamp>] [--page-size <n>] [--db <path>]
  ./indiemath open-collective status [--db <path>]
  ./indiemath stripe refund --transaction <transaction-id> --ref <id> [--db <path>]
  ./indiemath stripe disputes [--through <timestamp>] [--page-size <n>] [--db <path>]
  ./indiemath stripe reconcile [--through <timestamp>] [--page-size <n>] [--db <path>]
  ./indiemath stripe status [--db <path>]
  ./indiemath refund quote --transaction <transaction-id> [--db <path>]
  ./indiemath refund begin --transaction <transaction-id> --ref <id> [--db <path>]
  ./indiemath refund status (--transaction <transaction-id> | --ref <id>) [--db <path>]
  ./indiemath refund retry --transaction <transaction-id> --ref <id> [--db <path>]
  ./indiemath refund complete --ref <id> --provider-ref <id> [--db <path>]
  ./indiemath refund cancel --ref <id> --note <text> [--db <path>]
  ./indiemath dispute enter --transaction <transaction-id> --ref <id> \\
    [--amount-cents <n>] [--note <text>] [--db <path>]
  ./indiemath treasury status [--through <timestamp>] [--page-size <n>] [--db <path>]
  ./indiemath treasury fund <dollars> --ref <bank-or-ramp-reference> \\
    [--owner-prefunded] [--through <timestamp>] [--page-size <n>] [--db <path>]
  ./indiemath inspect <pools|claims|reviews|donations|adjustments|provider-spend|capacity|all> \\
    [--problem <id>] [--direction <direction>] [--status <status>] \\
    [--transaction <id>] [--ref <id>] [--worker <id>] [--outcome <outcome>] \\
    [--reason <reason>] [--db <path>]
  ./indiemath sweep problem --problem <id> [--db <path>]
  ./indiemath sweep all [--db <path>]
  ./indiemath backup create --output <path> [--db <path>]
  ./indiemath backup verify --file <path>
  ./indiemath backup restore --output <path> [--source <local-backup> | \\
    --timestamp <RFC3339>] [--db <path>]
  ./indiemath ramp sync [--through <timestamp>] [--db <path>]
  ./indiemath ramp status [--db <path>]
  ./indiemath launch verify [--evidence <path>] [--since <timestamp>] \\
    [--public-data-url <url>] [--site-url <url>] [--worker-count <1-4>] \\
    [--db <path>]
  ./indiemath monitor check [--since <timestamp>] \\
    [--max-intake-lag-seconds <n>] [--max-publication-lag-seconds <n>] \\
    [--public-data-url <url>] [--site-url <url>] [--worker-count <1-4>] \\
    [--db <path>]
  ANTHROPIC_ADMIN_API_KEY=... ./indiemath anthropic reconcile \\
    --problem <id> --direction <prove|disprove> --claim-ts <epoch-ms> \\
    --api-key-id <id> [--db <path>] [--pricing <path>] [--tolerance-cents <n>]
  ./indiemath anthropic reconcile-spend --through <timestamp> \\
    --actual-dollars <cumulative-dollars> --ref <statement-or-export-id> \\
    [--note <text>] [--db <path>]
`.trim());
  process.exit(2);
}
