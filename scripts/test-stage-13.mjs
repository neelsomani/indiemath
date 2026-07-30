#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyReviewVerdict,
  fundTreasuryFromReconciliation,
  reconcileOpenCollectiveCredits,
  syncOpenCollectiveTiers,
  verifyLaunchReadiness,
} from "#indiemath/admin-cli";
import {
  loadAnthropicPricingTable,
  reconcileClaimUsage,
} from "#indiemath/anthropic";
import {
  FakeAnthropicMessages,
  FakeOpenCollective,
  FakeR2,
  FakeStripe,
} from "#indiemath/fakes";
import { openLedger, syncCatalog } from "#indiemath/ledger";
import {
  buildPublicDocuments,
  runOpenCollectiveIntakeOnce,
} from "#indiemath/intake-publisher";
import {
  r2ArtifactUri,
} from "#indiemath/shared";
import {
  createWorkerRuntime,
  selectSamplingDecision,
} from "#indiemath/workers";
import { readCatalog, validateCatalog } from "./catalog-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = validateCatalog(
  await readCatalog(path.join(rootDir, "problems", "catalog.json")),
);
const pricingTable = await loadAnthropicPricingTable(
  path.join(rootDir, "pricing", "anthropic.json"),
);
const controlledProblems = catalog.problems.slice(0, 4);

