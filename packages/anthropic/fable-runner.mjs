import {
  assertPort,
  compactedContextKey,
  humanTranscriptKey,
  rawTranscriptKey,
  researchSessionTranscriptKey,
  r2ArtifactUri,
  solutionKey,
} from "#indiemath/shared";
import {
  buildFableRequest,
  buildFableSystemPrompt,
  buildInitialResearchMessage,
  parseSubmittedNoSolution,
  parseSubmittedSolution,
  renderSolutionArtifact,
} from "./protocol.mjs";
import { priceAnthropicUsage } from "./pricing.mjs";
import { retryAnthropicOperation } from "./retry.mjs";
import { collectMessageStream } from "./stream.mjs";
import {
  CLAUDE_FABLE_MODEL,
  DEFAULT_MAX_TOKENS,
  TASK_BUDGET_MINIMUM_TOKENS,
} from "./constants.mjs";

const CONTINUATION_CONTEXT_CHARACTER_LIMIT = 200_000;
export const DEFAULT_HARD_STOP_BUFFER_MS = 5 * 60 * 1_000;
const STREAM_FLUSH_EVENT_COUNT = 25;

export class WorkerProcessCrashError extends Error {
  constructor(boundary, options) {
    super(`Simulated worker process death at ${boundary}.`, options);
    this.name = "WorkerProcessCrashError";
    this.boundary = boundary;
    this.retryable = false;
  }
}

export async function republishPublicResearchArtifacts({ ledger, r2 } = {}) {
  assertPort(ledger, "ledger", ["inspect"]);
  assertPort(r2, "R2", ["putObject"]);
  const checkpoints = ledger.inspect().claimResponses;
  const sessions = new Map();
  for (const checkpoint of checkpoints) {
    const claim = {
      problemId: checkpoint.problemId,
      direction: checkpoint.direction,
      claimTs: checkpoint.claimTs,
    };
    await mirrorHumanTranscript({ r2, claim, checkpoint });
    const pairKey = `${checkpoint.problemId}\u0000${checkpoint.direction}`;
    const session = sessions.get(pairKey) ?? { claim, checkpoints: [] };
    session.checkpoints.push(checkpoint);
    sessions.set(pairKey, session);
  }
  for (const session of sessions.values()) {
    await mirrorResearchSession({
      r2,
      claim: session.claim,
      checkpoints: session.checkpoints,
    });
  }
  return Object.freeze({
    responseArtifactCount: checkpoints.length,
    researchSessionCount: sessions.size,
  });
}

