#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FakeAnthropicMessages,
  FakeR2,
} from "#indiemath/fakes";
import { loadAnthropicPricingTable } from "#indiemath/anthropic";
import { openLedger } from "#indiemath/ledger";
import {
  r2ArtifactUri,
  solutionKey,
} from "#indiemath/shared";
import { createWorkerRuntime } from "#indiemath/workers";
import {
  readCatalog,
  validateCatalog,
} from "./catalog-lib.mjs";
import { syncCatalog } from "./catalog-ledger.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = validateCatalog(
  await readCatalog(path.join(rootDir, "problems", "catalog.json")),
);
const problem = catalog.problems[0];
const pricingTable = await loadAnthropicPricingTable(
  path.join(rootDir, "pricing", "anthropic.json"),
);
const noDelayRetry = Object.freeze({
  maxAttempts: 3,
  sleep: async () => {},
});
let fixtureSequence = 0;

test("startup discovers its live claim and reconstructs a checkpointed solution", async (context) => {
  const fixture = await createFixture(context);
  const r2 = new FakeR2();
  const messages = new FakeAnthropicMessages({
    responses: [solutionMessage("msg_reconstruct_terminal")],
  });
  const worker = createRuntime({ fixture, r2, messages, workerId: "worker-1" });
  const emptyStartup = await worker.recoverStartup({
    clock: fixture.clock,
    artifactRetryOptions: noDelayRetry,
  });
  assert.equal(emptyStartup.outcome, "ready_to_sample");

  const claim = claimFor(fixture, "worker-1", "prove");
  assert.deepEqual(
    fixture.ledger.getWorkerUnsettledClaim("worker-1"),
    claim,
  );
  await assertCrashAt(worker.runClaim({
    claim,
    taskBudgetTokens: 20_000,
    onBoundary: crashAt("after_ledger_checkpoint"),
  }), "after_ledger_checkpoint");
  await assert.rejects(
    r2.getObject(solutionKey(claim)),
    (error) => error.code === "NoSuchKey",
  );

  const result = await worker.recoverStartup({
    clock: fixture.clock,
    artifactRetryOptions: noDelayRetry,
    runOptions: { taskBudgetTokens: 20_000 },
  });

  assert.equal(result.outcome, "recovered_solution");
  assert.equal(messages.requests.length, 1);
  assert.equal(fixture.ledger.getClaim(claim).settled, true);
  assert.equal(
    fixture.ledger.getClaim(claim).solutionUri,
    r2ArtifactUri(solutionKey(claim)),
  );
  assert.match(
    await (await r2.getObject(solutionKey(claim))).text(),
    /complete Stage 8 argument/,
  );
  assert.equal(fixture.ledger.getProblem(problem.id).status, "PendingReview");
});

test("startup resumes checkpoint history without duplicating spend", async (context) => {
  const fixture = await createFixture(context);
  const r2 = new FakeR2();
  const messages = new FakeAnthropicMessages({
    responses: [
      textMessage("msg_before_restart", "A useful intermediate lemma."),
      solutionMessage("msg_after_restart"),
    ],
  });
  const worker = createRuntime({ fixture, r2, messages, workerId: "worker-1" });
  const claim = claimFor(fixture, "worker-1", "prove");

  await assertCrashAt(worker.runClaim({
    claim,
    taskBudgetTokens: 20_000,
    onBoundary: crashAt("after_ledger_checkpoint"),
  }), "after_ledger_checkpoint");
  const before = fixture.ledger.listClaimResponses(claim);
  assert.equal(before.length, 1);
  assert.equal(before[0].messageId, "msg_before_restart");

  const result = await worker.recoverStartup({
    clock: fixture.clock,
    artifactRetryOptions: noDelayRetry,
    runOptions: { taskBudgetTokens: 20_000 },
  });

  assert.equal(result.outcome, "submitted_solution");
  assert.equal(result.recovery, "resumed");
  assert.equal(messages.requests.length, 2);
  assert.match(
    JSON.stringify(messages.requests[1].messages),
    /useful intermediate lemma/,
  );
  const checkpoints = fixture.ledger.listClaimResponses(claim);
  assert.deepEqual(
    checkpoints.map((row) => row.messageId),
    ["msg_before_restart", "msg_after_restart"],
  );
  assert.equal(
    fixture.ledger.getClaim(claim).spentCents,
    checkpoints.reduce((total, row) => total + row.appliedCostCents, 0),
  );
});

