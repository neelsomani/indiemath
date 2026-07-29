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
import {
  loadAnthropicPricingTable,
} from "#indiemath/anthropic";
import { openLedger } from "#indiemath/ledger";
import {
  compactedContextKey,
  humanTranscriptKey,
  rawTranscriptKey,
  r2ArtifactUri,
  solutionKey,
} from "#indiemath/shared";
import {
  createProductionWorkerRuntime,
  createWorkerRuntime,
} from "#indiemath/workers";
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

test("production worker composition binds the real R2 and Anthropic ports", async (context) => {
  const fixture = await createFixture(context);
  const worker = createProductionWorkerRuntime({
    config: {
      component: "worker",
      runtime: "production",
      workerId: "worker-1",
      pricingTablePath: path.join(rootDir, "pricing", "anthropic.json"),
      r2: {
        kind: "r2",
        endpoint: "https://example.r2.cloudflarestorage.com/",
        bucket: "stage7",
        accessKeyId: "access",
        secretAccessKey: "secret",
      },
      anthropic: {
        apiKey: "worker-secret",
      },
    },
    ledger: fixture.ledger,
    pricingTable,
    fetchImpl: async () => new Response(
      "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>",
    ),
  });
  const probe = await worker.probe();
  assert.equal(probe.ok, true);
  assert.equal(probe.dependencies.r2.fake, false);
  assert.equal(probe.dependencies.anthropicMessages.configured, true);
});

test("worker lifecycle assembles reviewed context and persists every audit surface", async (context) => {
  const fixture = await createFixture(context);
  const r2 = new FakeR2();
  const conditional = fixture.ledger.claim({
    problemId: problem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
  });
  const conditionalSolutionKey = solutionKey(conditional);
  const conditionalNoteKey = `reviews/${problem.id}/conditional.md`;
  await r2.putObject(
    conditionalSolutionKey,
    "# Conditional result\n\nA lemma follows under GRH.",
  );
  await r2.putObject(
    conditionalNoteKey,
    "The proof is valid only when GRH is assumed.",
  );
  fixture.ledger.settle({
    ...conditional,
    finalSpentCents: 0,
    solutionUri: r2ArtifactUri(conditionalSolutionKey),
  });
  fixture.ledger.review({
    problemId: problem.id,
    verdict: "conditional",
    assumptionLabel: "Generalized Riemann Hypothesis",
    noteUri: r2ArtifactUri(conditionalNoteKey),
  });

  const rejected = fixture.ledger.claim({
    problemId: problem.id,
    direction: "disprove",
    runBudgetCents: 5_000,
    workerId: "worker-2",
  });
  const rejectedSolutionKey = solutionKey(rejected);
  const rejectedNoteKey = `reviews/${problem.id}/rejected.md`;
  await r2.putObject(rejectedSolutionKey, "# Rejected result\n\nA failed counterexample.");
  await r2.putObject(
    rejectedNoteKey,
    "The numerical interval did not certify the claimed zero.",
  );
  fixture.ledger.settle({
    ...rejected,
    finalSpentCents: 0,
    solutionUri: r2ArtifactUri(rejectedSolutionKey),
  });
  fixture.ledger.review({
    problemId: problem.id,
    verdict: "rejected",
    noteUri: r2ArtifactUri(rejectedNoteKey),
  });

  await r2.putObject(
    compactedContextKey({ problemId: problem.id, direction: "prove" }),
    "Prior prove direction compacted context.",
  );
  await r2.putObject(
    compactedContextKey({ problemId: problem.id, direction: "disprove" }),
    "Prior disprove direction compacted context.",
  );

  const claim = fixture.ledger.claim({
    problemId: problem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
  });
  const messages = new FakeAnthropicMessages({
    responses: [solutionMessage("msg_stage7_normal")],
  });
  const worker = createRuntime({
    fixture,
    r2,
    messages,
    workerId: "worker-1",
  });
  const result = await worker.runClaim({
    claim,
    taskBudgetTokens: 20_000,
  });

  assert.equal(result.outcome, "submitted_solution");
  assert.equal(messages.requests.length, 1);
  const systemPrompt = messages.requests[0].system[0].text;
  assert.match(systemPrompt, /numerical interval did not certify/i);
  assert.match(systemPrompt, /Generalized Riemann Hypothesis/);
  assert.match(systemPrompt, /A lemma follows under GRH/);
  assert.match(
    messages.requests[0].messages[0].content,
    /Prior prove direction compacted context/,
  );
  assert.match(
    messages.requests[0].messages[0].content,
    /Prior disprove direction compacted context/,
  );

  const checkpoint = fixture.ledger.listClaimResponses(claim)[0];
  assert.equal(checkpoint.messageId, "msg_stage7_normal");
  const raw = await r2.getObject(rawTranscriptKey({ ...claim, sequence: 1 }));
  const rawRecords = (await raw.text()).trim().split("\n").map(JSON.parse);
  assert.equal(rawRecords[0].type, "request");
  assert.ok(rawRecords.some((record) => record.type === "anthropic_event"));
  assert.equal(rawRecords.at(-1).type, "checkpoint");
  assert.equal(raw.metadata.state, "completed");

  const human = await r2.getObject(humanTranscriptKey({ ...claim, sequence: 1 }));
  assert.match(await human.text(), /Client tool: submit_solution/);
  assert.match(await human.text(), /complete Stage 7 argument/);
  assert.equal(human.metadata.state, "completed");

  const solution = await r2.getObject(solutionKey(claim));
  assert.match(await solution.text(), /complete Stage 7 argument/);
  assert.equal(fixture.ledger.getClaim(claim).solutionUri, result.solutionUri);
  assert.equal(fixture.ledger.getProblem(problem.id).status, "PendingReview");
});