export async function runFableClaim({
  claim: suppliedClaim,
  problem,
  directionPrompt,
  rejectionNotes = [],
  reviewedResults = [],
  messagesClient,
  ledger,
  r2,
  pricingTable,
  taskBudgetTokens,
  maxTokens,
  effort,
  compactionTriggerTokens,
  pauseAfterCompaction = false,
  signal,
  hardStopBufferMs = DEFAULT_HARD_STOP_BUFFER_MS,
  clock = () => Date.now(),
  onEvent = () => {},
  onText = () => {},
  onRetry = () => {},
  onObserverError = () => {},
  onBoundary = () => {},
  retryOptions = {},
} = {}) {
  const claimKey = parseClaimKey(suppliedClaim);
  assertPort(messagesClient, "Anthropic Messages", ["streamMessage"]);
  assertPort(ledger, "ledger", [
    "getClaim",
    "getProblem",
    "listClaimResponses",
    "listPairClaimResponses",
    "checkpointResponse",
    "settle",
    "resolve",
  ]);
  assertPort(r2, "R2", ["getObject", "putObject"]);
  if (!pricingTable || typeof pricingTable !== "object") {
    throw new TypeError("pricingTable is required.");
  }
  if (!Number.isSafeInteger(hardStopBufferMs) || hardStopBufferMs < 0) {
    throw new TypeError("hardStopBufferMs must be a nonnegative safe integer.");
  }
  if (!retryOptions || typeof retryOptions !== "object" || Array.isArray(retryOptions)) {
    throw new TypeError("retryOptions must be an object.");
  }
  if (typeof onBoundary !== "function") {
    throw new TypeError("onBoundary must be a function.");
  }
  const effectiveMaxTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
  assertRequestFitsHeadroom({
    maxTokens: effectiveMaxTokens,
    pricingTable,
  });

  let claim = await ledger.getClaim(claimKey);
  let checkpoints = [...await ledger.listClaimResponses(claimKey)];
  let sessionCheckpoints = [...await ledger.listPairClaimResponses(claimKey)];
  const settleClaim = (solutionUri) => settleCurrentClaim({
    ledger,
    r2,
    claimKey,
    solutionUri,
    onBoundary,
  });
  await mirrorCheckpoints({ r2, claim: claimKey, checkpoints });
  await mirrorResearchSession({
    r2,
    claim: claimKey,
    checkpoints: sessionCheckpoints,
  });
  if (claim.settled) {
    return terminalResult("already_settled", claim, checkpoints);
  }

  const priorTerminal = terminalAction(checkpoints.at(-1)?.response);
  if (priorTerminal.kind === "solution") {
    return finalizeSolution({
      claim,
      checkpoint: checkpoints.at(-1),
      solution: priorTerminal.solution,
      ledger,
      r2,
      onBoundary,
    });
  }
  if (priorTerminal.kind === "no_solution") {
    const settledClaim = await settleClaim();
    return terminalResult("no_solution", settledClaim, checkpoints, {
      report: priorTerminal.report,
    });
  }
  if (priorTerminal.kind === "refusal") {
    const settledClaim = await settleClaim();
    return terminalResult("refusal", settledClaim, checkpoints);
  }
  const initialRequest = checkpoints[0]?.request;
  const totalTaskBudget = taskBudgetTokens ?? taskBudgetTokensForCents({
    budgetCents: claim.budgetCents,
    pricingTable,
  });
  const priorTaskBudget = initialRequest?.output_config?.task_budget?.total;
  let systemPrompt;
  let messages;
  let container = checkpoints.at(-1)?.containerId;
  let renewTaskBudget = checkpoints.length > 0 && priorTaskBudget !== totalTaskBudget;

  if (checkpoints.length) {
    const last = checkpoints.at(-1);
    systemPrompt = extractSystemPrompt(initialRequest);
    const continuation = prepareContinuationMessages(last);
    if (renewTaskBudget || continuation.taskBudgetExhausted) {
      messages = renewedTaskBudgetMessages(sessionCheckpoints);
      renewTaskBudget = true;
    } else {
      messages = continuation.messages;
    }
  } else {
    systemPrompt = buildFableSystemPrompt({
      problem,
      direction: claim.direction,
      directionPrompt: directionPrompt
        ?? problem?.directions?.[claim.direction]
        ?? problem?.[`${claim.direction}Prompt`],
      rejectionNotes,
      reviewedResults,
    });
    const priorCheckpoint = sessionCheckpoints.at(-1);
    if (priorCheckpoint) {
      messages = renewedTaskBudgetMessages(sessionCheckpoints);
      container = priorCheckpoint.containerId;
      renewTaskBudget = true;
    } else {
      const contexts = await readDirectionContexts(r2, claim.problemId);
      messages = [buildInitialResearchMessage(contexts)];
    }
  }

  while (true) {
    claim = await ledger.getClaim(claimKey);
    if (claim.settled) return terminalResult("already_settled", claim, checkpoints);
    const now = clock();
    const hardStopMs = Date.parse(claim.leaseExpiresAt) - hardStopBufferMs;
    if (!Number.isFinite(hardStopMs) || now >= hardStopMs) {
      const settledClaim = await settleClaim();
      return terminalResult("lease_hard_stop", settledClaim, checkpoints);
    }
    const currentProblem = await ledger.getProblem(claim.problemId);
    if (currentProblem.status !== "Open") {
      const settledClaim = await settleClaim();
      return terminalResult("problem_no_longer_open", settledClaim, checkpoints);
    }
    const remainingCents = claim.budgetCents - claim.spentCents;
    if (remainingCents <= pricingTable.one_request_headroom_cents) {
      await persistContinuationContext({ r2, claim: claimKey, checkpoints });
      const settledClaim = await settleClaim();
      return terminalResult("budget_headroom", settledClaim, checkpoints);
    }

    const resetsTaskBudget = renewTaskBudget;
    const request = buildFableRequest({
      messages,
      systemPrompt,
      taskBudgetTokens: totalTaskBudget,
      ...(renewTaskBudget
        ? {
            taskBudgetRemainingTokens: taskBudgetTokensForCents({
              budgetCents: remainingCents,
              pricingTable,
              maximumTokens: totalTaskBudget,
            }),
          }
        : {}),
      enableCompaction: !resetsTaskBudget,
      maxTokens: effectiveMaxTokens,
      ...(effort === undefined ? {} : { effort }),
      ...(compactionTriggerTokens === undefined
        ? {}
        : { compactionTriggerTokens }),
      ...(pauseAfterCompaction ? { pauseAfterCompaction: true } : {}),
      ...(container ? { container } : {}),
    });
    renewTaskBudget = false;
    const requestSignal = deadlineSignal(signal, hardStopMs - clock());
    let response;
    let requestStartedAt;
    const streamAttempts = [];
    try {
      response = await retryAnthropicOperation(
        async ({ attempt }) => {
          if (attempt > 1) {
            await requireProblemOpen({
              ledger,
              problemId: claim.problemId,
              boundary: "after Anthropic backoff",
            });
          }
          requestStartedAt = new Date(clock()).toISOString();
          await reachBoundary(onBoundary, "before_anthropic_request", {
            claim: claimKey,
            attempt,
            requestStartedAt,
          });
          const streamed = { attempt, events: [] };
          streamAttempts.push(streamed);
          const collected = await collectMessageStream(
            messagesClient.streamMessage(request, { signal: requestSignal }),
            {
              async onEvent(event) {
                streamed.events.push(event);
                try {
                  await onEvent(event);
                } catch (error) {
                  await notifyObserverError(onObserverError, error, "event callback");
                }
                if (
                  streamed.events.length === 1
                  || streamed.events.length % STREAM_FLUSH_EVENT_COUNT === 0
                  || event.type === "content_block_stop"
                  || event.type === "message_stop"
                ) {
                  try {
                    await mirrorPartialStream({
                      r2,
                      claim: claimKey,
                      sequence: checkpoints.length + 1,
                      streamAttempts,
                      sessionCheckpoints,
                    });
                    await reachBoundary(onBoundary, "after_r2_partial_mirror", {
                      claim: claimKey,
                      sequence: checkpoints.length + 1,
                      attempt,
                      eventType: event.type,
                    });
                  } catch (error) {
                    if (error instanceof WorkerProcessCrashError) throw error;
                    await notifyObserverError(
                      onObserverError,
                      error,
                      "partial transcript mirror",
                    );
                  }
                }
              },
              onText(delta) {
                void Promise.resolve()
                  .then(() => onText(delta))
                  .catch((error) => (
                    notifyObserverError(onObserverError, error, "text callback")
                  ));
              },
            },
          );
          await reachBoundary(onBoundary, "after_anthropic_response", {
            claim: claimKey,
            attempt,
            messageId: collected.id,
          });
          return collected;
        },
        {
          ...retryOptions,
          signal: requestSignal,
          hardStopMs,
          clock,
          async onRetry(retry) {
            await requireProblemOpen({
              ledger,
              problemId: claim.problemId,
              boundary: "before Anthropic backoff",
            });
            try {
              await onRetry(retry);
            } catch (error) {
              await notifyObserverError(onObserverError, error, "retry callback");
            }
          },
        },
      );
    } catch (error) {
      if (error instanceof WorkerProcessCrashError) throw error;
      if (error instanceof ProblemClosedDuringRunError) {
        const settledClaim = await settleClaim();
        return terminalResult("problem_no_longer_open", settledClaim, checkpoints);
      }
      if (clock() >= hardStopMs || isDeadlineAbort(error)) {
        const settledClaim = await settleClaim();
        return terminalResult("lease_hard_stop", settledClaim, checkpoints);
      }
      const settledClaim = await settleClaim();
      return terminalResult(
        signal?.aborted ? "aborted" : "persistent_api_failure",
        settledClaim,
        checkpoints,
        {
          failure: Object.freeze({
            name: error?.name ?? "Error",
            message: error?.message ?? String(error),
          }),
        },
      );
    }

    const priced = priceAnthropicUsage({
      usage: response.usage,
      model: response.model ?? request.model,
      pricingTable,
    });
    const checkpoint = await ledger.checkpointResponse({
      ...claimKey,
      request,
      response,
      requestId: response.request_id,
      requestStartedAt,
      costCents: priced.costCents,
    });
    claim = checkpoint.claim;
    if (checkpoint.outcome === "checkpointed") {
      checkpoints.push(checkpoint.response);
      sessionCheckpoints.push(checkpoint.response);
    } else if (!checkpoints.some((row) => row.messageId === response.id)) {
      checkpoints = [...await ledger.listClaimResponses(claimKey)];
    }
    await reachBoundary(onBoundary, "after_ledger_checkpoint", {
      claim: claimKey,
      checkpoint: checkpoint.response,
      checkpointOutcome: checkpoint.outcome,
    });
    await mirrorCheckpoint({
      r2,
      claim: claimKey,
      checkpoint: checkpoint.response,
      priced,
      streamAttempts,
    });
    await persistContinuationContext({ r2, claim: claimKey, checkpoints });
    await mirrorResearchSession({
      r2,
      claim: claimKey,
      checkpoints: sessionCheckpoints,
    });
    await reachBoundary(onBoundary, "after_r2_checkpoint_mirror", {
      claim: claimKey,
      checkpoint: checkpoint.response,
    });
    container = checkpoint.response.containerId ?? container;

    const terminal = terminalAction(response);
    if (terminal.kind === "solution") {
      return finalizeSolution({
        claim,
        checkpoint: checkpoint.response,
        solution: terminal.solution,
        ledger,
        r2,
        onBoundary,
      });
    }
    if (terminal.kind === "no_solution") {
      const settledClaim = await settleClaim();
      return terminalResult("no_solution", settledClaim, checkpoints, {
        report: terminal.report,
      });
    }
    if (terminal.kind === "refusal") {
      const settledClaim = await settleClaim();
      return terminalResult("refusal", settledClaim, checkpoints);
    }
    if (hasCompaction(response)) {
      try {
        await requireProblemOpen({
          ledger,
          problemId: claim.problemId,
          boundary: "at compaction",
        });
      } catch (error) {
        if (!(error instanceof ProblemClosedDuringRunError)) throw error;
        const settledClaim = await settleClaim();
        return terminalResult(
          "problem_no_longer_open",
          settledClaim,
          checkpoints,
        );
      }
    }

    const continuation = prepareContinuationMessages(checkpoint.response);
    if (continuation.taskBudgetExhausted) {
      messages = renewedTaskBudgetMessages(sessionCheckpoints);
      renewTaskBudget = true;
    } else {
      messages = continuation.messages;
      renewTaskBudget = false;
    }
  }
}

