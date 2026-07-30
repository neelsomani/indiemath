#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildOpenCollectiveTierSpecification,
  syncOpenCollectiveTiers,
} from "#indiemath/admin-cli";
import {
  FakeOpenCollective,
  FakeStripe,
} from "#indiemath/fakes";
import { openLedger } from "#indiemath/ledger";
import {
  executeStripeRefund,
  reconcileStripeSettlements,
  runOpenCollectiveIntakeOnce,
  runStripeDisputeIntakeOnce,
} from "#indiemath/intake-publisher";
import {
  openCollectiveCheckoutUrl,
  OpenCollectiveGraphQLClient,
} from "#indiemath/open-collective";
import { StripeClient } from "#indiemath/stripe";
import {
  readCatalog,
  validateCatalog,
} from "./catalog-lib.mjs";
import { syncCatalog } from "./catalog-ledger.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = validateCatalog(
  await readCatalog(path.join(rootDir, "problems", "catalog.json")),
);
const firstProblem = catalog.problems[0];

test("checkout links default to a one-time $50 personal contribution", () => {
  assert.equal(
    openCollectiveCheckoutUrl({
      collectiveSlug: "indiemath",
      tierSlug: "cs-001-prove-prove-np-versus-p-poly",
      legacyId: 104341,
      amountCents: 5_000,
    }),
    "https://opencollective.com/indiemath/contribute/cs-001-prove-prove-np-versus-p-poly-104341/checkout?interval=oneTime&amount=50&contributeAs=me",
  );
});

test("catalog-driven tier sync creates exactly one flexible $50 tier per pair", async (context) => {
  const fixture = await createFixture(context);
  const openCollective = new FakeOpenCollective();
  const result = await syncOpenCollectiveTiers({
    catalog,
    ledger: fixture.ledger,
    openCollective,
  });
  assert.equal(result.expectedTierCount, catalog.problems.length * 2);
  assert.equal(result.created, catalog.problems.length * 2);
  assert.equal(fixture.ledger.listOpenCollectiveTiers().length, result.expectedTierCount);

  const spec = buildOpenCollectiveTierSpecification(firstProblem, "disprove");
  assert.equal(spec.slug, `${firstProblem.id}-disprove`);
  assert.equal(spec.minimumAmountCents, 5_000);
  assert.match(spec.description, new RegExp(firstProblem.id));
  assert.match(spec.description, /disprove/i);
  assert.ok(openCollective.tiers().every((tier) => (
    tier.minimumAmountCents === 5_000
    && tier.amountType === "FLEXIBLE"
    && tier.frequency === "FLEXIBLE"
  )));

  const replay = await syncOpenCollectiveTiers({
    catalog,
    ledger: fixture.ledger,
    openCollective,
  });
  assert.equal(replay.tiers.filter((tier) => tier.ledgerOutcome === "unchanged").length,
    result.expectedTierCount);
  assert.equal(openCollective.tiers().length, result.expectedTierCount);
});

