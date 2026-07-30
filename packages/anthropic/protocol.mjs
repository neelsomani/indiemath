import {
  ANTHROPIC_BETAS,
  CLAUDE_FABLE_MODEL,
  CODE_EXECUTION_TOOL_TYPE,
  COMPACTION_STRATEGY_TYPE,
  DEFAULT_COMPACTION_TRIGGER_TOKENS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TASK_BUDGET_TOKENS,
  MAX_FABLE_OUTPUT_TOKENS,
  TASK_BUDGET_MINIMUM_TOKENS,
  WEB_FETCH_TOOL_TYPE,
} from "./constants.mjs";

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const SOLUTION_KEYS = new Set([
  "title",
  "summary",
  "argument_markdown",
  "verification_notes",
  "assumption_label",
  "citations",
]);
const NO_SOLUTION_KEYS = new Set([
  "title",
  "summary",
  "research_markdown",
  "verification_notes",
  "citations",
]);

export const SUBMIT_SOLUTION_TOOL = Object.freeze({
  name: "submit_solution",
  description:
    "Terminal action. Call only when you believe you have a complete, rigorous "
    + "proof or disproof. Put the full self-contained argument in the payload. "
    + "Do not call this merely to report progress or an incomplete idea.",
  input_schema: Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: Object.freeze({
      title: Object.freeze({ type: "string" }),
      summary: Object.freeze({ type: "string" }),
      argument_markdown: Object.freeze({
        type: "string",
        description: "The complete proof or counterexample argument in Markdown.",
      }),
      verification_notes: Object.freeze({
        type: "string",
        description: "Checks performed, fragile steps, and how each was verified.",
      }),
      assumption_label: Object.freeze({
        type: "string",
        description:
          "A precise named assumption if the result is conditional; omit for an unconditional result.",
      }),
      citations: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "string" }),
      }),
    }),
    required: Object.freeze([
      "title",
      "summary",
      "argument_markdown",
      "verification_notes",
    ]),
  }),
});

export const SUBMIT_NO_SOLUTION_TOOL = Object.freeze({
  name: "submit_no_solution",
  description:
    "Terminal action for ending this claim without a complete proof or disproof. "
    + "Use only after substantial investigation when no valid solution is available. "
    + "The problem remains open and unused claim funds return to its pool.",
  input_schema: Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: Object.freeze({
      title: Object.freeze({ type: "string" }),
      summary: Object.freeze({ type: "string" }),
      research_markdown: Object.freeze({
        type: "string",
        description: "Useful progress, failed approaches, and remaining obligations in Markdown.",
      }),
      verification_notes: Object.freeze({
        type: "string",
        description: "Checks performed and limitations of the research report.",
      }),
      citations: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "string" }),
      }),
    }),
    required: Object.freeze([
      "title",
      "summary",
      "research_markdown",
      "verification_notes",
    ]),
  }),
});

