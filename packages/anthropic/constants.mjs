export const ANTHROPIC_API_VERSION = "2023-06-01";
export const ANTHROPIC_MESSAGES_PATH = "/v1/messages";
export const ANTHROPIC_USAGE_PATH = "/v1/organizations/usage_report/messages";
export const CLAUDE_FABLE_MODEL = "claude-fable-5";

export const ANTHROPIC_BETAS = Object.freeze([
  "task-budgets-2026-03-13",
  "compact-2026-01-12",
]);

export const CODE_EXECUTION_TOOL_TYPE = "code_execution_20260521";
export const WEB_FETCH_TOOL_TYPE = "web_fetch_20260318";
export const COMPACTION_STRATEGY_TYPE = "compact_20260112";
export const TASK_BUDGET_MINIMUM_TOKENS = 20_000;
export const DEFAULT_MAX_TOKENS = 64_000;
export const MAX_FABLE_OUTPUT_TOKENS = 128_000;
export const DEFAULT_TASK_BUDGET_TOKENS = 64_000;
export const DEFAULT_COMPACTION_TRIGGER_TOKENS = 50_000;
