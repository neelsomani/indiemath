import { createHash } from "node:crypto";
import {
  assertPort,
  compactedContextKey,
} from "#indiemath/shared";

export async function bootstrapFableMathContexts({
  r2,
  manifest,
  loadArtifact,
} = {}) {
  assertPort(r2, "R2", ["putObject"]);
  if (typeof loadArtifact !== "function") {
    throw new TypeError("loadArtifact must be a function.");
  }
  const responses = parseManifest(manifest);
  const results = [];
  for (const response of responses) {
    const body = await loadArtifact(response.contextArtifact);
    if (typeof body !== "string" || !body.trim()) {
      throw new TypeError(
        `Fable context artifact ${response.contextArtifact} must contain text.`,
      );
    }
    const actualSha256 = sha256(body);
    if (actualSha256 !== response.contextSha256) {
      throw new Error(
        `Fable context artifact hash mismatch for ${response.problemId}: `
          + `expected ${response.contextSha256}, received ${actualSha256}.`,
      );
    }
    try {
      await r2.putObject(response.contextKey, body, {
        contentType: "text/markdown; charset=utf-8",
        metadata: {
          state: "seeded",
          source: "fable-math",
          problemId: response.problemId,
          direction: "disprove",
          sourceRunId: response.sourceRunId,
          sha256: response.contextSha256,
        },
        ifNoneMatch: true,
      });
      results.push(Object.freeze({
        problemId: response.problemId,
        contextKey: response.contextKey,
        outcome: "seeded",
      }));
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      results.push(Object.freeze({
        problemId: response.problemId,
        contextKey: response.contextKey,
        outcome: "skipped-existing",
      }));
    }
  }
  const seeded = results.filter((result) => result.outcome === "seeded").length;
  return Object.freeze({
    total: results.length,
    seeded,
    skippedExisting: results.length - seeded,
    results: Object.freeze(results),
  });
}

function parseManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("FableMath manifest must be an object.");
  }
  if (manifest.schemaVersion !== 1 || manifest.kind !== "fable-math-archive") {
    throw new TypeError("Unsupported FableMath manifest.");
  }
  if (!Array.isArray(manifest.responses)) {
    throw new TypeError("FableMath manifest responses must be an array.");
  }
  const problemIds = new Set();
  const contextKeys = new Set();
  return manifest.responses.map((response, index) => {
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new TypeError(`FableMath response ${index} must be an object.`);
    }
    const problemId = requiredString(response.problemId, `responses[${index}].problemId`);
    const sourceRunId = requiredString(
      response.sourceRunId,
      `responses[${index}].sourceRunId`,
    );
    const contextArtifact = safeRelativePath(
      response.contextArtifact,
      `responses[${index}].contextArtifact`,
    );
    const contextKey = requiredString(
      response.contextKey,
      `responses[${index}].contextKey`,
    );
    const expectedKey = compactedContextKey({
      problemId,
      direction: "disprove",
    });
    if (contextKey !== expectedKey) {
      throw new TypeError(
        `FableMath response ${problemId} context key must be ${expectedKey}.`,
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
      throw new TypeError(`Duplicate FableMath context for ${problemId}.`);
    }
    problemIds.add(problemId);
    contextKeys.add(contextKey);
    return Object.freeze({
      problemId,
      sourceRunId,
      contextArtifact,
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

function safeRelativePath(value, label) {
  const parsed = requiredString(value, label);
  if (
    parsed.startsWith("/")
    || parsed.includes("\\")
    || parsed.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError(`${label} must be a safe relative path.`);
  }
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPreconditionFailure(error) {
  return error?.status === 412 || error?.code === "PreconditionFailed";
}
