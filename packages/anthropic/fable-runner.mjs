import {
  assertPort,
  compactedContextKey,
  humanTranscriptKey,
  rawTranscriptKey,
  r2ArtifactUri,
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
  retryOptions = {},
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
  if (!retryOptions || typeof retryOptions !== "object" || Array.isArray(retryOptions)) {
    throw new TypeError("retryOptions must be an object.");
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
    const settledClaim = await settleCurrentClaim({ ledger, claimKey });
    return terminalResult("refusal", settledClaim, checkpoints);
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
      const settledClaim = await settleCurrentClaim({ ledger, claimKey });
      return terminalResult("lease_hard_stop", settledClaim, checkpoints);
    }
    const currentProblem = await ledger.getProblem(claim.problemId);
    if (currentProblem.status !== "Open") {
      const settledClaim = await settleCurrentClaim({ ledger, claimKey });
      return terminalResult("problem_no_longer_open", settledClaim, checkpoints);
    }
    const remainingCents = claim.budgetCents - claim.spentCents;
    if (remainingCents <= pricingTable.one_request_headroom_cents) {
      await persistContinuationContext({ r2, claim: claimKey, checkpoints });
      const settledClaim = await settleCurrentClaim({ ledger, claimKey });
      return terminalResult("budget_headroom", settledClaim, checkpoints);
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
          const streamed = { attempt, events: [] };
          streamAttempts.push(streamed);
          return collectMessageStream(
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
      if (error instanceof ProblemClosedDuringRunError) {
        const settledClaim = await settleCurrentClaim({ ledger, claimKey });
        return terminalResult("problem_no_longer_open", settledClaim, checkpoints);
      }
      if (clock() >= hardStopMs || isDeadlineAbort(error)) {
        const settledClaim = await settleCurrentClaim({ ledger, claimKey });
        return terminalResult("lease_hard_stop", settledClaim, checkpoints);
      }
      const settledClaim = await settleCurrentClaim({ ledger, claimKey });
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
    } else if (!checkpoints.some((row) => row.messageId === response.id)) {
      checkpoints = [...await ledger.listClaimResponses(claimKey)];
    }
    await mirrorCheckpoint({
      r2,
      claim: claimKey,
      checkpoint: checkpoint.response,
      priced,
      streamAttempts,
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
      const settledClaim = await settleCurrentClaim({ ledger, claimKey });
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
        const settledClaim = await settleCurrentClaim({ ledger, claimKey });
        return terminalResult(
          "problem_no_longer_open",
          settledClaim,
          checkpoints,
        );
      }
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
  const solutionUri = r2ArtifactUri(key);
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
    if (!["resolve-race-lost", "claim-settled", "lease-expired"].includes(error?.code)) {
      throw error;
    }
    resolution = {
      claim: await settleCurrentClaim({
        ledger,
        claimKey: {
          problemId: claim.problemId,
          direction: claim.direction,
          claimTs: claim.claimTs,
        },
        solutionUri,
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

async function mirrorPartialStream({ r2, claim, sequence, streamAttempts }) {
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
      text.trim() || "_No human-readable text has streamed yet._",
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

function renderHumanTranscript({ claim, checkpoint }) {
  const sections = [];
  for (const block of checkpoint.response.content ?? []) {
    switch (block?.type) {
      case "text":
        if (block.text?.trim()) sections.push(block.text.trim());
        break;
      case "compaction":
        if (block.content?.trim()) {
          sections.push(`## Compaction context\n\n${block.content.trim()}`);
        }
        break;
      case "tool_use":
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

async function settleCurrentClaim({ ledger, claimKey, solutionUri }) {
  const current = await ledger.getClaim(claimKey);
  if (current.settled && (!solutionUri || current.solutionUri === solutionUri)) {
    return current;
  }
  const settlement = await ledger.settle({
    ...claimKey,
    finalSpentCents: current.spentCents,
    ...(solutionUri ? { solutionUri } : {}),
  });
  return settlement.claim;
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
