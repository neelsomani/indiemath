#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  fundTreasuryFromReconciliation,
  refreshTreasuryStatus,
} from "#indiemath/admin-cli";
import { FakeStripe } from "#indiemath/fakes";
import { openLedger } from "#indiemath/ledger";
import { readTreasuryPublication } from "#indiemath/intake-publisher";
import {
  readCatalog,
  validateCatalog,
} from "./catalog-lib.mjs";
import { syncCatalog } from "./catalog-ledger.mjs";

const execFile = promisify(execFileCallback);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = validateCatalog(
  await readCatalog(path.join(rootDir, "problems", "catalog.json")),
);
const firstProblem = catalog.problems[0];

test("multi-day settlement, refunds, funding, and reservations share one treasury view",
  async (context) => {
    const fixture = await createFixture(context);
    donate(fixture.ledger, {
      dedupId: "txn-stage6-first",
      chargeId: "ch_stage6_first",
      netCents: 5_000,
      creditedAt: "2026-08-03T00:00:00.000Z",
    });
    donate(fixture.ledger, {
      dedupId: "txn-stage6-second",
      chargeId: "ch_stage6_second",
      netCents: 5_000,
      creditedAt: "2026-08-03T00:01:00.000Z",
    });

    const beforeSettlement = await refreshTreasuryStatus({
      ledger: fixture.ledger,
      stripe: new FakeStripe({ accountId: "acct_stage6" }),
      through: "2026-08-03T23:59:59.000Z",
    });
    assert.deepEqual(beforeSettlement.treasury, {
      settledContributionCents: 0,
      completedRefundCents: 0,
      pendingRefundCents: 0,
      fundingEventCents: 0,
      settledButUnfundedCents: 0,
      availableToFundCents: 0,
      spendableCapacityCents: 0,
      liveReservationsCents: 0,
      runsPausedPendingSettlement: true,
    });
    assert.equal(
      fixture.ledger.getDonation("txn-stage6-first").refundEligible,
      true,
    );
    assert.deepEqual(
      readTreasuryPublication(fixture.ledger),
      beforeSettlement.treasury,
    );

    const paidRecords = settlementRecords();
    const afterSettlement = await refreshTreasuryStatus({
      ledger: fixture.ledger,
      stripe: new FakeStripe({
        accountId: "acct_stage6",
        settlementRecords: paidRecords,
      }),
      through: "2026-08-05T23:59:59.000Z",
    });
    assert.equal(afterSettlement.treasury.settledButUnfundedCents, 10_000);
    assert.equal(afterSettlement.treasury.availableToFundCents, 10_000);
    assert.equal(afterSettlement.treasury.runsPausedPendingSettlement, true);
    assert.equal(
      fixture.ledger.getDonation("txn-stage6-second").refundEligible,
      true,
    );

    fixture.ledger.beginRefund({
      donationDedupId: "txn-stage6-second",
      requestedAmountCents: 2_000,
      idempotencyReference: "refund-stage6",
    });
    assert.equal(fixture.ledger.treasuryStatus().pendingRefundCents, 2_000);
    assert.equal(fixture.ledger.treasuryStatus().availableToFundCents, 8_000);

    const funded = await fundTreasuryFromReconciliation({
      ledger: fixture.ledger,
      stripe: new FakeStripe({
        accountId: "acct_stage6",
        settlementRecords: paidRecords,
      }),
      amountCents: 8_000,
      externalReference: "ramp-stage6",
      through: "2026-08-05T23:59:59.000Z",
    });
    assert.equal(funded.funding.outcome, "funded");
    assert.equal(funded.funding.fundingEvent.amountCents, 8_000);
    assert.equal(funded.treasury.availableToFundCents, 0);
    assert.equal(funded.treasury.spendableCapacityCents, 8_000);
    assert.equal(
      fixture.ledger.getDonation("txn-stage6-first").processed,
      true,
    );
    assert.equal(
      fixture.ledger.getDonation("txn-stage6-second").processed,
      true,
    );
    assert.throws(() => fixture.ledger.beginRefund({
      donationDedupId: "txn-stage6-first",
      idempotencyReference: "refund-too-late",
    }), /processed and no longer refundable/);
    assert.throws(() => fixture.ledger.treasuryFund({
      amountCents: 1,
      externalReference: "ramp-overfund",
      settledContributionCents: 10_000,
    }), /exceeds available-to-fund 0/);

    fixture.ledger.completeRefund({
      idempotencyReference: "refund-stage6",
      providerReference: "re_stage6",
    });
    const afterRefund = await refreshTreasuryStatus({
      ledger: fixture.ledger,
      stripe: new FakeStripe({
        accountId: "acct_stage6",
        settlementRecords: [
          ...paidRecords,
          {
            providerReference: "txn-stage6-refund",
            providerKind: "stripe",
            recordKind: "refund",
            amountCents: -2_000,
            occurredAt: "2026-08-06T00:00:00.000Z",
            payoutReference: "po_stage6",
            chargeId: "ch_stage6_second",
            source: { id: "re_stage6" },
          },
        ],
      }),
      through: "2026-08-06T23:59:59.000Z",
    });
    assert.equal(afterRefund.treasury.completedRefundCents, 2_000);
    assert.equal(afterRefund.treasury.pendingRefundCents, 0);
    assert.equal(afterRefund.treasury.settledButUnfundedCents, 0);

    const claim = fixture.ledger.claim({
      problemId: firstProblem.id,
      direction: "prove",
      runBudgetCents: 8_000,
      workerId: "worker-1",
      fundingMode: "pool-only",
    });
    assert.equal(readTreasuryPublication(fixture.ledger).liveReservationsCents, 8_000);
    assert.equal(
      readTreasuryPublication(fixture.ledger).runsPausedPendingSettlement,
      true,
    );
    fixture.ledger.settle({
      ...claim,
      finalSpentCents: 3_000,
    });
    assert.equal(readTreasuryPublication(fixture.ledger).liveReservationsCents, 0);
    assert.equal(readTreasuryPublication(fixture.ledger).spendableCapacityCents, 5_000);
    assert.equal(
      readTreasuryPublication(fixture.ledger).runsPausedPendingSettlement,
      false,
    );
    fixture.ledger.assertConservation();
  });