test("charge-level intake survives pagination, restart, recurring orders, and replay", async (context) => {
  let fixture = await createFixture(context);
  const tiers = new FakeOpenCollective();
  await syncOpenCollectiveTiers({
    catalog,
    ledger: fixture.ledger,
    openCollective: tiers,
  });
  const proveTier = fixture.ledger.findOpenCollectiveTier({
    tierSlug: `${firstProblem.id}-prove`,
  });
  const disproveTier = fixture.ledger.findOpenCollectiveTier({
    tierSlug: `${firstProblem.id}-disprove`,
  });
  const openCollective = new FakeOpenCollective({
    transactions: [
      transaction("txn-month-1", "order-recurring", "2026-07-01", proveTier, "Ada"),
      transaction("txn-month-2", "order-recurring", "2026-08-01", proveTier, "Ada"),
      transaction("txn-guest", "order-guest", "2026-08-02", disproveTier, "Guest"),
      transaction("txn-incognito", "order-private", "2026-08-03", {
        providerTierId: "tier-removed",
        tierSlug: "removed-tier",
      }, "Hidden", { incognito: true }),
      transaction("txn-generic", "order-generic", "2026-08-04", undefined, "Grace"),
    ],
  });

  const interrupted = await runOpenCollectiveIntakeOnce({
    ledger: fixture.ledger,
    openCollective,
    pageSize: 2,
    maxPages: 1,
  });
  assert.equal(interrupted.complete, false);
  assert.equal(interrupted.credited, 2);
  fixture.ledger.close();
  fixture.closed = true;
  fixture.ledger = await openLedger({ databasePath: fixture.databasePath });
  fixture.closed = false;

  const resumed = await runOpenCollectiveIntakeOnce({
    ledger: fixture.ledger,
    openCollective,
    pageSize: 2,
  });
  assert.equal(resumed.complete, true);
  assert.equal(fixture.ledger.inspect().donations.length, 5);
  assert.equal(new Set(fixture.ledger.inspect().donations
    .filter((item) => item.orderId === "order-recurring")
    .map((item) => item.dedupId)).size, 2);
  assert.equal(fixture.ledger.getDonation("txn-incognito").donorTag, "anonymous");
  assert.equal(
    fixture.ledger.getDonation("txn-incognito").source.attribution,
    "unattributed",
  );
  assert.equal(
    fixture.ledger.getDonation("txn-generic").destination.kind,
    "general",
  );
  const beforeReplay = fixture.ledger.accountingSnapshot();
  const replay = await runOpenCollectiveIntakeOnce({
    ledger: fixture.ledger,
    openCollective,
    pageSize: 2,
  });
  assert.equal(replay.credited, 0);
  assert.equal(replay.duplicates, 4);
  assert.deepEqual(fixture.ledger.accountingSnapshot(), beforeReplay);
  fixture.ledger.assertConservation();
});

test("Stripe net-full refund retries converge to one provider operation", async (context) => {
  const fixture = await createFixture(context);
  const stripeCollective = new FakeOpenCollective({
    transactions: [
      transaction(
        "txn-stripe-refund",
        "order-stripe-refund",
        "2026-08-02",
        undefined,
        "Grace",
        {
          grossCents: 20_000,
          feesCents: 610,
          netCents: 19_390,
          stripeChargeId: "ch_netfull19390",
        },
      ),
    ],
  });
  await runOpenCollectiveIntakeOnce({
    ledger: fixture.ledger,
    openCollective: stripeCollective,
  });
  const stripe = new FakeStripe();
  assert.throws(() => fixture.ledger.beginRefund({
      donationDedupId: "txn-stripe-refund",
      idempotencyReference: "refund-stripe-partial",
      requestedAmountCents: 5_000,
    }), /Only full refunds are supported/);
  assert.equal(stripe.calls.length, 0);
  assert.throws(
    () => fixture.ledger.getAdjustment("refund-stripe-partial"),
    /Unknown adjustment/,
  );
  await executeStripeRefund({
    ledger: fixture.ledger,
    stripe,
    donationDedupId: "txn-stripe-refund",
    idempotencyReference: "refund-stripe-1",
  });
  await executeStripeRefund({
    ledger: fixture.ledger,
    stripe,
    donationDedupId: "txn-stripe-refund",
    idempotencyReference: "refund-stripe-1",
  });
  assert.equal(stripe.calls.filter((call) => !call.duplicate).length, 1);
  assert.equal(stripe.calls[0].amountCents, 19_390);
  assert.equal(fixture.ledger.getDonation("txn-stripe-refund").refundedCents, 19_390);
  fixture.ledger.assertConservation();
});

