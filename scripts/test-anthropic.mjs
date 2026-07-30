#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  ANTHROPIC_BETAS,
  AnthropicAdminClient,
  AnthropicApiError,
  AnthropicMessagesClient,
  AnthropicProtocolError,
  AnthropicStreamError,
  buildFableRequest,
  buildFableSystemPrompt,
  collectAnthropicUsage,
  collectMessageStream,
  createAdminAnthropicClient,
  createWorkerAnthropicClient,
  loadAnthropicPricingTable,
  parseAnthropicEventStream,
  priceAnthropicUsage,
  reconcileClaimUsage,
  republishPublicResearchArtifacts,
  renewedTaskBudgetMessages,
  retryAnthropicOperation,
  runClaimUsageReconciliation,
  runFableClaim,
  taskBudgetTokensForCents,
} from "#indiemath/anthropic";
import { FakeAnthropicMessages, FakeR2 } from "#indiemath/fakes";
import { openLedger } from "#indiemath/ledger";
import {
  compactedContextKey,
  researchSessionTranscriptKey,
  solutionKey,
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
const problem = catalog.problems[0];
const pricingTable = await loadAnthropicPricingTable(
  path.join(rootDir, "pricing", "anthropic.json"),
);

test("Fable request pins the current model features and reserves termination for solutions", () => {
  const systemPrompt = buildFableSystemPrompt({
    problem,
    direction: "prove",
    directionPrompt: problem.directions.prove,
    rejectionNotes: ["A previous proof used an unjustified interchange of limits."],
    reviewedResults: [{
      outcome: "conditional",
      assumptionLabel: "Generalized Riemann Hypothesis",
    }],
  });
  const request = buildFableRequest({
    systemPrompt,
    messages: [{ role: "user", content: "Begin." }],
    taskBudgetTokens: 64_000,
    taskBudgetRemainingTokens: 50_000,
    pauseAfterCompaction: true,
  });

  assert.equal(request.model, "claude-fable-5");
  assert.equal(request.max_tokens, 64_000);
  assert.deepEqual(request.output_config.task_budget, {
    type: "tokens",
    total: 64_000,
    remaining: 50_000,
  });
  assert.deepEqual(request.cache_control, { type: "ephemeral" });
  assert.equal(request.context_management.edits[0].type, "compact_20260112");
  assert.equal(request.context_management.edits[0].pause_after_compaction, true);
  assert.match(
    request.context_management.edits[0].instructions,
    /nonempty carry-forward summary/,
  );
  assert.ok(request.tools.some((tool) => tool.type === "code_execution_20260521"));
  assert.ok(request.tools.some((tool) => tool.type === "web_fetch_20260318"));
  assert.ok(request.tools.some((tool) => tool.name === "submit_solution"));
  assert.ok(!request.tools.some((tool) => tool.name === "submit_no_solution"));
  assert.match(systemPrompt, /genuinely new analysis/i);
  assert.match(systemPrompt, /end_turn is only an API turn boundary/i);
  assert.match(systemPrompt, /until the claim's dollar budget/i);
  assert.match(systemPrompt, /compaction summary is a nonterminal/i);
  assert.match(systemPrompt, /unjustified interchange/);
  assert.deepEqual(ANTHROPIC_BETAS, [
    "task-budgets-2026-03-13",
    "compact-2026-01-12",
  ]);
});

test("a $50 financial claim receives a $50 output-equivalent task budget", () => {
  assert.equal(taskBudgetTokensForCents({
    budgetCents: 5_000,
    pricingTable,
  }), 1_000_000);
});

test("task-budget renewal starts from the latest pair compaction, not a reset sequence", () => {
  const messages = renewedTaskBudgetMessages([
    {
      claimTs: 1,
      sequence: 1,
      response: { content: [{ type: "compaction", content: "OLD COMPACTION" }] },
    },
    {
      claimTs: 1,
      sequence: 2,
      response: { content: [{ type: "text", text: "OLD FOLLOWUP" }] },
    },
    {
      claimTs: 2,
      sequence: 1,
      response: {
        content: [{
          type: "compaction",
          content:
            "LATEST COMPACTION\n\nBudget is exhausted; ending the funded turn.\n\n"
            + "This is the terminal state; the filed negative record is final. Ending the turn.\n\n"
            + "Investigation complete within funded budget; this is the terminal record.",
        }],
      },
    },
    {
      claimTs: 2,
      sequence: 2,
      response: { content: [{ type: "text", text: "LATEST FOLLOWUP" }] },
    },
  ]);
  const text = messages[0].content;
  assert.doesNotMatch(text, /OLD COMPACTION|OLD FOLLOWUP/);
  assert.match(text, /LATEST COMPACTION/);
  assert.match(text, /LATEST FOLLOWUP/);
  assert.doesNotMatch(
    text.split("The prior model task-token countdown ended")[0],
    /budget is exhausted|ending (?:the funded |the )?turn|terminal state|record is final|terminal record/i,
  );
});

test("production configuration constructs the real Messages and Admin clients", async () => {
  const workerClient = createWorkerAnthropicClient({
    config: {
      component: "worker",
      runtime: "production",
      anthropic: { apiKey: "worker-secret" },
    },
    fetchImpl: async () => Response.json(message({ id: "msg_factory" })),
  });
  const adminClient = createAdminAnthropicClient({
    config: {
      component: "admin-cli",
      runtime: "production",
      anthropicAdmin: { apiKey: "admin-secret" },
    },
    fetchImpl: async () => Response.json({ data: [], has_more: false }),
  });
  assert.equal((await workerClient.healthcheck()).configured, true);
  assert.equal((await adminClient.healthcheck()).configured, true);
  assert.throws(() => createWorkerAnthropicClient({
    config: {
      component: "worker",
      runtime: "fake",
      anthropic: {},
    },
  }), /production runtime/);
});

test("SSE assembly handles split UTF-8, partial tool JSON, thinking, and compaction", async () => {
  const events = [
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_stream",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    }),
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Proof ∑🙂" },
    }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "tool_1",
        name: "submit_solution",
        input: {},
      },
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "{\"title\":\"A\"," },
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "input_json_delta",
        partial_json:
          "\"summary\":\"B\",\"argument_markdown\":\"C\",\"verification_notes\":\"D\"}",
      },
    }),
    event("content_block_stop", { type: "content_block_stop", index: 1 }),
    event("content_block_start", {
      type: "content_block_start",
      index: 2,
      content_block: { type: "thinking", thinking: "", signature: "" },
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 2,
      delta: { type: "thinking_delta", thinking: "summary" },
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 2,
      delta: { type: "signature_delta", signature: "sig" },
    }),
    event("content_block_stop", { type: "content_block_stop", index: 2 }),
    event("content_block_start", {
      type: "content_block_start",
      index: 3,
      content_block: {
        type: "compaction",
        content: "",
        encrypted_content: "",
      },
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 3,
      delta: {
        type: "compaction_delta",
        content: "retained lemma",
        encrypted_content: "encrypted-retained-lemma",
      },
    }),
    event("content_block_stop", { type: "content_block_stop", index: 3 }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        iterations: [{ type: "message", input_tokens: 10, output_tokens: 20 }],
      },
      context_management: {
        applied_edits: [{ type: "compact_20260112" }],
      },
    }),
    event("message_stop", { type: "message_stop" }),
  ].join("");
  const bytes = new TextEncoder().encode(events);
  const chunks = [];
  for (let index = 0; index < bytes.length; index += 3) {
    chunks.push(bytes.slice(index, index + 3));
  }
  const parsed = parseAnthropicEventStream(asyncChunks(chunks));
  const response = await collectMessageStream(parsed);

  assert.equal(response.content[0].text, "Proof ∑🙂");
  assert.equal(response.content[1].input.argument_markdown, "C");
  assert.equal(response.content[2].thinking, "summary");
  assert.equal(response.content[2].signature, "sig");
  assert.equal(response.content[3].content, "retained lemma");
  assert.equal(
    response.content[3].encrypted_content,
    "encrypted-retained-lemma",
  );
  assert.equal(response.stop_reason, "tool_use");
  assert.equal(response.usage.iterations[0].output_tokens, 20);
  assert.deepEqual(response.context_management, {
    applied_edits: [{ type: "compact_20260112" }],
  });
});

