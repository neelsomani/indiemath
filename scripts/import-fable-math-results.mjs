#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compactedContextKey,
  solutionKey,
} from "#indiemath/shared";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(rootDir, "fable-math");
const outputDir = path.join(rootDir, "seed", "fable-math");
const catalog = JSON.parse(
  await readFile(path.join(rootDir, "problems", "catalog.json"), "utf8"),
);
const latest = JSON.parse(
  await readFile(path.join(sourceDir, "results", "latest.json"), "utf8"),
);
const runState = JSON.parse(
  await readFile(
    path.join(sourceDir, "results", "runs", latest.runId, "state.json"),
    "utf8",
  ),
);

const sourcedProblems = catalog.problems
  .filter((problem) => problem.source?.reference === "fable-math/50-open-problems.md")
  .sort((left, right) => left.source.entry - right.source.entry);

if (sourcedProblems.length !== 50) {
  throw new Error(`Expected 50 fable-math catalog entries, found ${sourcedProblems.length}.`);
}

const responses = [];
for (const problem of sourcedProblems) {
  const entry = problem.source.entry;
  const source = JSON.parse(
    await readFile(
      path.join(sourceDir, "public", "results", "problems", `${entry}.json`),
      "utf8",
    ),
  );
  if (source.id !== entry || source.title !== problem.title) {
    throw new Error(
      `Fable result ${entry} does not match ${problem.id}: ${source.title}.`,
    );
  }

  const claimTs = timestamp(
    source.startedAt
      ?? source.completedAt
      ?? runState.run.startedAt
      ?? runState.run.createdAt,
    `result ${entry}`,
  );
  const response = {
    problemId: problem.id,
    direction: "disprove",
    claimTs,
    modelId: source.model ?? runState.run.model,
    sourceProblemId: source.id,
    sourceRunId: latest.runId,
    status: source.status,
    verdict: source.verdict,
    claimedResult: source.claimedResult,
    solutionFound: Boolean(source.solutionFound),
    outputTokens: source.outputTokens,
    responseAvailable: typeof source.output === "string" && source.output.length > 0,
    completedAt: source.completedAt,
  };

  if (!response.responseAvailable) continue;
  const key = solutionKey(response);
  const body = source.output;
  await mkdir(path.dirname(path.join(outputDir, key)), { recursive: true });
  await writeFile(path.join(outputDir, key), body, "utf8");
  response.solutionKey = key;
  response.responseSha256 = sha256(body);
  const contextBody = renderCarryForwardContext({
    problem,
    response,
    source,
  });
  const contextKey = compactedContextKey({
    problemId: problem.id,
    direction: "disprove",
  });
  const contextArtifact = path.posix.join(
    "contexts",
    problem.id,
    "disprove",
    "compacted.md",
  );
  await mkdir(path.dirname(path.join(outputDir, contextArtifact)), {
    recursive: true,
  });
  await writeFile(
    path.join(outputDir, contextArtifact),
    contextBody,
    "utf8",
  );
  response.contextArtifact = contextArtifact;
  response.contextKey = contextKey;
  response.contextSha256 = sha256(contextBody);
  responses.push(response);
}

const manifest = {
  schemaVersion: 1,
  kind: "fable-math-archive",
  source: {
    repository: "neelsomani/fable-math",
    runId: latest.runId,
    sourceFile: runState.run.sourceFile,
    modelId: runState.run.model,
    completedAt: runState.run.completedAt,
  },
  responses,
};

await mkdir(outputDir, { recursive: true });
await writeFile(
  path.join(outputDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(
  `Imported ${responses.length} fable-math response artifacts and carry-forward contexts.`,
);

function renderCarryForwardContext({
  problem,
  response,
  source,
}) {
  const progress = Array.isArray(source.progress) ? source.progress : [];
  const progressSections = progress.map((entry, index) => {
    const phase = nonemptyText(entry.phase) ?? `Progress update ${index + 1}`;
    const summary = nonemptyText(entry.summary) ?? "No summary recorded.";
    const evidence = nonemptyText(entry.evidence);
    const at = nonemptyText(entry.at);
    return [
      `### ${phase}`,
      ...(at ? [`Recorded: ${at}`] : []),
      "",
      summary,
      ...(evidence ? ["", "**Evidence and checks**", "", evidence] : []),
    ].join("\n");
  });
  const finalOutput = nonemptyText(source.output);
  if (!finalOutput) {
    throw new TypeError(
      `Fable result ${response.sourceProblemId} has no final output to carry forward.`,
    );
  }
  const document = [
    "# Carry-forward research context",
    "",
    "This document is unverified prior research imported from FableMath. Recheck inherited claims before relying on them.",
    "",
    "## Source",
    "",
    `- Problem: ${problem.id} — ${problem.title}`,
    "- Direction: disprove",
    `- Source run: ${response.sourceRunId}`,
    `- Model: ${response.modelId}`,
    `- Completed: ${response.completedAt}`,
    `- Recorded status: ${response.status}`,
    `- Recorded verdict: ${response.verdict}`,
    "",
    "## Research progress",
    "",
    ...(progressSections.length > 0
      ? [progressSections.join("\n\n")]
      : ["No progress summaries were recorded."]),
    "",
    "## Final response",
    "",
    finalOutput,
    "",
  ].join("\n");
  if (document.length > 190_000) {
    throw new RangeError(
      `Fable carry-forward context for ${problem.id} exceeds 190000 characters.`,
    );
  }
  return document;
}

function nonemptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label} must have a valid positive timestamp.`);
  }
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
