export const RUN_PAUSE_REASONS = Object.freeze([
  "anthropic-monthly-plan-limit",
]);

export function parseRunPauseReason(value, label = "runPauseReason") {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  if (!value.trim()) return undefined;
  const reason = value.trim();
  if (!RUN_PAUSE_REASONS.includes(reason)) {
    throw new TypeError(
      `${label} must be one of ${RUN_PAUSE_REASONS.join(", ")}.`,
    );
  }
  return reason;
}

export function runControlFromPauseReason(reason) {
  const parsedReason = parseRunPauseReason(reason);
  return Object.freeze(parsedReason
    ? { paused: true, reason: parsedReason }
    : { paused: false });
}

export function parseRunControl(value, label = "runControl") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  if (typeof value.paused !== "boolean") {
    throw new TypeError(`${label}.paused must be a boolean.`);
  }
  const reason = parseRunPauseReason(value.reason, `${label}.reason`);
  if (value.paused !== Boolean(reason)) {
    throw new TypeError(`${label}.paused must agree with ${label}.reason.`);
  }
  return runControlFromPauseReason(reason);
}