test("the complete charge-to-publication workflow converges for every verdict",
  async (context) => {
    const fixture = await createFixture(context);
    const tierProvider = new FakeOpenCollective();
    await syncOpenCollectiveTiers({
      catalog,
      ledger: fixture.ledger,
      openCollective: tierProvider,
    });
    const transactions = controlledTransactions(fixture.ledger);
    const openCollective = new FakeOpenCollective({ transactions });

    const interrupted = await runOpenCollectiveIntakeOnce({
      ledger: fixture.ledger,
      openCollective,
      pageSize: 2,
      maxPages: 1,
    });
    assert.equal(interrupted.complete, false);
    assert.equal(interrupted.credited, 2);
    fixture.ledger.close();
    fixture.ledger = await openLedger({ databasePath: fixture.databasePath });

    const resumed = await runOpenCollectiveIntakeOnce({
      ledger: fixture.ledger,
      openCollective,
      pageSize: 2,
    });
    assert.equal(resumed.complete, true);
    assert.equal(fixture.ledger.inspect().donations.length, 4);
    assert.equal(
      fixture.ledger.inspect().donations
        .filter((donation) => donation.orderId === "order-controlled-recurring")
        .length,
      2,
    );
    assert.equal(fixture.ledger.treasuryStatus().settledContributionCents, 0);
    assert.equal(
      selectSamplingDecision(fixture.ledger.samplingSnapshot()).outcome,
      "treasury-blocked",
    );
    assert.ok(fixture.ledger.inspect().donations.every(
      (donation) => donation.refundEligible,
    ));

    const settlementRecords = settledRecords(transactions);
    const funding = await fundTreasuryFromReconciliation({
      ledger: fixture.ledger,
      stripe: new FakeStripe({
        accountId: "acct_stage13",
        settlementRecords,
      }),
      amountCents: 20_000,
      externalReference: "ramp-controlled-stage13",
      through: "2026-08-05T00:00:00.000Z",
      pageSize: 2,
    });
    assert.equal(funding.reconciliation.settledContributionCents, 20_000);
    assert.equal(funding.funding.outcome, "funded");
    assert.ok(fixture.ledger.inspect().donations.every(
      (donation) => donation.processed && !donation.refundEligible,
    ));

    const r2 = new FakeR2();
    const verdicts = [
      {
        problem: controlledProblems[0],
        direction: "prove",
        verdict: "unconditional",
        workerId: "worker-1",
      },
      {
        problem: controlledProblems[1],
        direction: "prove",
        verdict: "conditional",
        workerId: "worker-2",
        assumptionLabel: "Controlled Stage 13 assumption",
      },
      {
        problem: controlledProblems[2],
        direction: "disprove",
        verdict: "rejected",
        workerId: "worker-3",
      },
    ];
    const completedClaims = [];
    for (const [index, item] of verdicts.entries()) {
      const claim = fixture.ledger.claim({
        problemId: item.problem.id,
        direction: item.direction,
        runBudgetCents: 5_000,
        workerId: item.workerId,
        fundingMode: "pool-only",
      });
      const worker = createWorkerRuntime({
        config: fakeWorkerConfig(item.workerId),
        ledger: fixture.ledger,
        r2,
        anthropicMessages: new FakeAnthropicMessages({
          responses: [solutionMessage(`msg_stage13_${index + 1}`)],
        }),
        pricingTable,
      });
      const run = await worker.runClaim({
        claim,
        taskBudgetTokens: 20_000,
      });
      assert.equal(run.outcome, "submitted_solution");
      const settledClaim = fixture.ledger.getClaim(claim);
      assert.equal(settledClaim.settled, true);
      assert.ok(settledClaim.solutionUri);
      completedClaims.push(settledClaim);

      const noteKey = `reviews/${item.problem.id}/stage13-${item.verdict}.md`;
      await r2.putObject(
        noteKey,
        `# Controlled ${item.verdict} review\n\nStage 13 terminal-outcome drill.`,
      );
      const reviewed = await applyReviewVerdict({
        ledger: fixture.ledger,
        r2,
        problemId: item.problem.id,
        verdict: item.verdict,
        noteUri: r2ArtifactUri(noteKey),
        ...(item.assumptionLabel
          ? { assumptionLabel: item.assumptionLabel }
          : {}),
      });
      assert.equal(reviewed.review.outcome, item.verdict);
    }

    assert.equal(
      fixture.ledger.getProblem(controlledProblems[0].id).status,
      "Solved",
    );
    assert.equal(
      fixture.ledger.getProblem(controlledProblems[1].id).status,
      "Open",
    );
    assert.equal(
      fixture.ledger.getProblem(controlledProblems[2].id).status,
      "Open",
    );
    const sweep = fixture.ledger.sweepSolvedProblems();
    assert.equal(sweep.outcome, "swept");

    const generalBudgetCents = Math.min(
      5_000,
      fixture.ledger.inspect().claimableGeneralCreditCents,
    );
    assert.ok(generalBudgetCents >= 1_601);
    const generalClaim = fixture.ledger.claim({
      problemId: controlledProblems[3].id,
      direction: "prove",
      runBudgetCents: generalBudgetCents,
      workerId: "worker-4",
      fundingMode: "general-only",
    });
    const generalWorker = createWorkerRuntime({
      config: fakeWorkerConfig("worker-4"),
      ledger: fixture.ledger,
      r2,
      anthropicMessages: new FakeAnthropicMessages({
        responses: [solutionMessage("msg_stage13_general")],
      }),
      pricingTable,
    });
    assert.equal((await generalWorker.runClaim({
      claim: generalClaim,
      taskBudgetTokens: 20_000,
    })).outcome, "submitted_solution");
    const settledGeneralClaim = fixture.ledger.getClaim(generalClaim);
    completedClaims.push(settledGeneralClaim);
    const generalNoteKey =
      `reviews/${controlledProblems[3].id}/stage13-general-rejected.md`;
    await r2.putObject(
      generalNoteKey,
      "# Controlled general-funded rejection\n\nStage 13 funding-source drill.",
    );
    assert.equal((await applyReviewVerdict({
      ledger: fixture.ledger,
      r2,
      problemId: controlledProblems[3].id,
      verdict: "rejected",
      noteUri: r2ArtifactUri(generalNoteKey),
    })).review.outcome, "rejected");

    const openCollectiveReconciliation = await reconcileOpenCollectiveCredits({
      ledger: fixture.ledger,
      openCollective,
      through: "2026-08-05T00:00:00.000Z",
      pageSize: 2,
    });
    assert.equal(openCollectiveReconciliation.ok, true);
    assert.equal(openCollectiveReconciliation.providerTransactionCount, 4);

    const claimResponses = completedClaims.flatMap(
      (claim) => fixture.ledger.listClaimResponses(claim),
    );
    const adminRows = claimResponses.map((response) => ({
      model: response.modelId,
      uncachedInputTokens: response.usage.input_tokens ?? 0,
      cacheWrite5mTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      outputTokens: response.usage.output_tokens ?? 0,
      serverToolUse: {
        webSearchRequests:
          response.usage.server_tool_use?.web_search_requests ?? 0,
        webFetchRequests:
          response.usage.server_tool_use?.web_fetch_requests ?? 0,
      },
    }));
    const anthropicReconciliation = reconcileClaimUsage({
      claimResponses,
      adminRows,
      pricingTable,
      toleranceCents: 0,
    });
    assert.equal(anthropicReconciliation.withinTolerance, true);
    assert.equal(anthropicReconciliation.driftCents, 0);
    const anthropicReports = completedClaims.map((claim) => {
      const responses = fixture.ledger.listClaimResponses(claim);
      const reports = responses.map((response) => ({
        model: response.modelId,
        uncachedInputTokens: response.usage.input_tokens ?? 0,
        cacheWrite5mTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheWrite1hTokens: 0,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
        serverToolUse: {
          webSearchRequests:
            response.usage.server_tool_use?.web_search_requests ?? 0,
          webFetchRequests:
            response.usage.server_tool_use?.web_fetch_requests ?? 0,
        },
      }));
      return {
        ...reconcileClaimUsage({
          claimResponses: responses,
          adminRows: reports,
          pricingTable,
          toleranceCents: 0,
        }),
        targetClaim: {
          problemId: claim.problemId,
          direction: claim.direction,
          claimTs: claim.claimTs,
        },
        ledgerResponseCount: responses.length,
      };
    });

    const readiness = verifyLaunchReadiness({
      ledger: fixture.ledger,
      health: { ok: true, checks: [] },
      evidence: {
        schemaVersion: 1,
        controlledContributions: [
          { paymentRail: "card", transactionId: "txn-controlled-card" },
          { paymentRail: "ach", transactionId: "txn-controlled-ach" },
        ],
        fundingEventReferences: ["ramp-controlled-stage13"],
        controlledRuns: [
          ...completedClaims.slice(0, 3).map((claim, index) => ({
            problemId: claim.problemId,
            direction: claim.direction,
            claimTs: claim.claimTs,
            fundingSource: "pool",
            terminalOutcome: verdicts[index].verdict,
          })),
          {
            problemId: settledGeneralClaim.problemId,
            direction: settledGeneralClaim.direction,
            claimTs: settledGeneralClaim.claimTs,
            fundingSource: "general",
            terminalOutcome: "rejected",
          },
        ],
        anthropicReportPaths: anthropicReports.map(
          (_, index) => `/reports/claim-${index + 1}.json`,
        ),
        litestreamRestore: {
          source: "r2",
          databasePath: path.join(fixture.directory, "restored.sqlite"),
          restoredAt: "2026-08-05T00:00:00.000Z",
        },
      },
      restoreVerification: {
        ok: true,
        databasePath: path.join(fixture.directory, "restored.sqlite"),
        sha256: "a".repeat(64),
        conservation: { balanced: true },
      },
      anthropicReports,
      liveDatabasePath: fixture.databasePath,
      checkedAt: "2026-08-05T00:01:00.000Z",
    });
    assert.equal(readiness.ok, true);

    const publication = buildPublicDocuments({
      source: fixture.ledger.publicationSnapshot(),
      generatedAt: "2026-08-05T00:01:00.000Z",
    });
    const publicLedger = JSON.parse(publication.ledgerBody);
    assert.equal(publicLedger.donations.length, 4);
    assert.equal(publicLedger.runs.length, 4);
    assert.deepEqual(
      publicLedger.reviews.map((review) => review.outcome).sort(),
      ["conditional", "rejected", "rejected", "unconditional"],
    );
    fixture.ledger.assertConservation();
  });