export function prepareContinuationMessages(checkpoint) {
  const messages = structuredClone(checkpoint.request.messages);
  messages.push({
    role: "assistant",
    content: structuredClone(checkpoint.response.content),
  });
  const clientTools = checkpoint.response.content.filter(
    (block) => block?.type === "tool_use",
  );
  if (clientTools.length) {
    messages.push({
      role: "user",
      content: clientTools.map((tool) => {
        if (tool.name === "submit_solution") {
          try {
            parseSubmittedSolution(tool.input);
            return {
              type: "tool_result",
              tool_use_id: tool.id,
              is_error: true,
              content:
                "The solution was valid but could not be finalized. Call submit_solution again.",
            };
          } catch (error) {
            return {
              type: "tool_result",
              tool_use_id: tool.id,
              is_error: true,
              content: `Invalid submit_solution payload: ${error.message}`,
            };
          }
        }
        if (tool.name === "submit_no_solution") {
          try {
            parseSubmittedNoSolution(tool.input);
            return {
              type: "tool_result",
              tool_use_id: tool.id,
              is_error: false,
              content:
                "Progress was recorded. Continue the same investigation from the exact prior state. "
                + "Do not repeat completed checks; advance the research frontier.",
            };
          } catch (error) {
            return {
              type: "tool_result",
              tool_use_id: tool.id,
              is_error: true,
              content: `Invalid submit_no_solution payload: ${error.message}`,
            };
          }
        }
        return {
          type: "tool_result",
          tool_use_id: tool.id,
          is_error: true,
          content: `Unknown client tool: ${tool.name}`,
        };
      }),
    });
    return continuationResult(messages);
  }
  switch (checkpoint.response.stop_reason) {
    case "pause_turn":
      return continuationResult(messages);
    case "max_tokens":
      messages.push({
        role: "user",
        content:
          "Continue from the exact prior state. The last response reached its "
          + "per-request token limit; preserve all proof obligations.",
      });
      return continuationResult(messages);
    case "model_context_window_exceeded":
      messages.push({
        role: "user",
        content:
          "Resume from the retained compaction context and continue the investigation.",
      });
      return continuationResult(messages);
    default:
      messages.push({
        role: "user",
        content:
          "[IndieMath funded continuation] This is another API turn inside the same active funded claim. "
          + "Resume from the exact prior state and produce genuinely new work. Do not repeat completed checks, "
          + "restate the retained history, or stop at a summary. Pursue a new path, strengthen an incomplete "
          + "argument, or falsify a remaining obstruction. Call submit_solution only for a complete proof or "
          + "disproof. Do not announce whether the dollar budget is exhausted; only the harness tracks it.",
      });
      return collapseTaskBudgetExhaustion(messages);
  }
}

