#!/usr/bin/env node

import { openLedger } from "#indiemath/ledger";
import {
  AnthropicMessagesClient,
  buildFableRequest,
  collectMessageStream,
  loadAnthropicPricingTable,
  prepareContinuationMessages,
  renewedTaskBudgetMessages,
  taskBudgetTokensForCents,
} from "#indiemath/anthropic";
import { parseWorkerConfig } from "#indiemath/shared";

if (process.env.INDIEMATH_PROBE_LIVE_ANTHROPIC !== "confirmed") {
  throw new Error(
    "Set INDIEMATH_PROBE_LIVE_ANTHROPIC=confirmed to issue one unrecorded live continuation request.",
  );
}

const config = parseWorkerConfig(process.env);
if (config.runtime !== "production") {
  throw new TypeError("The continuation probe requires production configuration.");
}

const ledger = await openLedger({ databasePath: config.databasePath });
try {
  const claim = ledger.getWorkerUnsettledClaim(config.workerId);
  if (!claim) throw new Error(`${config.workerId} has no unsettled claim to probe.`);
  const checkpoints = ledger.listClaimResponses(claim);
  const checkpoint = checkpoints.at(-1);
  if (!checkpoint) throw new Error("The unsettled claim has no response to continue.");

  const pricingTable = await loadAnthropicPricingTable(config.pricingTablePath);
  const totalTaskBudget = taskBudgetTokensForCents({
    budgetCents: claim.budgetCents,
    pricingTable,
  });
  const remainingTaskBudget = taskBudgetTokensForCents({
    budgetCents: claim.budgetCents - claim.spentCents,
    pricingTable,
    maximumTokens: totalTaskBudget,
  });
  const continuation = prepareContinuationMessages(checkpoint);
  if (!continuation.taskBudgetExhausted) {
    throw new Error(
      "The latest response does not report task-budget exhaustion; refusing an unrelated probe.",
    );
  }
  const sessionCheckpoints = ledger.listPairClaimResponses(claim);
  const previous = checkpoint.request;
  const compaction = previous.context_management?.edits?.[0];
  const request = buildFableRequest({
    systemPrompt: previous.system?.[0]?.text,
    messages: renewedTaskBudgetMessages(sessionCheckpoints),
    taskBudgetTokens: totalTaskBudget,
    taskBudgetRemainingTokens: remainingTaskBudget,
    maxTokens: previous.max_tokens,
    effort: previous.output_config?.effort,
    compactionTriggerTokens: compaction?.trigger?.value,
    pauseAfterCompaction: compaction?.pause_after_compaction === true,
    enableCompaction: false,
    container: checkpoint.containerId,
    model: previous.model,
  });

  const client = new AnthropicMessagesClient({ apiKey: config.anthropic.apiKey });
  const hardStopMs = Date.parse(claim.leaseExpiresAt) - 5 * 60 * 1_000;
  const remainingLeaseMs = hardStopMs - Date.now();
  if (!Number.isFinite(remainingLeaseMs) || remainingLeaseMs <= 0) {
    throw new Error("The claim is already inside its production hard-stop buffer.");
  }
  process.stderr.write("--- live response text ---\n");
  const response = await collectMessageStream(
    client.streamMessage(request, { signal: AbortSignal.timeout(remainingLeaseMs) }),
    { onText: (delta) => process.stderr.write(delta) },
  );
  process.stderr.write("\n--- completed response metadata ---\n");
  console.log(JSON.stringify({
    source: {
      problemId: claim.problemId,
      direction: claim.direction,
      claimTs: claim.claimTs,
      sequence: checkpoint.sequence,
      priorStopReason: checkpoint.stopReason,
      priorMessageId: checkpoint.messageId,
    },
    request: {
      messageCount: request.messages.length,
      finalMessage: request.messages.at(-1),
      taskBudget: request.output_config.task_budget,
      cacheControl: request.cache_control,
      recorded: false,
    },
    response: {
      id: response.id,
      stopReason: response.stop_reason,
      usage: response.usage,
      content: response.content,
    },
  }, null, 2));
} finally {
  ledger.close();
}