export function buildFableRequest({
  messages,
  systemPrompt,
  taskBudgetTokens = DEFAULT_TASK_BUDGET_TOKENS,
  taskBudgetRemainingTokens,
  maxTokens = DEFAULT_MAX_TOKENS,
  effort = "max",
  compactionTriggerTokens = DEFAULT_COMPACTION_TRIGGER_TOKENS,
  pauseAfterCompaction = false,
  enableCompaction = true,
  container,
  model = CLAUDE_FABLE_MODEL,
} = {}) {
  if (!Array.isArray(messages)) throw new TypeError("messages must be an array.");
  const prompt = requiredString(systemPrompt, "systemPrompt");
  const total = integerInRange(
    taskBudgetTokens,
    TASK_BUDGET_MINIMUM_TOKENS,
    Number.MAX_SAFE_INTEGER,
    "taskBudgetTokens",
  );
  const remaining = taskBudgetRemainingTokens === undefined
    ? undefined
    : integerInRange(
        taskBudgetRemainingTokens,
        0,
        total,
        "taskBudgetRemainingTokens",
      );
  const parsedMaxTokens = integerInRange(
    maxTokens,
    1,
    MAX_FABLE_OUTPUT_TOKENS,
    "maxTokens",
  );
  const trigger = integerInRange(
    compactionTriggerTokens,
    50_000,
    1_000_000,
    "compactionTriggerTokens",
  );
  if (!EFFORT_LEVELS.has(effort)) {
    throw new TypeError(`effort must be one of ${[...EFFORT_LEVELS].join(", ")}.`);
  }
  if (typeof pauseAfterCompaction !== "boolean") {
    throw new TypeError("pauseAfterCompaction must be a boolean.");
  }
  if (typeof enableCompaction !== "boolean") {
    throw new TypeError("enableCompaction must be a boolean.");
  }

  return Object.freeze({
    model: requiredString(model, "model"),
    max_tokens: parsedMaxTokens,
    cache_control: Object.freeze({ type: "ephemeral" }),
    system: Object.freeze([Object.freeze({
      type: "text",
      text: prompt,
      cache_control: Object.freeze({ type: "ephemeral", ttl: "1h" }),
    })]),
    output_config: Object.freeze({
      effort,
      task_budget: Object.freeze({
        type: "tokens",
        total,
        ...(remaining === undefined ? {} : { remaining }),
      }),
    }),
    messages: structuredClone(messages),
    tools: structuredClone([
      { type: CODE_EXECUTION_TOOL_TYPE, name: "code_execution" },
      {
        type: WEB_FETCH_TOOL_TYPE,
        name: "web_fetch",
        max_content_tokens: 100_000,
      },
      SUBMIT_SOLUTION_TOOL,
    ]),
    ...(enableCompaction
      ? {
          context_management: Object.freeze({
            edits: Object.freeze([Object.freeze({
              type: COMPACTION_STRATEGY_TYPE,
              trigger: Object.freeze({ type: "input_tokens", value: trigger }),
              instructions:
                "This is a nonterminal server compaction step. Write a nonempty "
                + "carry-forward summary and do not call tools. Preserve the exact "
                + "conjecture, definitions, established lemmas, "
                + "failed approaches, computations, citations, rejection feedback, "
                + "and every unresolved proof obligation.",
              ...(pauseAfterCompaction ? { pause_after_compaction: true } : {}),
            })]),
          }),
        }
      : {}),
    ...(container ? { container: normalizeContainer(container) } : {}),
  });
}

export function buildFableSystemPrompt({
  problem,
  direction,
  directionPrompt,
  rejectionNotes = [],
  reviewedResults = [],
} = {}) {
  if (!problem || typeof problem !== "object") {
    throw new TypeError("problem must be an object.");
  }
  const parsedDirection = direction === "prove" || direction === "disprove"
    ? direction
    : (() => { throw new TypeError("direction must be prove or disprove."); })();
  const statement = requiredString(problem.statement, "problem.statement");
  const title = requiredString(problem.title, "problem.title");
  const directive = requiredString(directionPrompt, "directionPrompt");
  if (!Array.isArray(rejectionNotes) || !Array.isArray(reviewedResults)) {
    throw new TypeError("rejectionNotes and reviewedResults must be arrays.");
  }

  return [
    "You are the resident mathematical research agent for IndieMath.",
    `Problem: ${title}`,
    `Canonical statement:\n${statement}`,
    `Assigned direction: ${parsedDirection}.`,
    `Direction prompt:\n${directive}`,
    "Your work must be rigorous, self-contained, and checked against the canonical statement.",
    "Use code execution for calculations and searches for examples when they materially test an argument.",
    "A conditional result must name its assumption precisely; never present a conditional result as unconditional.",
    "Call submit_solution if and only if you believe you have a complete proof or disproof, and include "
      + "the full argument. Do not call it merely to stop or report progress. In every funded turn, advance "
      + "the research with genuinely new analysis: pursue a new path, strengthen an incomplete argument, "
      + "or falsify a remaining obstruction. Do not merely restate, recheck, or summarize prior work. End "
      + "the API turn normally only after making that new progress and exhausting the presently productive "
      + "avenue. An end_turn is only an API turn boundary, never the end of the funded claim: the harness "
      + "immediately continues the same investigation until the claim's dollar budget reaches its safe "
      + "spending boundary. The model task-token budget is advisory and is not the claim's financial budget; "
      + "never announce that the funded claim is exhausted merely because the task-token countdown ended. "
      + "A server-requested "
      + "compaction summary is a nonterminal context-management step, not an end_turn: write its "
      + "required nonempty summary without calling tools so the investigation can continue.",
    formatContextSection("Prior rejection notes", rejectionNotes),
    formatContextSection("Prior reviewed results", reviewedResults),
  ].join("\n\n");
}

export function buildInitialResearchMessage({
  proveContext,
  disproveContext,
} = {}) {
  return {
    role: "user",
    content: [
      "Begin or resume the assigned investigation. Recheck inherited claims only when necessary, then "
        + "produce genuinely new analysis that advances beyond the retained work.",
      formatOptionalContext("Prior compacted prove-direction context", proveContext),
      formatOptionalContext("Prior compacted disprove-direction context", disproveContext),
    ].join("\n\n"),
  };
}