export function taskBudgetTokensForCents({
  budgetCents,
  pricingTable,
  model = CLAUDE_FABLE_MODEL,
  maximumTokens = Number.MAX_SAFE_INTEGER,
} = {}) {
  if (!Number.isSafeInteger(budgetCents) || budgetCents < 0) {
    throw new TypeError("budgetCents must be a nonnegative safe integer.");
  }
  if (!Number.isSafeInteger(maximumTokens) || maximumTokens < TASK_BUDGET_MINIMUM_TOKENS) {
    throw new TypeError(
      `maximumTokens must be at least ${TASK_BUDGET_MINIMUM_TOKENS}.`,
    );
  }
  const outputRate = pricingTable?.models?.[model]
    ?.output_cents_per_million_tokens;
  if (!Number.isSafeInteger(outputRate) || outputRate < 1) {
    throw new TypeError(`Pricing table is missing an output rate for ${model}.`);
  }
  const derived = Number(
    BigInt(budgetCents) * 1_000_000n / BigInt(outputRate),
  );
  return Math.min(
    maximumTokens,
    Math.max(TASK_BUDGET_MINIMUM_TOKENS, derived),
  );
}

function continuationResult(messages, taskBudgetExhausted = false) {
  return Object.freeze({
    messages: Object.freeze(messages),
    taskBudgetExhausted,
  });
}

function collapseTaskBudgetExhaustion(messages) {
  if (!assistantReportsTaskBudgetExhaustion(messages.at(-2))) {
    return continuationResult(messages);
  }
  const retained = structuredClone(messages);
  let removed = 0;
  while (isFundedContinuation(retained.at(-1))) {
    const assistant = retained.at(-2);
    if (!assistantReportsTaskBudgetExhaustion(assistant)) break;
    retained.splice(-2, 2);
    removed += 1;
  }
  retained.push({
    role: "user",
    content:
      "[IndieMath task-budget renewal] The prior model task-token countdown ended, but the same funded "
      + "claim remains active and has a renewed task budget. Continue the exact same investigation now. "
      + "Produce substantive new research rather than another terminal budget message. Do not state that "
      + "the financial budget is exhausted; only the harness tracks dollars.",
  });
  return continuationResult(retained, removed > 0);
}

export function renewedTaskBudgetMessages(checkpoints) {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    throw new TypeError("checkpoints must be a nonempty array.");
  }
  const context = renderContinuationContext(checkpoints);
  return Object.freeze([Object.freeze({
    role: "user",
    content:
      "[IndieMath client-side carry-forward after task-budget renewal]\n\n"
      + `${context}\n`
      + "The prior model task-token countdown ended, but the same funded claim remains active with a "
      + "renewed task budget. Continue this exact investigation now and produce substantive new research. "
      + "Do not repeat a terminal budget message and do not state that the financial budget is exhausted; "
      + "only the harness tracks dollars.",
  })]);
}

function isFundedContinuation(message) {
  if (message?.role !== "user" || typeof message.content !== "string") return false;
  return message.content.startsWith("[IndieMath funded continuation]")
    || message.content.startsWith("Resume from the exact prior state");
}

function assistantReportsTaskBudgetExhaustion(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return false;
  const text = message.content
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  return isTaskBudgetExhaustionText(text);
}

