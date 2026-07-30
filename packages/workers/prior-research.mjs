import { createHash } from "node:crypto";
import { assertPort } from "#indiemath/shared";

export const PRIOR_RESEARCH_MANIFEST_KEY =
  "public/prior-research/manifest.json";

export async function verifyPriorResearchContexts({
  r2,
  manifest,
} = {}) {
  assertPort(r2, "R2", ["getObject"]);
  const responses = parsePriorResearchManifest(manifest);
  const results = [];
  for (const response of responses) {
    const object = await r2.getObject(response.contextKey);
    const body = await object.text();
    if (!body.trim()) {
      throw new TypeError(
        `Prior research context ${response.contextKey} must contain text.`,
      );
    }
    const actualSha256 = sha256(body);
    if (actualSha256 !== response.contextSha256) {
      throw new Error(
        `Prior research context hash mismatch for ${response.problemId}: `
          + `expected ${response.contextSha256}, received ${actualSha256}.`,
      );
    }
    results.push(Object.freeze({
      problemId: response.problemId,
      contextKey: response.contextKey,
      sha256: actualSha256,
    }));
  }
  return Object.freeze({
    total: results.length,
    results: Object.freeze(results),
  });
}

export function parsePriorResearchManifest(manifest) {
  if (
    !manifest
    || typeof manifest !== "object"
    || Array.isArray(manifest)
    || manifest.schemaVersion !== 1
    || manifest.kind !== "prior-research-archive"
    || !Array.isArray(manifest.responses)
  ) {
    throw new TypeError("Unsupported prior research manifest.");
  }
  if (manifest.responses.length === 0) {
    throw new TypeError("Prior research manifest contains no responses.");
  }
  const problemIds = new Set();
  const contextKeys = new Set();
  return manifest.responses.map((response, index) => {
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new TypeError(`Prior research response ${index} must be an object.`);
    }
    const problemId = requiredString(
      response.problemId,
      `responses[${index}].problemId`,
    );
    const direction = requiredString(
      response.direction,
      `responses[${index}].direction`,
    );
    if (!["prove", "disprove"].includes(direction)) {
      throw new TypeError(`Prior research response ${index} has an invalid direction.`);
    }
    if (!Number.isSafeInteger(response.claimTs) || response.claimTs <= 0) {
      throw new TypeError(`Prior research response ${index} has an invalid claimTs.`);
    }
    if (!Number.isSafeInteger(response.outputTokens) || response.outputTokens < 0) {
      throw new TypeError(
        `Prior research response ${index} has an invalid outputTokens value.`,
      );
    }
    const contextKey = requiredString(
      response.contextKey,
      `responses[${index}].contextKey`,
    );
    const expectedContextKey =
      `transcripts/${problemId}/${direction}/compacted.md`;
    if (contextKey !== expectedContextKey) {
      throw new TypeError(
        `Prior research response ${index} context key must be `
          + `${expectedContextKey}.`,
      );
    }
    const contextSha256 = requiredString(
      response.contextSha256,
      `responses[${index}].contextSha256`,
    );
    if (!/^[a-f0-9]{64}$/.test(contextSha256)) {
      throw new TypeError(
        `responses[${index}].contextSha256 must be a lowercase SHA-256 digest.`,
      );
    }
    if (problemIds.has(problemId) || contextKeys.has(contextKey)) {
      throw new TypeError(`Duplicate prior research context for ${problemId}.`);
    }
    problemIds.add(problemId);
    contextKeys.add(contextKey);
    return Object.freeze({
      problemId,
      direction,
      claimTs: response.claimTs,
      outputTokens: response.outputTokens,
      contextKey,
      contextSha256,
    });
  });
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value.trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