test("startup settles live claims whose lease or budget cannot support another request", async (context) => {
  await context.test("lease remainder", async (subcontext) => {
    const fixture = await createFixture(subcontext);
    const messages = new FakeAnthropicMessages({
      responses: [solutionMessage("msg_unsafe_lease_must_not_run")],
    });
    const worker = createRuntime({
      fixture,
      r2: new FakeR2(),
      messages,
      workerId: "worker-1",
    });
    const initialPool = poolBalance(fixture, "prove");
    const claim = claimFor(fixture, "worker-1", "prove");
    fixture.setNow(Date.parse(claim.leaseExpiresAt) - (5 * 60 * 1_000));
    assert.throws(() => claimFor(fixture, "worker-2", "prove"), (error) => (
      error?.code === "pair-already-claimed"
    ));

    const result = await worker.recoverStartup({
      clock: fixture.clock,
      artifactRetryOptions: noDelayRetry,
      runOptions: { taskBudgetTokens: 20_000 },
    });

    assert.equal(result.outcome, "recovery_lease_unusable");
    assert.equal(result.resample, true);
    assert.equal(messages.requests.length, 0);
    assert.equal(fixture.ledger.getClaim(claim).settled, true);
    assert.equal(poolBalance(fixture, "prove"), initialPool);
    const replacement = claimFor(fixture, "worker-2", "prove");
    assert.equal(replacement.workerId, "worker-2");
    fixture.ledger.settle({ ...replacement, finalSpentCents: 0 });
  });

  await context.test("budget headroom", async (subcontext) => {
    const fixture = await createFixture(subcontext);
    const messages = new FakeAnthropicMessages({
      responses: [solutionMessage("msg_unsafe_budget_must_not_run")],
    });
    const worker = createRuntime({
      fixture,
      r2: new FakeR2(),
      messages,
      workerId: "worker-1",
    });
    const claim = claimFor(fixture, "worker-1", "prove");
    fixture.ledger.checkpointSpend({
      ...claim,
      newSpentCents:
        claim.budgetCents - pricingTable.one_request_headroom_cents,
    });

    const result = await worker.recoverStartup({
      clock: fixture.clock,
      artifactRetryOptions: noDelayRetry,
      runOptions: { taskBudgetTokens: 20_000 },
    });

    assert.equal(result.outcome, "recovery_budget_unusable");
    assert.equal(messages.requests.length, 0);
    assert.equal(fixture.ledger.getClaim(claim).settled, true);
  });
});

test("sampling step zero settles every expired claim and preserves both solution sources", async (context) => {
  const fixture = await createFixture(context);
  const r2 = new FakeR2();
  const prove = claimFor(fixture, "worker-1", "prove");
  const disprove = claimFor(fixture, "worker-2", "disprove");
  await r2.putObject(solutionKey(prove), "# Existing durable solution");

  const worker2Messages = new FakeAnthropicMessages({
    responses: [solutionMessage("msg_expired_checkpoint_solution")],
  });
  const worker2 = createRuntime({
    fixture,
    r2,
    messages: worker2Messages,
    workerId: "worker-2",
  });
  await assertCrashAt(worker2.runClaim({
    claim: disprove,
    taskBudgetTokens: 20_000,
    onBoundary: crashAt("after_ledger_checkpoint"),
  }), "after_ledger_checkpoint");
  fixture.setNow(Math.max(
    Date.parse(prove.leaseExpiresAt),
    Date.parse(disprove.leaseExpiresAt),
  ));

  const worker3 = createRuntime({
    fixture,
    r2,
    messages: new FakeAnthropicMessages(),
    workerId: "worker-3",
  });
  const result = await worker3.settleExpiredClaims({
    clock: fixture.clock,
    artifactRetryOptions: noDelayRetry,
  });

  assert.equal(result.outcome, "expired_claims_settled");
  assert.equal(result.readyToSample, true);
  assert.deepEqual(
    result.settlements.map((row) => row.solutionSource).sort(),
    ["checkpoint", "r2"],
  );
  assert.equal(fixture.ledger.listUnsettledClaims().length, 0);
  assert.equal(
    fixture.ledger.getClaim(prove).solutionUri,
    r2ArtifactUri(solutionKey(prove)),
  );
  assert.equal(
    fixture.ledger.getClaim(disprove).solutionUri,
    r2ArtifactUri(solutionKey(disprove)),
  );
  const storedProblem = fixture.ledger.getProblem(problem.id);
  assert.ok(storedProblem.pendingSolution);
  assert.ok(storedProblem.secondarySolution);
});