test("persistent Anthropic failure settles the claim and returns its residue", async (context) => {
  const fixture = await createFixture(context);
  const initialPool = poolBalance(fixture.ledger, "prove");
  const claim = fixture.ledger.claim({
    problemId: problem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
  });
  const messages = failingMessages(new TypeError("invalid persistent API response"));
  const worker = createRuntime({
    fixture,
    r2: new FakeR2(),
    messages,
    workerId: "worker-1",
  });

  const result = await worker.runClaim({
    claim,
    taskBudgetTokens: 20_000,
    retryOptions: {
      maxAttempts: 2,
      random: () => 0,
      sleep: async () => {},
    },
  });

  assert.equal(result.outcome, "persistent_api_failure");
  assert.equal(messages.calls, 2);
  assert.match(result.failure.message, /persistent API response/);
  assert.equal(fixture.ledger.getClaim(claim).settled, true);
  assert.equal(fixture.ledger.getClaim(claim).spentCents, 0);
  assert.equal(poolBalance(fixture.ledger, "prove"), initialPool);
});

test("catalog revision mismatch settles immediately and directs resampling", async (context) => {
  const fixture = await createFixture(context);
  const initialPool = poolBalance(fixture.ledger, "prove");
  const claim = fixture.ledger.claim({
    problemId: problem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
  });
  const revisedCatalog = structuredClone(catalog);
  revisedCatalog.catalog_revision += 1;
  revisedCatalog.problems[0].directions.prove += " Revised presentation.";
  await syncCatalog({
    databasePath: fixture.databasePath,
    catalog: revisedCatalog,
  });
  const messages = new FakeAnthropicMessages({
    responses: [solutionMessage("msg_revision_guard_must_not_run")],
  });
  const worker = createRuntime({
    fixture,
    r2: new FakeR2(),
    messages,
    workerId: "worker-1",
  });

  const result = await worker.runClaim({
    claim,
    taskBudgetTokens: 20_000,
  });

  assert.equal(result.outcome, "catalog_revision_mismatch");
  assert.equal(result.reason, "catalog-revision-mismatch");
  assert.equal(result.resample, true);
  assert.equal(result.attempts, 1);
  assert.equal(messages.requests.length, 0);
  assert.equal(fixture.ledger.getClaim(claim).settled, true);
  assert.equal(fixture.ledger.getClaim(claim).spentCents, 0);
  assert.equal(poolBalance(fixture.ledger, "prove"), initialPool);
});

test("review artifacts retry transient failure before model dispatch", async (context) => {
  const fixture = await createFixture(context);
  const r2 = new FakeR2();
  const { noteKey } = await recordConditionalReview({ fixture, r2 });
  let failuresRemaining = 2;
  const getObject = r2.getObject.bind(r2);
  r2.getObject = async (key) => {
    if (key === noteKey && failuresRemaining > 0) {
      failuresRemaining -= 1;
      throw new Error("transient R2 read failure");
    }
    return getObject(key);
  };
  const claim = fixture.ledger.claim({
    problemId: problem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
  });
  const messages = new FakeAnthropicMessages({
    responses: [solutionMessage("msg_after_context_retry")],
  });
  const worker = createRuntime({
    fixture,
    r2,
    messages,
    workerId: "worker-1",
  });
  const delays = [];

  const result = await worker.runClaim({
    claim,
    taskBudgetTokens: 20_000,
    contextRetryOptions: {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 20,
      sleep: async (delayMs) => delays.push(delayMs),
    },
  });

  assert.equal(result.outcome, "submitted_solution");
  assert.deepEqual(delays, [10, 20]);
  assert.equal(failuresRemaining, 0);
  assert.equal(messages.requests.length, 1);
  assert.match(messages.requests[0].system[0].text, /Assumption used for retry testing/);
});