test("Stripe refunds an existing Open Collective PaymentIntent reference",
  async (context) => {
    const fixture = await createFixture(context);
    fixture.ledger.donate({
      dedupId: "txn-stripe-payment-intent-refund",
      orderId: "order-stripe-payment-intent-refund",
      destination: { kind: "general" },
      grossCents: 20_000,
      feesCents: 610,
      netCents: 19_390,
      donorTag: "Neel",
      creditedAt: "2026-08-02T00:00:00.000Z",
      source: {
        kind: "open_collective",
        attribution: "unattributed",
        metadata: {
          paymentProcessorUrl:
            "https://dashboard.stripe.com/id/pi_existing123?account=acct_fake",
        },
      },
    });
    const stripe = new FakeStripe();
    await executeStripeRefund({
      ledger: fixture.ledger,
      stripe,
      donationDedupId: "txn-stripe-payment-intent-refund",
      idempotencyReference: "refund-stripe-payment-intent-1",
    });
    assert.equal(stripe.calls.length, 1);
    assert.deepEqual(stripe.calls[0].target, {
      kind: "payment_intent",
      id: "pi_existing123",
    });
    assert.equal(stripe.calls[0].amountCents, 19_390);
    assert.equal(
      fixture.ledger.getDonation("txn-stripe-payment-intent-refund").refundedCents,
      19_390,
    );
    fixture.ledger.assertConservation();
  });

test("refund recovery converges across death before and after provider acceptance",
  async (context) => {
    const fixture = await createFixture(context);
    const openCollective = new FakeOpenCollective({
      transactions: [
        transaction(
          "txn-refund-death-before",
          "order-refund-death-before",
          "2026-08-01",
          undefined,
          "Ada",
          { stripeChargeId: "ch_refundbefore" },
        ),
        transaction(
          "txn-refund-death-after",
          "order-refund-death-after",
          "2026-08-02",
          undefined,
          "Grace",
          { stripeChargeId: "ch_refundafter" },
        ),
      ],
    });
    await runOpenCollectiveIntakeOnce({
      ledger: fixture.ledger,
      openCollective,
    });

    const acceptedBeforeDeath = new FakeStripe();
    let rejectBeforeAcceptance = true;
    const transientStripe = {
      async refundPayment(input) {
        if (rejectBeforeAcceptance) {
          rejectBeforeAcceptance = false;
          throw new Error("simulated process loss before provider acceptance");
        }
        return acceptedBeforeDeath.refundPayment(input);
      },
    };
    await assert.rejects(
      executeStripeRefund({
        ledger: fixture.ledger,
        stripe: transientStripe,
        donationDedupId: "txn-refund-death-before",
        idempotencyReference: "refund-death-before",
      }),
      /before provider acceptance/,
    );
    assert.equal(
      fixture.ledger.getAdjustment("refund-death-before").status,
      "pending",
    );
    await executeStripeRefund({
      ledger: fixture.ledger,
      stripe: transientStripe,
      donationDedupId: "txn-refund-death-before",
      idempotencyReference: "refund-death-before",
    });
    assert.equal(
      fixture.ledger.getAdjustment("refund-death-before").status,
      "completed",
    );

    const acceptedAfterDeath = new FakeStripe();
    let loseCompletion = true;
    const crashBoundaryLedger = {
      beginRefund: fixture.ledger.beginRefund.bind(fixture.ledger),
      cancelRefund: fixture.ledger.cancelRefund.bind(fixture.ledger),
      getDonation: fixture.ledger.getDonation.bind(fixture.ledger),
      completeRefund(input) {
        if (loseCompletion) {
          loseCompletion = false;
          throw new Error("simulated process loss after provider acceptance");
        }
        return fixture.ledger.completeRefund(input);
      },
    };
    await assert.rejects(
      executeStripeRefund({
        ledger: crashBoundaryLedger,
        stripe: acceptedAfterDeath,
        donationDedupId: "txn-refund-death-after",
        idempotencyReference: "refund-death-after",
      }),
      /after provider acceptance/,
    );
    assert.equal(
      fixture.ledger.getAdjustment("refund-death-after").status,
      "pending",
    );
    assert.equal(
      acceptedAfterDeath.calls.filter((call) => !call.duplicate).length,
      1,
    );
    const recovered = await executeStripeRefund({
      ledger: fixture.ledger,
      stripe: acceptedAfterDeath,
      donationDedupId: "txn-refund-death-after",
      idempotencyReference: "refund-death-after",
    });
    assert.equal(recovered.outcome, "completed");
    assert.equal(
      acceptedAfterDeath.calls.filter((call) => call.duplicate).length,
      1,
    );
    assert.equal(
      fixture.ledger.getDonation("txn-refund-death-after").refundedCents,
      4_750,
    );
    fixture.ledger.assertConservation();
  });