test("stream protocol rejects malformed JSON, invalid lifecycle, truncation, and error events", async () => {
  await assert.rejects(
    collectMessageStream(asEvents([
      messageStart("msg_bad_tool"),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tool", name: "x", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{" },
      },
      { type: "content_block_stop", index: 0 },
    ])),
    AnthropicProtocolError,
  );
  await assert.rejects(
    collectMessageStream(asEvents([
      { type: "content_block_stop", index: 0 },
    ])),
    /before message_start/,
  );
  await assert.rejects(
    collectMessageStream(asEvents([messageStart("msg_truncated")])),
    /before message_stop/,
  );
  await assert.rejects(
    collectMessageStream(asEvents([
      messageStart("msg_error"),
      {
        type: "error",
        error: { type: "overloaded_error", message: "overloaded" },
      },
    ])),
    (error) => error instanceof AnthropicStreamError && error.retryable,
  );
});

test("Messages client sends exact headers and surfaces retry metadata for HTTP failures", async (context) => {
  for (const status of [408, 409, 429, 500, 503]) {
    await context.test(`HTTP ${status}`, async () => {
      const client = new AnthropicMessagesClient({
        apiKey: "secret",
        fetchImpl: async () => new Response(
          JSON.stringify({ error: { type: "api_error", message: "retry me" } }),
          {
            status,
            headers: {
              "content-type": "application/json",
              "request-id": "req_failure",
              "retry-after": "2",
            },
          },
        ),
      });
      await assert.rejects(
        client.createMessage({ model: "claude-fable-5", messages: [] }),
        (error) => (
          error instanceof AnthropicApiError
          && error.retryable
          && error.requestId === "req_failure"
          && error.retryAfterMs === 2_000
        ),
      );
    });
  }

  let captured;
  const client = new AnthropicMessagesClient({
    apiKey: "secret",
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return new Response([
        event("message_start", messageStart("msg_headers")),
        event("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        event("message_stop", { type: "message_stop" }),
      ].join(""), {
        headers: {
          "content-type": "text/event-stream",
          "request-id": "req_headers",
        },
      });
    },
  });
  const response = await collectMessageStream(client.streamMessage({
    model: "claude-fable-5",
    messages: [],
  }));
  assert.equal(response.request_id, "req_headers");
  assert.equal(captured.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(
    captured.init.headers["anthropic-beta"],
    "task-budgets-2026-03-13,compact-2026-01-12",
  );
  assert.equal(JSON.parse(captured.init.body).stream, true);
});

test("retry policy handles network and rate-limit failures but respects abort and hard stop", async () => {
  let attempts = 0;
  const delays = [];
  const result = await retryAnthropicOperation(async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("network reset");
    if (attempts === 2) {
      const error = new Error("rate limited");
      error.retryable = true;
      error.retryAfterMs = 25;
      throw error;
    }
    return "ok";
  }, {
    clock: () => 0,
    random: () => 0,
    sleep: async (delay) => delays.push(delay),
  });
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.equal(delays.length, 2);
  assert.ok(delays[1] >= 25);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    retryAnthropicOperation(async () => "never", { signal: controller.signal }),
    /abort/i,
  );
  await assert.rejects(
    retryAnthropicOperation(async () => {
      const error = new TypeError("network");
      throw error;
    }, {
      hardStopMs: 100,
      clock: () => 99,
      random: () => 0,
      sleep: async () => {},
    }),
    /hard stop/,
  );
});