test("an unavailable solution lookup never settles or resumes a claim", async (context) => {
  const fixture = await createFixture(context);
  const r2 = new FakeR2();
  const messages = new FakeAnthropicMessages({
    responses: [solutionMessage("msg_r2_outage_must_not_run")],
  });
  const claim = claimFor(fixture, "worker-1", "prove");
  const originalGet = r2.getObject.bind(r2);
  let attempts = 0;
  r2.getObject = async (key) => {
    if (key === solutionKey(claim)) {
      attempts += 1;
      throw new Error("R2 temporarily unavailable");
    }
    return originalGet(key);
  };
  const worker = createRuntime({ fixture, r2, messages, workerId: "worker-1" });

  const result = await worker.recoverStartup({
    clock: fixture.clock,
    artifactRetryOptions: {
      maxAttempts: 2,
      sleep: async () => {},
    },
    runOptions: { taskBudgetTokens: 20_000 },
  });

  assert.equal(result.outcome, "solution_artifact_unavailable");
  assert.equal(result.retryStartup, true);
  assert.equal(result.resample, false);
  assert.equal(attempts, 2);
  assert.equal(messages.requests.length, 0);
  assert.equal(fixture.ledger.getClaim(claim).settled, false);

  fixture.setNow(Date.parse(claim.leaseExpiresAt));
  const cleanup = await worker.settleExpiredClaims({
    clock: fixture.clock,
    artifactRetryOptions: {
      maxAttempts: 2,
      sleep: async () => {},
    },
  });
  assert.equal(cleanup.readyToSample, false);
  assert.equal(fixture.ledger.getClaim(claim).settled, false);
});

test("every paid-run persistence boundary converges after process death", async (context) => {
  const boundaries = [
    "before_anthropic_request",
    "after_r2_partial_mirror",
    "after_anthropic_response",
    "after_ledger_checkpoint",
    "after_r2_checkpoint_mirror",
    "after_r2_solution_write",
    "after_ledger_resolve",
  ];
  for (const boundary of boundaries) {
    await context.test(boundary, async (subcontext) => {
      const fixture = await createFixture(subcontext);
      const r2 = new FakeR2();
      const messages = new FakeAnthropicMessages({
        responses: [
          solutionMessage(`msg_${boundary}_first`),
          solutionMessage(`msg_${boundary}_recovery`),
        ],
      });
      const worker = createRuntime({
        fixture,
        r2,
        messages,
        workerId: "worker-1",
      });
      const claim = claimFor(fixture, "worker-1", "prove");

      await assertCrashAt(worker.runClaim({
        claim,
        taskBudgetTokens: 20_000,
        onBoundary: crashAt(boundary),
      }), boundary);
      const result = await worker.recoverStartup({
        clock: fixture.clock,
        artifactRetryOptions: noDelayRetry,
        runOptions: { taskBudgetTokens: 20_000 },
      });

      assert.ok([
        "submitted_solution",
        "recovered_solution",
        "ready_to_sample",
      ].includes(result.outcome));
      const stored = fixture.ledger.getClaim(claim);
      const checkpoints = fixture.ledger.listClaimResponses(claim);
      assert.equal(stored.settled, true);
      assert.equal(stored.solutionUri, r2ArtifactUri(solutionKey(claim)));
      assert.equal(fixture.ledger.getProblem(problem.id).status, "PendingReview");
      assert.equal(
        stored.spentCents,
        checkpoints.reduce((total, row) => total + row.appliedCostCents, 0),
      );
      assert.equal(new Set(checkpoints.map((row) => row.messageId)).size, checkpoints.length);
    });
  }
});

