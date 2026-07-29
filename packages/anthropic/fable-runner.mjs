import {
  assertPort,
  compactedContextKey,
  rawTranscriptKey,
  solutionKey,
} from "#indiemath/shared";
import {
  buildFableRequest,
  buildFableSystemPrompt,
  buildInitialResearchMessage,
  parseSubmittedSolution,
  renderSolutionArtifact,
} from "./protocol.mjs";
import { priceAnthropicUsage } from "./pricing.mjs";
import { retryAnthropicOperation } from "./retry.mjs";
import { collectMessageStream } from "./stream.mjs";
import { DEFAULT_MAX_TOKENS } from "./constants.mjs";

const CONTINUATION_CONTEXT_CHARACTER_LIMIT = 200_000;
const DEFAULT_HARD_STOP_BUFFER_MS = 5 * 60 * 1_000;
const STREAM_FLUSH_EVENT_COUNT = 25;

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
} = {}) {
  const claimKey = parseClaimKey(suppliedClaim);
  assertPort(messagesClient, "Anthropic Messages", ["streamMessage"]);
  assertPort(ledger, "ledger", [
    "getClaim",
    "getProblem",
    "listClaimResponses",
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
  const effectiveMaxTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
  assertRequestFitsHeadroom({
    maxTokens: effectiveMaxTokens,
    pricingTable,
  });

  let claim = await ledger.getClaim(claimKey);
  let checkpoints = [...await ledger.listClaimResponses(claimKey)];
  await mirrorCheckpoints({ r2, claim: claimKey, checkpoints });
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
    });
  }
  if (priorTerminal.kind === "refusal") {
    const settlement = await ledger.settle({
      ...claimKey,
      finalSpentCents: claim.spentCents,
    });
    return terminalResult("refusal", settlement.claim, checkpoints);
  }

  const initialRequest = checkpoints[0]?.request;
  const totalTaskBudget = initialRequest?.output_config?.task_budget?.total
    ?? taskBudgetTokens;
  let systemPrompt;
  let messages;
  let container = checkpoints.at(-1)?.containerId;

  if (checkpoints.length) {
    const last = checkpoints.at(-1);
    systemPrompt = extractSystemPrompt(initialRequest);
    messages = continuationMessages(last);
  } else {
    const contexts = await readDirectionContexts(r2, claim.problemId);
    systemPrompt = buildFableSystemPrompt({
      problem,
      direction: claim.direction,
      directionPrompt: directionPrompt
        ?? problem?.directions?.[claim.direction]
        ?? problem?.[`${claim.direction}Prompt`],
      rejectionNotes,
      reviewedResults,
    });
    messages = [buildInitialResearchMessage(contexts)];
  }

  while (true) {
    claim = await ledger.getClaim(claimKey);
    if (claim.settled) return terminalResult("already_settled", claim, checkpoints);
    const now = clock();
    const hardStopMs = Date.parse(claim.leaseExpiresAt) - hardStopBufferMs;
    if (!Number.isFinite(hardStopMs) || now >= hardStopMs) {
      const settlement = await ledger.settle({
        ...claimKey,
        finalSpentCents: claim.spentCents,
      });
      return terminalResult("lease_hard_stop", settlement.claim, checkpoints);
    }
    const currentProblem = await ledger.getProblem(claim.problemId);
    if (currentProblem.status !== "Open") {
      const settlement = await ledger.settle({
        ...claimKey,
        finalSpentCents: claim.spentCents,
      });
      return terminalResult("problem_no_longer_open", settlement.claim, checkpoints);
    }
    const remainingCents = claim.budgetCents - claim.spentCents;
    if (remainingCents <= pricingTable.one_request_headroom_cents) {
      await persistContinuationContext({ r2, claim: claimKey, checkpoints });
      const settlement = await ledger.settle({
        ...claimKey,
        finalSpentCents: claim.spentCents,
      });
      return terminalResult("budget_headroom", settlement.claim, checkpoints);
    }

    const request = buildFableRequest({
      messages,
      systemPrompt,
      taskBudgetTokens: totalTaskBudget,
      maxTokens: effectiveMaxTokens,
      ...(effort === undefined ? {} : { effort }),
      ...(compactionTriggerTokens === undefined
        ? {}
        : { compactionTriggerTokens }),
      ...(pauseAfterCompaction ? { pauseAfterCompaction: true } : {}),
      ...(container ? { container } : {}),
    });
    const requestSignal = deadlineSignal(signal, hardStopMs - clock());
    let response;
    let requestStartedAt;
    try {
      response = await retryAnthropicOperation(
        async () => {
          requestStartedAt = new Date(clock()).toISOString();
          const streamedEvents = [];
          return collectMessageStream(
            messagesClient.streamMessage(request, { signal: requestSignal }),
            {
              async onEvent(event) {
                streamedEvents.push(event);
                try {
                  await onEvent(event);
                } catch (error) {
                  await notifyObserverError(onObserverError, error, "event callback");
                }
                if (
                  streamedEvents.length === 1
                  || streamedEvents.length % STREAM_FLUSH_EVENT_COUNT === 0
                  || event.type === "content_block_stop"
                  || event.type === "message_stop"
                ) {
                  try {
                    await mirrorPartialStream({
                      r2,
                      claim: claimKey,
                      sequence: checkpoints.length + 1,
                      events: streamedEvents,
                    });
                  } catch (error) {
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
        },
        {
          signal: requestSignal,
          hardStopMs,
          clock,
          async onRetry(retry) {
            const status = await ledger.getProblem(claim.problemId);
            if (status.status !== "Open") {
              throw new ProblemClosedDuringRunError(status.status);
            }
            try {
              await onRetry(retry);
            } catch (error) {
              await notifyObserverError(onObserverError, error, "retry callback");
            }
          },
        },
      );
    } catch (error) {
      if (error instanceof ProblemClosedDuringRunError) {
        const current = await ledger.getClaim(claimKey);
        const settlement = await ledger.settle({
          ...claimKey,
          finalSpentCents: current.spentCents,
        });
        return terminalResult("problem_no_longer_open", settlement.claim, checkpoints);
      }
      if (clock() >= hardStopMs || isDeadlineAbort(error)) {
        const current = await ledger.getClaim(claimKey);
        const settlement = await ledger.settle({
          ...claimKey,
          finalSpentCents: current.spentCents,
        });
        return terminalResult("lease_hard_stop", settlement.claim, checkpoints);
      }
      throw error;
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
    } else if (!checkpoints.some((row) => row.messageId === response.id)) {
      checkpoints = [...await ledger.listClaimResponses(claimKey)];
    }
    await mirrorCheckpoint({
      r2,
      claim: claimKey,
      checkpoint: checkpoint.response,
      priced,
    });
    await persistContinuationContext({ r2, claim: claimKey, checkpoints });
    container = checkpoint.response.containerId ?? container;

    const terminal = terminalAction(response);
    if (terminal.kind === "solution") {
      return finalizeSolution({
        claim,
        checkpoint: checkpoint.response,
        solution: terminal.solution,
        ledger,
        r2,
      });
    }
    if (terminal.kind === "refusal") {
      const settlement = await ledger.settle({
        ...claimKey,
        finalSpentCents: claim.spentCents,
      });
      return terminalResult("refusal", settlement.claim, checkpoints);
    }

    messages = continuationMessages(checkpoint.response);
  }
}

function continuationMessages(checkpoint) {
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
        return {
          type: "tool_result",
          tool_use_id: tool.id,
          is_error: true,
          content: `Unknown client tool: ${tool.name}`,
        };
      }),
    });
    return messages;
  }
  switch (checkpoint.response.stop_reason) {
    case "pause_turn":
      return messages;
    case "max_tokens":
      messages.push({
        role: "user",
        content:
          "Continue from the exact prior state. The last response reached its "
          + "per-request token limit; preserve all proof obligations.",
      });
      return messages;
    case "model_context_window_exceeded":
      messages.push({
        role: "user",
        content:
          "Resume from the retained compaction context and continue the investigation.",
      });
      return messages;
    default:
      messages.push({
        role: "user",
        content:
          "Continue investigating. Do not stop with prose alone; submit_solution "
          + "is the only accepted terminal signal.",
      });
      return messages;
  }
}