test("disputes and paid-payout settlement reconcile through provider references", async (context) => {
  const fixture = await createFixture(context);
  const openCollective = new FakeOpenCollective({
    transactions: [
      transaction(
        "txn-settled",
        "order-settled",
        "2026-08-01",
        undefined,
        "Ada",
        { stripeChargeId: "ch_settled123" },
      ),
      {
        ...transaction(
          "txn-oc-disputed",
          "order-disputed",
          "2026-08-02",
          undefined,
          "Grace",
        ),
        isDisputed: true,
      },
    ],
  });
  const intake = await runOpenCollectiveIntakeOnce({
    ledger: fixture.ledger,
    openCollective,
  });
  assert.equal(intake.disputes, 1);
  assert.equal(fixture.ledger.getDonation("txn-oc-disputed").state, "reversed");

  const stripe = new FakeStripe({
    accountId: "acct_fake_settlement",
    settlementRecords: [
      {
        providerReference: "po_fake_1",
        providerKind: "stripe",
        recordKind: "payout",
        amountCents: 4_500,
        occurredAt: "2026-08-05T00:00:00.000Z",
        payoutReference: "po_fake_1",
        source: { id: "po_fake_1" },
      },
      {
        providerReference: "txn_balance_1",
        providerKind: "stripe",
        recordKind: "contribution",
        amountCents: 4_500,
        occurredAt: "2026-08-05T00:00:00.000Z",
        payoutReference: "po_fake_1",
        chargeId: "ch_settled123",
        source: { id: "ch_settled123" },
      },
    ],
  });
  const settlement = await reconcileStripeSettlements({
    ledger: fixture.ledger,
    stripe,
    through: "2026-08-06T00:00:00.000Z",
    pageSize: 1,
  });
  assert.equal(settlement.settledContributionCents, 4_750);
  assert.equal(settlement.matchedDonationCount, 1);
  assert.equal(fixture.ledger.latestSettlementSnapshot().sourceRecordCount, 2);
  assert.equal(fixture.ledger.treasuryStatus().settledContributionCents, 4_750);

  const stripeDisputes = new FakeStripe({
    disputes: [{
      id: "dp_fake_1",
      chargeId: "ch_settled123",
      amountCents: 5_000,
      status: "lost",
      createdAt: "2026-08-07T00:00:00.000Z",
      source: { id: "dp_fake_1" },
    }],
  });
  const disputes = await runStripeDisputeIntakeOnce({
    ledger: fixture.ledger,
    stripe: stripeDisputes,
    through: "2026-08-08T00:00:00.000Z",
  });
  assert.equal(disputes.recorded, 1);
  assert.equal(fixture.ledger.getDonation("txn-settled").state, "reversed");
  fixture.ledger.assertConservation();
});

test("real GraphQL client sends Personal-Token and normalizes net fee/donor fields", async () => {
  const requests = [];
  const client = new OpenCollectiveGraphQLClient({
    endpoint: "https://api.example.test/graphql/v2",
    collectiveSlug: "indiemath",
    apiToken: "personal-token",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ headers: init.headers, body });
      assert.equal(body.operationName, "ListCreditTransactions");
      return jsonResponse({
        data: {
          transactions: {
            totalCount: 1,
            nodes: [{
              id: "txn_real_1",
              type: "CREDIT",
              kind: "CONTRIBUTION",
              createdAt: "2026-08-01T00:00:00.000Z",
              clearedAt: "2026-08-03T00:00:00.000Z",
              paymentProcessorUrl: "https://dashboard.stripe.com/payments/ch_real123",
              isRefunded: false,
              isDisputed: false,
              amount: { valueInCents: 5_000, currency: "USD" },
              netAmount: { valueInCents: 4_750, currency: "USD" },
              platformFee: { valueInCents: 0, currency: "USD" },
              hostFee: { valueInCents: 0, currency: "USD" },
              paymentProcessorFee: { valueInCents: 250, currency: "USD" },
              order: {
                id: "order_real_1",
                tier: { id: "tier_real_1", slug: "math-001-prove" },
              },
              fromAccount: {
                id: "account_real_1",
                name: "Ada",
                slug: "ada",
                isIncognito: false,
              },
              oppositeAccount: null,
            }],
          },
        },
      });
    },
  });
  const page = await client.listCreditTransactions({
    since: "2026-07-01T00:00:00.000Z",
  });
  assert.equal(requests[0].headers["Personal-Token"], "personal-token");
  assert.match(
    requests[0].body.query,
    /orderBy:\s*\{\s*field:\s*CREATED_AT,\s*direction:\s*ASC\s*\}/,
  );
  assert.equal(page.transactions[0].grossCents, 5_000);
  assert.equal(page.transactions[0].feesCents, 250);
  assert.equal(page.transactions[0].netCents, 4_750);
  assert.equal(page.transactions[0].account.name, "Ada");
});