test("the launch gate fails closed with an actionable check for every missing proof",
  async (context) => {
    const fixture = await createFixture(context);
    const result = verifyLaunchReadiness({
      ledger: fixture.ledger,
      health: {
        ok: false,
        checks: [{ id: "intake-lag", ok: false }],
      },
      evidence: {
        schemaVersion: 1,
        controlledContributions: [{
          paymentRail: "card",
          transactionId: "missing-card-transaction",
        }],
        fundingEventReferences: [],
        controlledRuns: [],
        anthropicReportPaths: [],
        litestreamRestore: {
          source: "local",
          databasePath: fixture.databasePath,
          restoredAt: "2026-08-05T00:00:00.000Z",
        },
      },
      restoreVerification: { ok: false, databasePath: fixture.databasePath },
      anthropicReports: [],
      liveDatabasePath: fixture.databasePath,
      checkedAt: "2026-08-05T00:01:00.000Z",
    });

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.checks.filter((check) => !check.ok).map((check) => check.id),
      [
        "operational-health",
        "controlled-contributions",
        "controlled-funding",
        "controlled-runs",
        "anthropic-reconciliation",
        "litestream-restore",
      ],
    );
  });

function controlledTransactions(ledger) {
  const targets = [
    [controlledProblems[0], "prove", "txn-controlled-card", "order-controlled-card"],
    [controlledProblems[1], "prove", "txn-controlled-ach", "order-controlled-ach"],
    [
      controlledProblems[2],
      "disprove",
      "txn-controlled-recurring-1",
      "order-controlled-recurring",
    ],
    [
      controlledProblems[2],
      "disprove",
      "txn-controlled-recurring-2",
      "order-controlled-recurring",
    ],
  ];
  return targets.map(([problem, direction, id, orderId], index) => {
    const tier = ledger.findOpenCollectiveTier({
      tierSlug: `${problem.id}-${direction}`,
    });
    return {
      id,
      type: "CREDIT",
      kind: "CONTRIBUTION",
      createdAt: new Date(
        Date.parse("2026-08-01T00:00:00.000Z") + index * 60_000,
      ).toISOString(),
      grossCents: 5_000,
      feesCents: 0,
      netCents: 5_000,
      paymentProcessorUrl:
        `https://dashboard.stripe.com/payments/ch_stage13${index + 1}`,
      order: {
        id: orderId,
        tier: {
          id: tier.providerTierId,
          slug: tier.tierSlug,
        },
      },
      account: {
        name: index === 1 ? "ACH contributor" : "Card contributor",
        isIncognito: false,
      },
    };
  });
}

