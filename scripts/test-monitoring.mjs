#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkOperationalHealth,
  readSystemdServiceStates,
  requiredProductionServices,
} from "#indiemath/admin-cli";
import { FakeOpenCollective } from "#indiemath/fakes";
import { openLedger, syncCatalog } from "#indiemath/ledger";
import { readCatalog, validateCatalog } from "./catalog-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = validateCatalog(
  await readCatalog(path.join(rootDir, "problems", "catalog.json")),
);
const now = "2026-07-30T04:01:00.000Z";

test("health monitoring follows the configured worker count", async (context) => {
  const fixture = await createFixture(context);
  fixture.ledger.saveIntakeCheckpoint({
    source: "open-collective-contribution-credits",
    highWaterAt: "2026-07-30T04:00:30.000Z",
    updatedAt: "2026-07-30T04:00:30.000Z",
  });
  const publicDocuments = documents({
    generatedAt: "2026-07-30T04:00:30.000Z",
  });
  const health = await checkOperationalHealth({
    ledger: fixture.ledger,
    openCollective: new FakeOpenCollective(),
    publicDataBaseUrl: "https://public.example.test",
    publicSiteUrl: "https://indiemath.example.test",
    serviceStates: activeServiceStates(2),
    fetchImpl: fakeFetch(publicDocuments),
    now,
    workerCount: 2,
  });

  assert.equal(health.ok, true);
  const liveness = check(health, "worker-liveness");
  assert.equal(liveness.workerCount, 2);
  assert.deepEqual(
    Object.keys(liveness.services),
    requiredProductionServices(2),
  );
  assert.equal(
    Object.hasOwn(
      liveness.services,
      "indiemath-worker@worker-3.service",
    ),
    false,
  );
});

test("health monitoring reports service, intake, public, and terms failures",
  async (context) => {
    const fixture = await createFixture(context);
    fixture.ledger.saveIntakeCheckpoint({
      source: "open-collective-contribution-credits",
      highWaterAt: "2026-07-30T03:00:00.000Z",
      updatedAt: "2026-07-30T03:00:00.000Z",
    });
    const publicDocuments = documents({
      generatedAt: "2026-07-30T03:00:00.000Z",
      terms: "<html>incomplete</html>",
    });
    const serviceStates = activeServiceStates(3);
    serviceStates["indiemath-worker@worker-2.service"] = "failed";
    const health = await checkOperationalHealth({
      ledger: fixture.ledger,
      openCollective: new FakeOpenCollective({
        transactions: [{
          id: "missing-monitor-transaction",
          type: "CREDIT",
          kind: "CONTRIBUTION",
          createdAt: "2026-07-30T03:30:00.000Z",
          grossCents: 5_000,
          feesCents: 0,
          netCents: 5_000,
          order: { id: "missing-monitor-order" },
          account: { name: "Missing", isIncognito: false },
        }],
      }),
      publicDataBaseUrl: "https://public.example.test",
      publicSiteUrl: "https://indiemath.example.test",
      serviceStates,
      fetchImpl: fakeFetch(publicDocuments),
      now,
      workerCount: 3,
      maxIntakeLagSeconds: 180,
      maxPublicationLagSeconds: 180,
    });

    assert.equal(health.ok, false);
    assert.equal(check(health, "worker-liveness").ok, false);
    assert.equal(check(health, "intake-lag").lagSeconds, 3_660);
    assert.equal(check(health, "public-data").ok, false);
    assert.equal(check(health, "terms-page").ok, false);
    assert.deepEqual(
      check(health, "reconciliation-drift").missingFromLedger,
      ["missing-monitor-transaction"],
    );
  });