test("recovery's own R2 and ledger boundaries are restart-safe", async (context) => {
  await context.test("reconstructed solution write", async (subcontext) => {
    const fixture = await createFixture(subcontext);
    const r2 = new FakeR2();
    const claim = claimFor(fixture, "worker-1", "prove");
    const worker = createRuntime({
      fixture,
      r2,
      messages: new FakeAnthropicMessages({
        responses: [solutionMessage("msg_recovery_write_boundary")],
      }),
      workerId: "worker-1",
    });
    await assertCrashAt(worker.runClaim({
      claim,
      taskBudgetTokens: 20_000,
      onBoundary: crashAt("after_ledger_checkpoint"),
    }), "after_ledger_checkpoint");
    fixture.setNow(Date.parse(claim.leaseExpiresAt));

    await assert.rejects(
      worker.settleExpiredClaims({
        clock: fixture.clock,
        artifactRetryOptions: noDelayRetry,
        async onBoundary(event) {
          if (event.name === "after_recovered_solution_write") {
            throw new Error("kill after reconstructing solution");
          }
        },
      }),
      /kill after reconstructing solution/,
    );
    assert.equal(fixture.ledger.getClaim(claim).settled, false);
    assert.match(
      await (await r2.getObject(solutionKey(claim))).text(),
      /complete Stage 8 argument/,
    );

    const retry = await worker.settleExpiredClaims({
      clock: fixture.clock,
      artifactRetryOptions: noDelayRetry,
    });
    assert.equal(retry.readyToSample, true);
    assert.equal(fixture.ledger.getClaim(claim).settled, true);
    assert.equal(
      fixture.ledger.getClaim(claim).solutionUri,
      r2ArtifactUri(solutionKey(claim)),
    );
  });

  for (const boundary of ["before_recovery_settle", "after_recovery_settle"]) {
    await context.test(boundary, async (subcontext) => {
      const fixture = await createFixture(subcontext);
      const claim = claimFor(fixture, "worker-1", "prove");
      fixture.setNow(Date.parse(claim.leaseExpiresAt));
      const worker = createRuntime({
        fixture,
        r2: new FakeR2(),
        messages: new FakeAnthropicMessages(),
        workerId: "worker-2",
      });

      await assert.rejects(
        worker.settleExpiredClaims({
          clock: fixture.clock,
          artifactRetryOptions: noDelayRetry,
          async onBoundary(event) {
            if (event.name === boundary) {
              throw new Error(`kill at ${boundary}`);
            }
          },
        }),
        new RegExp(boundary),
      );
      const retry = await worker.settleExpiredClaims({
        clock: fixture.clock,
        artifactRetryOptions: noDelayRetry,
      });
      assert.equal(retry.readyToSample, true);
      assert.equal(fixture.ledger.getClaim(claim).settled, true);
      assert.equal(fixture.ledger.listUnsettledClaims().length, 0);
    });
  }

  await context.test("recovery resolve", async (subcontext) => {
    const fixture = await createFixture(subcontext);
    const r2 = new FakeR2();
    const claim = claimFor(fixture, "worker-1", "prove");
    await r2.putObject(solutionKey(claim), "# Durable recovered solution");
    const worker = createRuntime({
      fixture,
      r2,
      messages: new FakeAnthropicMessages(),
      workerId: "worker-1",
    });

    await assert.rejects(
      worker.recoverStartup({
        clock: fixture.clock,
        artifactRetryOptions: noDelayRetry,
        async onBoundary(event) {
          if (event.name === "after_recovery_resolve") {
            throw new Error("kill after recovery resolve");
          }
        },
      }),
      /kill after recovery resolve/,
    );
    const retry = await worker.recoverStartup({
      clock: fixture.clock,
      artifactRetryOptions: noDelayRetry,
    });
    assert.equal(retry.outcome, "ready_to_sample");
    assert.equal(fixture.ledger.getClaim(claim).settled, true);
    assert.equal(
      fixture.ledger.getClaim(claim).solutionUri,
      r2ArtifactUri(solutionKey(claim)),
    );
  });
});

test("settlement boundaries and a crashed resolve race converge idempotently", async (context) => {
  for (const boundary of ["before_ledger_settle", "after_ledger_settle"]) {
    await context.test(boundary, async (subcontext) => {
      const fixture = await createFixture(subcontext);
      const messages = new FakeAnthropicMessages({
        responses: [refusalMessage(`msg_${boundary}`)],
      });
      const worker = createRuntime({
        fixture,
        r2: new FakeR2(),
        messages,
        workerId: "worker-1",
      });
      const claim = claimFor(fixture, "worker-1", "prove");

      await assertCrashAt(worker.runClaim({
        claim,
        taskBudgetTokens: 20_000,
        onBoundary: crashAt(boundary),
      }), boundary);
      const result = await worker.recoverStartup({
        clock: fixture.clock,
        artifactRetryOptions: noDelayRetry,
        runOptions: { taskBudgetTokens: 20_000 },
      });

      assert.ok(["refusal", "ready_to_sample"].includes(result.outcome));
      assert.equal(messages.requests.length, 1);
      assert.equal(fixture.ledger.listClaimResponses(claim).length, 1);
      assert.equal(fixture.ledger.getClaim(claim).settled, true);
      assert.equal(fixture.ledger.getClaim(claim).solutionUri, undefined);
    });
  }

  await context.test("resolve race after solution write", async (subcontext) => {
    const fixture = await createFixture(subcontext);
    const r2 = new FakeR2();
    const current = claimFor(fixture, "worker-1", "prove");
    const competitor = claimFor(fixture, "worker-2", "disprove");
    const competitorUri = "r2://solutions/recovery-race-competitor.md";
    const worker = createRuntime({
      fixture,
      r2,
      messages: new FakeAnthropicMessages({
        responses: [solutionMessage("msg_recovery_resolve_race")],
      }),
      workerId: "worker-1",
    });

    await assertCrashAt(worker.runClaim({
      claim: current,
      taskBudgetTokens: 20_000,
      async onBoundary(event) {
        if (event.name !== "after_r2_solution_write") return;
        fixture.ledger.settle({
          ...competitor,
          finalSpentCents: 0,
          solutionUri: competitorUri,
        });
        throw new Error("kill after competitor wins");
      },
    }), "after_r2_solution_write");
    const result = await worker.recoverStartup({
      clock: fixture.clock,
      artifactRetryOptions: noDelayRetry,
      runOptions: { taskBudgetTokens: 20_000 },
    });

    assert.equal(result.outcome, "recovered_solution");
    assert.equal(fixture.ledger.getClaim(current).settled, true);
    const stored = fixture.ledger.getProblem(problem.id);
    assert.equal(stored.pendingSolution.solutionUri, competitorUri);
    assert.equal(
      stored.secondarySolution.solutionUri,
      r2ArtifactUri(solutionKey(current)),
    );
  });
});

