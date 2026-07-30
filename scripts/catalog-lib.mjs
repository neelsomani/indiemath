import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  PROBLEM_ID_MAX_LENGTH,
  PROBLEM_ID_MIN_LENGTH,
  PROBLEM_ID_PATTERN,
} from "../packages/shared/identifiers.mjs";

export {
  PROBLEM_ID_MAX_LENGTH,
  PROBLEM_ID_MIN_LENGTH,
  PROBLEM_ID_PATTERN,
};
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 120;
export const SOURCE_KINDS = new Set(["repository", "url", "admin"]);

export async function readCatalog(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read catalog ${filePath}: ${error.message}`);
  }
}

export function validateCatalog(catalog) {
  const errors = [];

  if (!isPlainObject(catalog)) {
    throw new CatalogValidationError(["Catalog root must be an object."]);
  }
  if (catalog.schema_version !== 1) {
    errors.push(`schema_version must be 1; received ${JSON.stringify(catalog.schema_version)}.`);
  }
  if (!Number.isSafeInteger(catalog.catalog_revision) || catalog.catalog_revision < 1) {
    errors.push("catalog_revision must be a positive integer.");
  }

  requireStringFields(catalog.direction_contract, [
    "statement",
    "prove",
    "disprove",
  ], "direction_contract", errors);
  requireStringFields(catalog.review_policy, [
    "terminal_resolution",
    "conditional_result",
  ], "review_policy", errors);

  if (!Array.isArray(catalog.problems)) {
    errors.push("problems must be an array.");
  } else {
    const ids = new Map();
    const slugs = new Map();
    for (const [index, problem] of catalog.problems.entries()) {
      validateProblem(problem, index, errors);
      if (!isPlainObject(problem)) continue;
      recordUnique(ids, problem.id, index, "id", errors);
      recordUnique(slugs, problem.slug, index, "slug", errors);
    }
  }

  if (errors.length) throw new CatalogValidationError(errors);
  return catalog;
}

export function problemIdentityHash(problem) {
  return sha256(stableStringify({
    statement: normalizeClaim(problem.statement),
  }));
}

export function catalogContentHash(catalog) {
  return sha256(stableStringify(catalog));
}

export function assertCatalogRevisionAdvance(base, candidate) {
  validateCatalog(base);
  validateCatalog(candidate);

  if (candidate.catalog_revision < base.catalog_revision) {
    throw new Error(
      `Catalog revision moved backward from ${base.catalog_revision} `
      + `to ${candidate.catalog_revision}.`,
    );
  }

  const contentChanged = stableStringify(withoutCatalogRevision(base))
    !== stableStringify(withoutCatalogRevision(candidate));

  if (contentChanged && candidate.catalog_revision <= base.catalog_revision) {
    throw new Error(
      `Catalog content changed but revision ${candidate.catalog_revision} `
      + `is not greater than base revision ${base.catalog_revision}.`,
    );
  }

  return {
    baseRevision: base.catalog_revision,
    candidateRevision: candidate.catalog_revision,
    contentChanged,
  };
}

export function diffCatalogs(base, candidate) {
  const revision = assertCatalogRevisionAdvance(base, candidate);
  const baseProblems = new Map(base.problems.map((problem) => [problem.id, problem]));
  const candidateProblems = new Map(
    candidate.problems.map((problem) => [problem.id, problem]),
  );
  const added = candidate.problems
    .filter((problem) => !baseProblems.has(problem.id))
    .map((problem) => problem.id)
    .sort();
  const removed = base.problems
    .filter((problem) => !candidateProblems.has(problem.id))
    .map((problem) => problem.id)
    .sort();
  const changed = candidate.problems
    .filter((problem) => {
      const previous = baseProblems.get(problem.id);
      return previous && stableStringify(previous) !== stableStringify(problem);
    })
    .map((problem) => {
      const previous = baseProblems.get(problem.id);
      return Object.freeze({
        problemId: problem.id,
        identityChanged: problemIdentityHash(previous) !== problemIdentityHash(problem),
        fields: Object.freeze(problemChangedFields(previous, problem)),
      });
    })
    .sort((left, right) => left.problemId.localeCompare(right.problemId));
  const catalogFields = ["direction_contract", "review_policy"]
    .filter((field) => (
      stableStringify(base[field]) !== stableStringify(candidate[field])
    ));
  return Object.freeze({
    ...revision,
    catalogFields: Object.freeze(catalogFields),
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    changed: Object.freeze(changed),
    safeToSync: changed.every((problem) => !problem.identityChanged),
  });
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class CatalogValidationError extends Error {
  constructor(errors) {
    super(`Catalog validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    this.name = "CatalogValidationError";
    this.errors = errors;
  }
}

