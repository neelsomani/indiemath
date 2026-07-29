#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ANTHROPIC_BETAS,
  AnthropicMessagesClient,
  CODE_EXECUTION_TOOL_TYPE,
  COMPACTION_STRATEGY_TYPE,
  WEB_FETCH_TOOL_TYPE,
  loadAnthropicPricingTable,
  normalizeAnthropicUsage,
  runFableClaim,
} from "#indiemath/anthropic";
import { FakeR2 } from "#indiemath/fakes";
import { openLedger } from "#indiemath/ledger";
import {
  compactedContextKey,
  rawTranscriptKey,
  solutionKey,
} from "#indiemath/shared";
import {
  readCatalog,
  validateCatalog,
} from "./catalog-lib.mjs";
import { syncCatalog } from "./catalog-ledger.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const enabled = process.env.INDIEMATH_RUN_LIVE_ANTHROPIC === "confirmed";

test("live claimed worker reaches submit_solution through Claude Fable", {
  skip: enabled
    ? false
    : "Set INDIEMATH_RUN_LIVE_ANTHROPIC=confirmed and ANTHROPIC_API_KEY to run.",
}, async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required for the live Anthropic gate.");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "indiemath-live-"));
  const databasePath = path.join(directory, "ledger.sqlite");
  let ledger;
  try {
    const base = validateCatalog(await readCatalog(
      path.join(rootDir, "problems", "catalog.json"),
    ));
    const liveProblem = {
      id: "live-identity",
      slug: "live-identity-law-gate",
      domain: "mathematics",
      title: "Identity-law integration gate",
      statement: "Every integer n satisfies n = n.",
      directions: {
        prove: "Prove the canonical statement directly from equality.",
        disprove: "Exhibit an integer n for which n is not equal to itself.",
      },
      source: {
        kind: "admin",
        reference: "Stage 4 live integration gate",
      },
    };
    const liveCatalog = validateCatalog({
      ...structuredClone(base),
      catalog_revision: base.catalog_revision + 1,
      problems: [...structuredClone(base.problems), liveProblem],
    });
    await syncCatalog({ catalog: liveCatalog, databasePath });
    ledger = await openLedger({ databasePath });
    ledger.donate({
      dedupId: "live-gate-credit",
      orderId: "live-gate-order",
      destination: {
        kind: "pool",
        problemId: liveProblem.id,
        direction: "prove",
      },
      grossCents: 5_000,
      feesCents: 0,
      netCents: 5_000,
      donorTag: "integration-gate",
      creditedAt: new Date().toISOString(),
    });
    ledger.treasuryFund({
      amountCents: 5_000,
      externalReference: "live-gate-funding",
      settledContributionCents: 5_000,
    });
    const claim = ledger.claim({
      problemId: liveProblem.id,
      direction: "prove",
      runBudgetCents: 5_000,
      workerId: "worker-1",
      fundingMode: "pool-only",
    });
    const r2 = new FakeR2({ bucket: "live-gate-artifacts" });
    const result = await runFableClaim({
      claim,
      problem: liveProblem,
      messagesClient: new AnthropicMessagesClient({
        apiKey: process.env.ANTHROPIC_API_KEY,
        ...(process.env.ANTHROPIC_BASE_URL
          ? { baseUrl: process.env.ANTHROPIC_BASE_URL }
          : {}),
      }),
      ledger,
      r2,
      pricingTable: await loadAnthropicPricingTable(
        path.join(rootDir, "pricing", "anthropic.json"),
      ),
      taskBudgetTokens: 20_000,
    });
    assert.equal(result.outcome, "submitted_solution");
    const completedClaim = ledger.getClaim(claim);
    const completedResponses = ledger.listClaimResponses(claim);
    assert.equal(completedClaim.settled, true);
    assert.ok(completedResponses.length >= 1);
    assert.ok(completedClaim.spentCents > 0);
    assert.equal(completedResponses.at(-1).stopReason, "tool_use");

    const rawKey = rawTranscriptKey({ ...claim, sequence: 1 });
    assert.ok(
      r2.calls.filter(
        (call) => call.operation === "putObject" && call.key === rawKey,
      ).length >= 2,
      "the stream must be mirrored before the immutable final checkpoint",
    );
    assert.match(
      await (await r2.getObject(rawKey)).text(),
      /"request"|"response"/,
    );
    assert.match(
      await (await r2.getObject(compactedContextKey(claim))).text(),
      /Carry-forward research context/,
    );
    assert.match(
      await (await r2.getObject(solutionKey(claim))).text(),
      /## Argument/,
    );

    const expectedSpend = completedClaim.spentCents;
    const expectedResponseJson = completedResponses.map((row) => ({
      sequence: row.sequence,
      messageId: row.messageId,
      request: row.request,
      response: row.response,
      pricedCostCents: row.pricedCostCents,
    }));
    ledger.close();
    ledger = await openLedger({ databasePath });
    assert.equal(ledger.getClaim(claim).spentCents, expectedSpend);
    assert.equal(ledger.getClaim(claim).settled, true);
    assert.deepEqual(
      ledger.listClaimResponses(claim).map((row) => ({
        sequence: row.sequence,
        messageId: row.messageId,
        request: row.request,
        response: row.response,
        pricedCostCents: row.pricedCostCents,
      })),
      expectedResponseJson,
    );
  } finally {
    ledger?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("live Fable compaction drops pre-compaction context on continuation", {
  skip: enabled
    ? false
    : "Set INDIEMATH_RUN_LIVE_ANTHROPIC=confirmed and ANTHROPIC_API_KEY to run.",
}, async (context) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required for the live Anthropic gate.");
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "indiemath-compact-live-"));
  const databasePath = path.join(directory, "ledger.sqlite");
  let ledger;
  try {
    const base = validateCatalog(await readCatalog(
      path.join(rootDir, "problems", "catalog.json"),
    ));
    const liveProblem = {
      id: "live-compaction",
      slug: "live-compaction-continuation-gate",
      domain: "mathematics",
      title: "Compaction continuation integration gate",
      statement: "Every integer n satisfies n = n.",
      directions: {
        prove: "Prove the canonical statement directly from reflexivity of equality.",
        disprove: "Exhibit an integer n for which n is not equal to itself.",
      },
      source: {
        kind: "admin",
        reference: "Stage 4 live compaction integration gate",
      },
    };
    const liveCatalog = validateCatalog({
      ...structuredClone(base),
      catalog_revision: base.catalog_revision + 1,
      problems: [...structuredClone(base.problems), liveProblem],
    });
    await syncCatalog({ catalog: liveCatalog, databasePath });
    ledger = await openLedger({ databasePath });
    ledger.donate({
      dedupId: "live-compaction-credit",
      orderId: "live-compaction-order",
      destination: {
        kind: "pool",
        problemId: liveProblem.id,
        direction: "prove",
      },
      grossCents: 5_000,
      feesCents: 0,
      netCents: 5_000,
      donorTag: "integration-gate",
      creditedAt: new Date().toISOString(),
    });
    ledger.treasuryFund({
      amountCents: 5_000,
      externalReference: "live-compaction-funding",
      settledContributionCents: 5_000,
    });
    const claim = ledger.claim({
      problemId: liveProblem.id,
      direction: "prove",
      runBudgetCents: 5_000,
      workerId: "worker-1",
      fundingMode: "pool-only",
    });
    const r2 = new FakeR2({ bucket: "live-compaction-artifacts" });
    const paddedContext = [
      "COMPACTION_SENTINEL: retain the identity-law objective.",
      "The following repeated token is deliberate transport padding.",
      "alpha ".repeat(155_000),
    ].join("\n");
    await r2.putObject(
      compactedContextKey({ problemId: liveProblem.id, direction: "prove" }),
      paddedContext,
      { contentType: "text/plain; charset=utf-8" },
    );

    const observedTransport = [];
    const observedCompactionEvents = [];
    const messagesClient = new AnthropicMessagesClient({
      apiKey: process.env.ANTHROPIC_API_KEY,
      ...(process.env.ANTHROPIC_BASE_URL
        ? { baseUrl: process.env.ANTHROPIC_BASE_URL }
        : {}),
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        observedTransport.push({
          apiVersion: init.headers["anthropic-version"],
          betaHeader: init.headers["anthropic-beta"],
          model: body.model,
          compactionType: body.context_management?.edits?.[0]?.type,
          toolTypes: body.tools
            ?.map((tool) => tool.type)
            .filter(Boolean),
          replayedCompactions: body.messages.flatMap((message, messageIndex) => (
            Array.isArray(message.content)
              ? message.content
                .filter((block) => block.type === "compaction")
                .map((block) => ({
                  messageIndex,
                  contentType: typeof block.content,
                  contentLength: block.content?.length ?? null,
                  encryptedType: typeof block.encrypted_content,
                  encryptedLength: block.encrypted_content?.length ?? null,
                }))
              : []
          )),
        });
        return fetch(url, init);
      },
    });
    let result;
    try {
      result = await runFableClaim({
        claim,
        problem: liveProblem,
        messagesClient,
        ledger,
        r2,
        pricingTable: await loadAnthropicPricingTable(
          path.join(rootDir, "pricing", "anthropic.json"),
        ),
        taskBudgetTokens: 64_000,
        maxTokens: 4_096,
        effort: "low",
        pauseAfterCompaction: true,
        onEvent(event) {
          if (
            event.type === "content_block_start"
            && event.content_block?.type === "compaction"
          ) {
            observedCompactionEvents.push({
              eventType: event.type,
              index: event.index,
              blockKeys: Object.keys(event.content_block),
              contentType: typeof event.content_block.content,
              contentLength: event.content_block.content?.length ?? null,
              encryptedType: typeof event.content_block.encrypted_content,
              encryptedLength:
                event.content_block.encrypted_content?.length ?? null,
            });
          }
          if (
            event.type === "content_block_delta"
            && event.delta?.type === "compaction_delta"
          ) {
            observedCompactionEvents.push({
              eventType: event.type,
              index: event.index,
              deltaKeys: Object.keys(event.delta),
              contentType: typeof event.delta.content,
              contentLength: event.delta.content?.length ?? null,
              encryptedType: typeof event.delta.encrypted_content,
              encryptedLength: event.delta.encrypted_content?.length ?? null,
            });
          }
          if (event.type === "message_delta") {
            observedCompactionEvents.push({
              eventType: event.type,
              stopReason: event.delta?.stop_reason ?? null,
              contextManagementKeys: Object.keys(
                event.context_management ?? {},
              ),
              usageIterationTypes: event.usage?.iterations?.map(
                (iteration) => iteration.type,
              ) ?? [],
            });
          }
        },
      });
    } catch (error) {
      const checkpointStructure = ledger.listClaimResponses(claim).map((row) => ({
        stopReason: row.stopReason,
        content: row.response.content.map((block) => ({
          type: block.type,
          keys: Object.keys(block),
          contentType: typeof block.content,
          contentLength: block.content?.length ?? null,
          encryptedType: typeof block.encrypted_content,
          encryptedLength: block.encrypted_content?.length ?? null,
        })),
        iterationTypes: row.usage.iterations?.map(
          (iteration) => iteration.type,
        ) ?? [],
      }));
      throw new Error(
        `Live compaction continuation failed with structure `
          + `${JSON.stringify({
            observedCompactionEvents,
            observedTransport,
            checkpointStructure,
          })}.`,
        { cause: error },
      );
    }
    assert.equal(result.outcome, "submitted_solution");

    const responses = ledger.listClaimResponses(claim);
    const compactionIndex = responses.findIndex((row) => (
      row.response.content.some((block) => block.type === "compaction")
    ));
    assert.ok(compactionIndex >= 0, "the live request must cross the compaction trigger");
    assert.ok(
      compactionIndex + 1 < responses.length,
      "the runner must issue a continuation after the compaction block",
    );
    const compactionResponse = responses[compactionIndex];
    const continuationResponse = responses[compactionIndex + 1];
    assert.equal(compactionResponse.stopReason, "compaction");
    const compactionBlock = compactionResponse.response.content.find(
      (block) => block.type === "compaction",
    );
    assert.ok(compactionBlock.content.length > 0);
    assert.ok(compactionBlock.encrypted_content.length > 0);
    assert.ok(
      compactionResponse.usage.iterations.some(
        (iteration) => iteration.type === "compaction",
      ),
    );
    assert.equal(
      continuationResponse.usage.iterations.some(
        (iteration) => iteration.type === "compaction",
      ),
      false,
      "replaying the prior compaction block must not trigger compaction again",
    );
    assert.equal(
      Object.hasOwn(
        continuationResponse.request.output_config.task_budget,
        "remaining",
      ),
      false,
    );

    const compactionInputTokens = totalInputTokens(compactionResponse.usage);
    const continuationInputTokens = totalInputTokens(continuationResponse.usage);
    assert.ok(
      compactionInputTokens >= 150_000,
      `expected at least 150K pre-compaction tokens, saw ${compactionInputTokens}`,
    );
    assert.ok(
      continuationInputTokens < compactionInputTokens / 2,
      `expected the effective continuation context to shrink; `
        + `${compactionInputTokens} -> ${continuationInputTokens}`,
    );
    context.diagnostic(
      `effective input tokens after full-history replay: `
        + `${compactionInputTokens} -> ${continuationInputTokens}`,
    );
    assert.ok(
      continuationResponse.request.messages[0].content.length > 500_000,
      "the client request must still contain the full pre-compaction history",
    );

    assert.ok(observedTransport.length >= 2);
    for (const observation of observedTransport) {
      assert.equal(observation.apiVersion, "2023-06-01");
      assert.equal(observation.betaHeader, ANTHROPIC_BETAS.join(","));
      assert.equal(observation.model, "claude-fable-5");
      assert.equal(observation.compactionType, COMPACTION_STRATEGY_TYPE);
      assert.ok(observation.toolTypes.includes(CODE_EXECUTION_TOOL_TYPE));
      assert.ok(observation.toolTypes.includes(WEB_FETCH_TOOL_TYPE));
    }
  } finally {
    ledger?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function totalInputTokens(usage) {
  const normalized = normalizeAnthropicUsage(usage);
  return (
    normalized.uncachedInputTokens
    + normalized.cacheWrite5mTokens
    + normalized.cacheWrite1hTokens
    + normalized.cacheReadTokens
  );
}