test("a streamed overload retries only the incomplete response", async () => {
  let calls = 0;
  const client = {
    async *streamMessage() {
      calls += 1;
      yield messageStart(`msg_attempt_${calls}`);
      if (calls === 1) {
        yield {
          type: "error",
          error: { type: "overloaded_error", message: "try again" },
        };
        return;
      }
      yield {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 2, output_tokens: 1 },
      };
      yield { type: "message_stop" };
    },
  };
  const response = await retryAnthropicOperation(
    () => collectMessageStream(client.streamMessage()),
    {
      clock: () => 0,
      sleep: async () => {},
      random: () => 0,
    },
  );
  assert.equal(calls, 2);
  assert.equal(response.id, "msg_attempt_2");
});

test("pricing includes compaction iterations, both cache TTLs, and billable server tools", () => {
  const priced = priceAnthropicUsage({
    model: "claude-fable-5",
    pricingTable,
    usage: {
      input_tokens: 23_000,
      output_tokens: 1_000,
      iterations: [
        {
          type: "compaction",
          input_tokens: 180_000,
          output_tokens: 3_500,
          cache_creation: {
            ephemeral_1h_input_tokens: 1_000,
            ephemeral_5m_input_tokens: 2_000,
          },
        },
        {
          type: "message",
          input_tokens: 23_000,
          output_tokens: 1_000,
          cache_read_input_tokens: 10_000,
        },
      ],
      server_tool_use: {
        web_search_requests: 1,
        web_fetch_requests: 3,
        code_execution_requests: 2,
      },
    },
  });

  assert.deepEqual(priced.usage, {
    uncachedInputTokens: 203_000,
    cacheWrite5mTokens: 2_000,
    cacheWrite1hTokens: 1_000,
    cacheReadTokens: 10_000,
    outputTokens: 4_500,
    webSearchRequests: 1,
    webFetchRequests: 3,
    codeExecutionRequests: 2,
  });
  assert.equal(priced.baseCostCents, 232);
  assert.equal(priced.costCents, 239);
  const headroomProfile = priceAnthropicUsage({
    model: "claude-fable-5",
    pricingTable,
    usage: {
      cache_creation: {
        ephemeral_1h_input_tokens:
          pricingTable.request_profile.headroom_input_allowance_tokens,
      },
      output_tokens: pricingTable.request_profile.default_max_output_tokens,
    },
  });
  assert.ok(
    headroomProfile.costCents <= pricingTable.one_request_headroom_cents,
  );
});

