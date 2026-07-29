#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { syncOpenCollectiveTiers } from "#indiemath/admin-cli";
import {
  FakeOpenCollective,
  FakePublicData,
  FakeR2,
} from "#indiemath/fakes";
import { createFrontendRuntime } from "#indiemath/frontend";
import { openLedger } from "#indiemath/ledger";
import {
  buildPublicDocuments,
  publishPublicLedgerOnce,
  PublicLedgerPublisherController,
} from "#indiemath/intake-publisher";
import {
  parseFrontendConfig,
  parsePublicLedger,
  parsePublisherSnapshot,
  publicLedgerKey,
  publicStateKey,
} from "#indiemath/shared";
import {
  readCatalog,
  validateCatalog,
} from "./catalog-lib.mjs";
import { syncCatalog } from "./catalog-ledger.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = validateCatalog(
  await readCatalog(path.join(rootDir, "problems", "catalog.json")),
);
const [firstProblem, secondProblem, thirdProblem] = catalog.problems;
const publicOrigin = "https://public.publisher.fake/";

test("publisher emits complete deterministic state and a privacy-minimized ledger",
  async (context) => {
    const fixture = await createFixture(context);
    const source = fixture.ledger.publicationSnapshot();
    const generatedAt = "2026-08-10T12:00:00.000Z";
    const firstBuild = buildPublicDocuments({ source, generatedAt });
    const replayBuild = buildPublicDocuments({ source, generatedAt });

    assert.equal(firstBuild.stateBody, replayBuild.stateBody);
    assert.equal(firstBuild.ledgerBody, replayBuild.ledgerBody);
    assert.equal(firstBuild.publicationId, replayBuild.publicationId);
    const state = parsePublisherSnapshot(JSON.parse(firstBuild.stateBody));
    const publicLedger = parsePublicLedger(JSON.parse(firstBuild.ledgerBody));
    assert.equal(state.publicationId, publicLedger.publicationId);
    assert.equal(state.ledgerSha256, sha256(firstBuild.ledgerBody));
    assert.equal(state.catalogRevision, catalog.catalog_revision);
    assert.equal(state.problems.length, catalog.problems.length);
    assert.equal(state.unprocessedCents, 8_000);
    assert.equal(
      state.problems.find((problem) => problem.problemId === firstProblem.id)
        .unprocessedCents,
      8_000,
    );
    assert.equal(
      publicLedger.donations.find((donation) => donation.dedupId === "txn-late")
        .remainingCents,
      8_000,
    );
    assert.equal(
      publicLedger.donations.find((donation) => donation.dedupId === "txn-first")
        .processingStatus,
      "processed",
    );
    assert.equal(
      publicLedger.donations.find((donation) => donation.dedupId === "txn-disputed")
        .processingStatus,
      "reversed",
    );
    assert.equal(publicLedger.runs.length, 4);
    assert.equal(publicLedger.runs.filter((run) => run.status === "running").length, 1);
    assert.equal(publicLedger.runs[0].transcriptSegments.length, 1);
    assert.match(
      publicLedger.runs[0].transcriptSegments[0].humanTranscriptKey,
      /response-1\.md$/,
    );
    assert.equal(publicLedger.reviews[0].outcome, "conditional");
    assert.equal(publicLedger.reviews[0].assumptionLabel, "P != NP");
    assert.equal(
      state.problems.find((problem) => problem.problemId === thirdProblem.id)
        .pendingSolutions.length,
      2,
    );
    assert.equal(state.problems[0].problemId, firstProblem.id);
    assert.ok(state.problems.every((problem) => (
      problem.pools.every((pool) => (
        pool.checkoutUrl?.startsWith("https://opencollective.com/")
      ))
    )));
    assert.equal(
      state.problems.flatMap((problem) => problem.pools)
        .filter((pool) => pool.checkoutUrl).length,
      catalog.problems.length * 2,
    );

    for (const forbidden of [
      "ch_must_not_publish",
      "https://dashboard.stripe.com/private",
      "acct_must_not_publish",
      "funding-private-reference",
      "refund-private-reference",
      "provider-refund-private",
    ]) {
      assert.doesNotMatch(firstBuild.stateBody, new RegExp(forbidden));
      assert.doesNotMatch(firstBuild.ledgerBody, new RegExp(forbidden));
    }
    assert.match(firstBuild.ledgerBody, /"donorTag":"Ada"/);
    assert.equal(source.accounting.balanced, true);
  });