function terminalAction(response) {
  if (!response) return { kind: "none" };
  for (const block of response.content ?? []) {
    if (block?.type !== "tool_use") continue;
    if (block.name === "submit_solution") {
      try {
        return { kind: "solution", solution: parseSubmittedSolution(block.input) };
      } catch {
        return { kind: "none" };
      }
    }
    if (block.name === "submit_no_solution") {
      try {
        return {
          kind: "no_solution",
          report: parseSubmittedNoSolution(block.input),
        };
      } catch {
        return { kind: "none" };
      }
    }
  }
  if (response.stop_reason === "refusal") return { kind: "refusal" };
  return { kind: "none" };
}

async function finalizeSolution({
  claim,
  checkpoint,
  solution,
  ledger,
  r2,
  onBoundary,
}) {
  const key = solutionKey(claim);
  const artifact = renderSolutionArtifact({
    solution,
    problemId: claim.problemId,
    direction: claim.direction,
    claimTs: claim.claimTs,
    model: checkpoint.modelId,
    messageId: checkpoint.messageId,
    requestId: checkpoint.requestId,
  });
  await r2.putObject(key, artifact, {
    contentType: "text/markdown; charset=utf-8",
    metadata: {
      problemId: claim.problemId,
      direction: claim.direction,
      claimTs: String(claim.claimTs),
      messageId: checkpoint.messageId,
    },
  });
  const solutionUri = r2ArtifactUri(key);
  await reachBoundary(onBoundary, "after_r2_solution_write", {
    claim,
    solutionUri,
  });
  let resolution;
  try {
    resolution = await ledger.resolve({
      problemId: claim.problemId,
      direction: claim.direction,
      claimTs: claim.claimTs,
      workerId: claim.workerId,
      finalSpentCents: claim.spentCents,
      solutionUri,
    });
    await reachBoundary(onBoundary, "after_ledger_resolve", {
      claim: resolution.claim,
      solutionUri,
      resolutionOutcome: resolution.outcome,
    });
  } catch (error) {
    if (error instanceof WorkerProcessCrashError) throw error;
    if (!["resolve-race-lost", "claim-settled", "lease-expired"].includes(error?.code)) {
      throw error;
    }
    resolution = {
      claim: await settleCurrentClaim({
        ledger,
        r2,
        claimKey: {
          problemId: claim.problemId,
          direction: claim.direction,
          claimTs: claim.claimTs,
        },
        solutionUri,
        onBoundary,
      }),
    };
  }
  return Object.freeze({
    outcome: "submitted_solution",
    claim: resolution.claim,
    solutionUri,
    solution,
  });
}

async function mirrorCheckpoints({ r2, claim, checkpoints }) {
  for (const checkpoint of checkpoints) {
    const rawKey = rawTranscriptKey({ ...claim, sequence: checkpoint.sequence });
    if (!await objectExists(r2, rawKey)) {
      await mirrorCheckpoint({ r2, claim, checkpoint });
    } else {
      await mirrorHumanTranscript({ r2, claim, checkpoint });
    }
  }
  if (checkpoints.length) {
    await persistContinuationContext({ r2, claim, checkpoints });
  }
}

async function mirrorCheckpoint({
  r2,
  claim,
  checkpoint,
  priced,
  streamAttempts = [],
}) {
  const key = rawTranscriptKey({ ...claim, sequence: checkpoint.sequence });
  const header = {
    schemaVersion: 1,
    type: "request",
    claim,
    sequence: checkpoint.sequence,
    request: checkpoint.request,
  };
  const events = streamAttempts.flatMap((streamed) => streamed.events.map((event) => ({
    schemaVersion: 1,
    type: "anthropic_event",
    claim,
    sequence: checkpoint.sequence,
    attempt: streamed.attempt,
    event,
  })));
  const completed = {
    schemaVersion: 1,
    type: "checkpoint",
    claim,
    sequence: checkpoint.sequence,
    requestId: checkpoint.requestId,
    messageId: checkpoint.messageId,
    response: checkpoint.response,
    pricing: priced ?? {
      costCents: checkpoint.pricedCostCents,
      appliedCostCents: checkpoint.appliedCostCents,
      overageCents: checkpoint.overageCents,
    },
    completedAt: checkpoint.completedAt,
    reconstructedFromLedger: streamAttempts.length === 0,
  };
  await Promise.all([
    r2.putObject(
      key,
      `${[header, ...events, completed].map((row) => JSON.stringify(row)).join("\n")}\n`,
      {
        contentType: "application/jsonl",
        metadata: {
          state: "completed",
          eventCount: String(events.length),
          messageId: checkpoint.messageId,
        },
      },
    ),
    mirrorHumanTranscript({ r2, claim, checkpoint }),
  ]);
}