function createRuntime({ fixture, r2, messages, workerId }) {
  return createWorkerRuntime({
    config: {
      component: "worker",
      runtime: "fake",
      workerId,
      pricingTablePath: path.join(rootDir, "pricing", "anthropic.json"),
    },
    ledger: fixture.ledger,
    r2,
    anthropicMessages: messages,
    pricingTable,
  });
}

async function createFixture(context) {
  fixtureSequence += 1;
  const directory = await mkdtemp(path.join(os.tmpdir(), "indiemath-recovery-"));
  const databasePath = path.join(directory, "ledger.sqlite");
  let now = Date.parse("2026-07-29T12:00:00.000Z") + fixtureSequence * 10_000;
  const ledger = await openLedger({
    databasePath,
    clock: () => new Date(now),
  });
  await syncCatalog({ databasePath, catalog });
  for (const direction of ["prove", "disprove"]) {
    ledger.donate({
      dedupId: `recovery-${fixtureSequence}-${direction}`,
      orderId: `recovery-order-${fixtureSequence}-${direction}`,
      destination: {
        kind: "pool",
        problemId: problem.id,
        direction,
      },
      grossCents: 50_000,
      feesCents: 0,
      netCents: 50_000,
      donorTag: "Stage 8 recovery test",
      creditedAt: new Date(now - 1_000).toISOString(),
    });
  }
  ledger.treasuryFund({
    amountCents: 100_000,
    externalReference: `recovery-fund-${fixtureSequence}`,
    settledContributionCents: 100_000,
  });
  const fixture = {
    ledger,
    databasePath,
    clock: () => now,
    setNow(value) {
      now = value;
    },
  };
  context.after(async () => {
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  });
  return fixture;
}

function claimFor(fixture, workerId, direction) {
  return fixture.ledger.claim({
    problemId: problem.id,
    direction,
    runBudgetCents: 5_000,
    workerId,
  });
}

function poolBalance(fixture, direction) {
  return fixture.ledger.inspect().pools.find((pool) => (
    pool.problemId === problem.id && pool.direction === direction
  )).balanceCents;
}

function crashAt(boundary) {
  return async (event) => {
    if (event.name === boundary) throw new Error(`process death at ${boundary}`);
  };
}

async function assertCrashAt(promise, boundary) {
  await assert.rejects(
    promise,
    (error) => (
      error?.name === "WorkerProcessCrashError"
      && error.boundary === boundary
    ),
  );
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
        title: "Stage 8 solution",
        summary: "The recovered run reached its terminal tool.",
        argument_markdown: "This is the complete Stage 8 argument.",
        verification_notes: "Crash recovery preserved the terminal record.",
      },
    }],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function textMessage(id, text) {
  return {
    id,
    type: "message",
    role: "assistant",
    model: "claude-fable-5",
    content: [{ type: "text", text }],
    stop_reason: "pause_turn",
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function refusalMessage(id) {
  return {
    id,
    type: "message",
    role: "assistant",
    model: "claude-fable-5",
    content: [{ type: "text", text: "I cannot continue this request." }],
    stop_reason: "refusal",
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}
