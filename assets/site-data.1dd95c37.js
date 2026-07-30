const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const wholeMoneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const compactMoneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

export function formatMoney(cents, { compact = false } = {}) {
  const normalizedCents = finiteCents(cents);
  const amount = normalizedCents / 100;
  if (compact) return compactMoneyFormatter.format(amount);
  return (
    normalizedCents % 100 === 0 ? wholeMoneyFormatter : moneyFormatter
  ).format(amount);
}

export function processedPoolBalanceCents(problems) {
  if (!Array.isArray(problems)) {
    throw new TypeError("problems must be an array.");
  }
  return problems.reduce((problemTotal, problem, problemIndex) => (
    problemTotal + (problem.pools ?? []).reduce((poolTotal, pool, poolIndex) => {
      const balanceCents = finiteCents(pool.balanceCents);
      const unprocessedCents = finiteCents(pool.unprocessedCents);
      if (unprocessedCents > balanceCents) {
        throw new TypeError(
          `problems[${problemIndex}].pools[${poolIndex}] has more `
            + "unprocessed money than its balance.",
        );
      }
      return poolTotal + balanceCents - unprocessedCents;
    }, 0)
  ), 0);
}

export function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : "Unknown date";
}

export function formatDateTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? dateTimeFormatter.format(date)
    : "Unknown time";
}