async function mirrorPartialStream({
  r2,
  claim,
  sequence,
  streamAttempts,
  sessionCheckpoints = [],
}) {
  const key = rawTranscriptKey({ ...claim, sequence });
  const events = streamAttempts.flatMap((streamed) => streamed.events.map((event) => ({
    schemaVersion: 1,
    type: "anthropic_event",
    claim,
    sequence,
    attempt: streamed.attempt,
    partial: true,
    event,
  })));
  await Promise.all([
    r2.putObject(
      key,
      `${events.map((row) => JSON.stringify(row)).join("\n")}\n`,
      {
        contentType: "application/jsonl",
        metadata: {
          state: "streaming",
          eventCount: String(events.length),
          attemptCount: String(streamAttempts.length),
        },
      },
    ),
    r2.putObject(
      humanTranscriptKey({ ...claim, sequence }),
      renderPartialHumanTranscript({ claim, sequence, streamAttempts }),
      {
        contentType: "text/markdown; charset=utf-8",
        metadata: {
          state: "streaming",
          attemptCount: String(streamAttempts.length),
        },
      },
    ),
    r2.putObject(
      researchSessionTranscriptKey(claim),
      renderResearchSession({
        checkpoints: sessionCheckpoints,
        partialText: streamedHumanText(streamAttempts),
      }),
      {
        contentType: "text/markdown; charset=utf-8",
        metadata: {
          state: "streaming",
          problemId: claim.problemId,
          direction: claim.direction,
        },
      },
    ),
  ]);
}

async function mirrorHumanTranscript({ r2, claim, checkpoint }) {
  await r2.putObject(
    humanTranscriptKey({ ...claim, sequence: checkpoint.sequence }),
    renderHumanTranscript({ claim, checkpoint }),
    {
      contentType: "text/markdown; charset=utf-8",
      metadata: {
        state: "completed",
        problemId: claim.problemId,
        direction: claim.direction,
        claimTs: String(claim.claimTs),
        sequence: String(checkpoint.sequence),
        messageId: checkpoint.messageId,
      },
    },
  );
}

function renderPartialHumanTranscript({ claim, sequence, streamAttempts }) {
  const sections = streamAttempts.map((streamed) => {
    const text = streamed.events
      .filter((event) => event?.type === "content_block_delta")
      .map((event) => event.delta)
      .filter((delta) => delta?.type === "text_delta")
      .map((delta) => delta.text ?? "")
      .join("");
    return [
      `## Attempt ${streamed.attempt}`,
      stripTaskBudgetControlParagraphs(text)
        || "_No human-readable text has streamed yet._",
    ].join("\n\n");
  });
  return [
    `# ${claim.problemId} ${claim.direction} response ${sequence}`,
    `- Claim: ${claim.claimTs}`,
    "- State: streaming",
    ...sections,
    "",
  ].join("\n\n");
}

function streamedHumanText(streamAttempts) {
  const streamed = streamAttempts.at(-1);
  if (!streamed) return "";
  return streamed.events
    .filter((event) => event?.type === "content_block_delta")
    .map((event) => event.delta)
    .filter((delta) => delta?.type === "text_delta")
    .map((delta) => delta.text ?? "")
    .join("");
}

function renderHumanTranscript({ claim, checkpoint }) {
  const sections = renderCheckpointSections(checkpoint);
  return [
    `# ${claim.problemId} ${claim.direction} response ${checkpoint.sequence}`,
    `- Claim: ${claim.claimTs}`,
    `- Message: ${checkpoint.messageId}`,
    ...(checkpoint.requestId ? [`- Request: ${checkpoint.requestId}`] : []),
    `- Model: ${checkpoint.modelId}`,
    `- Stop reason: ${checkpoint.stopReason ?? "unknown"}`,
    `- Completed: ${checkpoint.completedAt}`,
    ...sections,
    "",
  ].join("\n\n");
}

function renderCheckpointSections(checkpoint) {
  const sections = [];
  for (const block of checkpoint.response.content ?? []) {
    switch (block?.type) {
      case "text":
        if (block.text?.trim()) {
          const publicText = stripTaskBudgetControlParagraphs(block.text);
          if (publicText) sections.push(publicText);
        }
        break;
      case "compaction":
        if (block.content?.trim()) {
          sections.push(`## Compaction context\n\n${block.content.trim()}`);
        }
        break;
      case "tool_use":
        if (block.name === "submit_no_solution") {
          try {
            const report = parseSubmittedNoSolution(block.input);
            sections.push([
              report.summary,
              report.researchMarkdown,
              `Verification notes: ${report.verificationNotes}`,
              ...(report.citations.length
                ? [`Citations:\n${report.citations.map((item) => `- ${item}`).join("\n")}`]
                : []),
            ].join("\n\n"));
            break;
          } catch {
            // Preserve an invalid historical payload in its raw form below.
          }
        }
        sections.push([
          `## Client tool: ${block.name ?? "unknown"}`,
          "```json",
          JSON.stringify(block.input ?? {}, null, 2),
          "```",
        ].join("\n"));
        break;
      case "server_tool_use":
        sections.push([
          `## Server tool: ${block.name ?? "unknown"}`,
          "```json",
          JSON.stringify(block.input ?? {}, null, 2),
          "```",
        ].join("\n"));
        break;
      case "code_execution_tool_result":
      case "web_fetch_tool_result":
      case "web_search_tool_result":
        sections.push([
          `## ${humanizeBlockType(block.type)}`,
          "```json",
          JSON.stringify(block.content ?? {}, null, 2),
          "```",
        ].join("\n"));
        break;
      case "thinking":
        sections.push("_Extended reasoning is retained only in the raw transcript._");
        break;
      default:
        if (block?.type) {
          sections.push(`_Raw transcript contains ${block.type} content._`);
        }
        break;
    }
  }
  return sections
    .map(stripTaskBudgetControlParagraphs)
    .filter(Boolean);
}