test("real Stripe client pins idempotency and returns privacy-minimized settlement evidence",
  async () => {
    const requests = [];
    const stripe = new StripeClient({
      secretKey: "sk_test_private",
      accountId: "acct_real123",
      fetchImpl: async (url, init) => {
        requests.push({
          pathname: url.pathname,
          search: url.search,
          headers: init.headers,
          body: init.body?.toString(),
        });
        if (url.pathname.endsWith("/refunds")) {
          return jsonResponse({
            id: "re_real123",
            amount: 1_250,
            status: "succeeded",
          });
        }
        if (url.pathname.endsWith("/balance")) {
          return jsonResponse({
            object: "balance",
            livemode: false,
            available: [{ amount: 4_500, currency: "usd" }],
            pending: [],
          });
        }
        if (url.pathname.endsWith("/payouts")) {
          return jsonResponse({
            data: [{
              id: "po_real123",
              object: "payout",
              amount: 4_500,
              arrival_date: 1_786_003_200,
              created: 1_786_003_200,
              currency: "usd",
              status: "paid",
              type: "bank_account",
            }],
            has_more: false,
          });
        }
        if (url.pathname.endsWith("/balance_transactions")) {
          return jsonResponse({
            data: [{
              id: "txn_balance_real123",
              object: "balance_transaction",
              amount: 5_000,
              fee: 500,
              net: 4_500,
              available_on: 1_786_003_200,
              created: 1_786_003_200,
              currency: "usd",
              reporting_category: "charge",
              status: "available",
              type: "charge",
              source: {
                id: "ch_real123",
                object: "charge",
                billing_details: {
                  email: "must-not-enter-settlement-evidence@example.test",
                },
              },
            }],
            has_more: false,
          });
        }
        throw new Error(`Unexpected Stripe path: ${url.pathname}`);
      },
    });
    const health = await stripe.healthcheck();
    assert.equal(health.accountId, "acct_real123");
    assert.equal(health.livemode, false);
    assert.deepEqual(health.currencies, ["usd"]);
    const chargeRefund = await stripe.refundPayment({
      chargeId: "ch_real123",
      amountCents: 1_250,
      idempotencyReference: "refund-real-1",
    });
    assert.equal(chargeRefund.providerReference, "re_real123");
    assert.equal(requests[1].headers["Idempotency-Key"], "refund-real-1");
    assert.equal(requests[1].body, "charge=ch_real123&amount=1250");
    const intentRefund = await stripe.refundPayment({
      paymentIntentId: "pi_real123",
      amountCents: 1_250,
      idempotencyReference: "refund-real-2",
    });
    assert.equal(intentRefund.providerReference, "re_real123");
    assert.equal(requests[2].headers["Idempotency-Key"], "refund-real-2");
    assert.equal(requests[2].body, "payment_intent=pi_real123&amount=1250");
    assert.equal(requests.some((request) => request.pathname.endsWith("/account")), false);

    const payouts = await stripe.listPaidPayoutSettlementRecords({
      through: "2026-08-06T00:00:00.000Z",
    });
    assert.equal(payouts.records.length, 2);
    assert.equal(payouts.records[1].chargeId, "ch_real123");
    assert.doesNotMatch(
      JSON.stringify(payouts.records),
      /must-not-enter-settlement-evidence/,
    );
    assert.ok(requests.every((request) => (
      request.headers.authorization === "Bearer sk_test_private"
    )));
  });