function terminalAction(response) {
  if (!response) return { kind: "none" };
  for (const block of response.content ?? []) {
    if (block?.type !== "tool_use" || block.name !== "submit_solution") continue;
    try {
      return { kind: "solution", solution: parseSubmittedSolution(block.input) };
    } catch {
      return { kind: "none" };
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
  const solutionUri = `r2://${key}`;
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
  } catch (error) {
    if (error?.code !== "resolve-race-lost") throw error;
    resolution = await ledger.settle({
      problemId: claim.problemId,
      direction: claim.direction,
      claimTs: claim.claimTs,
      finalSpentCents: claim.spentCents,
      solutionUri,
    });
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
    await mirrorCheckpoint({ r2, claim, checkpoint });
  }
  if (checkpoints.length) {
    await persistContinuationContext({ r2, claim, checkpoints });
  }
}

async function mirrorCheckpoint({ r2, claim, checkpoint, priced }) {
  const key = rawTranscriptKey({ ...claim, sequence: checkpoint.sequence });
  await r2.putObject(key, `${JSON.stringify({
    schemaVersion: 1,
    claim,
    requestId: checkpoint.requestId,
    messageId: checkpoint.messageId,
    request: checkpoint.request,
    response: checkpoint.response,
    pricing: priced ?? {
      costCents: checkpoint.pricedCostCents,
      appliedCostCents: checkpoint.appliedCostCents,
      overageCents: checkpoint.overageCents,
    },
    completedAt: checkpoint.completedAt,
  })}\n`, {
    contentType: "application/jsonl",
  });
}

async function mirrorPartialStream({ r2, claim, sequence, events }) {
  const key = rawTranscriptKey({ ...claim, sequence });
  const body = events.map((event) => JSON.stringify({
    partial: true,
    event,
  })).join("\n");
  await r2.putObject(key, `${body}\n`, {
    contentType: "application/jsonl",
    metadata: {
      state: "streaming",
      eventCount: String(events.length),
    },
  });
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
  let compactionSequence = 0;
  for (const checkpoint of checkpoints) {
    for (const block of checkpoint.response.content ?? []) {
      if (block?.type === "compaction" && typeof block.content === "string") {
        compaction = block.content;
        compactionSequence = checkpoint.sequence;
      }
    }
  }
  const recent = checkpoints
    .filter((checkpoint) => checkpoint.sequence >= compactionSequence)
    .flatMap((checkpoint) => checkpoint.response.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n");
  const text = [
    "# Carry-forward research context",
    compaction ? "## Server compaction\n\n" + compaction : "",
    recent ? "## Subsequent research output\n\n" + recent : "",
  ].filter(Boolean).join("\n\n");
  return `${text.slice(-CONTINUATION_CONTEXT_CHARACTER_LIMIT)}\n`;
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

function terminalResult(outcome, claim, checkpoints) {
  return Object.freeze({
    outcome,
    claim,
    responseCount: checkpoints.length,
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
  constructor(status) {
    super(`Problem left Open status during Anthropic backoff: ${status}.`);
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
