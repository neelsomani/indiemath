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

export function humanTranscriptKey({ problemId, direction, claimTs, sequence }) {
  return `${claimPrefix(problemId, direction, claimTs)}/response-${
    parsePositiveInteger(sequence, "sequence")
  }.md`;
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

export function publicPublicationStateKey(publicationId) {
  return `public/publications/${parsePublicationId(publicationId)}/state.json`;
}

export function publicPublicationLedgerKey(publicationId) {
  return `public/publications/${parsePublicationId(publicationId)}/ledger.json`;
}

export function databaseReplicaPrefix() {
  return "db-replica/";
}

export function r2ArtifactUri(key) {
  return `r2://${parseObjectKey(key, "key")}`;
}

export function artifactKeyFromR2Uri(uri) {
  if (
    typeof uri !== "string"
    || !uri.startsWith("r2://")
    || uri.includes("?")
    || uri.includes("#")
  ) {
    throw new TypeError("Artifact URI must be an r2:// object URI.");
  }
  return parseObjectKey(uri.slice("r2://".length), "uri");
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

function parseObjectKey(value, label) {
  if (
    typeof value !== "string"
    || !value
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("\\")
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError(`${label} must be a safe nonempty R2 object key.`);
  }
  return value;
}

function parsePublicationId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError("publicationId must be a lowercase SHA-256 digest.");
  }
  return value;
}