test("deployment assets supervise intake, publishing, and health monitoring", async () => {
  const [
    unit,
    monitorUnit,
    monitorTimer,
    setup,
    runner,
    monitorRunner,
    wrapper,
    wrapperStat,
    corsPolicyText,
  ] = await Promise.all([
    readFile(path.join(rootDir, "ops", "indiemath-intake.service"), "utf8"),
    readFile(path.join(rootDir, "ops", "indiemath-monitor.service"), "utf8"),
    readFile(path.join(rootDir, "ops", "indiemath-monitor.timer"), "utf8"),
    readFile(path.join(rootDir, "scripts", "setup-intake.mjs"), "utf8"),
    readFile(
      path.join(rootDir, "scripts", "run-open-collective-intake.mjs"),
      "utf8",
    ),
    readFile(path.join(rootDir, "scripts", "run-health-monitor.mjs"), "utf8"),
    readFile(path.join(rootDir, "setup-intake.sh"), "utf8"),
    stat(path.join(rootDir, "setup-intake.sh")),
    readFile(path.join(rootDir, "ops", "r2-public-cors.json"), "utf8"),
  ]);
  const corsPolicy = JSON.parse(corsPolicyText);
  assert.match(unit, /EnvironmentFile=\/etc\/indiemath\/indiemath\.env/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /ReadWritePaths=\/var\/lib\/indiemath/);
  assert.match(setup, /\["restart", "indiemath-intake\.service"\]/);
  assert.match(monitorUnit, /^Type=oneshot$/m);
  assert.match(monitorUnit, /run-health-monitor\.mjs/);
  assert.match(monitorTimer, /^OnUnitActiveSec=5min$/m);
  assert.match(setup, /"indiemath-monitor\.timer"/);
  assert.match(setup, /\["start", "indiemath-monitor\.service"\]/);
  assert.match(runner, /OpenCollectiveIntakeController/);
  assert.match(runner, /PublicLedgerPublisherController/);
  assert.match(runner, /public-ledger-published/);
  assert.match(runner, /runStripeDisputeIntakeOnce/);
  assert.match(monitorRunner, /checkOperationalHealth/);
  assert.match(monitorRunner, /WORKER_COUNT/);
  assert.match(wrapper, /scripts\/setup-intake\.mjs/);
  assert.ok((wrapperStat.mode & 0o111) !== 0, "setup-intake.sh must be executable");
  assert.deepEqual(corsPolicy, [{
    AllowedOrigins: ["*"],
    AllowedMethods: ["GET", "HEAD"],
    AllowedHeaders: [],
    ExposeHeaders: ["ETag", "Content-Length"],
    MaxAgeSeconds: 3_600,
  }]);
});

function transaction(
  id,
  orderId,
  date,
  tier,
  donorName,
  {
    feesCents = 250,
    grossCents = 5_000,
    incognito = false,
    netCents = grossCents - feesCents,
    stripeChargeId,
  } = {},
) {
  return {
    id,
    type: "CREDIT",
    kind: "CONTRIBUTION",
    createdAt: `${date}T00:00:00.000Z`,
    grossCents,
    feesCents,
    netCents,
    order: {
      id: orderId,
      ...(tier
        ? {
            tier: {
              id: tier.providerTierId,
              slug: tier.tierSlug,
            },
          }
        : {}),
    },
    account: { name: donorName, isIncognito: incognito },
    ...(stripeChargeId
      ? {
          paymentProcessorUrl:
            `https://dashboard.stripe.com/payments/${stripeChargeId}`,
        }
      : {}),
  };
}

async function createFixture(context) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "indiemath-oc-test-"));
  const databasePath = path.join(scratch, "ledger.sqlite");
  await syncCatalog({ catalog, databasePath });
  const fixture = {
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

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(payload);
    },
  };
}