function settledRecords(transactions) {
  return [
    ...transactions.map((transaction, index) => ({
      providerReference: `balance-stage13-${index + 1}`,
      providerKind: "stripe",
      recordKind: "contribution",
      amountCents: transaction.netCents,
      occurredAt: "2026-08-03T00:00:00.000Z",
      payoutReference: "po_stage13",
      chargeId: `ch_stage13${index + 1}`,
      source: { id: `balance-stage13-${index + 1}` },
    })),
    {
      providerReference: "po_stage13",
      providerKind: "stripe",
      recordKind: "payout",
      amountCents: 20_000,
      occurredAt: "2026-08-04T00:00:00.000Z",
      source: { id: "po_stage13" },
    },
  ];
}

function fakeWorkerConfig(workerId) {
  return {
    component: "worker",
    runtime: "fake",
    workerId,
    pricingTablePath: path.join(rootDir, "pricing", "anthropic.json"),
  };
}

function solutionMessage(id) {
  return {
    id,
    type: "message",
    role: "assistant",
    model: "claude-fable-5",
    content: [{
      type: "tool_use",
      id: `tool_${id}`,
      name: "submit_solution",
      input: {
        title: "Controlled Stage 13 result",
        summary: "The controlled run reached review.",
        argument_markdown: "A complete controlled argument for lifecycle verification.",
        verification_notes: "This artifact exists to exercise the terminal workflow.",
      },
    }],
    stop_reason: "tool_use",
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 10,
    },
  };
}

async function createFixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "indiemath-stage13-"));
  const databasePath = path.join(directory, "ledger.sqlite");
  const fixture = {
    directory,
    databasePath,
    ledger: await openLedger({ databasePath }),
  };
  await syncCatalog({ databasePath, catalog });
  context.after(async () => {
    fixture.ledger.close();
    await rm(directory, { recursive: true, force: true });
  });
  return fixture;
}