async function mirrorResearchSession({ r2, claim, checkpoints }) {
  if (!checkpoints.length) return;
  await r2.putObject(
    researchSessionTranscriptKey(claim),
    renderResearchSession({ checkpoints }),
    {
      contentType: "text/markdown; charset=utf-8",
      metadata: {
        state: "completed",
        problemId: claim.problemId,
        direction: claim.direction,
        lastMessageId: checkpoints.at(-1).messageId,
      },
    },
  );
}

function renderResearchSession({ checkpoints, partialText = "" }) {
  const sections = checkpoints.flatMap(renderCheckpointSections);
  const publicPartialText = stripTaskBudgetControlParagraphs(partialText);
  if (publicPartialText) sections.push(publicPartialText);
  return `${sections.join("\n\n").trim()}\n`;
}

function humanizeBlockType(type) {
  return type
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

async function persistContinuationContext({ r2, claim, checkpoints }) {
  if (!checkpoints.length) return;
  const context = renderContinuationContext(checkpoints);
  await r2.putObject(compactedContextKey(claim), context, {
    contentType: "text/markdown; charset=utf-8",
    metadata: {
      problemId: claim.problemId,
      direction: claim.direction,
      lastMessageId: checkpoints.at(-1).messageId,
    },
  });
}

function renderContinuationContext(checkpoints) {
  let compaction;
  let compactionIndex = -1;
  for (const [index, checkpoint] of checkpoints.entries()) {
    for (const block of checkpoint.response.content ?? []) {
      if (block?.type === "compaction" && typeof block.content === "string") {
        compaction = block.content;
        compactionIndex = index;
      }
    }
  }
  const recent = checkpoints
    .slice(Math.max(0, compactionIndex))
    .flatMap((checkpoint) => checkpoint.response.content ?? [])
    .map(continuationBlockText)
    .filter(Boolean)
    .join("\n\n");
  const fixed = [
    "# Carry-forward research context",
    compaction
      ? "## Server compaction\n\n" + stripTaskBudgetControlParagraphs(compaction)
      : "",
  ].filter(Boolean).join("\n\n");
  const recentHeader = "## Subsequent research output\n\n";
  const availableRecentCharacters = Math.max(
    0,
    CONTINUATION_CONTEXT_CHARACTER_LIMIT - fixed.length - recentHeader.length - 2,
  );
  const retainedRecent = recent.length <= availableRecentCharacters
    ? recent
    : `[Earlier post-compaction output omitted at a message boundary.]\n\n${tailAtParagraphBoundary(
        recent,
        availableRecentCharacters,
      )}`;
  return `${[
    fixed,
    retainedRecent ? recentHeader + retainedRecent : "",
  ].filter(Boolean).join("\n\n")}\n`;
}

function continuationBlockText(block) {
  if (block?.type === "text" && typeof block.text === "string") {
    return stripTaskBudgetControlParagraphs(block.text);
  }
  if (block?.type !== "tool_use" || block.name !== "submit_no_solution") {
    return "";
  }
  try {
    const report = parseSubmittedNoSolution(block.input);
    return [
      `## No-solution report: ${report.title}`,
      report.summary,
      report.researchMarkdown,
      `Verification notes: ${report.verificationNotes}`,
      ...(report.citations.length
        ? [`Citations:\n${report.citations.map((item) => `- ${item}`).join("\n")}`]
        : []),
    ].join("\n\n");
  } catch {
    return "";
  }
}

function isTaskBudgetExhaustionText(text) {
  return typeof text === "string"
    && text.length <= 2_000
    && /\b(?:task[ -]|request )?budget(?:\s+\w+){0,2}\s+exhausted\b/i.test(text);
}

function stripTaskBudgetControlParagraphs(text) {
  return text
    .split(/(?<=[.!?])(?=\s)|(?<=\n)/u)
    .filter((fragment) => !isTaskBudgetControlFragment(fragment))
    .join("")
    .split(/\n{2,}/)
    .filter((paragraph) => !isTaskBudgetControlParagraph(paragraph))
    .join("\n\n")
    .trim();
}

function isTaskBudgetControlFragment(fragment) {
  return isTerminalControlText(fragment);
}

function isTaskBudgetControlParagraph(paragraph) {
  if (paragraph.length > 2_000) return false;
  return isTerminalControlText(paragraph);
}

function isTerminalControlText(text) {
  return /\b(?:task|context|request)?\s*budget(?:\s+\w+){0,4}\s+exhausted\b/i
    .test(text)
    || /\b(?:remaining )?budget cannot fund\b/i.test(text)
    || /\bending (?:the )?(?:funded )?turn\b/i.test(text)
    || /\b(?:this is the )?terminal state\b/i.test(text)
    || /\bterminal (?:negative )?record\b/i.test(text)
    || /\binvestigation complete within funded budget\b/i.test(text)
    || /\brecord stands as last corrected\b/i.test(text)
    || /\b(?:terminal|filed) (?:negative )?record\b.*\b(?:complete|definitive|final|stands)\b/i
      .test(text);
}

function tailAtParagraphBoundary(text, maximumCharacters) {
  if (maximumCharacters <= 0) return "";
  const tail = text.slice(-maximumCharacters);
  const boundary = tail.indexOf("\n\n");
  return boundary === -1 ? tail : tail.slice(boundary + 2);
}

async function readDirectionContexts(r2, problemId) {
  const [proveContext, disproveContext] = await Promise.all([
    readOptionalText(r2, compactedContextKey({ problemId, direction: "prove" })),
    readOptionalText(r2, compactedContextKey({ problemId, direction: "disprove" })),
  ]);
  return { proveContext, disproveContext };
}

async function readOptionalText(r2, key) {
  try {
    const object = await r2.getObject(key);
    return await object.text();
  } catch (error) {
    if (error?.code === "NoSuchKey") return undefined;
    throw error;
  }
}

async function objectExists(r2, key) {
  try {
    await r2.getObject(key);
    return true;
  } catch (error) {
    if (error?.code === "NoSuchKey") return false;
    throw error;
  }
}

function extractSystemPrompt(request) {
  const block = request?.system?.[0];
  if (!block || typeof block.text !== "string" || !block.text) {
    throw new TypeError("Checkpointed request is missing its system prompt.");
  }
  return block.text;
}

function deadlineSignal(parent, remainingMs) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs)));
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function isDeadlineAbort(error) {
  return error?.name === "TimeoutError"
    || /hard stop|deadline/i.test(error?.message ?? "");
}