function validateProblem(problem, index, errors) {
  const label = `problems[${index}]`;
  if (!isPlainObject(problem)) {
    errors.push(`${label} must be an object.`);
    return;
  }

  for (const field of ["id", "slug", "domain", "title", "statement"]) {
    requireString(problem[field], `${label}.${field}`, errors);
  }

  if (typeof problem.id === "string") {
    if (
      problem.id.length < PROBLEM_ID_MIN_LENGTH
      || problem.id.length > PROBLEM_ID_MAX_LENGTH
      || !PROBLEM_ID_PATTERN.test(problem.id)
    ) {
      errors.push(
        `${label}.id must be ${PROBLEM_ID_MIN_LENGTH}–${PROBLEM_ID_MAX_LENGTH} characters `
        + `and match ${PROBLEM_ID_PATTERN}; received ${JSON.stringify(problem.id)}.`,
      );
    }
  }

  if (typeof problem.slug === "string") {
    if (problem.slug.length > SLUG_MAX_LENGTH || !SLUG_PATTERN.test(problem.slug)) {
      errors.push(
        `${label}.slug must be at most ${SLUG_MAX_LENGTH} characters and match `
        + `${SLUG_PATTERN}; received ${JSON.stringify(problem.slug)}.`,
      );
    }
  }

  if (typeof problem.statement === "string" && problem.statement.trim().endsWith("?")) {
    errors.push(`${label}.statement must be a canonical positive statement, not a question.`);
  }

  requireStringFields(problem.directions, ["prove", "disprove"], `${label}.directions`, errors);
  validateSource(problem.source, `${label}.source`, errors);

  if (Object.hasOwn(problem, "active")) {
    errors.push(`${label}.active is unsupported; remove the field.`);
  }
}

function validateSource(source, label, errors) {
  if (!isPlainObject(source)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  requireString(source.kind, `${label}.kind`, errors);
  requireString(source.reference, `${label}.reference`, errors);

  if (typeof source.kind === "string" && !SOURCE_KINDS.has(source.kind)) {
    errors.push(`${label}.kind must be one of ${[...SOURCE_KINDS].join(", ")}.`);
  }
  if (
    source.entry !== undefined
    && !(typeof source.entry === "string" && source.entry.trim())
    && !(Number.isSafeInteger(source.entry) && source.entry >= 0)
  ) {
    errors.push(`${label}.entry must be a nonempty string or a nonnegative integer when present.`);
  }

  if (source.kind === "url" && typeof source.reference === "string") {
    try {
      const url = new URL(source.reference);
      if (!["http:", "https:"].includes(url.protocol)) {
        errors.push(`${label}.reference must use http or https for a url source.`);
      }
    } catch {
      errors.push(`${label}.reference must be a valid URL for a url source.`);
    }
  }

  if (source.kind === "repository" && typeof source.reference === "string") {
    if (
      source.reference.startsWith("/")
      || source.reference.split("/").includes("..")
      || source.reference.includes("\\")
    ) {
      errors.push(`${label}.reference must be a safe repository-relative path.`);
    }
  }
}

function recordUnique(seen, value, index, field, errors) {
  if (typeof value !== "string" || !value.trim()) return;
  if (seen.has(value)) {
    errors.push(`problems[${index}].${field} duplicates problems[${seen.get(value)}].${field}: ${value}.`);
  } else {
    seen.set(value, index);
  }
}

function requireStringFields(value, fields, label, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  for (const field of fields) requireString(value[field], `${label}.${field}`, errors);
}

function requireString(value, label, errors) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${label} must be a nonempty string.`);
  }
}

function normalizeClaim(statement) {
  return statement.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function withoutCatalogRevision(catalog) {
  const { catalog_revision: _catalogRevision, ...content } = catalog;
  return content;
}

function problemChangedFields(base, candidate) {
  return [...new Set([
    ...Object.keys(base),
    ...Object.keys(candidate),
  ])].filter((field) => (
    stableStringify(base[field]) !== stableStringify(candidate[field])
  )).sort();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