test("treasury CLI derives settlement, accepts exact dollars, and has no manual total",
  async (context) => {
    const fixture = await createFixture(context);
    donate(fixture.ledger, {
      dedupId: "txn-stage6-cli",
      chargeId: "ch_stage6_cli",
      netCents: 5_000,
      creditedAt: "2026-08-03T00:00:00.000Z",
    });
    fixture.ledger.close();
    fixture.closed = true;

    const server = createStripeServer({
      chargeId: "ch_stage6_cli",
      amountCents: 5_000,
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    const environment = {
      ...process.env,
      INDIEMATH_DB: fixture.databasePath,
      STRIPE_SECRET_KEY: "rk_test_stage6",
      STRIPE_ACCOUNT_ID: "acct_stage6_cli",
      STRIPE_API_BASE_URL: `http://127.0.0.1:${address.port}/v1/`,
    };
    const common = [
      "--through",
      "2026-08-06T00:00:00.000Z",
      "--db",
      fixture.databasePath,
    ];

    const status = JSON.parse((await execFile(
      process.execPath,
      [path.join(rootDir, "scripts", "indiemath.mjs"), "treasury", "status", ...common],
      { env: environment },
    )).stdout);
    assert.equal(status.treasury.settledContributionCents, 5_000);
    assert.equal(status.treasury.availableToFundCents, 5_000);
    assert.equal(status.treasury.runsPausedPendingSettlement, true);

    const funded = JSON.parse((await execFile(
      process.execPath,
      [
        path.join(rootDir, "scripts", "indiemath.mjs"),
        "treasury",
        "fund",
        "50.00",
        "--ref",
        "ramp-cli-stage6",
        ...common,
      ],
      { env: environment },
    )).stdout);
    assert.equal(funded.funding.outcome, "funded");
    assert.equal(funded.funding.fundingEvent.amountCents, 5_000);
    assert.equal(funded.treasury.spendableCapacityCents, 5_000);
    assert.equal(funded.treasury.runsPausedPendingSettlement, false);

    const replay = JSON.parse((await execFile(
      process.execPath,
      [
        path.join(rootDir, "scripts", "indiemath.mjs"),
        "treasury",
        "fund",
        "$50",
        "--ref",
        "ramp-cli-stage6",
        ...common,
      ],
      { env: environment },
    )).stdout);
    assert.equal(replay.funding.outcome, "duplicate");

    await assert.rejects(
      execFile(process.execPath, [
        path.join(rootDir, "scripts", "indiemath.mjs"),
        "treasury",
        "fund",
        "50",
        "--ref",
        "forbidden-manual-total",
        "--settled-contribution-cents",
        "5000",
      ]),
      (error) => {
        assert.match(error.stderr, /Unknown option.*settled-contribution-cents/);
        return true;
      },
    );

    const ledger = await openLedger({ databasePath: fixture.databasePath });
    context.after(() => ledger.close());
    assert.equal(ledger.inspect().fundingEvents.length, 1);
    assert.equal(ledger.inspect().fundingEvents[0].amountCents, 5_000);
    assert.equal(ledger.getDonation("txn-stage6-cli").processed, true);
  });

test("publisher snapshot rejects a treasury pause flag that disagrees with capacity",
  async () => {
    const { parsePublisherSnapshot } = await import("#indiemath/shared");
    assert.throws(() => parsePublisherSnapshot({
      schemaVersion: 1,
      generatedAt: "2026-08-01T00:00:00.000Z",
      catalogRevision: 1,
      treasury: {
        settledContributionCents: 5_000,
        completedRefundCents: 0,
        pendingRefundCents: 0,
        fundingEventCents: 5_000,
        settledButUnfundedCents: 0,
        availableToFundCents: 0,
        spendableCapacityCents: 5_000,
        liveReservationsCents: 0,
        runsPausedPendingSettlement: true,
      },
      problems: [],
    }), /must be derived from spendable capacity/);
  });

test("production wrapper loads the protected environment then drops privileges",
  async () => {
    const { readFile } = await import("node:fs/promises");
    const [wrapper, runbook] = await Promise.all([
      readFile(path.join(rootDir, "indiemath"), "utf8"),
      readFile(path.join(rootDir, "docs", "ADMIN_RUNBOOK.md"), "utf8"),
    ]);
    assert.match(wrapper, /\/etc\/indiemath\/indiemath\.env/);
    assert.match(wrapper, /runuser -u "\$service_user" --preserve-environment/);
    assert.match(wrapper, /Production admin commands must run with sudo/);
    const inbox = runbook.indexOf("Review the refund inbox");
    const status = runbook.indexOf("sudo ./indiemath treasury status");
    const fund = runbook.indexOf("sudo ./indiemath treasury fund");
    assert.ok(inbox >= 0 && status > inbox && fund > status);
    assert.match(runbook, /There is no command-line input for settled contribution totals/);
  });

async function createFixture(context) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "indiemath-treasury-test-"));
  const databasePath = path.join(scratch, "ledger.sqlite");
  await syncCatalog({ catalog, databasePath });
  const fixture = {
    scratch,
    databasePath,
    closed: false,
  };
  fixture.ledger = await openLedger({ databasePath });
  context.after(async () => {
    if (!fixture.closed) fixture.ledger.close();
    await rm(scratch, { recursive: true, force: true });
  });
  return fixture;
}