export function parseSubmittedSolution(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("submit_solution input must be an object.");
  }
  const unexpected = Object.keys(value).filter((key) => !SOLUTION_KEYS.has(key));
  if (unexpected.length) {
    throw new TypeError(
      `submit_solution contains unsupported fields: ${unexpected.join(", ")}.`,
    );
  }
  const citations = value.citations === undefined
    ? []
    : parseStringArray(value.citations, "submit_solution.citations");
  return Object.freeze({
    title: requiredString(value.title, "submit_solution.title"),
    summary: requiredString(value.summary, "submit_solution.summary"),
    argumentMarkdown: requiredString(
      value.argument_markdown,
      "submit_solution.argument_markdown",
    ),
    verificationNotes: requiredString(
      value.verification_notes,
      "submit_solution.verification_notes",
    ),
    assumptionLabel: optionalString(
      value.assumption_label,
      "submit_solution.assumption_label",
    ),
    citations: Object.freeze(citations),
  });
}

export function parseSubmittedNoSolution(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("submit_no_solution input must be an object.");
  }
  const unexpected = Object.keys(value).filter((key) => !NO_SOLUTION_KEYS.has(key));
  if (unexpected.length) {
    throw new TypeError(
      `submit_no_solution contains unsupported fields: ${unexpected.join(", ")}.`,
    );
  }
  const citations = value.citations === undefined
    ? []
    : parseStringArray(value.citations, "submit_no_solution.citations");
  return Object.freeze({
    title: requiredString(value.title, "submit_no_solution.title"),
    summary: requiredString(value.summary, "submit_no_solution.summary"),
    researchMarkdown: requiredString(
      value.research_markdown,
      "submit_no_solution.research_markdown",
    ),
    verificationNotes: requiredString(
      value.verification_notes,
      "submit_no_solution.verification_notes",
    ),
    citations: Object.freeze(citations),
  });
}

export function renderSolutionArtifact({
  solution,
  problemId,
  direction,
  claimTs,
  model,
  messageId,
  requestId,
} = {}) {
  const parsed = parseSubmittedSolution({
    title: solution?.title,
    summary: solution?.summary,
    argument_markdown: solution?.argumentMarkdown,
    verification_notes: solution?.verificationNotes,
    ...(solution?.assumptionLabel
      ? { assumption_label: solution.assumptionLabel }
      : {}),
    citations: solution?.citations ?? [],
  });
  const metadata = [
    `Problem: ${requiredString(problemId, "problemId")}`,
    `Direction: ${direction}`,
    `Claim: ${claimTs}`,
    `Model: ${requiredString(model, "model")}`,
    `Message: ${requiredString(messageId, "messageId")}`,
    ...(requestId ? [`Request: ${requestId}`] : []),
    ...(parsed.assumptionLabel
      ? [`Resolved under assumption: ${parsed.assumptionLabel}`]
      : []),
  ];
  return [
    `# ${parsed.title}`,
    metadata.map((line) => `- ${line}`).join("\n"),
    "## Summary",
    parsed.summary,
    "## Argument",
    parsed.argumentMarkdown,
    "## Verification notes",
    parsed.verificationNotes,
    ...(parsed.citations.length
      ? ["## Citations", parsed.citations.map((item) => `- ${item}`).join("\n")]
      : []),
    "",
  ].join("\n\n");
}

export function anthropicBetaHeader() {
  return ANTHROPIC_BETAS.join(",");
}

function formatContextSection(label, values) {
  if (!values.length) return `${label}: none.`;
  return `${label}:\n${values.map((value, index) => (
    `${index + 1}. ${typeof value === "string" ? value : JSON.stringify(value)}`
  )).join("\n")}`;
}

function formatOptionalContext(label, value) {
  return `${label}:\n${typeof value === "string" && value.trim() ? value.trim() : "(none)"}`;
}

function parseStringArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value.map((item, index) => requiredString(item, `${label}[${index}]`));
}

function normalizeContainer(container) {
  if (typeof container === "string") return container;
  if (
    container
    && typeof container === "object"
    && typeof container.id === "string"
    && container.id.trim()
  ) {
    return container.id.trim();
  }
  throw new TypeError("container must be a nonempty ID string or object with an ID.");
}

function integerInRange(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(
      `${label} must be a safe integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value.trim();
}

function optionalString(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, label);
}
