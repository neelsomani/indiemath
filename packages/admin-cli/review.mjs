import { readFile } from "node:fs/promises";
import {
  artifactKeyFromR2Uri,
  assertPort,
  r2ArtifactUri,
  reviewKey,
} from "#indiemath/shared";

export async function applyReviewVerdict({
  ledger,
  r2,
  problemId,
  verdict,
  noteFile,
  noteUri,
  reviewTs,
  assumptionLabel,
  approveDirection,
  rejectAll = false,
}) {
  assertPort(ledger, "ledger", ["review"]);
  if (Boolean(noteFile) === Boolean(noteUri)) {
    throw new TypeError("Provide exactly one of noteFile or noteUri.");
  }

  let resolvedNoteUri = noteUri;
  if (noteFile) {
    assertPort(r2, "R2", ["getObject", "putObject"]);
    if (!Number.isSafeInteger(reviewTs) || reviewTs < 1) {
      throw new TypeError("reviewTs is required with noteFile.");
    }
    const noteBody = await readFile(noteFile, "utf8");
    if (!noteBody.trim()) throw new TypeError("Review note file cannot be empty.");
    const key = reviewKey({ problemId, reviewTs });
    await putReviewNoteOnce({
      r2,
      key,
      body: noteBody,
      problemId,
      verdict,
      reviewTs,
    });
    resolvedNoteUri = r2ArtifactUri(key);
  } else {
    assertPort(r2, "R2", ["headObject"]);
    await r2.headObject(artifactKeyFromR2Uri(noteUri));
  }

  const review = ledger.review({
    problemId,
    verdict,
    noteUri: resolvedNoteUri,
    ...(assumptionLabel ? { assumptionLabel } : {}),
    ...(approveDirection ? { approveDirection } : {}),
    ...(rejectAll ? { rejectAll: true } : {}),
  });
  return Object.freeze({
    noteUri: resolvedNoteUri,
    review,
  });
}

async function putReviewNoteOnce({
  r2,
  key,
  body,
  problemId,
  verdict,
  reviewTs,
}) {
  try {
    await r2.putObject(key, body, {
      contentType: "text/markdown; charset=utf-8",
      ifNoneMatch: true,
      metadata: {
        problemId,
        verdict,
        reviewTs: String(reviewTs),
      },
    });
    return;
  } catch (error) {
    if (error?.code !== "PreconditionFailed") throw error;
  }
  const existing = await r2.getObject(key);
  if (await existing.text() !== body) {
    throw new Error(`Review note ${key} already exists with different content.`);
  }
}