test("state.json is the atomic commit point for an immutable ledger generation",
  async (context) => {
    const fixture = await createFixture(context);
    const r2 = new FakeR2();
    let clockTick = 0;
    const clock = () => new Date(
      Date.parse("2026-08-10T12:00:00.000Z") + clockTick++,
    );
    const first = await publishPublicLedgerOnce({
      ledger: fixture.ledger,
      r2,
      clock,
    });
    const committedStateObject = await r2.getObject(publicStateKey());
    assert.equal(committedStateObject.cacheControl, "no-cache");
    const committedState = JSON.parse(await committedStateObject.text());
    assert.equal(committedState.publicationId, first.publicationId);
    assert.equal(
      (await r2.getObject(first.immutableLedgerKey)).cacheControl,
      "public, max-age=31536000, immutable",
    );

    donate(fixture.ledger, {
      dedupId: "txn-after-commit",
      problemId: secondProblem.id,
      direction: "disprove",
      netCents: 5_000,
      creditedAt: "2026-08-11T00:00:00.000Z",
      donorTag: "Noether",
    });
    const failingR2 = new FailOnFixedStateR2(r2);
    await assert.rejects(
      publishPublicLedgerOnce({
        ledger: fixture.ledger,
        r2: failingR2,
        clock,
      }),
      /simulated fixed-state failure/,
    );
    const stillCommittedState = JSON.parse(
      await (await r2.getObject(publicStateKey())).text(),
    );
    const fixedLedger = JSON.parse(
      await (await r2.getObject(publicLedgerKey())).text(),
    );
    assert.equal(stillCommittedState.publicationId, first.publicationId);
    assert.notEqual(fixedLedger.publicationId, first.publicationId);

    const frontend = createFrontendRuntime({
      config: parseFrontendConfig({
        INDIEMATH_RUNTIME: "fake",
        PUBLIC_DATA_BASE_URL: publicOrigin,
      }),
      publicData: new FakePublicData({ r2, origin: publicOrigin }),
    });
    const state = await frontend.loadSnapshot();
    const ledger = await frontend.loadPublicLedger(state);
    assert.equal(ledger.publicationId, state.publicationId);
    assert.equal(ledger.publicationId, first.publicationId);
    assert.equal(
      ledger.donations.some((donation) => donation.dedupId === "txn-after-commit"),
      false,
    );

    const recovered = await publishPublicLedgerOnce({
      ledger: fixture.ledger,
      r2,
      clock,
    });
    assert.notEqual(recovered.publicationId, first.publicationId);
    const recoveredState = await frontend.loadSnapshot();
    const recoveredLedger = await frontend.loadPublicLedger(recoveredState);
    assert.equal(recoveredLedger.publicationId, recoveredState.publicationId);
    assert.equal(
      recoveredLedger.donations.some(
        (donation) => donation.dedupId === "txn-after-commit",
      ),
      true,
    );
  });

test("continuous publisher writes immediately and exits cleanly on abort",
  async (context) => {
    const fixture = await createFixture(context);
    const r2 = new FakeR2();
    const controller = new PublicLedgerPublisherController({
      ledger: fixture.ledger,
      r2,
      intervalSeconds: 60,
      clock: () => new Date("2026-08-10T12:00:00.000Z"),
    });
    const abortController = new AbortController();
    let publications = 0;
    await controller.run({
      signal: abortController.signal,
      onPublish() {
        publications += 1;
        abortController.abort();
        controller.poke();
      },
    });
    assert.equal(publications, 1);
    assert.equal(
      r2.calls.filter((call) => call.operation === "putObject").length,
      4,
    );
  });

