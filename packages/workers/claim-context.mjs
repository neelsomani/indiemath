import {
  artifactKeyFromR2Uri,
  assertPort,
} from "#indiemath/shared";

export async function assembleWorkerClaimContext({
  claim,
  ledger,
  r2,
} = {}) {
  const claimKey = parseClaimKey(claim);
  assertPort(ledger, "ledger", [
    "getClaim",
    "getProblem",
    "listClaimResponses",
    "listReviewedResults",
  ]);
  assertPort(r2, "R2", ["getObject"]);

  const [storedClaim, problem, checkpoints] = await Promise.all([
    ledger.getClaim(claimKey),
    ledger.getProblem(claimKey.problemId),
    ledger.listClaimResponses(claimKey),
  ]);
  if (
    storedClaim.settled
    || problem.status !== "Open"
    || checkpoints.length > 0
  ) {
    return Object.freeze({
      problem,
      directionPrompt: problem.directions[storedClaim.direction],
      rejectionNotes: Object.freeze([]),
      reviewedResults: Object.freeze([]),
    });
  }
  if (storedClaim.catalogRevision !== problem.catalogRevision) {
    throw new WorkerContextError(
      "catalog-revision-mismatch",
      `Claim ${claimLabel(storedClaim)} was created from catalog revision `
      + `${storedClaim.catalogRevision}, but the ledger currently exposes revision `
      + `${problem.catalogRevision}. Refusing to start it with revised guidance.`,
    );
  }
  const reviewed = await ledger.listReviewedResults(claimKey.problemId);

  const rejected = reviewed.filter((result) => result.outcome === "rejected");
  const conditional = reviewed.filter((result) => result.outcome === "conditional");
  const rejectionNotes = await assembleRejectionNotes({ rejected, r2 });
  const reviewedResults = await Promise.all(conditional.map(async (result) => {
    const [solution, note] = await Promise.all([
      readArtifact(r2, result.solutionUri),
      readArtifact(r2, result.noteUri),
    ]);
    return [
      `Conditional ${result.direction} result from claim ${result.claimTs}.`,
      `Resolved under assumption: ${result.assumptionLabel}.`,
      `Reviewed: ${result.reviewedAt}.`,
      "Reviewed solution:",
      solution,
      "Review note:",
      note,
    ].join("\n\n");
  }));

  return Object.freeze({
    problem,
    directionPrompt: problem.directions[storedClaim.direction],
    rejectionNotes: Object.freeze(rejectionNotes),
    reviewedResults: Object.freeze(reviewedResults),
  });
}

export class WorkerContextError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "WorkerContextError";
    this.code = code;
  }
}

async function assembleRejectionNotes({ rejected, r2 }) {
  const byNote = new Map();
  for (const result of rejected) {
    const candidates = byNote.get(result.noteUri) ?? [];
    candidates.push(result);
    byNote.set(result.noteUri, candidates);
  }
  return Promise.all([...byNote].map(async ([noteUri, candidates]) => {
    const note = await readArtifact(r2, noteUri);
    const claims = candidates.map((candidate) => (
      `${candidate.direction}/${candidate.claimTs}`
    )).join(", ");
    return [
      `Rejected claim${candidates.length === 1 ? "" : "s"}: ${claims}.`,
      `Reviewed: ${candidates[0].reviewedAt}.`,
      note,
    ].join("\n\n");
  }));
}

async function readArtifact(r2, uri) {
  const key = artifactKeyFromR2Uri(uri);
  try {
    return await (await r2.getObject(key)).text();
  } catch (error) {
    throw new WorkerContextError(
      "review-artifact-unavailable",
      `Cannot load required reviewed-result artifact ${uri}: ${error.message}`,
      { cause: error },
    );
  }
}

function parseClaimKey(claim) {
  if (!claim || typeof claim !== "object") {
    throw new TypeError("claim is required.");
  }
  if (typeof claim.problemId !== "string" || !claim.problemId) {
    throw new TypeError("claim.problemId is required.");
  }
  if (!["prove", "disprove"].includes(claim.direction)) {
    throw new TypeError("claim.direction must be prove or disprove.");
  }
  if (!Number.isSafeInteger(claim.claimTs) || claim.claimTs < 1) {
    throw new TypeError("claim.claimTs must be a positive safe integer.");
  }
  return Object.freeze({
    problemId: claim.problemId,
    direction: claim.direction,
    claimTs: claim.claimTs,
  });
}

function claimLabel(claim) {
  return `${claim.problemId}/${claim.direction}/${claim.claimTs}`;
}
