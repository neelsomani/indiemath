// The current pricing table reserves $16.00 for the worst-case next request.
// A claim needs one cent beyond that boundary or the runner would settle before
// issuing any paid request.
export const MINIMUM_RUN_BUDGET_CENTS = 1_601;
export const DEFAULT_RUN_BUDGET_CENTS = 5_000;
export const MAX_RUN_BUDGET_CENTS = 50_000;
export const WORKER_IDLE_POLL_INTERVAL_MS = 15 * 60 * 1_000;