async function createFixture(context) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "indiemath-publisher-test-"));
  const databasePath = path.join(scratch, "ledger.sqlite");
  await syncCatalog({ catalog, databasePath });
  const ledger = await openLedger({
    databasePath,
    clock: () => new Date("2026-08-10T12:00:00.000Z"),
  });
  context.after(async () => {
    ledger.close();
    await rm(scratch, { recursive: true, force: true });
  });
  await syncOpenCollectiveTiers({
    catalog,
    ledger,
    openCollective: new FakeOpenCollective(),
  });

  donate(ledger, {
    dedupId: "txn-first",
    problemId: firstProblem.id,
    direction: "prove",
    netCents: 10_000,
    creditedAt: "2026-08-01T00:00:00.000Z",
    donorTag: "Ada",
  });
  donate(ledger, {
    dedupId: "txn-disputed",
    problemId: firstProblem.id,
    direction: "disprove",
    netCents: 5_000,
    creditedAt: "2026-08-01T00:01:00.000Z",
    donorTag: "Grace",
  });
  ledger.dispute({
    donationDedupId: "txn-disputed",
    externalReference: "dispute-private-reference",
  });
  donate(ledger, {
    dedupId: "txn-general",
    netCents: 15_000,
    creditedAt: "2026-08-01T00:02:00.000Z",
    donorTag: "Emmy",
  });
  donate(ledger, {
    dedupId: "txn-late",
    problemId: firstProblem.id,
    direction: "prove",
    netCents: 10_000,
    creditedAt: "2026-08-01T00:03:00.000Z",
    donorTag: "Sofia",
    privateSource: true,
  });
  ledger.beginRefund({
    donationDedupId: "txn-late",
    requestedAmountCents: 2_000,
    idempotencyReference: "refund-private-reference",
  });
  ledger.recordSettlementSnapshot({
    snapshotId: `stripe:acct_must_not_publish:${"a".repeat(64)}`,
    providerKind: "stripe",
    providerAccountId: "acct_must_not_publish",
    cutoffAt: "2026-08-09T00:00:00.000Z",
    settledContributionCents: 42_000,
    sourceRecordCount: 1,
    sourceHash: "a".repeat(64),
    source: {
      chargeId: "ch_must_not_publish",
      providerReference: "provider-refund-private",
    },
  });
  ledger.treasuryFund({
    amountCents: 25_000,
    externalReference: "funding-private-reference",
    settledContributionCents: 42_000,
  });

  const conditional = ledger.claim({
    problemId: secondProblem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
    fundingMode: "general-only",
  });
  checkpointOneResponse(ledger, conditional);
  ledger.resolve({
    ...conditional,
    finalSpentCents: 1_000,
    solutionUri: `r2://solutions/${secondProblem.id}/prove/${conditional.claimTs}.md`,
  });
  ledger.review({
    problemId: secondProblem.id,
    verdict: "conditional",
    assumptionLabel: "P != NP",
    noteUri: `r2://reviews/${secondProblem.id}/conditional.md`,
  });

  const live = ledger.claim({
    problemId: firstProblem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-2",
    fundingMode: "pool-only",
  });
  checkpointOneResponse(ledger, live);

  const primary = ledger.claim({
    problemId: thirdProblem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-3",
    fundingMode: "general-only",
  });
  const secondary = ledger.claim({
    problemId: thirdProblem.id,
    direction: "disprove",
    runBudgetCents: 5_000,
    workerId: "worker-4",
    fundingMode: "general-only",
  });
  ledger.resolve({
    ...primary,
    finalSpentCents: 0,
    solutionUri: `r2://solutions/${thirdProblem.id}/prove/${primary.claimTs}.md`,
  });
  ledger.settle({
    ...secondary,
    finalSpentCents: 0,
    solutionUri: `r2://solutions/${thirdProblem.id}/disprove/${secondary.claimTs}.md`,
  });
  ledger.assertConservation();
  return { ledger };
}

function donate(ledger, {
  dedupId,
  problemId,
  direction,
  netCents,
  creditedAt,
  donorTag,
  privateSource = false,
}) {
  return ledger.donate({
    dedupId,
    orderId: `order-${dedupId}`,
    destination: problemId
      ? { kind: "pool", problemId, direction }
      : { kind: "general" },
    grossCents: netCents,
    feesCents: 0,
    netCents,
    donorTag,
    creditedAt,
    source: {
      kind: "open_collective",
      attribution: problemId ? "mapped" : "unattributed",
      metadata: privateSource
        ? {
            stripeChargeId: "ch_must_not_publish",
            paymentProcessorUrl: "https://dashboard.stripe.com/private",
          }
        : {
            transactionId: dedupId,
            orderId: `order-${dedupId}`,
          },
    },
  });
}

function checkpointOneResponse(ledger, claim) {
  return ledger.checkpointResponse({
    ...claim,
    request: {
      model: "claude-fable-5",
      messages: [{ role: "user", content: "Private request payload." }],
    },
    response: {
      id: `msg-${claim.claimTs}`,
      model: "claude-fable-5",
      content: [{ type: "text", text: "Private response payload." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    requestId: `request-${claim.claimTs}`,
    requestStartedAt: "2026-08-10T11:59:00.000Z",
    costCents: 1_000,
  });
}

class FailOnFixedStateR2 {
  constructor(r2) {
    this.r2 = r2;
  }

  async putObject(key, body, options) {
    if (key === publicStateKey()) {
      throw new Error("simulated fixed-state failure");
    }
    return this.r2.putObject(key, body, options);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