test("Admin client paginates minute buckets and reconstructs cost with the live table", async () => {
  const calls = [];
  const payloads = [
    adminPayload({ hasMore: true, nextPage: "page_2", inputTokens: 100 }),
    adminPayload({ hasMore: false, inputTokens: 200 }),
  ];
  const client = new AnthropicAdminClient({
    apiKey: "admin-secret",
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return Response.json(payloads.shift());
    },
  });
  const rows = await collectAnthropicUsage(client, {
    apiKeyId: "apikey_worker_1",
    startTime: "2026-07-29T00:00:00Z",
    endTime: "2026-07-29T00:02:00Z",
    limit: 1,
  });
  assert.equal(rows.length, 2);
  assert.equal(calls[0].url.searchParams.get("bucket_width"), "1m");
  assert.equal(calls[0].url.searchParams.get("api_key_ids[]"), "apikey_worker_1");
  assert.deepEqual(calls[0].url.searchParams.getAll("group_by[]"), [
    "api_key_id",
    "model",
    "context_window",
  ]);
  assert.equal(calls[1].url.searchParams.get("page"), "page_2");
  assert.equal(calls[0].init.headers["x-api-key"], "admin-secret");

  const adminCost = priceAnthropicUsage({
    usage: rows[0],
    model: rows[0].model,
    pricingTable,
  }).costCents + priceAnthropicUsage({
    usage: rows[1],
    model: rows[1].model,
    pricingTable,
  }).costCents;
  const reconciliation = reconcileClaimUsage({
    claimResponses: [{ pricedCostCents: adminCost }],
    adminRows: rows,
    pricingTable,
    toleranceCents: 0,
  });
  assert.equal(reconciliation.driftCents, 0);
  assert.equal(reconciliation.alert, false);
});

test("completed response checkpointing is exactly once across replay, reopen, and settlement", async (context) => {
  const fixture = await createClaimFixture(context);
  const request = minimalRequest();
  const auditMinute = Math.floor(fixture.claim.claimTs / 60_000) * 60_000;
  const requestStartedAt = new Date(auditMinute + 10_000).toISOString();
  const first = message({
    id: "msg_exactly_once",
    stopReason: "max_tokens",
    content: [{ type: "text", text: "working" }],
  });
  const checkpoint = fixture.ledger.checkpointResponse({
    ...fixture.claim,
    request,
    response: first,
    requestId: "req_exactly_once",
    requestStartedAt,
    costCents: 123,
  });
  assert.equal(checkpoint.claim.spentCents, 123);
  assert.equal(fixture.ledger.checkpointResponse({
    ...fixture.claim,
    request,
    response: first,
    requestId: "req_exactly_once",
    requestStartedAt,
    costCents: 123,
  }).outcome, "duplicate");
  assert.equal(fixture.ledger.getClaim(fixture.claim).spentCents, 123);

  fixture.ledger.close();
  fixture.ledger = await openLedger({ databasePath: fixture.databasePath });
  assert.equal(fixture.ledger.listClaimResponses(fixture.claim).length, 1);
  assert.equal(fixture.ledger.getClaim(fixture.claim).spentCents, 123);
  fixture.ledger.settle({ ...fixture.claim, finalSpentCents: 123 });
  assert.equal(fixture.ledger.checkpointResponse({
    ...fixture.claim,
    request,
    response: first,
    requestId: "req_exactly_once",
    requestStartedAt,
    costCents: 123,
  }).outcome, "duplicate");
  assert.throws(() => fixture.ledger.checkpointResponse({
    ...fixture.claim,
    request,
    response: message({ id: "msg_after_settle" }),
    requestStartedAt: "2026-07-29T00:00:20.000Z",
    costCents: 1,
  }), /settled claim/);

  const adjacentClaim = fixture.ledger.claim({
    problemId: problem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
    fundingMode: "pool-only",
  });
  fixture.ledger.checkpointResponse({
    ...adjacentClaim,
    request,
    response: message({ id: "msg_adjacent_claim" }),
    requestId: "req_adjacent_claim",
    requestStartedAt: new Date(auditMinute + 30_000).toISOString(),
    costCents: 77,
  });
  fixture.ledger.settle({ ...adjacentClaim, finalSpentCents: 77 });

  let alert;
  const audit = await runClaimUsageReconciliation({
    ledger: fixture.ledger,
    adminClient: {
      async listUsage() {
        return { data: [], nextCursor: undefined };
      },
    },
    claim: fixture.ledger.getClaim(fixture.claim),
    apiKeyId: "apikey_worker_1",
    pricingTable,
    toleranceCents: 0,
    onAlert(value) {
      alert = value;
    },
  });
  assert.equal(audit.alert, true);
  assert.equal(audit.ledgerResponseCount, 2);
  assert.equal(audit.ledgerCostCents, 200);
  assert.equal(audit.boundaryClaims.length, 2);
  assert.equal(alert.type, "anthropic-usage-drift");
});

