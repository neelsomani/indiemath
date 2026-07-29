export const PROBLEM_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const PROBLEM_ID_MIN_LENGTH = 3;
export const PROBLEM_ID_MAX_LENGTH = 64;
export const WORKER_IDS = Object.freeze([
  "worker-1",
  "worker-2",
  "worker-3",
  "worker-4",
]);

export function parseProblemId(value, label = "problemId") {
  if (
    typeof value !== "string"
    || value.length < PROBLEM_ID_MIN_LENGTH
    || value.length > PROBLEM_ID_MAX_LENGTH
    || !PROBLEM_ID_PATTERN.test(value)
  ) {
    throw new TypeError(
      `${label} must be ${PROBLEM_ID_MIN_LENGTH}–${PROBLEM_ID_MAX_LENGTH} characters `
      + `and match ${PROBLEM_ID_PATTERN}.`,
    );
  }
  return value;
}

export function parseWorkerId(value, label = "workerId") {
  if (!WORKER_IDS.includes(value)) {
    throw new TypeError(`${label} must be one of ${WORKER_IDS.join(", ")}.`);
  }
  return value;
}

export function parsePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

export function parseNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer.`);
  }
  return value;
}