async function requireProblemOpen({ ledger, problemId, boundary }) {
  const problem = await ledger.getProblem(problemId);
  if (problem.status !== "Open") {
    throw new ProblemClosedDuringRunError(problem.status, boundary);
  }
  return problem;
}

async function settleCurrentClaim({
  ledger,
  r2,
  claimKey,
  solutionUri,
  onBoundary,
}) {
  const current = await ledger.getClaim(claimKey);
  let terminalUri = solutionUri;
  if (!terminalUri && await objectExists(r2, solutionKey(claimKey))) {
    terminalUri = r2ArtifactUri(solutionKey(claimKey));
  }
  if (current.settled && (!terminalUri || current.solutionUri === terminalUri)) {
    return current;
  }
  await reachBoundary(onBoundary, "before_ledger_settle", {
    claim: current,
    solutionUri: terminalUri,
  });
  const settlement = await ledger.settle({
    ...claimKey,
    finalSpentCents: current.spentCents,
    ...(terminalUri ? { solutionUri: terminalUri } : {}),
  });
  await reachBoundary(onBoundary, "after_ledger_settle", {
    claim: settlement.claim,
    solutionUri: terminalUri,
    settlementOutcome: settlement.outcome,
  });
  return settlement.claim;
}

async function reachBoundary(callback, name, details) {
  try {
    await callback(Object.freeze({ name, ...details }));
  } catch (error) {
    if (error instanceof WorkerProcessCrashError) throw error;
    throw new WorkerProcessCrashError(name, { cause: error });
  }
}

function hasCompaction(response) {
  return (response?.content ?? []).some((block) => block?.type === "compaction");
}

function terminalResult(outcome, claim, checkpoints, extra = {}) {
  return Object.freeze({
    outcome,
    claim,
    responseCount: checkpoints.length,
    ...extra,
  });
}

function parseClaimKey(claim) {
  if (!claim || typeof claim !== "object") throw new TypeError("claim is required.");
  if (typeof claim.problemId !== "string" || !claim.problemId) {
    throw new TypeError("claim.problemId is required.");
  }
  if (!["prove", "disprove"].includes(claim.direction)) {
    throw new TypeError("claim.direction must be prove or disprove.");
  }
  if (!Number.isSafeInteger(claim.claimTs) || claim.claimTs < 1) {
    throw new TypeError("claim.claimTs must be a positive safe integer.");
  }
  return Object.freeze({
    problemId: claim.problemId,
    direction: claim.direction,
    claimTs: claim.claimTs,
  });
}

function assertRequestFitsHeadroom({ maxTokens, pricingTable }) {
  const inputAllowance = pricingTable.request_profile
    ?.headroom_input_allowance_tokens;
  if (!Number.isSafeInteger(inputAllowance) || inputAllowance < 0) {
    throw new TypeError(
      "Pricing table must define headroom_input_allowance_tokens.",
    );
  }
  const maximumProfile = [
    { input_tokens: inputAllowance },
    {
      cache_creation: {
        ephemeral_5m_input_tokens: inputAllowance,
      },
    },
    {
      cache_creation: {
        ephemeral_1h_input_tokens: inputAllowance,
      },
    },
  ].map((inputUsage) => priceAnthropicUsage({
    model: "claude-fable-5",
    pricingTable,
    usage: {
      ...inputUsage,
      output_tokens: maxTokens,
    },
  })).reduce((maximum, candidate) => (
    candidate.costCents > maximum.costCents ? candidate : maximum
  ));
  if (maximumProfile.costCents > pricingTable.one_request_headroom_cents) {
    throw new RangeError(
      `maxTokens ${maxTokens} prices above the configured one-request headroom.`,
    );
  }
}

class ProblemClosedDuringRunError extends Error {
  constructor(status, boundary) {
    super(`Problem left Open status ${boundary}: ${status}.`);
    this.name = "ProblemClosedDuringRunError";
  }
}

async function notifyObserverError(callback, error, source) {
  try {
    await callback(Object.freeze({ source, error }));
  } catch {
    // Observability must never alter the paid request or accounting path.
  }
}