test("Fable loop resumes server turns, persists compaction, and validates terminal payloads", async (context) => {
  const fixture = await createClaimFixture(context);
  const r2 = new FakeR2();
  const messages = new FakeAnthropicMessages({
    responses: [
      message({
        id: "msg_invalid_solution",
        stopReason: "tool_use",
        content: [{
          type: "tool_use",
          id: "tool_invalid_solution",
          name: "submit_solution",
          input: {
            title: "Incomplete",
            summary: "Missing the required full argument.",
            verification_notes: "Not valid.",
          },
        }],
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
      message({
        id: "msg_compaction",
        stopReason: "pause_turn",
        container: { id: "container_math" },
        content: [
          {
            type: "compaction",
            content: "Lemma A is established.",
            encrypted_content: "encrypted-lemma-a",
          },
          {
            type: "server_tool_use",
            id: "srv_code",
            name: "code_execution",
            input: { code: "assert 1 + 1 == 2" },
          },
          {
            type: "code_execution_tool_result",
            tool_use_id: "srv_code",
            content: { type: "code_execution_result", stdout: "", stderr: "" },
          },
          { type: "text", text: "Continuing after compaction." },
        ],
        usage: {
          input_tokens: 50,
          output_tokens: 100,
          iterations: [
            { type: "compaction", input_tokens: 500, output_tokens: 40 },
            { type: "message", input_tokens: 50, output_tokens: 100 },
          ],
        },
      }),
      message({
        id: "msg_max",
        stopReason: "max_tokens",
        content: [{ type: "text", text: "A candidate argument." }],
      }),
      message({
        id: "msg_context",
        stopReason: "model_context_window_exceeded",
        content: [{ type: "text", text: "Context boundary reached." }],
      }),
      message({
        id: "msg_end_turn",
        stopReason: "end_turn",
        content: [{ type: "text", text: "More research is needed." }],
      }),
      message({
        id: "msg_solution",
        stopReason: "tool_use",
        content: [{
          type: "tool_use",
          id: "tool_solution",
          name: "submit_solution",
          input: {
            title: "A rigorous result",
            summary: "The claim follows.",
            argument_markdown: "Here is the complete argument.",
            verification_notes: "Every inference was checked.",
          },
        }],
      }),
    ],
  });

  const result = await runFableClaim({
    claim: fixture.claim,
    problem,
    messagesClient: messages,
    ledger: fixture.ledger,
    r2,
    pricingTable,
    taskBudgetTokens: 20_000,
  });

  assert.equal(result.outcome, "submitted_solution");
  assert.equal(messages.requests.length, 6);
  assert.equal(
    messages.requests[0].context_management.edits[0].type,
    "compact_20260112",
  );
  assert.equal(
    Object.hasOwn(messages.requests[0].output_config.task_budget, "remaining"),
    false,
  );
  assert.match(
    messages.requests[1].messages.at(-1).content[0].content,
    /Invalid submit_solution payload/,
  );
  assert.equal(messages.requests[2].container, "container_math");
  assert.equal(
    Object.hasOwn(messages.requests[2].output_config.task_budget, "remaining"),
    false,
  );
  assert.equal(
    Object.hasOwn(messages.requests[5].output_config.task_budget, "remaining"),
    false,
  );
  assert.ok(
    messages.requests[2].messages.at(-1).content.some(
      (block) => block.type === "server_tool_use",
    ),
  );
  assert.equal(
    messages.requests[2].messages.at(-1).content.find(
      (block) => block.type === "compaction",
    ).encrypted_content,
    "encrypted-lemma-a",
  );
  assert.match(
    messages.requests[4].messages.at(-1).content,
    /compaction context/,
  );
  assert.match(
    messages.requests[5].messages.at(-1).content,
    /produce genuinely new work/,
  );
  assert.equal(fixture.ledger.listClaimResponses(fixture.claim).length, 6);
  assert.equal(fixture.ledger.getClaim(fixture.claim).settled, true);
  const compacted = await r2.getObject(compactedContextKey({
    problemId: problem.id,
    direction: "prove",
  }));
  assert.match(await compacted.text(), /Lemma A is established/);
  const solution = await r2.getObject(solutionKey(fixture.claim));
  assert.match(await solution.text(), /complete argument/);
  assert.equal(
    fixture.ledger.inspect().problems.find((item) => item.problemId === problem.id).status,
    "PendingReview",
  );
});

test("end_turn task exhaustion renews the same claim and produces new work", async (context) => {
  const fixture = await createClaimFixture(context);
  const r2 = new FakeR2();
  const messages = new FakeAnthropicMessages({
    responses: [
      message({
        id: "msg_task_budget_exhausted",
        content: [{
          type: "text",
          text: "Terminal: budget exhausted; record final; no disproof claimed.",
        }],
      }),
      message({
        id: "msg_new_research",
        content: [{
          type: "text",
          text: "A genuinely new lemma eliminates the remaining finite obstruction.",
        }],
      }),
      message({
        id: "msg_solution_after_renewal",
        stopReason: "tool_use",
        content: [{
          type: "tool_use",
          id: "tool_solution_after_renewal",
          name: "submit_solution",
          input: {
            title: "Renewed result",
            summary: "The renewed task continued the same claim.",
            argument_markdown: "Here is the complete renewed argument.",
            verification_notes: "Checked after task-budget renewal.",
          },
        }],
      }),
    ],
  });

  const result = await runFableClaim({
    claim: fixture.claim,
    problem,
    messagesClient: messages,
    ledger: fixture.ledger,
    r2,
    pricingTable,
  });

  assert.equal(result.outcome, "submitted_solution");
  assert.equal(messages.requests.length, 3);
  assert.deepEqual(messages.requests[0].output_config.task_budget, {
    type: "tokens",
    total: 1_000_000,
  });
  assert.equal(messages.requests[0].context_management.edits[0].type, "compact_20260112");
  assert.equal(messages.requests[1].context_management, undefined);
  assert.ok(messages.requests[1].output_config.task_budget.remaining < 1_000_000);
  assert.equal(messages.requests[1].messages.length, 1);
  assert.doesNotMatch(
    JSON.stringify(messages.requests[1].messages),
    /Terminal: budget exhausted/,
  );
  assert.match(
    JSON.stringify(messages.requests[1].messages),
    /same funded claim remains active/,
  );
  assert.equal(
    Object.hasOwn(messages.requests[2].output_config.task_budget, "remaining"),
    false,
  );
  assert.equal(messages.requests[2].context_management.edits[0].type, "compact_20260112");
  assert.equal(fixture.ledger.listClaimResponses(fixture.claim).length, 3);
  const session = await r2.getObject(researchSessionTranscriptKey({
    problemId: problem.id,
    direction: "prove",
  }));
  const publicTranscript = await session.text();
  assert.doesNotMatch(publicTranscript, /budget exhausted/i);
  assert.match(publicTranscript, /genuinely new lemma/i);
  const republished = await republishPublicResearchArtifacts({
    ledger: fixture.ledger,
    r2,
  });
  assert.equal(republished.responseArtifactCount, 3);
  assert.equal(republished.researchSessionCount, 1);
});

test("a terminal no-solution report settles without claiming the problem", async (context) => {
  const fixture = await createClaimFixture(context);
  const r2 = new FakeR2();
  const messages = new FakeAnthropicMessages({
    responses: [message({
      id: "msg_no_solution",
      stopReason: "tool_use",
      content: [{
        type: "tool_use",
        id: "tool_no_solution",
        name: "submit_no_solution",
        input: {
          title: "No proof obtained",
          summary: "The canonical statement remains open.",
          research_markdown: "Several candidate constructions were eliminated.",
          verification_notes: "This report explicitly makes no solution claim.",
        },
      }],
    })],
  });

  const result = await runFableClaim({
    claim: fixture.claim,
    problem,
    messagesClient: messages,
    ledger: fixture.ledger,
    r2,
    pricingTable,
    taskBudgetTokens: 20_000,
  });

  assert.equal(result.outcome, "no_solution");
  assert.equal(result.report.summary, "The canonical statement remains open.");
  assert.equal(fixture.ledger.getClaim(fixture.claim).settled, true);
  assert.equal(fixture.ledger.getClaim(fixture.claim).solutionUri, undefined);
  assert.equal(fixture.ledger.getProblem(problem.id).status, "Open");
  await assert.rejects(() => r2.getObject(solutionKey(fixture.claim)));
  const human = await r2.getObject(compactedContextKey({
    problemId: problem.id,
    direction: "prove",
  }));
  assert.match(await human.text(), /canonical statement remains open/i);
});

test("a checkpointed no-solution report settles safely after worker restart", async (context) => {
  const fixture = await createClaimFixture(context);
  const r2 = new FakeR2();
  const response = message({
    id: "msg_no_solution_crash",
    stopReason: "tool_use",
    content: [{
      type: "tool_use",
      id: "tool_no_solution_crash",
      name: "submit_no_solution",
      input: {
        title: "No proof obtained",
        summary: "No complete result was found.",
        research_markdown: "Useful partial work was preserved.",
        verification_notes: "No solution claim is made.",
      },
    }],
  });
  await assert.rejects(
    runFableClaim({
      claim: fixture.claim,
      problem,
      messagesClient: new FakeAnthropicMessages({ responses: [response] }),
      ledger: fixture.ledger,
      r2,
      pricingTable,
      taskBudgetTokens: 20_000,
      onBoundary({ name }) {
        if (name === "after_r2_checkpoint_mirror") throw new Error("crash");
      },
    }),
    { name: "WorkerProcessCrashError" },
  );

  const resumedMessages = new FakeAnthropicMessages();
  const result = await runFableClaim({
    claim: fixture.claim,
    problem,
    messagesClient: resumedMessages,
    ledger: fixture.ledger,
    r2,
    pricingTable,
    taskBudgetTokens: 20_000,
  });
  assert.equal(result.outcome, "no_solution");
  assert.equal(resumedMessages.requests.length, 0);
  assert.equal(fixture.ledger.getProblem(problem.id).status, "Open");
});

test("the runner issues no request across its budget and lease hard stops", async (context) => {
  const budgetFixture = await createClaimFixture(context);
  budgetFixture.ledger.checkpointResponse({
    ...budgetFixture.claim,
    request: minimalRequest(),
    response: message({
      id: "msg_consumed_to_headroom",
      stopReason: "pause_turn",
      content: [{ type: "text", text: "Checkpointed work." }],
    }),
    requestStartedAt: new Date(budgetFixture.claim.claimTs).toISOString(),
    costCents:
      budgetFixture.claim.budgetCents
      - pricingTable.one_request_headroom_cents,
  });
  const budgetClient = new FakeAnthropicMessages();
  const budgetResult = await runFableClaim({
    claim: budgetFixture.claim,
    problem,
    messagesClient: budgetClient,
    ledger: budgetFixture.ledger,
    r2: new FakeR2(),
    pricingTable,
    taskBudgetTokens: 20_000,
  });
  assert.equal(budgetResult.outcome, "budget_headroom");
  assert.equal(budgetClient.requests.length, 0);

  const leaseFixture = await createClaimFixture(context);
  const leaseClient = new FakeAnthropicMessages();
  const leaseResult = await runFableClaim({
    claim: leaseFixture.claim,
    problem,
    messagesClient: leaseClient,
    ledger: leaseFixture.ledger,
    r2: new FakeR2(),
    pricingTable,
    taskBudgetTokens: 20_000,
    hardStopBufferMs: 0,
    clock: () => Date.parse(leaseFixture.claim.leaseExpiresAt),
  });
  assert.equal(leaseResult.outcome, "lease_hard_stop");
  assert.equal(leaseClient.requests.length, 0);
});

test("a claimed worker completes through the real HTTP Messages client", async (context) => {
  const fixture = await createClaimFixture(context);
  const r2 = new FakeR2();
  let received;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = {
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    const streamed = [
      event("message_start", messageStart("msg_http_runner")),
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tool_http",
          name: "submit_solution",
          input: {},
        },
      }),
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({
            title: "HTTP integration",
            summary: "The direct client completed.",
            argument_markdown: "A complete local transport argument.",
            verification_notes: "The SSE bytes were deliberately fragmented.",
          }),
        },
      }),
      event("content_block_stop", { type: "content_block_stop", index: 0 }),
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: {
          input_tokens: 20,
          output_tokens: 10,
          iterations: [{ type: "message", input_tokens: 20, output_tokens: 10 }],
        },
      }),
      event("message_stop", { type: "message_stop" }),
    ].join("");
    const bytes = Buffer.from(streamed);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "request-id": "req_http_runner",
    });
    for (let index = 0; index < bytes.length; index += 5) {
      response.write(bytes.subarray(index, index + 5));
    }
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const client = new AnthropicMessagesClient({
    apiKey: "worker-http-secret",
    baseUrl: `http://127.0.0.1:${address.port}`,
  });

  const result = await runFableClaim({
    claim: fixture.claim,
    problem,
    messagesClient: client,
    ledger: fixture.ledger,
    r2,
    pricingTable,
    taskBudgetTokens: 20_000,
  });

  assert.equal(result.outcome, "submitted_solution");
  assert.equal(received.headers["x-api-key"], "worker-http-secret");
  assert.equal(received.headers["anthropic-version"], "2023-06-01");
  assert.equal(
    received.headers["anthropic-beta"],
    "task-budgets-2026-03-13,compact-2026-01-12",
  );
  assert.equal(received.body.model, "claude-fable-5");
  assert.equal(received.body.stream, true);
  assert.equal(
    fixture.ledger.listClaimResponses(fixture.claim)[0].requestId,
    "req_http_runner",
  );
});

