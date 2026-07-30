#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { FakeR2 } from "#indiemath/fakes";
import {
  parsePriorResearchManifest,
  PRIOR_RESEARCH_MANIFEST_KEY,
  verifyPriorResearchContexts,
} from "#indiemath/workers";

const contextBody = [
  "# Carry-forward research context",
  "",
  "Preserved prior work.",
  "",
].join("\n");
const contextSha256 = createHash("sha256")
  .update(contextBody)
  .digest("hex");
const manifest = Object.freeze({
  schemaVersion: 1,
  kind: "prior-research-archive",
  responses: Object.freeze([
    Object.freeze({
      problemId: "math-001",
      direction: "disprove",
      claimTs: 1_700_000_000_000,
      outputTokens: 12_345,
      contextKey: "transcripts/math-001/disprove/compacted.md",
      contextSha256,
    }),
  ]),
});

test("prior research is verified from R2 without a repository seed", async () => {
  const r2 = new FakeR2();
  await r2.putObject(
    manifest.responses[0].contextKey,
    contextBody,
  );
  const result = await verifyPriorResearchContexts({ r2, manifest });
  assert.equal(result.total, 1);
  assert.deepEqual(result.results[0], {
    problemId: "math-001",
    contextKey: "transcripts/math-001/disprove/compacted.md",
    sha256: contextSha256,
  });
  assert.equal(
    PRIOR_RESEARCH_MANIFEST_KEY,
    "public/prior-research/manifest.json",
  );
});

test("prior research verification rejects corrupted or malformed R2 state", async () => {
  const r2 = new FakeR2();
  await r2.putObject(
    manifest.responses[0].contextKey,
    "# Different context\n",
  );
  await assert.rejects(
    verifyPriorResearchContexts({ r2, manifest }),
    /context hash mismatch/,
  );

  assert.throws(
    () => parsePriorResearchManifest({
      ...manifest,
      responses: [{
        ...manifest.responses[0],
        contextKey: "../private/output.md",
      }],
    }),
    /context key must be/,
  );
});