test("health monitoring detects settled funds that were never staged",
  async (context) => {
    const fixture = await createFixture(context);
    fixture.ledger.saveIntakeCheckpoint({
      source: "open-collective-contribution-credits",
      highWaterAt: "2026-07-30T04:00:30.000Z",
      updatedAt: "2026-07-30T04:00:30.000Z",
    });
    fixture.ledger.donate({
      dedupId: "manual-capacity-monitor",
      orderId: "manual-capacity-monitor-order",
      destination: { kind: "general" },
      grossCents: 5_000,
      feesCents: 0,
      netCents: 5_000,
      donorTag: "Capacity monitor",
      creditedAt: "2026-07-30T03:00:00.000Z",
      source: { kind: "manual", attribution: "manual", metadata: {} },
    });
    fixture.ledger.recordSettlementSnapshot({
      snapshotId: `stripe:acct_monitor:${"b".repeat(64)}`,
      providerKind: "stripe",
      providerAccountId: "acct_monitor",
      cutoffAt: "2026-07-30T03:30:00.000Z",
      settledContributionCents: 5_000,
      sourceRecordCount: 1,
      sourceHash: "b".repeat(64),
      source: { controlled: true },
      createdAt: "2026-07-30T03:31:00.000Z",
    });
    const health = await checkOperationalHealth({
      ledger: fixture.ledger,
      openCollective: new FakeOpenCollective(),
      publicDataBaseUrl: "https://public.example.test",
      publicSiteUrl: "https://indiemath.example.test",
      serviceStates: activeServiceStates(1),
      fetchImpl: fakeFetch(documents({
        generatedAt: "2026-07-30T04:00:30.000Z",
      })),
      now,
      workerCount: 1,
    });

    assert.equal(health.ok, false);
    assert.equal(check(health, "capacity").fundableButUnstaged, true);
    assert.equal(check(health, "capacity").availableToFundCents, 5_000);
  });

test("systemd probing uses only the selected fleet", async () => {
  const calls = [];
  const states = await readSystemdServiceStates({
    workerCount: 1,
    execFileImpl: async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: "active\n" };
    },
  });
  assert.deepEqual(
    calls.map((call) => call.at(-1)),
    requiredProductionServices(1),
  );
  assert.ok(Object.values(states).every((state) => state === "active"));
});

function documents({
  generatedAt,
  terms = [
    "Lipschitz Strategies LLC",
    "<span data-cfemail=\"8be8e4e5ffeae8ffcbe2e5efe2eee6eaffe3a5eae2\">"
      + "[email protected]</span>",
    "Refund",
    "Dispute",
    "Cancellation",
  ].join("\n"),
}) {
  const publicationId = "a".repeat(64);
  const ledgerKey = `public/publications/${publicationId}/ledger.json`;
  const ledger = JSON.stringify({
    publicationId,
    catalogRevision: catalog.catalog_revision,
  });
  const state = JSON.stringify({
    publicationId,
    catalogRevision: catalog.catalog_revision,
    ledgerKey,
    ledgerSha256: createHash("sha256").update(ledger).digest("hex"),
    generatedAt,
  });
  return new Map([
    ["/public/state.json", state],
    [`/${ledgerKey}`, ledger],
    ["/terms", terms],
  ]);
}

function fakeFetch(documentsByPath) {
  return async (url) => {
    const pathname = new URL(url).pathname;
    const body = documentsByPath.get(pathname);
    return body === undefined
      ? { ok: false, status: 404, text: async () => "" }
      : { ok: true, status: 200, text: async () => body };
  };
}

function activeServiceStates(workerCount) {
  return Object.fromEntries(
    requiredProductionServices(workerCount)
      .map((service) => [service, "active"]),
  );
}

function check(health, id) {
  return health.checks.find((candidate) => candidate.id === id);
}

async function createFixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "indiemath-monitor-"));
  const databasePath = path.join(directory, "ledger.sqlite");
  const ledger = await openLedger({
    databasePath,
    clock: () => new Date(now),
  });
  await syncCatalog({ databasePath, catalog });
  context.after(async () => {
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ledger };
}
