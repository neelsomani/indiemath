#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FakeR2 } from "#indiemath/fakes";
import { bootstrapFableMathContexts } from "#indiemath/workers";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seedDirectory = path.join(rootDir, "seed", "fable-math");
const manifest = JSON.parse(
  await readFile(path.join(seedDirectory, "manifest.json"), "utf8"),
);
const loadArtifact = (artifact) => (
  readFile(path.join(seedDirectory, artifact), "utf8")
);

test("FableMath context bootstrap is idempotent and never overwrites context", async () => {
  const r2 = new FakeR2();
  const first = await bootstrapFableMathContexts({
    r2,
    manifest,
    loadArtifact,
  });
  assert.equal(first.total, 23);
  assert.equal(first.seeded, 23);
  assert.equal(first.skippedExisting, 0);

  const response = manifest.responses[0];
  const object = await r2.getObject(response.contextKey);
  assert.equal(await object.text(), await loadArtifact(response.contextArtifact));
  assert.deepEqual(object.metadata, {
    state: "seeded",
    source: "fable-math",
    problemId: response.problemId,
    direction: "disprove",
    sourceRunId: response.sourceRunId,
    sha256: response.contextSha256,
  });

  const second = await bootstrapFableMathContexts({
    r2,
    manifest,
    loadArtifact,
  });
  assert.equal(second.seeded, 0);
  assert.equal(second.skippedExisting, 23);
  assert.equal(await (await r2.getObject(response.contextKey)).text(), await object.text());

  const existingR2 = new FakeR2();
  await existingR2.putObject(response.contextKey, "# New IndieMath context\n");
  const preexisting = await bootstrapFableMathContexts({
    r2: existingR2,
    manifest,
    loadArtifact,
  });
  assert.equal(preexisting.skippedExisting, 1);
  assert.equal(
    await (await existingR2.getObject(response.contextKey)).text(),
    "# New IndieMath context\n",
  );
});

test("FableMath context bootstrap verifies committed artifact hashes", async () => {
  const corruptManifest = structuredClone(manifest);
  corruptManifest.responses[0].contextSha256 = "0".repeat(64);
  await assert.rejects(
    bootstrapFableMathContexts({
      r2: new FakeR2(),
      manifest: corruptManifest,
      loadArtifact,
    }),
    /artifact hash mismatch/,
  );
});
