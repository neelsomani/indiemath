#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  applyReviewVerdict,
  inspectLedger,
  reconcileOpenCollectiveCredits,
} from "#indiemath/admin-cli";
import {
  FakeOpenCollective,
  FakeR2,
} from "#indiemath/fakes";
import { openLedger } from "#indiemath/ledger";
import { runOpenCollectiveIntakeOnce } from "#indiemath/intake-publisher";
import {
  diffCatalogs,
  readCatalog,
  validateCatalog,
} from "./catalog-lib.mjs";
import { syncCatalog } from "./catalog-ledger.mjs";

const execFile = promisify(execFileCallback);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(rootDir, "scripts", "indiemath.mjs");
const catalog = validateCatalog(
  await readCatalog(path.join(rootDir, "problems", "catalog.json")),
);

test("Stage 12 exposes every privileged operation through the CLI", async () => {
  const [cli, runbook, wrapper] = await Promise.all([
    readFile(cliPath, "utf8"),
    readFile(path.join(rootDir, "docs", "ADMIN_RUNBOOK.md"), "utf8"),
    readFile(path.join(rootDir, "indiemath"), "utf8"),
  ]);
  for (const command of [
    "catalog diff",
    "catalog tiers",
    "review <unconditional|conditional|rejected>",
    "open-collective reconcile",
    "refund quote",
    "refund begin",
    "refund status",
    "refund retry",
    "refund complete",
    "refund cancel",
    "dispute enter",
    "inspect <pools|claims|reviews|donations|adjustments|provider-spend|capacity|all>",
    "sweep problem",
    "sweep all",
    "backup create",
    "backup verify",
    "backup restore",
    "ramp sync",
    "ramp status",
    "launch verify",
    "monitor check",
    "anthropic reconcile",
    "anthropic reconcile-spend",
  ]) {
    assert.match(cli, new RegExp(escapeRegExp(command)));
  }
  assert.match(runbook, /## Reviews/);
  assert.match(runbook, /## Refund lifecycle/);
  assert.match(runbook, /## Reconciliation checks/);
  assert.match(runbook, /## Operational monitoring/);
  assert.match(runbook, /## Launch verification/);
  assert.match(runbook, /## Backup and restore/);
  assert.match(wrapper, /\/etc\/indiemath\/litestream\.env/);
  assert.match(wrapper, /"\$\{1:-\}" = "backup"/);
  assert.match(wrapper, /"\$\{2:-\}" = "restore"/);
  assert.doesNotMatch(cli, /admin web|listen\(|createServer\(/);
});

test("catalog diff reports metadata changes and unsafe identity changes", () => {
  const candidate = structuredClone(catalog);
  candidate.catalog_revision += 1;
  candidate.problems[0].title = `${candidate.problems[0].title} revised`;
  const safe = diffCatalogs(catalog, candidate);
  assert.equal(safe.safeToSync, true);
  assert.deepEqual(safe.changed[0].fields, ["title"]);
  assert.equal(safe.changed[0].identityChanged, false);

  const unsafeCandidate = structuredClone(candidate);
  unsafeCandidate.problems[0].statement += " Materially changed.";
  const unsafe = diffCatalogs(catalog, unsafeCandidate);
  assert.equal(unsafe.safeToSync, false);
  assert.equal(unsafe.changed[0].identityChanged, true);

  const omission = structuredClone(catalog);
  omission.catalog_revision += 1;
  omission.problems.splice(0, 1);
  const omitted = diffCatalogs(catalog, omission);
  assert.equal(omitted.safeToSync, true);
  assert.deepEqual(omitted.removed, [catalog.problems[0].id]);
});

test("catalog tier generation is a read-only complete CLI plan", async () => {
  const result = await runCli(["catalog", "tiers"]);
  assert.equal(result.catalogRevision, catalog.catalog_revision);
  assert.equal(result.tierCount, catalog.problems.length * 2);
  assert.equal(
    new Set(result.tiers.map((tier) => `${tier.problemId}/${tier.direction}`)).size,
    result.tierCount,
  );
});

test("refund, dispute, inspection, and sweep CLI commands are safely replayable",
  async (context) => {
    const fixture = await createFixture(context);
    fixture.ledger.donate({
      dedupId: "txn-admin-refund",
      orderId: "order-admin-refund",
      destination: { kind: "general" },
      grossCents: 5_000,
      feesCents: 0,
      netCents: 5_000,
      donorTag: "Ada",
      creditedAt: "2026-08-01T00:00:00.000Z",
      source: { kind: "manual", attribution: "manual", metadata: {} },
    });
    fixture.ledger.donate({
      dedupId: "txn-admin-dispute",
      orderId: "order-admin-dispute",
      destination: { kind: "general" },
      grossCents: 5_000,
      feesCents: 0,
      netCents: 5_000,
      donorTag: "Grace",
      creditedAt: "2026-08-01T00:01:00.000Z",
      source: { kind: "manual", attribution: "manual", metadata: {} },
    });
    fixture.ledger.close();
    fixture.closed = true;

    const common = ["--db", fixture.databasePath];
    await assert.rejects(
      execFile(process.execPath, [
        cliPath,
        "refund",
        "quote",
        "--transaction",
        "txn-admin-refund",
        "--amount-cents",
        "1250",
        ...common,
      ], { env: process.env }),
      /Unknown option.*--amount-cents/,
    );
    const quote = await runCli([
      "refund",
      "quote",
      "--transaction",
      "txn-admin-refund",
      ...common,
    ]);
    assert.equal(quote.eligible, true);
    assert.equal(quote.refundableCents, 5_000);

    const pending = await runCli([
      "refund",
      "begin",
      "--transaction",
      "txn-admin-refund",
      "--ref",
      "refund-admin-1",
      ...common,
    ]);
    assert.equal(pending.outcome, "pending");
    assert.equal(pending.quote.refundableCents, quote.refundableCents);

    const pendingReplay = await runCli([
      "refund",
      "begin",
      "--transaction",
      "txn-admin-refund",
      "--ref",
      "refund-admin-1",
      ...common,
    ]);
    assert.equal(pendingReplay.outcome, "duplicate");

    const status = await runCli([
      "refund",
      "status",
      "--ref",
      "refund-admin-1",
      ...common,
    ]);
    assert.equal(status.adjustment.status, "pending");
    assert.equal(status.donation.dedupId, "txn-admin-refund");

    const canceled = await runCli([
      "refund",
      "cancel",
      "--ref",
      "refund-admin-1",
      "--note",
      "Provider rejected the request.",
      ...common,
    ]);
    assert.equal(canceled.outcome, "canceled");
    const canceledReplay = await runCli([
      "refund",
      "cancel",
      "--ref",
      "refund-admin-1",
      "--note",
      "Provider rejected the request.",
      ...common,
    ]);
    assert.equal(canceledReplay.outcome, "duplicate");

    await runCli([
      "refund",
      "begin",
      "--transaction",
      "txn-admin-refund",
      "--ref",
      "refund-admin-2",
      ...common,
    ]);
    const completed = await runCli([
      "refund",
      "complete",
      "--ref",
      "refund-admin-2",
      "--provider-ref",
      "provider-admin-2",
      ...common,
    ]);
    assert.equal(completed.outcome, "completed");
    const completedReplay = await runCli([
      "refund",
      "complete",
      "--ref",
      "refund-admin-2",
      "--provider-ref",
      "provider-admin-2",
      ...common,
    ]);
    assert.equal(completedReplay.outcome, "duplicate");

    const disputed = await runCli([
      "dispute",
      "enter",
      "--transaction",
      "txn-admin-dispute",
      "--ref",
      "dispute-admin-1",
      "--amount-cents",
      "1000",
      "--note",
      "Lost dispute.",
      ...common,
    ]);
    assert.equal(disputed.outcome, "disputed");
    const disputeReplay = await runCli([
      "dispute",
      "enter",
      "--transaction",
      "txn-admin-dispute",
      "--ref",
      "dispute-admin-1",
      "--amount-cents",
      "1000",
      "--note",
      "Lost dispute.",
      ...common,
    ]);
    assert.equal(disputeReplay.outcome, "duplicate");

    const donations = await runCli([
      "inspect",
      "donations",
      "--transaction",
      "txn-admin-refund",
      ...common,
    ]);
    assert.equal(donations.count, 1);
    assert.equal(donations.rows[0].refundedCents, 5_000);
    const adjustments = await runCli([
      "inspect",
      "adjustments",
      "--reason",
      "refund",
      ...common,
    ]);
    assert.equal(adjustments.count, 2);
    const capacity = await runCli(["inspect", "capacity", ...common]);
    assert.equal(capacity.accounting.balanced, true);
    const sweep = await runCli(["sweep", "all", ...common]);
    assert.equal(sweep.outcome, "unchanged");

    fixture.ledger = await openLedger({ databasePath: fixture.databasePath });
    fixture.closed = false;
    fixture.ledger.assertConservation();
  });

test("review notes and verdicts converge across a lost CLI response", async (context) => {
  const fixture = await createFixture(context);
  const problem = catalog.problems[0];
  fixture.ledger.donate({
    dedupId: "txn-admin-review",
    orderId: "order-admin-review",
    destination: {
      kind: "pool",
      problemId: problem.id,
      direction: "prove",
    },
    grossCents: 5_000,
    feesCents: 0,
    netCents: 5_000,
    donorTag: "Emmy",
    creditedAt: "2026-08-02T00:00:00.000Z",
    source: { kind: "manual", attribution: "manual", metadata: {} },
  });
  fixture.ledger.treasuryFund({
    amountCents: 5_000,
    externalReference: "fund-admin-review",
    settledContributionCents: 5_000,
  });
  const claim = fixture.ledger.claim({
    problemId: problem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
    fundingMode: "pool-only",
  });
  fixture.ledger.resolve({
    ...claim,
    finalSpentCents: 1_000,
    solutionUri: `r2://solutions/${problem.id}/prove/${claim.claimTs}.md`,
  });

  const notePath = path.join(fixture.scratch, "review-note.md");
  await writeFile(notePath, "# Review\n\nValid under P != NP.\n", "utf8");
  const r2 = new FakeR2();
  const input = {
    ledger: fixture.ledger,
    r2,
    problemId: problem.id,
    verdict: "conditional",
    noteFile: notePath,
    reviewTs: 1_786_000_000_000,
    assumptionLabel: "P != NP",
  };
  const first = await applyReviewVerdict(input);
  const replay = await applyReviewVerdict(input);
  assert.equal(first.review.outcome, "conditional");
  assert.equal(replay.review.outcome, "replayed");
  assert.equal(first.noteUri, replay.noteUri);
  assert.equal(r2.calls.filter((call) => (
    call.operation === "putObject" && call.outcome === undefined
  )).length, 1);
  assert.equal(fixture.ledger.getProblem(problem.id).status, "Open");
  assert.equal(
    fixture.ledger.listReviewedResults(problem.id)[0].assumptionLabel,
    "P != NP",
  );
});

test("Open Collective reconciliation is read-only and identifies exact drift",
  async (context) => {
    const fixture = await createFixture(context);
    const transaction = openCollectiveTransaction({
      id: "txn-admin-reconcile",
      orderId: "order-admin-reconcile",
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    const openCollective = new FakeOpenCollective({
      transactions: [transaction],
    });
    await runOpenCollectiveIntakeOnce({
      ledger: fixture.ledger,
      openCollective,
    });
    const before = fixture.ledger.accountingSnapshot();
    const result = await reconcileOpenCollectiveCredits({
      ledger: fixture.ledger,
      openCollective,
      through: "2026-08-04T00:00:00.000Z",
      pageSize: 1,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(fixture.ledger.accountingSnapshot(), before);

    const drift = await reconcileOpenCollectiveCredits({
      ledger: fixture.ledger,
      openCollective: new FakeOpenCollective({
        transactions: [
          transaction,
          openCollectiveTransaction({
            id: "txn-admin-missing",
            orderId: "order-admin-missing",
            createdAt: "2026-08-03T00:01:00.000Z",
          }),
        ],
      }),
      through: "2026-08-04T00:00:00.000Z",
    });
    assert.equal(drift.ok, false);
    assert.deepEqual(drift.missingFromLedger, ["txn-admin-missing"]);
  });

test("backup create, verify, and restore are integrity-checked and replay-safe",
  async (context) => {
    const fixture = await createFixture(context);
    fixture.ledger.donate({
      dedupId: "txn-admin-backup",
      orderId: "order-admin-backup",
      destination: { kind: "general" },
      grossCents: 5_000,
      feesCents: 0,
      netCents: 5_000,
      donorTag: "Sofia",
      creditedAt: "2026-08-04T00:00:00.000Z",
      source: { kind: "manual", attribution: "manual", metadata: {} },
    });
    const backupPath = path.join(fixture.scratch, "backup.sqlite");
    const restoredPath = path.join(fixture.scratch, "restored.sqlite");
    const common = ["--db", fixture.databasePath];
    const created = await runCli([
      "backup",
      "create",
      "--output",
      backupPath,
      ...common,
    ]);
    assert.equal(created.outcome, "created");
    assert.equal(created.verification.ok, true);
    const replay = await runCli([
      "backup",
      "create",
      "--output",
      backupPath,
      ...common,
    ]);
    assert.equal(replay.outcome, "existing");
    assert.equal((await runCli([
      "backup",
      "verify",
      "--file",
      backupPath,
    ])).ok, true);

    const restored = await runCli([
      "backup",
      "restore",
      "--source",
      backupPath,
      "--output",
      restoredPath,
      ...common,
    ]);
    assert.equal(restored.outcome, "restored");
    const restoreReplay = await runCli([
      "backup",
      "restore",
      "--source",
      backupPath,
      "--output",
      restoredPath,
      ...common,
    ]);
    assert.equal(restoreReplay.outcome, "existing");
    const restoredLedger = await openLedger({ databasePath: restoredPath });
    context.after(() => restoredLedger.close());
    assert.deepEqual(
      restoredLedger.accountingSnapshot(),
      fixture.ledger.accountingSnapshot(),
    );

    const otherPath = path.join(fixture.scratch, "other.sqlite");
    await syncCatalog({ catalog, databasePath: otherPath });
    const otherLedger = await openLedger({ databasePath: otherPath });
    otherLedger.donate({
      dedupId: "txn-admin-other-backup",
      orderId: "order-admin-other-backup",
      destination: { kind: "general" },
      grossCents: 1_000,
      feesCents: 0,
      netCents: 1_000,
      donorTag: "Different",
      creditedAt: "2026-08-04T00:01:00.000Z",
      source: { kind: "manual", attribution: "manual", metadata: {} },
    });
    otherLedger.close();
    await assert.rejects(
      runCli([
        "backup",
        "restore",
        "--source",
        otherPath,
        "--output",
        restoredPath,
        ...common,
      ]),
      /already contains a different ledger/,
    );
  });

test("inspection returns only the requested privileged state", async (context) => {
  const fixture = await createFixture(context);
  const pools = inspectLedger({
    ledger: fixture.ledger,
    entity: "pools",
    filters: {
      problemId: catalog.problems[0].id,
      direction: "prove",
    },
  });
  assert.equal(pools.count, 1);
  assert.equal(pools.rows[0].direction, "prove");
  assert.throws(() => inspectLedger({
    ledger: fixture.ledger,
    entity: "pools",
    filters: { status: "Open" },
  }), /does not support/);
});

test("cumulative provider spend reconciliation is replay-safe through the CLI",
  async (context) => {
    const fixture = await createFixture(context);
    fixture.ledger.close();
    fixture.closed = true;
    const arguments_ = [
      "anthropic",
      "reconcile-spend",
      "--through",
      "2026-07-01T00:00:00.000Z",
      "--actual-dollars",
      "0",
      "--ref",
      "anthropic-export-2026-07-01",
      "--note",
      "Cumulative provider export.",
      "--db",
      fixture.databasePath,
    ];
    const first = await runCli(arguments_);
    const replay = await runCli(arguments_);
    assert.equal(first.outcome, "completed");
    assert.equal(first.reconciliation.appliedCorrectionCents, 0);
    assert.equal(replay.outcome, "duplicate");

    const inspection = await runCli([
      "inspect",
      "provider-spend",
      "--ref",
      "anthropic-export-2026-07-01",
      "--db",
      fixture.databasePath,
    ]);
    assert.equal(inspection.count, 1);
    assert.equal(
      inspection.rows[0].externalReference,
      "anthropic-export-2026-07-01",
    );
    assert.deepEqual(await runCli([
      "ramp",
      "status",
      "--db",
      fixture.databasePath,
    ]), { status: "not-synced" });
  });

async function createFixture(context) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "indiemath-admin-test-"));
  const databasePath = path.join(scratch, "ledger.sqlite");
  await syncCatalog({ catalog, databasePath });
  const fixture = {
    scratch,
    databasePath,
    ledger: await openLedger({ databasePath }),
    closed: false,
  };
  context.after(async () => {
    if (!fixture.closed) fixture.ledger.close();
    await rm(scratch, { recursive: true, force: true });
  });
  return fixture;
}

async function runCli(arguments_) {
  const result = await execFile(process.execPath, [cliPath, ...arguments_], {
    env: process.env,
  });
  return JSON.parse(result.stdout);
}

function openCollectiveTransaction({
  id,
  orderId,
  createdAt,
}) {
  return {
    id,
    type: "CREDIT",
    kind: "CONTRIBUTION",
    order: { id: orderId },
    account: {
      id: `account-${id}`,
      name: "Ada",
      slug: "ada",
      isIncognito: false,
    },
    grossCents: 5_000,
    feesCents: 250,
    netCents: 4_750,
    createdAt,
    clearedAt: createdAt,
    paymentProcessorUrl: undefined,
    isDisputed: false,
    isRefunded: false,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