function donate(ledger, {
  dedupId,
  chargeId,
  netCents,
  creditedAt,
}) {
  return ledger.donate({
    dedupId,
    orderId: `order-${dedupId}`,
    destination: {
      kind: "pool",
      problemId: firstProblem.id,
      direction: "prove",
    },
    grossCents: netCents,
    feesCents: 0,
    netCents,
    donorTag: "Ada",
    creditedAt,
    source: {
      kind: "open_collective",
      attribution: "mapped",
      metadata: { stripeChargeId: chargeId },
    },
  });
}

function settlementRecords() {
  return [
    {
      providerReference: "po_stage6",
      providerKind: "stripe",
      recordKind: "payout",
      amountCents: 10_000,
      occurredAt: "2026-08-05T00:00:00.000Z",
      payoutReference: "po_stage6",
      source: { id: "po_stage6" },
    },
    {
      providerReference: "txn-stage6-first-balance",
      providerKind: "stripe",
      recordKind: "contribution",
      amountCents: 5_000,
      occurredAt: "2026-08-05T00:00:00.000Z",
      payoutReference: "po_stage6",
      chargeId: "ch_stage6_first",
      source: { id: "ch_stage6_first" },
    },
    {
      providerReference: "txn-stage6-second-balance",
      providerKind: "stripe",
      recordKind: "contribution",
      amountCents: 5_000,
      occurredAt: "2026-08-05T00:00:00.000Z",
      payoutReference: "po_stage6",
      chargeId: "ch_stage6_second",
      source: { id: "ch_stage6_second" },
    },
  ];
}

function createStripeServer({ chargeId, amountCents }) {
  const occurred = Math.floor(Date.parse("2026-08-05T00:00:00.000Z") / 1_000);
  return createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/v1/balance") {
      response.end(JSON.stringify({
        object: "balance",
        livemode: false,
        available: [{ amount: amountCents, currency: "usd" }],
        pending: [],
      }));
      return;
    }
    if (url.pathname === "/v1/payouts") {
      response.end(JSON.stringify({
        data: [{
          id: "po_stage6_cli",
          object: "payout",
          amount: amountCents,
          arrival_date: occurred,
          created: occurred,
          currency: "usd",
          status: "paid",
          type: "bank_account",
        }],
        has_more: false,
      }));
      return;
    }
    if (url.pathname === "/v1/balance_transactions") {
      response.end(JSON.stringify({
        data: [{
          id: "txn_stage6_cli_balance",
          object: "balance_transaction",
          amount: amountCents,
          fee: 0,
          net: amountCents,
          available_on: occurred,
          created: occurred,
          currency: "usd",
          reporting_category: "charge",
          status: "available",
          type: "charge",
          source: { id: chargeId, object: "charge" },
        }],
        has_more: false,
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({
      error: { message: `Unexpected Stripe test path ${url.pathname}.` },
    }));
  });
}
