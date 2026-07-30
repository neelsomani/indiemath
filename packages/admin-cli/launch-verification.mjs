const PAYMENT_RAILS = Object.freeze(["card", "ach"]);
const FUNDING_SOURCES = Object.freeze(["pool", "general"]);
const TERMINAL_OUTCOMES = Object.freeze([
  "unconditional",
  "conditional",
  "rejected",
]);

export function verifyLaunchReadiness({
  ledger,
  health,
  evidence,
  restoreVerification,
  anthropicReports,
  liveDatabasePath,
  checkedAt = new Date().toISOString(),
}) {
  if (!ledger || typeof ledger.inspect !== "function") {
    throw new TypeError("ledger must provide inspect().");
  }
  if (!health || !Array.isArray(health.checks)) {
    throw new TypeError("health must be an operational health result.");
  }
  const parsedEvidence = launchEvidence(evidence);
  if (!Array.isArray(anthropicReports)) {
    throw new TypeError("anthropicReports must be an array.");
  }
  const timestamp = canonicalTimestamp(checkedAt, "checkedAt");
  const state = ledger.inspect();
  const donationById = new Map(
    state.donations.map((donation) => [donation.dedupId, donation]),
  );
  const fundingByReference = new Map(
    state.fundingEvents.map((event) => [event.externalReference, event]),
  );
  const claimByKey = new Map(
    state.claims.map((claim) => [claimKey(claim), claim]),
  );
  const reviewByKey = new Map(
    state.reviewedResults.map((review) => [claimKey(review), review]),
  );

  const contributionIssues = [];
  const observedRails = new Set();
  for (const contribution of parsedEvidence.controlledContributions) {
    observedRails.add(contribution.paymentRail);
    const donation = donationById.get(contribution.transactionId);
    if (!donation) {
      contributionIssues.push(
        `Missing controlled ${contribution.paymentRail} transaction `
          + `${contribution.transactionId}.`,
      );
    } else if (donation.source?.kind !== "open_collective") {
      contributionIssues.push(
        `Controlled transaction ${contribution.transactionId} is not `
          + "Open Collective sourced.",
      );
    }
  }
  for (const rail of PAYMENT_RAILS) {
    if (!observedRails.has(rail)) {
      contributionIssues.push(`No controlled ${rail} contribution is recorded.`);
    }
  }

  const fundingIssues = parsedEvidence.fundingEventReferences
    .filter((reference) => !fundingByReference.has(reference))
    .map((reference) => `Missing controlled funding event ${reference}.`);
  if (parsedEvidence.fundingEventReferences.length === 0) {
    fundingIssues.push("No controlled treasury funding event is recorded.");
  }

  const runIssues = [];
  const observedFundingSources = new Set();
  const observedOutcomes = new Set();
  const controlledClaimKeys = new Set();
  for (const controlled of parsedEvidence.controlledRuns) {
    const key = claimKey(controlled);
    controlledClaimKeys.add(key);
    observedFundingSources.add(controlled.fundingSource);
    observedOutcomes.add(controlled.terminalOutcome);
    const claim = claimByKey.get(key);
    const review = reviewByKey.get(key);
    if (!claim) {
      runIssues.push(`Missing controlled claim ${key}.`);
      continue;
    }
    if (!claim.settled || !claim.solutionUri) {
      runIssues.push(`Controlled claim ${key} has no settled solution.`);
    }
    if (
      controlled.fundingSource === "pool"
      && claim.poolFundedCents !== claim.budgetCents
    ) {
      runIssues.push(`Controlled claim ${key} is not pool-only funded.`);
    }
    if (
      controlled.fundingSource === "general"
      && claim.poolFundedCents !== 0
    ) {
      runIssues.push(`Controlled claim ${key} is not general-only funded.`);
    }
    if (!review || review.outcome !== controlled.terminalOutcome) {
      runIssues.push(
        `Controlled claim ${key} is missing its `
          + `${controlled.terminalOutcome} review.`,
      );
    }
  }
  for (const source of FUNDING_SOURCES) {
    if (!observedFundingSources.has(source)) {
      runIssues.push(`No controlled ${source}-funded claim is recorded.`);
    }
  }
  for (const outcome of TERMINAL_OUTCOMES) {
    if (!observedOutcomes.has(outcome)) {
      runIssues.push(`No controlled ${outcome} review is recorded.`);
    }
  }

  const reportIssues = [];
  const reconciledClaimKeys = new Set();
  if (anthropicReports.length === 0) {
    reportIssues.push("No priced Anthropic Admin API reconciliation is recorded.");
  }
  for (const [index, report] of anthropicReports.entries()) {
    if (!report || typeof report !== "object" || Array.isArray(report)) {
      reportIssues.push(`Anthropic report ${index + 1} is malformed.`);
      continue;
    }
    if (
      report.withinTolerance !== true
      || report.alert !== false
      || !Number.isSafeInteger(report.ledgerResponseCount)
      || report.ledgerResponseCount < 1
    ) {
      reportIssues.push(
        `Anthropic report ${index + 1} does not prove an in-tolerance `
          + "priced usage reconciliation.",
      );
    }
    try {
      reconciledClaimKeys.add(claimKey(report.targetClaim));
    } catch {
      reportIssues.push(`Anthropic report ${index + 1} has no target claim.`);
    }
  }
  for (const key of controlledClaimKeys) {
    if (!reconciledClaimKeys.has(key)) {
      reportIssues.push(`Controlled claim ${key} has no Admin API reconciliation.`);
    }
  }

  const restoreIssues = [];
  if (parsedEvidence.litestreamRestore.source !== "r2") {
    restoreIssues.push("The launch restore drill is not identified as an R2 restore.");
  }
  if (
    !restoreVerification?.ok
    || restoreVerification.databasePath
      !== parsedEvidence.litestreamRestore.databasePath
    || !/^[a-f0-9]{64}$/.test(restoreVerification.sha256 ?? "")
    || restoreVerification.conservation?.balanced !== true
  ) {
    restoreIssues.push(
      "The R2-restored database is missing or did not pass ledger verification.",
    );
  }
  if (
    typeof liveDatabasePath === "string"
    && parsedEvidence.litestreamRestore.databasePath === liveDatabasePath
  ) {
    restoreIssues.push("The restore drill path is the live database path.");
  }
  if (
    Date.parse(parsedEvidence.litestreamRestore.restoredAt)
    > Date.parse(timestamp)
  ) {
    restoreIssues.push("The restore drill timestamp is in the future.");
  }

  const checks = Object.freeze([
    result("operational-health", health.ok ? [] : health.checks
      .filter((check) => !check.ok)
      .map((check) => `Operational check failed: ${check.id}.`)),
    result("controlled-contributions", contributionIssues),
    result("controlled-funding", fundingIssues),
    result("controlled-runs", runIssues),
    result("anthropic-reconciliation", reportIssues),
    result("litestream-restore", restoreIssues),
  ]);
  return Object.freeze({
    schemaVersion: 1,
    checkedAt: timestamp,
    ok: checks.every((check) => check.ok),
    checks,
  });
}

function launchEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Launch evidence must be an object.");
  }
  if (value.schemaVersion !== 1) {
    throw new TypeError("Launch evidence schemaVersion must be 1.");
  }
  const controlledContributions = array(
    value.controlledContributions,
    "controlledContributions",
  ).map((item, index) => Object.freeze({
    paymentRail: enumValue(
      item?.paymentRail,
      PAYMENT_RAILS,
      `controlledContributions[${index}].paymentRail`,
    ),
    transactionId: nonempty(
      item?.transactionId,
      `controlledContributions[${index}].transactionId`,
    ),
  }));
  const fundingEventReferences = array(
    value.fundingEventReferences,
    "fundingEventReferences",
  ).map((item, index) => nonempty(
    item,
    `fundingEventReferences[${index}]`,
  ));
  const controlledRuns = array(
    value.controlledRuns,
    "controlledRuns",
  ).map((item, index) => Object.freeze({
    problemId: nonempty(item?.problemId, `controlledRuns[${index}].problemId`),
    direction: enumValue(
      item?.direction,
      ["prove", "disprove"],
      `controlledRuns[${index}].direction`,
    ),
    claimTs: positiveInteger(item?.claimTs, `controlledRuns[${index}].claimTs`),
    fundingSource: enumValue(
      item?.fundingSource,
      FUNDING_SOURCES,
      `controlledRuns[${index}].fundingSource`,
    ),
    terminalOutcome: enumValue(
      item?.terminalOutcome,
      TERMINAL_OUTCOMES,
      `controlledRuns[${index}].terminalOutcome`,
    ),
  }));
  const anthropicReportPaths = array(
    value.anthropicReportPaths,
    "anthropicReportPaths",
  ).map((item, index) => nonempty(
    item,
    `anthropicReportPaths[${index}]`,
  ));
  const restore = value.litestreamRestore;
  if (!restore || typeof restore !== "object" || Array.isArray(restore)) {
    throw new TypeError("litestreamRestore must be an object.");
  }
  return Object.freeze({
    schemaVersion: 1,
    controlledContributions: Object.freeze(controlledContributions),
    fundingEventReferences: Object.freeze(fundingEventReferences),
    controlledRuns: Object.freeze(controlledRuns),
    anthropicReportPaths: Object.freeze(anthropicReportPaths),
    litestreamRestore: Object.freeze({
      source: nonempty(restore.source, "litestreamRestore.source"),
      databasePath: nonempty(
        restore.databasePath,
        "litestreamRestore.databasePath",
      ),
      restoredAt: canonicalTimestamp(
        restore.restoredAt,
        "litestreamRestore.restoredAt",
      ),
    }),
  });
}

function claimKey(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Claim key must be an object.");
  }
  return [
    nonempty(value.problemId, "claim.problemId"),
    enumValue(value.direction, ["prove", "disprove"], "claim.direction"),
    positiveInteger(value.claimTs, "claim.claimTs"),
  ].join("/");
}

function result(id, issues) {
  return Object.freeze({
    id,
    ok: issues.length === 0,
    issues: Object.freeze(issues),
  });
}

function array(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}

function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value.trim();
}

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${label} must be one of ${allowed.join(", ")}.`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  const text = nonempty(value, label);
  if (!Number.isFinite(Date.parse(text))) {
    throw new TypeError(`${label} must be a timestamp.`);
  }
  return new Date(Date.parse(text)).toISOString();
}