export function formatDomain(value) {
  return String(value ?? "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.length <= 3
      ? part.toUpperCase()
      : `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function directionLabel(direction) {
  return direction === "prove"
    ? "Proof"
    : direction === "disprove"
      ? "Disproof"
      : "General";
}

export function statusPresentation(status) {
  switch (status) {
    case "PendingReview":
      return Object.freeze({
        label: "Claimed solved · under review",
        className: "status-review",
      });
    case "Solved":
      return Object.freeze({
        label: "Verified",
        className: "status-solved",
      });
    default:
      return Object.freeze({
        label: "Open",
        className: "status-open",
      });
  }
}

export function assertPriorResearchArchive(archive, problems) {
  if (
    !archive
    || archive.schemaVersion !== 1
    || archive.kind !== "prior-research-archive"
    || !Array.isArray(archive.responses)
  ) {
    throw new TypeError("Invalid prior research archive manifest.");
  }
  const expected = new Set(
    (problems ?? [])
      .map((problem) => problem.problemId),
  );
  const seen = new Set();
  if (archive.responses.length === 0) {
    throw new TypeError("Prior research archive contains no response artifacts.");
  }
  for (const response of archive.responses) {
    if (
      !expected.has(response.problemId)
      || seen.has(response.problemId)
      || !["prove", "disprove"].includes(response.direction)
      || !Number.isSafeInteger(response.claimTs)
      || response.claimTs <= 0
    ) {
      throw new TypeError("Prior research archive response identity is invalid.");
    }
    const expectedContextKey =
      `transcripts/${response.problemId}/${response.direction}/compacted.md`;
    if (
      response.contextKey !== expectedContextKey
      || !/^[a-f0-9]{64}$/.test(response.contextSha256)
    ) {
      throw new TypeError("Prior research archive carry-forward context is invalid.");
    }
    if (!Number.isSafeInteger(response.outputTokens) || response.outputTokens < 0) {
      throw new TypeError("Prior research archive output token count is invalid.");
    }
    seen.add(response.problemId);
  }
  return true;
}

export function priorResearchForCurrentCatalog(archive, problems) {
  if (
    !archive
    || archive.schemaVersion !== 1
    || archive.kind !== "prior-research-archive"
    || !Array.isArray(archive.responses)
  ) {
    throw new TypeError("Invalid prior research archive manifest.");
  }
  const currentProblemIds = new Set(
    (problems ?? []).map((problem) => problem.problemId),
  );
  const current = Object.freeze({
    ...archive,
    responses: Object.freeze(archive.responses.filter((response) => (
      currentProblemIds.has(response?.problemId)
    ))),
  });
  if (current.responses.length) {
    assertPriorResearchArchive(current, problems);
  }
  return current;
}

export function processingPresentation(status) {
  switch (status) {
    case "processed":
      return Object.freeze({
        label: "Processed · final",
        className: "badge-processed",
      });
    case "refunded":
      return Object.freeze({
        label: "Refunded",
        className: "badge-refunded",
      });
    case "reversed":
      return Object.freeze({
        label: "Reversed",
        className: "badge-reversed",
      });
    default:
      return Object.freeze({
        label: "Unprocessed",
        className: "badge-received",
      });
  }
}

export function filterAndSortProblems(problems, {
  query = "",
  domain = "all",
  status = "all",
  sort = "publisher",
  generatedOutputTokens = new Map(),
} = {}) {
  const normalizedQuery = normalizeSearch(query);
  return problems
    .map((problem, publisherIndex) => ({ problem, publisherIndex }))
    .filter(({ problem }) => (
      (domain === "all" || problem.domain === domain)
      && (status === "all" || problem.status === status)
      && (!normalizedQuery || problemSearchText(problem).includes(normalizedQuery))
    ))
    .sort((left, right) => {
      const fundingOrder = (
        finiteCents(right.problem.totalPoolBalanceCents)
        - finiteCents(left.problem.totalPoolBalanceCents)
      );
      const generatedContentOrder = (
        nonnegativeCount(generatedOutputTokens.get(right.problem.problemId))
        - nonnegativeCount(generatedOutputTokens.get(left.problem.problemId))
      );
      if (sort === "funding") {
        return (
          fundingOrder
          || generatedContentOrder
          || left.problem.title.localeCompare(right.problem.title)
        );
      }
      if (sort === "title") {
        return left.problem.title.localeCompare(right.problem.title);
      }
      const liveRunOrder = (
        Number((right.problem.liveClaims?.length ?? 0) > 0)
        - Number((left.problem.liveClaims?.length ?? 0) > 0)
      );
      return (
        liveRunOrder
        || fundingOrder
        || generatedContentOrder
        || left.publisherIndex - right.publisherIndex
      );
    })
    .map(({ problem }) => problem);
}

export function generatedOutputTokensByProblem({
  runs = [],
  archivedResponses = [],
} = {}) {
  const totals = new Map();
  const add = (problemId, outputTokens) => {
    const count = nonnegativeCount(outputTokens);
    totals.set(problemId, (totals.get(problemId) ?? 0) + count);
  };
  for (const run of runs) {
    for (const segment of run.transcriptSegments ?? []) {
      add(
        run.problemId,
        segment.usage?.output_tokens ?? segment.usage?.outputTokens,
      );
    }
  }
  for (const response of archivedResponses) {
    add(response.problemId, response.outputTokens);
  }
  return totals;
}

export function researchRunCount({
  runs = [],
  archivedResponses = [],
} = {}) {
  return runs.length + archivedResponses.length;
}

export function initialResearchDirection(outputSources = []) {
  const available = new Set(outputSources.map((source) => source.direction));
  return !available.has("prove") && available.has("disprove")
    ? "disprove"
    : "prove";
}

export async function pollKeepingLastGood(lastGood, load, apply) {
  if (typeof load !== "function" || typeof apply !== "function") {
    throw new TypeError("Polling requires load and apply functions.");
  }
  try {
    const next = await load();
    apply(next);
    return Object.freeze({
      value: next,
      updated: true,
    });
  } catch (error) {
    return Object.freeze({
      value: lastGood,
      updated: false,
      error,
    });
  }
}

export async function loadWithRetry(load, {
  attempts = 3,
  wait = (attempt) => new Promise((resolve) => {
    setTimeout(resolve, attempt * 250);
  }),
} = {}) {
  if (typeof load !== "function" || typeof wait !== "function") {
    throw new TypeError("Retry loading requires load and wait functions.");
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new TypeError("Retry attempts must be a positive safe integer.");
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(attempt);
    }
  }
  throw lastError;
}

export function displayDestination(donation) {
  return donation?.intendedDestination?.kind === "pool"
    ? donation.intendedDestination
    : donation?.destination;
}

export function destinationLabel(donation, problemTitles = new Map()) {
  const destination = displayDestination(donation);
  if (destination?.kind !== "pool") return "General research";
  const problem = problemTitles.get(destination.problemId) ?? destination.problemId;
  return `${problem} · ${directionLabel(destination.direction)}`;
}

export function donorAcknowledgement(problem, ledger) {
  const approved = [...(problem.reviewedResults ?? [])]
    .reverse()
    .find((review) => review.outcome === "unconditional");
  if (!approved) return undefined;
  const claimTime = Number(approved.claimTs);
  const candidates = (ledger.donations ?? [])
    .filter((donation) => {
      const destination = displayDestination(donation);
      return (
        destination?.kind === "pool"
        && destination.problemId === problem.problemId
        && destination.direction === approved.direction
        && Date.parse(donation.creditedAt) < claimTime
        && !["refunded", "reversed"].includes(donation.processingStatus)
      );
    })
    .sort((left, right) => (
      Date.parse(right.creditedAt) - Date.parse(left.creditedAt)
      || String(right.dedupId).localeCompare(String(left.dedupId))
    ));
  if (candidates.length === 0) return undefined;
  return Object.freeze({
    donorTag: candidates[0].donorTag,
    donationId: candidates[0].dedupId,
  });
}

export function searchableDonation(donation, problemTitles = new Map()) {
  return normalizeSearch([
    donation.donorTag,
    donation.dedupId,
    donation.orderId,
    destinationLabel(donation, problemTitles),
    donation.processingStatus,
  ].filter(Boolean).join(" "));
}

export function searchableRun(run, problemTitles = new Map()) {
  return normalizeSearch([
    run.problemId,
    problemTitles.get(run.problemId),
    run.direction,
    run.claimTs,
    run.workerId,
    run.status,
  ].filter(Boolean).join(" "));
}

export function searchableReview(review, problemTitles = new Map()) {
  return normalizeSearch([
    review.problemId,
    problemTitles.get(review.problemId),
    review.direction,
    review.claimTs,
    review.outcome,
    review.assumptionLabel,
  ].filter(Boolean).join(" "));
}

export function visibleContributions(contributions) {
  if (!Array.isArray(contributions)) return [];
  return contributions.filter(
    (contribution) => contribution?.processingStatus !== "refunded",
  );
}

export function netContributionCents(accounting, treasury) {
  return Math.max(
    0,
    finiteCents(accounting?.donationNetCents)
      - finiteCents(treasury?.completedRefundCents),
  );
}

export function netPoolContributionCents(
  donations,
  { problemId, direction },
) {
  return netMatchingContributionCents(donations, (destination) => (
    destination?.kind === "pool"
    && destination.problemId === problemId
    && destination.direction === direction
  ));
}

export function netProblemContributionCents(donations, problemId) {
  return netMatchingContributionCents(donations, (destination) => (
    destination?.kind === "pool"
    && destination.problemId === problemId
  ));
}

function netMatchingContributionCents(donations, matchesDestination) {
  if (!Array.isArray(donations)) return 0;
  return donations.reduce((total, donation) => {
    const destination = donation?.destination;
    if (!matchesDestination(destination)) {
      return total;
    }
    const remaining = Math.max(
      0,
      finiteCents(donation.netCents)
        - finiteCents(donation.refundedCents)
        - finiteCents(donation.waterlineExcludedCents),
    );
    const next = total + remaining;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError("Contribution total exceeds safe cents.");
    }
    return next;
  }, 0);
}

export function publicObjectUrl(baseUrl, objectKey) {
  const parsedBase = new URL(baseUrl);
  if (parsedBase.protocol !== "https:" && parsedBase.hostname !== "localhost") {
    throw new TypeError("Public data must use HTTPS.");
  }
  const key = String(objectKey ?? "");
  if (
    !key
    || key.startsWith("/")
    || key.includes("\\")
    || key.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError("Invalid public object key.");
  }
  parsedBase.pathname = `${parsedBase.pathname.replace(/\/+$/, "")}/${key}`;
  parsedBase.search = "";
  parsedBase.hash = "";
  return parsedBase.toString();
}

export function normalizeSearch(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en-US")
    .trim();
}

export function assertPublicDocumentPair(state, ledger) {
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.problems)) {
    throw new TypeError("The public state document is invalid.");
  }
  if (!ledger || ledger.schemaVersion !== 1 || !Array.isArray(ledger.donations)) {
    throw new TypeError("The public ledger document is invalid.");
  }
  if (state.publicationId !== ledger.publicationId) {
    throw new Error("The public state and ledger are from different generations.");
  }
  if (state.catalogRevision !== ledger.catalogRevision) {
    throw new Error("The public state and ledger catalog revisions disagree.");
  }
  return true;
}

function problemSearchText(problem) {
  return normalizeSearch([
    problem.problemId,
    problem.slug,
    problem.title,
    problem.statement,
    problem.domain,
    problem.directions?.prove,
    problem.directions?.disprove,
  ].filter(Boolean).join(" "));
}

function finiteCents(value) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

function nonnegativeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}