test("a later funded claim renews from a compact carry-forward of prior work", async (context) => {
  const fixture = await createClaimFixture(context);
  const r2 = new FakeR2();
  const refusedResponse = message({
    id: "msg_refused",
    stopReason: "refusal",
    content: [{ type: "text", text: "Preserve this useful failed approach." }],
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  const refused = new FakeAnthropicMessages({
    responses: [refusedResponse],
  });
  const first = await runFableClaim({
    claim: fixture.claim,
    problem,
    messagesClient: refused,
    ledger: fixture.ledger,
    r2,
    pricingTable,
    taskBudgetTokens: 20_000,
  });
  assert.equal(first.outcome, "refusal");

  donateAndFund(fixture.ledger, {
    suffix: "resume",
    amountCents: 5_000,
    settledContributionCents: 15_000,
  });
  const nextClaim = fixture.ledger.claim({
    problemId: problem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
    fundingMode: "pool-only",
  });
  const submit = new FakeAnthropicMessages({
    responses: [message({
      id: "msg_resumed_solution",
      stopReason: "tool_use",
      content: [{
        type: "tool_use",
        id: "tool_resumed",
        name: "submit_solution",
        input: {
          title: "Resumed",
          summary: "Built on prior work.",
          argument_markdown: "Complete.",
          verification_notes: "Checked.",
        },
      }],
    })],
  });
  await runFableClaim({
    claim: nextClaim,
    problem,
    messagesClient: submit,
    ledger: fixture.ledger,
    r2,
    pricingTable,
    taskBudgetTokens: 20_000,
  });
  assert.equal(submit.requests[0].messages.length, 1);
  assert.equal(submit.requests[0].context_management, undefined);
  assert.equal(submit.requests[0].output_config.task_budget.remaining, 20_000);
  assert.match(JSON.stringify(submit.requests[0].messages), /Preserve this useful failed approach/);
  const session = await r2.getObject(researchSessionTranscriptKey({
    problemId: problem.id,
    direction: "prove",
  }));
  assert.match(await session.text(), /Preserve this useful failed approach/);
});

function message({
  id,
  stopReason = "end_turn",
  content = [{ type: "text", text: "Continue." }],
  usage = { input_tokens: 10, output_tokens: 5 },
  container,
} = {}) {
  return {
    id,
    type: "message",
    role: "assistant",
    model: "claude-fable-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
    ...(container ? { container } : {}),
  };
}

function minimalRequest() {
  return buildFableRequest({
    systemPrompt: "Research rigorously.",
    messages: [{ role: "user", content: "Begin." }],
    taskBudgetTokens: 20_000,
  });
}

function event(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function messageStart(id) {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-fable-5",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  };
}

async function* asyncChunks(chunks) {
  yield* chunks;
}

async function* asEvents(events) {
  yield* events;
}

function adminPayload({ hasMore, nextPage, inputTokens }) {
  return {
    data: [{
      starting_at: "2026-07-29T00:00:00Z",
      ending_at: "2026-07-29T00:01:00Z",
      results: [{
        api_key_id: "apikey_worker_1",
        model: "claude-fable-5",
        context_window: "0-200k",
        uncached_input_tokens: inputTokens,
        cache_read_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 0,
        },
        output_tokens: 10,
        server_tool_use: {
          web_search_requests: 0,
          web_fetch_requests: 0,
        },
      }],
    }],
    has_more: hasMore,
    ...(nextPage ? { next_page: nextPage } : {}),
  };
}

async function createClaimFixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "indiemath-anthropic-"));
  const databasePath = path.join(directory, "ledger.sqlite");
  const ledger = await openLedger({ databasePath });
  await syncCatalog({
    databasePath,
    catalog,
  });
  donateAndFund(ledger, {
    suffix: "initial",
    amountCents: 10_000,
    settledContributionCents: 10_000,
  });
  const claim = ledger.claim({
    problemId: problem.id,
    direction: "prove",
    runBudgetCents: 5_000,
    workerId: "worker-1",
    fundingMode: "pool-only",
  });
  const fixture = { directory, databasePath, ledger, claim };
  context.after(async () => {
    fixture.ledger.close();
    await rm(directory, { recursive: true, force: true });
  });
  return fixture;
}

function donateAndFund(ledger, {
  suffix,
  amountCents,
  settledContributionCents,
}) {
  ledger.donate({
    dedupId: `transaction-${suffix}`,
    orderId: `order-${suffix}`,
    destination: {
      kind: "pool",
      problemId: problem.id,
      direction: "prove",
    },
    grossCents: amountCents,
    feesCents: 0,
    netCents: amountCents,
    donorTag: "anonymous",
    creditedAt: new Date().toISOString(),
  });
  ledger.treasuryFund({
    amountCents,
    externalReference: `fund-${suffix}`,
    settledContributionCents,
  });
}