test("persistent review artifact failure settles and never runs degraded", async (context) => {
  const fixture = await createFixture(context);
  const r2 = new FakeR2();
  const { noteKey } = await recordConditionalReview({ fixture, r2 });
  let failedReads = 0;
  const getObject = r2.getObject.bind(r2);
  r2.getObject = async (key) => {
    if (key === noteKey) {
      failedReads += 1;
      throw new Error("persistent R2 read failure");
    }
    return getObject(key);
  };
  const initialPool = poolBalance(fixture.ledger, "prove");
  const claim = fixture.ledger.claim({
    problemId: problem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
  });
  const messages = new FakeAnthropicMessages({
    responses: [solutionMessage("msg_degraded_context_must_not_run")],
  });
  const worker = createRuntime({
    fixture,
    r2,
    messages,
    workerId: "worker-1",
  });

  const result = await worker.runClaim({
    claim,
    taskBudgetTokens: 20_000,
    contextRetryOptions: {
      maxAttempts: 2,
      sleep: async () => {},
    },
  });

  assert.equal(result.outcome, "review_artifact_unavailable");
  assert.equal(result.reason, "review-artifact-unavailable");
  assert.equal(result.resample, true);
  assert.equal(result.attempts, 2);
  assert.equal(failedReads, 2);
  assert.equal(messages.requests.length, 0);
  assert.equal(fixture.ledger.getClaim(claim).settled, true);
  assert.equal(fixture.ledger.getClaim(claim).spentCents, 0);
  assert.equal(poolBalance(fixture.ledger, "prove"), initialPool);
});

test("a status change during backoff prevents the next API attempt", async (context) => {
  const fixture = await createFixture(context);
  const current = fixture.ledger.claim({
    problemId: problem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
  });
  const competitor = fixture.ledger.claim({
    problemId: problem.id,
    direction: "disprove",
    runBudgetCents: 5_000,
    workerId: "worker-2",
  });
  let calls = 0;
  const messages = {
    async healthcheck() {
      return { ok: true };
    },
    async createMessage() {
      throw new Error("not used");
    },
    async *streamMessage() {
      calls += 1;
      if (calls === 1) throw new TypeError("temporary network failure");
      yield* streamMessage(solutionMessage("msg_must_not_run"));
    },
  };
  const worker = createRuntime({
    fixture,
    r2: new FakeR2(),
    messages,
    workerId: "worker-1",
  });

  const result = await worker.runClaim({
    claim: current,
    taskBudgetTokens: 20_000,
    retryOptions: {
      maxAttempts: 2,
      random: () => 0,
      async sleep() {
        fixture.ledger.settle({
          ...competitor,
          finalSpentCents: 0,
          solutionUri: "r2://solutions/competitor-after-backoff.md",
        });
      },
    },
  });

  assert.equal(result.outcome, "problem_no_longer_open");
  assert.equal(calls, 1);
  assert.equal(fixture.ledger.getClaim(current).settled, true);
});

