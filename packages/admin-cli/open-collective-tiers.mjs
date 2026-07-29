import {
  assertPort,
  parseDirection,
  parseProblemId,
} from "#indiemath/shared";

export const OPEN_COLLECTIVE_MINIMUM_CENTS = 5_000;

export function buildOpenCollectiveTierSpecification(problem, direction) {
  if (!problem || typeof problem !== "object") {
    throw new TypeError("problem must be a catalog problem.");
  }
  const problemId = parseProblemId(problem.id);
  const parsedDirection = parseDirection(direction);
  const title = requiredString(problem.title, "problem.title");
  const statement = requiredString(problem.statement, "problem.statement");
  const verb = parsedDirection === "prove" ? "Prove" : "Disprove";
  const identityMarker = `[IndieMath:${problemId}:${parsedDirection}]`;
  const description = [
    identityMarker,
    `${verb} the ${title} conjecture through an IndieMath AI research attempt.`,
    `Canonical statement: ${statement}`,
    "Contributions fund model usage and related compute for this direction.",
  ].join("\n\n");
  return Object.freeze({
    problemId,
    direction: parsedDirection,
    slug: `${problemId}-${parsedDirection}`,
    name: `${problemId}-${parsedDirection}: ${verb} ${title}`,
    description,
    identityMarker,
    minimumAmountCents: OPEN_COLLECTIVE_MINIMUM_CENTS,
  });
}

export async function syncOpenCollectiveTiers({
  catalog,
  ledger,
  openCollective,
}) {
  validateCatalogShape(catalog);
  assertPort(ledger, "ledger", [
    "listOpenCollectiveTiers",
    "recordOpenCollectiveTier",
  ]);
  assertPort(openCollective, "Open Collective", ["upsertTier", "upsertTiers"]);

  const mappings = new Map(ledger.listOpenCollectiveTiers().map((tier) => [
    destinationKey(tier.problemId, tier.direction),
    tier,
  ]));
  const specifications = [];
  for (const problem of catalog.problems) {
    for (const direction of ["prove", "disprove"]) {
      const spec = buildOpenCollectiveTierSpecification(problem, direction);
      const existing = mappings.get(destinationKey(problem.id, direction));
      specifications.push({
        ...spec,
        providerTierId: existing?.providerTierId,
      });
    }
  }
  const remoteTiers = await openCollective.upsertTiers(specifications);
  if (remoteTiers.length !== specifications.length) {
    throw new Error("Open Collective tier batch returned an incomplete result.");
  }
  const results = [];
  for (const [index, spec] of specifications.entries()) {
    const remote = remoteTiers[index];
    const recorded = ledger.recordOpenCollectiveTier({
      providerTierId: remote.id,
      tierSlug: remote.slug,
      problemId: spec.problemId,
      direction: spec.direction,
      catalogRevision: catalog.catalog_revision,
      name: remote.name,
      description: remote.description,
      minimumAmountCents: remote.minimumAmountCents,
      checkoutUrl: remote.checkoutUrl,
    });
    results.push(Object.freeze({
      problemId: spec.problemId,
      direction: spec.direction,
      providerOutcome: remote.outcome,
      ledgerOutcome: recorded.outcome,
      providerTierId: remote.id,
      tierSlug: remote.slug,
      checkoutUrl: remote.checkoutUrl,
    }));
  }
  return Object.freeze({
    catalogRevision: catalog.catalog_revision,
    expectedTierCount: catalog.problems.length * 2,
    created: results.filter((result) => result.providerOutcome === "created").length,
    updated: results.filter((result) => result.providerOutcome === "updated").length,
    tiers: Object.freeze(results),
  });
}

function validateCatalogShape(catalog) {
  if (
    !catalog
    || typeof catalog !== "object"
    || !Number.isSafeInteger(catalog.catalog_revision)
    || catalog.catalog_revision < 1
    || !Array.isArray(catalog.problems)
  ) {
    throw new TypeError("catalog must be a validated, revisioned problem catalog.");
  }
}

function destinationKey(problemId, direction) {
  return `${problemId}\0${direction}`;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value.trim();
}
