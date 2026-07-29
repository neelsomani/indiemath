import {
  parseNonnegativeInteger,
  parsePositiveInteger,
  parseProblemId,
} from "./identifiers.mjs";
import { parseDirection } from "./types.mjs";

/**
 * @typedef {object} ArtifactKeys
 * @property {string} rawTranscriptPrefix
 * @property {string} compactedContextKey
 * @property {string} solutionKey
 */

export function rawTranscriptKey({ problemId, direction, claimTs, sequence }) {
  return `${claimPrefix(problemId, direction, claimTs)}/raw-${
    parseNonnegativeInteger(sequence, "sequence")
  }.jsonl`;
}

export function rawTranscriptPrefix({ problemId, direction, claimTs }) {
  return `${claimPrefix(problemId, direction, claimTs)}/`;
}

export function compactedContextKey({ problemId, direction }) {
  return `transcripts/${parseProblemId(problemId)}/${parseDirection(direction)}/compacted.md`;
}

export function solutionKey({ problemId, direction, claimTs }) {
  return `solutions/${parseProblemId(problemId)}/${parseDirection(direction)}/${
    parsePositiveInteger(claimTs, "claimTs")
  }.md`;
}

export function reviewKey({ problemId, reviewTs }) {
  return `reviews/${parseProblemId(problemId)}/${
    parsePositiveInteger(reviewTs, "reviewTs")
  }.md`;
}

export function publicStateKey() {
  return "public/state.json";
}

export function publicLedgerKey() {
  return "public/ledger.json";
}

export function databaseReplicaPrefix() {
  return "db-replica/";
}

export function artifactKeysForClaim(input) {
  return Object.freeze({
    rawTranscriptPrefix: rawTranscriptPrefix(input),
    compactedContextKey: compactedContextKey(input),
    solutionKey: solutionKey(input),
  });
}

function claimPrefix(problemId, direction, claimTs) {
  return `transcripts/${parseProblemId(problemId)}/${parseDirection(direction)}/${
    parsePositiveInteger(claimTs, "claimTs")
  }`;
}