test("compaction status checks stop cleanly and a lost solution race stays reviewable", async (context) => {
  await context.test("compaction boundary", async () => {
    const fixture = await createFixture(context);
    const current = fixture.ledger.claim({
      problemId: problem.id,
      direction: "prove",
      runBudgetCents: 5_000,
      workerId: "worker-1",
    });
    const competitor = fixture.ledger.claim({
      problemId: problem.id,
      direction: "disprove",
      runBudgetCents: 5_000,
      workerId: "worker-2",
    });
    const messages = new FakeAnthropicMessages({
      responses: [{
        id: "msg_compaction_status",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [{
          type: "compaction",
          content: "Carry the exact lemma.",
          encrypted_content: "encrypted",
        }],
        stop_reason: "pause_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      }],
    });
    const worker = createRuntime({
      fixture,
      r2: new FakeR2(),
      messages,
      workerId: "worker-1",
    });
    let closed = false;
    const result = await worker.runClaim({
      claim: current,
      taskBudgetTokens: 20_000,
      async onEvent(event) {
        if (event.type !== "message_stop" || closed) return;
        closed = true;
        fixture.ledger.settle({
          ...competitor,
          finalSpentCents: 0,
          solutionUri: "r2://solutions/compaction-competitor.md",
        });
      },
    });
    assert.equal(result.outcome, "problem_no_longer_open");
    assert.equal(messages.requests.length, 1);
    assert.equal(fixture.ledger.getClaim(current).settled, true);
  });

  await context.test("lost resolve race", async () => {
    const fixture = await createFixture(context);
    const current = fixture.ledger.claim({
      problemId: problem.id,
      direction: "prove",
      runBudgetCents: 5_000,
      workerId: "worker-1",
    });
    const competitor = fixture.ledger.claim({
      problemId: problem.id,
      direction: "disprove",
      runBudgetCents: 5_000,
      workerId: "worker-2",
    });
    const messages = new FakeAnthropicMessages({
      responses: [solutionMessage("msg_lost_race")],
    });
    const r2 = new FakeR2();
    const worker = createRuntime({
      fixture,
      r2,
      messages,
      workerId: "worker-1",
    });
    let resolved = false;
    const result = await worker.runClaim({
      claim: current,
      taskBudgetTokens: 20_000,
      async onEvent(event) {
        if (event.type !== "message_stop" || resolved) return;
        resolved = true;
        fixture.ledger.settle({
          ...competitor,
          finalSpentCents: 0,
          solutionUri: "r2://solutions/lost-race-winner.md",
        });
      },
    });

    assert.equal(result.outcome, "submitted_solution");
    const stored = fixture.ledger.getProblem(problem.id);
    assert.equal(stored.pendingSolution.direction, "disprove");
    assert.equal(stored.secondarySolution.direction, "prove");
    assert.equal(stored.secondarySolution.solutionUri, result.solutionUri);
    assert.equal(fixture.ledger.getClaim(current).settled, true);
    assert.match(await (await r2.getObject(solutionKey(current))).text(), /Stage 7/);
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "indiemath-worker-"));
  const databasePath = path.join(directory, "ledger.sqlite");
  const ledger = await openLedger({ databasePath });
  await syncCatalog({ databasePath, catalog });
  donate(ledger, "prove", 50_000);
  donate(ledger, "disprove", 50_000);
  ledger.treasuryFund({
    amountCents: 100_000,
    externalReference: `fund-${path.basename(directory)}`,
    settledContributionCents: 100_000,
  });
  const fixture = { directory, databasePath, ledger };
  context.after(async () => {
    fixture.ledger.close();
    await rm(directory, { recursive: true, force: true });
  });
  return fixture;
}

function donate(ledger, direction, amountCents) {
  ledger.donate({
    dedupId: `transaction-${direction}-${Date.now()}-${Math.random()}`,
    orderId: `order-${direction}-${Date.now()}-${Math.random()}`,
    destination: {
      kind: "pool",
      problemId: problem.id,
      direction,
    },
    grossCents: amountCents,
    feesCents: 0,
    netCents: amountCents,
    donorTag: "Stage 7 test",
    creditedAt: new Date().toISOString(),
  });
}

function poolBalance(ledger, direction) {
  return ledger.inspect().pools.find((pool) => (
    pool.problemId === problem.id && pool.direction === direction
  )).balanceCents;
}

async function recordConditionalReview({ fixture, r2 }) {
  const reviewedClaim = fixture.ledger.claim({
    problemId: problem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
  });
  const reviewedSolutionKey = solutionKey(reviewedClaim);
  const noteKey = `reviews/${problem.id}/context-retry.md`;
  await r2.putObject(
    reviewedSolutionKey,
    "# Conditional result\n\nThe proof depends on a named assumption.",
  );
  await r2.putObject(noteKey, "This review note must reach the next worker.");
  fixture.ledger.settle({
    ...reviewedClaim,
    finalSpentCents: 0,
    solutionUri: r2ArtifactUri(reviewedSolutionKey),
  });
  fixture.ledger.review({
    problemId: problem.id,
    verdict: "conditional",
    assumptionLabel: "Assumption used for retry testing",
    noteUri: r2ArtifactUri(noteKey),
  });
  return { noteKey, reviewedSolutionKey };
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
        title: "Stage 7 solution",
        summary: "The run reached the terminal tool.",
        argument_markdown: "This is the complete Stage 7 argument.",
        verification_notes: "The lifecycle test verified every persisted boundary.",
      },
    }],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function failingMessages(error) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async healthcheck() {
      return { ok: true };
    },
    async createMessage() {
      throw error;
    },
    async *streamMessage() {
      calls += 1;
      throw error;
    },
  };
}

async function* streamMessage(response) {
  yield {
    type: "message_start",
    message: {
      ...response,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
  for (const [index, block] of response.content.entries()) {
    yield {
      type: "content_block_start",
      index,
      content_block: { ...block, input: {} },
    };
    yield {
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(block.input),
      },
    };
    yield { type: "content_block_stop", index };
  }
  yield {
    type: "message_delta",
    delta: { stop_reason: response.stop_reason },
    usage: response.usage,
  };
  yield { type: "message_stop" };
}
