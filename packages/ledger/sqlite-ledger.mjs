import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  addCents,
  asCents,
  calculateAvailableToFundCents,
  calculateRefundableCents,
  calculateSettledButUnfundedCents,
  deriveDonationRefundState,
  deriveDonationWaterline,
  parseDirection,
  parseDonation,
  parseProblemId,
  parseWorkerId,
} from "#indiemath/shared";
import {
  configureLedgerConnection,
  initializeLedgerSchema,
  isLedgerSchemaCurrent,
  LEDGER_SCHEMA_VERSION,
} from "./schema.mjs";

const MAX_RUN_BUDGET_CENTS = 50_000;
const RESIDUE_FLOOR_CENTS = 5_000;
const LEASE_MILLISECONDS = 65 * 60 * 1000;
const FUNDING_MODES = new Set(["pool-first", "pool-only", "general-only"]);

export class LedgerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "LedgerError";
    this.code = code;
  }
}

export async function openLedger({
  databasePath,
  clock = () => new Date(),
} = {}) {
  if (typeof databasePath !== "string" || !databasePath.trim()) {
    throw new TypeError("databasePath must be a nonempty string.");
  }
  await mkdir(path.dirname(path.resolve(databasePath)), { recursive: true });
  const database = new DatabaseSync(path.resolve(databasePath));
  configureLedgerConnection(database);
  if (!isLedgerSchemaCurrent(database)) {
    initializeLedgerSchema(database);
  }
  return new SQLiteLedger({ database, databasePath: path.resolve(databasePath), clock });
}

export class SQLiteLedger {
  #database;
  #databasePath;
  #clock;
  #closed = false;

  constructor({ database, databasePath, clock = () => new Date() }) {
    if (!(database instanceof DatabaseSync)) {
      throw new TypeError("database must be a node:sqlite DatabaseSync.");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function.");
    this.#database = database;
    this.#databasePath = databasePath;
    this.#clock = clock;
    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
  }

  close() {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  async healthcheck() {
    this.#assertOpen();
    const schema = this.#database.prepare(
      "SELECT schema_version FROM ledger_schema WHERE singleton = 1",
    ).get();
    const catalog = this.#database.prepare(
      "SELECT catalog_revision FROM catalog_sync WHERE singleton = 1",
    ).get();
    return {
      ok: true,
      service: "ledger",
      schemaVersion: Number(schema?.schema_version ?? LEDGER_SCHEMA_VERSION),
      catalogRevision: catalog ? Number(catalog.catalog_revision) : undefined,
      databasePath: this.#databasePath,
    };
  }

  donate(input) {
    const proposed = parseDonation({
      ...input,
      refundedCents: 0,
      state: "credited",
    });
    return this.#transaction(() => {
      const existing = this.#database.prepare(
        "SELECT * FROM donations WHERE dedup_id = ?",
      ).get(proposed.dedupId);
      if (existing) {
        this.#assertDonationReplay(existing, proposed);
        return { outcome: "duplicate", donation: this.#mapDonation(existing) };
      }

      let destination = proposed.destination;
      if (destination.kind === "pool") {
        const problem = this.#requireProblem(destination.problemId);
        this.#requirePool(destination.problemId, destination.direction);
        if (problem.status === "Solved") destination = { kind: "general" };
      }

      this.#database.prepare(`
        INSERT INTO donations (
          dedup_id,
          order_id,
          destination_kind,
          problem_id,
          direction,
          intended_problem_id,
          intended_direction,
          gross_cents,
          fees_cents,
          net_cents,
          donor_tag,
          credited_at,
          payment_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'credited')
      `).run(
        proposed.dedupId,
        proposed.orderId,
        destination.kind,
        destination.kind === "pool" ? destination.problemId : null,
        destination.kind === "pool" ? destination.direction : null,
        proposed.destination.kind === "pool"
          ? proposed.destination.problemId
          : null,
        proposed.destination.kind === "pool"
          ? proposed.destination.direction
          : null,
        proposed.grossCents,
        proposed.feesCents,
        proposed.netCents,
        proposed.donorTag,
        proposed.creditedAt,
      );

      if (destination.kind === "pool") {
        const pool = this.#requirePool(destination.problemId, destination.direction);
        this.#setPoolBalances({
          problemId: destination.problemId,
          direction: destination.direction,
          balanceCents: addCents(Number(pool.balance_cents), proposed.netCents),
          cumulativeDonationsCents: addCents(
            Number(pool.cumulative_donations_cents),
            proposed.netCents,
          ),
        });
      } else {
        this.#setGeneralBalance(addCents(this.#generalBalance(), proposed.netCents));
      }

      const stored = this.#database.prepare(
        "SELECT * FROM donations WHERE dedup_id = ?",
      ).get(proposed.dedupId);
      return { outcome: "credited", donation: this.#mapDonation(stored) };
    });
  }

  claim({
    problemId,
    direction,
    runBudgetCents,
    workerId,
    fundingMode = "pool-only",
  }) {
    const parsedProblemId = parseProblemId(problemId);
    const parsedDirection = parseDirection(direction);
    const parsedWorkerId = parseWorkerId(workerId);
    const budget = positiveCents(runBudgetCents, "runBudgetCents");
    if (budget > MAX_RUN_BUDGET_CENTS) {
      throw new LedgerError(
        "run-budget-cap",
        `runBudgetCents cannot exceed ${MAX_RUN_BUDGET_CENTS}.`,
      );
    }
    if (!FUNDING_MODES.has(fundingMode)) {
      throw new TypeError(
        `fundingMode must be one of ${[...FUNDING_MODES].join(", ")}.`,
      );
    }

    return this.#transaction(() => {
      const problem = this.#requireProblem(parsedProblemId);
      if (problem.status !== "Open") {
        throw new LedgerError(
          "problem-not-open",
          `Problem ${parsedProblemId} is ${problem.status}, not Open.`,
        );
      }
      this.#requirePool(parsedProblemId, parsedDirection);

      const existingPairClaim = this.#database.prepare(`
        SELECT claim_ts, lease_expires_at
        FROM claims
        WHERE problem_id = ? AND direction = ? AND settled = 0
      `).get(parsedProblemId, parsedDirection);
      if (existingPairClaim) {
        throw new LedgerError(
          "pair-already-claimed",
          `${parsedProblemId}/${parsedDirection} already has an unsettled claim `
          + `${existingPairClaim.claim_ts}.`,
        );
      }
      const existingWorkerClaim = this.#database.prepare(`
        SELECT problem_id, direction, claim_ts
        FROM claims WHERE worker_id = ? AND settled = 0
      `).get(parsedWorkerId);
      if (existingWorkerClaim) {
        throw new LedgerError(
          "worker-already-claimed",
          `${parsedWorkerId} already owns unsettled claim `
          + `${existingWorkerClaim.problem_id}/${existingWorkerClaim.direction}/`
          + `${existingWorkerClaim.claim_ts}.`,
        );
      }

      const capacity = this.#spendableCapacity();
      if (capacity < budget) {
        throw new LedgerError(
          "insufficient-capacity",
          `Spendable capacity ${capacity} is below requested budget ${budget}.`,
        );
      }

      const poolClaimable = this.#claimablePoolBalance(
        parsedProblemId,
        parsedDirection,
      );
      const generalClaimable = this.#claimableGeneralBalance();
      const poolFunded = fundingMode === "general-only"
        ? 0
        : Math.min(poolClaimable, budget);
      const generalFunded = budget - poolFunded;

      if (fundingMode === "pool-only" && poolFunded < budget) {
        throw new LedgerError(
          "insufficient-pool-balance",
          `Claimable pool balance ${poolClaimable} is below requested budget ${budget}.`,
        );
      }
      if (generalFunded > generalClaimable) {
        throw new LedgerError(
          "insufficient-claimable-balance",
          `Claimable balances cannot fund requested budget ${budget}.`,
        );
      }

      if (poolFunded > 0) {
        const pool = this.#requirePool(parsedProblemId, parsedDirection);
        this.#setPoolBalances({
          problemId: parsedProblemId,
          direction: parsedDirection,
          balanceCents: addCents(Number(pool.balance_cents), -poolFunded),
          cumulativeDonationsCents: Number(pool.cumulative_donations_cents),
        });
      }
      if (generalFunded > 0) {
        this.#setGeneralBalance(addCents(this.#generalBalance(), -generalFunded));
      }

      const now = this.#now();
      const claimTs = this.#nextClaimTimestamp(now.epochMilliseconds);
      const leaseExpiresAt = new Date(
        now.epochMilliseconds + LEASE_MILLISECONDS,
      ).toISOString();
      this.#database.prepare(`
        INSERT INTO claims (
          problem_id,
          direction,
          claim_ts,
          catalog_revision,
          worker_id,
          budget_cents,
          pool_funded_cents,
          spent_cents,
          lease_expires_at,
          settled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0)
      `).run(
        parsedProblemId,
        parsedDirection,
        claimTs,
        Number(problem.catalog_revision),
        parsedWorkerId,
        budget,
        poolFunded,
        leaseExpiresAt,
      );

      return this.#mapClaim(this.#requireClaim({
        problemId: parsedProblemId,
        direction: parsedDirection,
        claimTs,
      }));
    });
  }

  checkpointSpend({ problemId, direction, claimTs, newSpentCents }) {
    const key = parseClaimKey({ problemId, direction, claimTs });
    const proposed = asCents(newSpentCents, "newSpentCents");
    return this.#transaction(() => {
      const claim = this.#requireClaim(key);
      if (Number(claim.settled) === 1) {
        throw new LedgerError("claim-settled", "Cannot checkpoint a settled claim.");
      }
      const current = Number(claim.spent_cents);
      if (proposed < current) {
        throw new LedgerError(
          "spend-not-monotonic",
          `Spend cannot move backward from ${current} to ${proposed}.`,
        );
      }
      const clamped = Math.min(proposed, Number(claim.budget_cents));
      if (clamped !== current) {
        this.#database.prepare(`
          UPDATE claims SET spent_cents = ?
          WHERE problem_id = ? AND direction = ? AND claim_ts = ?
        `).run(clamped, key.problemId, key.direction, key.claimTs);
      }
      return this.#mapClaim(this.#requireClaim(key));
    });
  }

  checkpointResponse({
    problemId,
    direction,
    claimTs,
    request,
    response,
    requestId,
    requestStartedAt,
    costCents,
  }) {
    const key = parseClaimKey({ problemId, direction, claimTs });
    const parsedResponse = parseCheckpointResponse(response);
    const parsedRequest = parseCheckpointRequest(request);
    const parsedRequestId = optionalNonemptyString(requestId, "requestId");
    const parsedRequestStartedAt = requiredTimestamp(
      requestStartedAt,
      "requestStartedAt",
    );
    const pricedCost = asCents(costCents, "costCents");
    const responseJson = canonicalJson(parsedResponse);
    const requestJson = canonicalJson(parsedRequest);
    const usageJson = canonicalJson(parsedResponse.usage);
    const stopDetailsJson = parsedResponse.stop_details === undefined
      || parsedResponse.stop_details === null
      ? null
      : canonicalJson(parsedResponse.stop_details);
    const containerId = containerIdFromResponse(parsedResponse);

    return this.#transaction(() => {
      const existing = this.#database.prepare(`
        SELECT * FROM claim_responses WHERE message_id = ?
      `).get(parsedResponse.id);
      if (existing) {
        if (
          existing.problem_id !== key.problemId
          || existing.direction !== key.direction
          || Number(existing.claim_ts) !== key.claimTs
          || existing.request_id !== (parsedRequestId ?? null)
          || existing.request_started_at !== parsedRequestStartedAt
          || existing.response_json !== responseJson
          || existing.request_json !== requestJson
          || Number(existing.priced_cost_cents) !== pricedCost
        ) {
          throw new LedgerError(
            "idempotency-conflict",
            `Anthropic message ${parsedResponse.id} was already checkpointed with different values.`,
          );
        }
        return Object.freeze({
          outcome: "duplicate",
          claim: this.#mapClaim(this.#requireClaim(key)),
          response: mapClaimResponse(existing),
        });
      }

      const claim = this.#requireClaim(key);
      if (Number(claim.settled) === 1) {
        throw new LedgerError(
          "claim-settled",
          "Cannot checkpoint a response against a settled claim.",
        );
      }
      const current = Number(claim.spent_cents);
      const remaining = Number(claim.budget_cents) - current;
      const appliedCost = Math.min(pricedCost, remaining);
      const overage = pricedCost - appliedCost;
      const sequence = Number(this.#database.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM claim_responses
        WHERE problem_id = ? AND direction = ? AND claim_ts = ?
      `).get(key.problemId, key.direction, key.claimTs).sequence);
      const now = this.#now().iso;

      this.#database.prepare(`
        INSERT INTO claim_responses (
          problem_id,
          direction,
          claim_ts,
          sequence,
          message_id,
          request_id,
          model_id,
          stop_reason,
          stop_details_json,
          container_id,
          usage_json,
          request_json,
          response_json,
          priced_cost_cents,
          applied_cost_cents,
          overage_cents,
          request_started_at,
          completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        key.problemId,
        key.direction,
        key.claimTs,
        sequence,
        parsedResponse.id,
        parsedRequestId ?? null,
        parsedResponse.model,
        parsedResponse.stop_reason ?? null,
        stopDetailsJson,
        containerId ?? null,
        usageJson,
        requestJson,
        responseJson,
        pricedCost,
        appliedCost,
        overage,
        parsedRequestStartedAt,
        now,
      );
      if (appliedCost > 0) {
        this.#database.prepare(`
          UPDATE claims SET spent_cents = spent_cents + ?
          WHERE problem_id = ? AND direction = ? AND claim_ts = ?
        `).run(appliedCost, key.problemId, key.direction, key.claimTs);
      }
      const stored = this.#database.prepare(`
        SELECT * FROM claim_responses WHERE message_id = ?
      `).get(parsedResponse.id);
      return Object.freeze({
        outcome: "checkpointed",
        claim: this.#mapClaim(this.#requireClaim(key)),
        response: mapClaimResponse(stored),
      });
    });
  }

  settle({
    problemId,
    direction,
    claimTs,
    finalSpentCents,
    solutionUri,
  }) {
    const key = parseClaimKey({ problemId, direction, claimTs });
    const finalSpent = asCents(finalSpentCents, "finalSpentCents");
    const parsedSolutionUri = optionalNonemptyString(solutionUri, "solutionUri");
    return this.#transaction(() => this.#settleInsideTransaction({
      ...key,
      finalSpentCents: finalSpent,
      solutionUri: parsedSolutionUri,
    }));
  }

  resolve({
    problemId,
    direction,
    claimTs,
    workerId,
    finalSpentCents,
    solutionUri,
  }) {
    const key = parseClaimKey({ problemId, direction, claimTs });
    const parsedWorkerId = parseWorkerId(workerId);
    const finalSpent = asCents(finalSpentCents, "finalSpentCents");
    const parsedSolutionUri = requiredString(solutionUri, "solutionUri");

    return this.#transaction(() => {
      const claim = this.#requireClaim(key);
      if (claim.worker_id !== parsedWorkerId) {
        throw new LedgerError(
          "wrong-worker",
          `Claim belongs to ${claim.worker_id}, not ${parsedWorkerId}.`,
        );
      }
      if (Number(claim.settled) === 1) {
        if (claim.solution_uri === parsedSolutionUri) {
          return { outcome: "replayed", claim: this.#mapClaim(claim) };
        }
        throw new LedgerError("claim-settled", "Cannot resolve a settled claim.");
      }
      const now = this.#now();
      if (Date.parse(claim.lease_expires_at) <= now.epochMilliseconds) {
        throw new LedgerError("lease-expired", "Cannot resolve an expired claim.");
      }
      const problem = this.#requireProblem(key.problemId);
      if (problem.status !== "Open") {
        throw new LedgerError(
          "resolve-race-lost",
          `Problem ${key.problemId} is ${problem.status}; settle with the solution instead.`,
        );
      }
      const settled = this.#settleInsideTransaction({
        ...key,
        finalSpentCents: finalSpent,
        solutionUri: parsedSolutionUri,
      });
      return { outcome: "pending-review", claim: settled.claim };
    });
  }

  review({
    problemId,
    verdict,
    noteUri,
    assumptionLabel,
    approveDirection,
    rejectAll = false,
  }) {
    const parsedProblemId = parseProblemId(problemId);
    if (!["unconditional", "conditional", "rejected"].includes(verdict)) {
      throw new TypeError("verdict must be unconditional, conditional, or rejected.");
    }
    const parsedNoteUri = requiredString(noteUri, "noteUri");
    const parsedAssumption = optionalNonemptyString(
      assumptionLabel,
      "assumptionLabel",
    );
    const parsedApproveDirection = approveDirection === undefined
      ? undefined
      : parseDirection(approveDirection, "approveDirection");
    if (verdict === "conditional" && !parsedAssumption) {
      throw new TypeError("assumptionLabel is required for a conditional review.");
    }
    if (verdict !== "conditional" && parsedAssumption) {
      throw new TypeError("assumptionLabel is valid only for a conditional review.");
    }

    return this.#transaction(() => {
      const replayRows = this.#database.prepare(`
        SELECT * FROM reviewed_results
        WHERE problem_id = ? AND note_uri = ?
        ORDER BY direction, claim_ts
      `).all(parsedProblemId, parsedNoteUri);
      if (replayRows.length > 0) {
        this.#assertReviewReplay(replayRows, {
          verdict,
          assumptionLabel: parsedAssumption,
          approveDirection: parsedApproveDirection,
          rejectAll,
        });
        return {
          outcome: "replayed",
          results: replayRows.map((row) => this.#mapReviewedResult(row)),
        };
      }

      const problem = this.#requireProblem(parsedProblemId);
      if (problem.status !== "PendingReview") {
        throw new LedgerError(
          "problem-not-pending-review",
          `Problem ${parsedProblemId} is ${problem.status}, not PendingReview.`,
        );
      }
      const unsettledCompetitor = this.#database.prepare(`
        SELECT direction, claim_ts
        FROM claims
        WHERE problem_id = ? AND settled = 0
        ORDER BY claim_ts
        LIMIT 1
      `).get(parsedProblemId);
      if (unsettledCompetitor) {
        throw new LedgerError(
          "competing-claim-unsettled",
          `Claim ${unsettledCompetitor.direction}/${unsettledCompetitor.claim_ts} `
          + "must settle before review.",
        );
      }
      const candidates = pendingCandidates(problem);
      if (candidates.length === 0) {
        throw new LedgerError(
          "pending-solution-missing",
          `Problem ${parsedProblemId} has no pending solution metadata.`,
        );
      }

      let approved;
      if (verdict !== "rejected") {
        if (candidates.length > 1 && !parsedApproveDirection) {
          throw new LedgerError(
            "candidate-disposition-required",
            "approveDirection is required when competing solutions exist.",
          );
        }
        approved = parsedApproveDirection
          ? candidates.find((candidate) => candidate.direction === parsedApproveDirection)
          : candidates[0];
        if (!approved) {
          throw new LedgerError(
            "candidate-not-found",
            `No pending candidate exists for ${parsedApproveDirection}.`,
          );
        }
      } else if (candidates.length > 1 && rejectAll !== true) {
        throw new LedgerError(
          "candidate-disposition-required",
          "rejectAll=true is required when rejecting competing solutions.",
        );
      }

      const reviewedAt = this.#now().iso;
      const insert = this.#database.prepare(`
        INSERT INTO reviewed_results (
          problem_id,
          direction,
          claim_ts,
          solution_uri,
          outcome,
          note_uri,
          assumption_label,
          reviewed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const results = [];
      for (const candidate of candidates) {
        const candidateOutcome = verdict === "rejected"
          ? "rejected"
          : candidate === approved
            ? verdict
            : "rejected";
        const candidateAssumption = candidateOutcome === "conditional"
          ? parsedAssumption
          : null;
        insert.run(
          parsedProblemId,
          candidate.direction,
          candidate.claimTs,
          candidate.solutionUri,
          candidateOutcome,
          parsedNoteUri,
          candidateAssumption,
          reviewedAt,
        );
        results.push({
          problemId: parsedProblemId,
          direction: candidate.direction,
          claimTs: candidate.claimTs,
          solutionUri: candidate.solutionUri,
          outcome: candidateOutcome,
          noteUri: parsedNoteUri,
          assumptionLabel: candidateAssumption ?? undefined,
          reviewedAt,
        });
      }

      const nextStatus = verdict === "unconditional" ? "Solved" : "Open";
      this.#database.prepare(`
        UPDATE problems
        SET status = ?,
            pending_direction = NULL,
            pending_claim_ts = NULL,
            pending_solution_uri = NULL,
            secondary_direction = NULL,
            secondary_claim_ts = NULL,
            secondary_solution_uri = NULL
        WHERE problem_id = ?
      `).run(nextStatus, parsedProblemId);

      return {
        outcome: verdict,
        problemStatus: nextStatus,
        results: results.map(Object.freeze),
      };
    });
  }

  sweep({ problemId }) {
    const parsedProblemId = parseProblemId(problemId);
    return this.#transaction(() => {
      const problem = this.#requireProblem(parsedProblemId);
      if (problem.status !== "Solved") {
        throw new LedgerError(
          "problem-not-solved",
          `Problem ${parsedProblemId} is ${problem.status}, not Solved.`,
        );
      }
      let sweptCents = 0;
      for (const direction of ["prove", "disprove"]) {
        const claimable = this.#claimablePoolBalance(parsedProblemId, direction);
        if (claimable === 0) continue;
        const pool = this.#requirePool(parsedProblemId, direction);
        this.#setPoolBalances({
          problemId: parsedProblemId,
          direction,
          balanceCents: addCents(Number(pool.balance_cents), -claimable),
          cumulativeDonationsCents: Number(pool.cumulative_donations_cents),
        });
        sweptCents = addCents(sweptCents, claimable);
      }
      if (sweptCents > 0) {
        this.#setGeneralBalance(addCents(this.#generalBalance(), sweptCents));
      }
      return {
        outcome: sweptCents > 0 ? "swept" : "unchanged",
        problemId: parsedProblemId,
        sweptCents,
      };
    });
  }

  treasuryFund({
    amountCents,
    externalReference,
    settledContributionCents,
    fundedAt,
  }) {
    const amount = positiveCents(amountCents, "amountCents");
    const reference = requiredString(externalReference, "externalReference");
    const settled = asCents(
      settledContributionCents,
      "settledContributionCents",
    );
    const timestamp = fundedAt === undefined
      ? this.#now().iso
      : parseTimestamp(fundedAt, "fundedAt");

    return this.#transaction(() => {
      const existing = this.#database.prepare(
        "SELECT * FROM funding_events WHERE external_reference = ?",
      ).get(reference);
      if (existing) {
        if (
          Number(existing.amount_cents) !== amount
          || Number(existing.settled_contribution_cents) !== settled
        ) {
          throw new LedgerError(
            "idempotency-conflict",
            `Funding reference ${reference} already has different values.`,
          );
        }
        return { outcome: "duplicate", fundingEvent: mapFundingEvent(existing) };
      }

      const previousSettlement = this.#database.prepare(`
        SELECT MAX(settled_contribution_cents) AS amount
        FROM funding_events
      `).get();
      if (
        previousSettlement.amount !== null
        && settled < Number(previousSettlement.amount)
      ) {
        throw new LedgerError(
          "settlement-rollback",
          "settledContributionCents cannot move backward.",
        );
      }

      const totals = this.#treasuryAdjustmentTotals();
      const fundingEventCents = this.#fundingTotal();
      const available = calculateAvailableToFundCents({
        settledContributionCents: settled,
        completedRefundCents: totals.completedRefundCents,
        fundingEventCents,
        pendingRefundCents: totals.pendingRefundCents,
      });
      if (amount > available) {
        throw new LedgerError(
          "insufficient-settled-funds",
          `Funding amount ${amount} exceeds available-to-fund ${available}.`,
        );
      }

      this.#database.prepare(`
        INSERT INTO funding_events (
          external_reference,
          amount_cents,
          settled_contribution_cents,
          funded_at
        ) VALUES (?, ?, ?, ?)
      `).run(reference, amount, settled, timestamp);
      return {
        outcome: "funded",
        fundingEvent: {
          externalReference: reference,
          amountCents: amount,
          settledContributionCents: settled,
          fundedAt: timestamp,
        },
      };
    });
  }

  treasuryStatus({ settledContributionCents } = {}) {
    this.#assertOpen();
    const settled = settledContributionCents === undefined
      ? this.#latestSettledContributionSnapshot()
      : asCents(settledContributionCents, "settledContributionCents");
    const totals = this.#treasuryAdjustmentTotals();
    const fundingEventCents = this.#fundingTotal();
    const settledButUnfundedCents = calculateSettledButUnfundedCents({
      settledContributionCents: settled,
      completedRefundCents: totals.completedRefundCents,
      fundingEventCents,
    });
    const availableToFundCents = calculateAvailableToFundCents({
      settledContributionCents: settled,
      completedRefundCents: totals.completedRefundCents,
      fundingEventCents,
      pendingRefundCents: totals.pendingRefundCents,
    });
    const liveReservationsCents = this.#liveReservationTotal();
    return Object.freeze({
      settledContributionCents: settled,
      completedRefundCents: totals.completedRefundCents,
      pendingRefundCents: totals.pendingRefundCents,
      fundingEventCents,
      settledButUnfundedCents,
      availableToFundCents,
      spendableCapacityCents: this.#spendableCapacity(),
      liveReservationsCents,
    });
  }

  beginRefund({
    donationDedupId,
    requestedAmountCents,
    idempotencyReference,
  }) {
    const dedupId = requiredString(donationDedupId, "donationDedupId");
    const reference = requiredString(
      idempotencyReference,
      "idempotencyReference",
    );
    const requested = requestedAmountCents === undefined
      ? undefined
      : positiveCents(requestedAmountCents, "requestedAmountCents");

    return this.#transaction(() => {
      const existing = this.#database.prepare(
        "SELECT * FROM adjustments WHERE external_reference = ?",
      ).get(reference);
      if (existing) {
        if (
          existing.reason_code !== "refund"
          || existing.donation_dedup_id !== dedupId
          || (
            requested !== undefined
            && -Number(existing.amount_cents) !== requested
          )
        ) {
          throw new LedgerError(
            "idempotency-conflict",
            `Adjustment reference ${reference} already belongs to another operation.`,
          );
        }
        return { outcome: "duplicate", adjustment: mapAdjustment(existing) };
      }

      const donation = this.#requireDonationRow(dedupId);
      if (donation.payment_state !== "credited") {
        throw new LedgerError(
          "donation-not-refundable",
          `Donation ${dedupId} is ${donation.payment_state}.`,
        );
      }
      const waterlineStatus = this.#waterlineStatuses().find(
        (entry) => entry.dedupId === dedupId,
      );
      if (waterlineStatus?.status === "processed") {
        throw new LedgerError(
          "donation-processed",
          `Donation ${dedupId} has been processed and is no longer refundable.`,
        );
      }
      const pendingRefundCents = this.#refundAmount(dedupId, "pending");
      const destinationBalanceCents = Math.max(
        0,
        this.#destinationBalance(donation),
      );
      const refundableCents = calculateRefundableCents({
        donationDedupId: dedupId,
        donations: this.#waterlineDonations(),
        fundedCents: this.#fundingTotal(),
        pendingRefundCents,
        destinationBalanceCents,
        requestedCents: requested,
      });
      if (refundableCents === 0) {
        throw new LedgerError(
          "nothing-refundable",
          `Donation ${dedupId} has no refundable balance.`,
        );
      }

      this.#changeDestinationBalance(donation, -refundableCents);
      const createdAt = this.#now().iso;
      const adjustmentId = `refund:${reference}`;
      this.#database.prepare(`
        INSERT INTO adjustments (
          adjustment_id,
          reason_code,
          amount_cents,
          donation_dedup_id,
          external_reference,
          status,
          created_at
        ) VALUES (?, 'refund', ?, ?, ?, 'pending', ?)
      `).run(adjustmentId, -refundableCents, dedupId, reference, createdAt);
      return {
        outcome: "pending",
        adjustment: mapAdjustment(this.#requireAdjustment(reference)),
      };
    });
  }

  completeRefund({ idempotencyReference, providerReference }) {
    const reference = requiredString(
      idempotencyReference,
      "idempotencyReference",
    );
    const provider = requiredString(providerReference, "providerReference");
    return this.#transaction(() => {
      const adjustment = this.#requireAdjustment(reference);
      if (adjustment.reason_code !== "refund") {
        throw new LedgerError("not-a-refund", `${reference} is not a refund.`);
      }
      if (adjustment.status === "completed") {
        if (adjustment.provider_reference !== provider) {
          throw new LedgerError(
            "idempotency-conflict",
            `Refund ${reference} already has another provider reference.`,
          );
        }
        return { outcome: "duplicate", adjustment: mapAdjustment(adjustment) };
      }
      if (adjustment.status !== "pending") {
        throw new LedgerError(
          "refund-not-pending",
          `Refund ${reference} is ${adjustment.status}.`,
        );
      }
      this.#database.prepare(`
        UPDATE adjustments
        SET status = 'completed', provider_reference = ?, resolved_at = ?
        WHERE external_reference = ?
      `).run(provider, this.#now().iso, reference);
      return {
        outcome: "completed",
        adjustment: mapAdjustment(this.#requireAdjustment(reference)),
      };
    });
  }

  cancelRefund({ idempotencyReference, note }) {
    const reference = requiredString(
      idempotencyReference,
      "idempotencyReference",
    );
    const parsedNote = requiredString(note, "note");
    return this.#transaction(() => {
      const adjustment = this.#requireAdjustment(reference);
      if (adjustment.reason_code !== "refund") {
        throw new LedgerError("not-a-refund", `${reference} is not a refund.`);
      }
      if (adjustment.status === "canceled") {
        if (adjustment.note !== parsedNote) {
          throw new LedgerError(
            "idempotency-conflict",
            `Canceled refund ${reference} already has a different note.`,
          );
        }
        return { outcome: "duplicate", adjustment: mapAdjustment(adjustment) };
      }
      if (adjustment.status !== "pending") {
        throw new LedgerError(
          "refund-not-pending",
          `Refund ${reference} is ${adjustment.status}.`,
        );
      }
      const donation = this.#requireDonationRow(adjustment.donation_dedup_id);
      this.#changeDestinationBalance(donation, -Number(adjustment.amount_cents));
      this.#database.prepare(`
        UPDATE adjustments
        SET status = 'canceled', note = ?, resolved_at = ?
        WHERE external_reference = ?
      `).run(parsedNote, this.#now().iso, reference);
      return {
        outcome: "canceled",
        adjustment: mapAdjustment(this.#requireAdjustment(reference)),
      };
    });
  }

  dispute({
    donationDedupId,
    externalReference,
    amountCents,
    note,
  }) {
    const dedupId = requiredString(donationDedupId, "donationDedupId");
    const reference = requiredString(externalReference, "externalReference");
    const parsedNote = optionalNonemptyString(note, "note");
    const requested = amountCents === undefined
      ? undefined
      : positiveCents(amountCents, "amountCents");

    return this.#transaction(() => {
      const existing = this.#database.prepare(
        "SELECT * FROM adjustments WHERE external_reference = ?",
      ).get(reference);
      if (existing) {
        if (
          existing.reason_code !== "dispute"
          || existing.donation_dedup_id !== dedupId
          || (
            requested !== undefined
            && -Number(existing.amount_cents) !== requested
          )
          || (
            parsedNote !== undefined
            && existing.note !== parsedNote
          )
        ) {
          throw new LedgerError(
            "idempotency-conflict",
            `Adjustment reference ${reference} already belongs to another operation.`,
          );
        }
        return { outcome: "duplicate", adjustment: mapAdjustment(existing) };
      }

      const donation = this.#requireDonationRow(dedupId);
      if (this.#refundAmount(dedupId, "pending") > 0) {
        throw new LedgerError(
          "refund-pending",
          `Donation ${dedupId} has a pending refund and cannot be disputed.`,
        );
      }
      const completedRefunds = this.#refundAmount(dedupId, "completed");
      const priorDisputes = this.#completedDisputeAmount(dedupId);
      const wasProcessed = this.#waterlineStatuses().find(
        (entry) => entry.dedupId === dedupId,
      )?.processed === true;
      const outstanding = addCents(
        Number(donation.net_cents),
        -completedRefunds,
        -priorDisputes,
      );
      const disputedCents = requested ?? outstanding;
      if (disputedCents < 1 || disputedCents > outstanding) {
        throw new LedgerError(
          "invalid-dispute-amount",
          `Dispute amount must be between 1 and outstanding amount ${outstanding}.`,
        );
      }

      this.#debitDisputeDestination(donation, disputedCents);
      const totalDisputed = addCents(priorDisputes, disputedCents);
      const nextPaymentState = totalDisputed === addCents(
        Number(donation.net_cents),
        -completedRefunds,
      )
        ? "reversed"
        : "disputed";
      const waterlineExclusion = wasProcessed
        ? Number(donation.waterline_excluded_cents)
        : addCents(
            Number(donation.waterline_excluded_cents),
            disputedCents,
          );
      this.#database.prepare(`
        UPDATE donations
        SET payment_state = ?, waterline_excluded_cents = ?
        WHERE dedup_id = ?
      `).run(nextPaymentState, waterlineExclusion, dedupId);

      const createdAt = this.#now().iso;
      this.#database.prepare(`
        INSERT INTO adjustments (
          adjustment_id,
          reason_code,
          amount_cents,
          donation_dedup_id,
          external_reference,
          provider_reference,
          status,
          note,
          created_at,
          resolved_at
        ) VALUES (?, 'dispute', ?, ?, ?, ?, 'completed', ?, ?, ?)
      `).run(
        `dispute:${reference}`,
        -disputedCents,
        dedupId,
        reference,
        reference,
        parsedNote ?? null,
        createdAt,
        createdAt,
      );
      return {
        outcome: nextPaymentState,
        adjustment: mapAdjustment(this.#requireAdjustment(reference)),
      };
    });
  }

  reconcileGeneralCredit({ amountCents, externalReference, note }) {
    const amount = asCents(amountCents, "amountCents", { allowNegative: true });
    if (amount === 0) throw new RangeError("amountCents cannot be zero.");
    const reference = requiredString(externalReference, "externalReference");
    const parsedNote = requiredString(note, "note");
    return this.#transaction(() => {
      const existing = this.#database.prepare(
        "SELECT * FROM adjustments WHERE external_reference = ?",
      ).get(reference);
      if (existing) {
        if (
          existing.reason_code !== "reconciliation"
          || Number(existing.amount_cents) !== amount
          || existing.note !== parsedNote
        ) {
          throw new LedgerError(
            "idempotency-conflict",
            `Adjustment reference ${reference} already has different values.`,
          );
        }
        return { outcome: "duplicate", adjustment: mapAdjustment(existing) };
      }
      if (amount > 0) {
        this.#setGeneralBalance(addCents(this.#generalBalance(), amount));
      } else {
        const debit = Math.min(this.#claimableGeneralBalance(), -amount);
        if (debit > 0) {
          this.#setGeneralBalance(addCents(this.#generalBalance(), -debit));
        }
        const shortfall = -amount - debit;
        if (shortfall > 0) {
          this.#setGeneralDebt(addCents(this.#generalDebt(), shortfall));
        }
      }
      const now = this.#now().iso;
      this.#database.prepare(`
        INSERT INTO adjustments (
          adjustment_id,
          reason_code,
          amount_cents,
          external_reference,
          status,
          note,
          created_at,
          resolved_at
        ) VALUES (?, 'reconciliation', ?, ?, 'completed', ?, ?, ?)
      `).run(`reconciliation:${reference}`, amount, reference, parsedNote, now, now);
      return {
        outcome: "completed",
        adjustment: mapAdjustment(this.#requireAdjustment(reference)),
      };
    });
  }

  getDonation(dedupId) {
    this.#assertOpen();
    return this.#mapDonation(this.#requireDonationRow(
      requiredString(dedupId, "dedupId"),
    ));
  }

  getProblem(problemId) {
    this.#assertOpen();
    return mapProblem(this.#requireProblem(parseProblemId(problemId)));
  }

  getClaim(key) {
    this.#assertOpen();
    return this.#mapClaim(this.#requireClaim(parseClaimKey(key)));
  }

  listUnsettledClaims() {
    this.#assertOpen();
    return this.#database.prepare(`
      SELECT * FROM claims WHERE settled = 0
      ORDER BY problem_id, direction, claim_ts
    `).all().map((row) => this.#mapClaim(row));
  }

  listClaimResponses(key) {
    this.#assertOpen();
    const parsed = parseClaimKey(key);
    this.#requireClaim(parsed);
    return Object.freeze(this.#database.prepare(`
      SELECT * FROM claim_responses
      WHERE problem_id = ? AND direction = ? AND claim_ts = ?
      ORDER BY sequence
    `).all(parsed.problemId, parsed.direction, parsed.claimTs).map(mapClaimResponse));
  }

  listWorkerClaimResponses({
    workerId,
    startTime,
    endTime,
  }) {
    this.#assertOpen();
    const parsedWorkerId = parseWorkerId(workerId);
    const start = requiredTimestamp(startTime, "startTime");
    const end = requiredTimestamp(endTime, "endTime");
    if (Date.parse(start) >= Date.parse(end)) {
      throw new RangeError("startTime must be before endTime.");
    }
    return Object.freeze(this.#database.prepare(`
      SELECT claim_responses.*, claims.worker_id
      FROM claim_responses
      JOIN claims USING (problem_id, direction, claim_ts)
      WHERE claims.worker_id = ?
        AND claim_responses.request_started_at >= ?
        AND claim_responses.request_started_at < ?
      ORDER BY claim_responses.request_started_at, claim_responses.message_id
    `).all(parsedWorkerId, start, end).map(mapClaimResponse));
  }

  inspect() {
    this.#assertOpen();
    const problems = this.#database.prepare(
      "SELECT * FROM problems ORDER BY problem_id",
    ).all().map(mapProblem);
    const pools = this.#database.prepare(
      "SELECT * FROM pools ORDER BY problem_id, direction",
    ).all().map((row) => ({
      problemId: row.problem_id,
      direction: row.direction,
      balanceCents: Number(row.balance_cents),
      cumulativeDonationsCents: Number(row.cumulative_donations_cents),
      claimableBalanceCents: this.#claimablePoolBalance(
        row.problem_id,
        row.direction,
      ),
    }));
    const donations = this.#database.prepare(
      "SELECT * FROM donations ORDER BY credited_at, dedup_id",
    ).all().map((row) => this.#mapDonation(row));
    const claims = this.#database.prepare(
      "SELECT * FROM claims ORDER BY claim_ts",
    ).all().map((row) => this.#mapClaim(row));
    const claimResponses = this.#database.prepare(`
      SELECT * FROM claim_responses
      ORDER BY problem_id, direction, claim_ts, sequence
    `).all().map(mapClaimResponse);
    const reviewedResults = this.#database.prepare(
      "SELECT * FROM reviewed_results ORDER BY reviewed_at, problem_id, direction",
    ).all().map((row) => this.#mapReviewedResult(row));
    const fundingEvents = this.#database.prepare(
      "SELECT * FROM funding_events ORDER BY funded_at, external_reference",
    ).all().map(mapFundingEvent);
    const adjustments = this.#database.prepare(
      "SELECT * FROM adjustments ORDER BY created_at, adjustment_id",
    ).all().map(mapAdjustment);
    return Object.freeze({
      problems: Object.freeze(problems),
      pools: Object.freeze(pools),
      donations: Object.freeze(donations),
      claims: Object.freeze(claims),
      claimResponses: Object.freeze(claimResponses),
      reviewedResults: Object.freeze(reviewedResults),
      fundingEvents: Object.freeze(fundingEvents),
      adjustments: Object.freeze(adjustments),
      generalCreditCents: this.#generalBalance(),
      generalDebtCents: this.#generalDebt(),
      claimableGeneralCreditCents: this.#claimableGeneralBalance(),
      spendableCapacityCents: this.#spendableCapacity(),
    });
  }

  accountingSnapshot() {
    this.#assertOpen();
    const donationNetCents = sumRows(
      this.#database.prepare("SELECT net_cents AS amount FROM donations").all(),
    );
    const poolBalanceCents = sumRows(
      this.#database.prepare("SELECT balance_cents AS amount FROM pools").all(),
    );
    const settledSpendCents = sumRows(this.#database.prepare(
      "SELECT spent_cents AS amount FROM claims WHERE settled = 1",
    ).all());
    const liveReservationCents = this.#liveReservationTotal();
    const includedAdjustments = this.#database.prepare(`
      SELECT amount_cents
      FROM adjustments
      WHERE status IN ('pending', 'completed')
    `).all();
    let adjustmentInflowsCents = 0;
    let adjustmentOutflowsCents = 0;
    for (const row of includedAdjustments) {
      const amount = Number(row.amount_cents);
      if (amount > 0) adjustmentInflowsCents = addCents(adjustmentInflowsCents, amount);
      else adjustmentOutflowsCents = addCents(adjustmentOutflowsCents, -amount);
    }
    const generalCreditCents = this.#generalBalance();
    const generalDebtCents = this.#generalDebt();
    const inflowsCents = addCents(donationNetCents, adjustmentInflowsCents);
    const accountedCents = addCents(
      poolBalanceCents,
      generalCreditCents,
      -generalDebtCents,
      settledSpendCents,
      liveReservationCents,
      adjustmentOutflowsCents,
    );
    return Object.freeze({
      donationNetCents,
      adjustmentInflowsCents,
      inflowsCents,
      poolBalanceCents,
      generalCreditCents,
      generalDebtCents,
      settledSpendCents,
      liveReservationCents,
      adjustmentOutflowsCents,
      accountedCents,
      balanced: inflowsCents === accountedCents,
    });
  }

  assertConservation() {
    const snapshot = this.accountingSnapshot();
    if (!snapshot.balanced) {
      throw new LedgerError(
        "conservation-failed",
        `Ledger inflows ${snapshot.inflowsCents} do not equal accounted `
        + `${snapshot.accountedCents}.`,
      );
    }
    return snapshot;
  }

  #settleInsideTransaction({
    problemId,
    direction,
    claimTs,
    finalSpentCents,
    solutionUri,
  }) {
    const claim = this.#requireClaim({ problemId, direction, claimTs });
    const budget = Number(claim.budget_cents);
    const requested = Math.min(finalSpentCents, budget);
    const finalSpent = Math.max(requested, Number(claim.spent_cents));

    if (Number(claim.settled) === 1) {
      if (finalSpent !== Number(claim.spent_cents)) {
        throw new LedgerError(
          "settlement-conflict",
          "Settled claim cannot be replayed with different spend.",
        );
      }
      if (
        solutionUri
        && claim.solution_uri
        && claim.solution_uri !== solutionUri
      ) {
        throw new LedgerError(
          "solution-conflict",
          "Claim already references a different solution URI.",
        );
      }
      if (solutionUri && !claim.solution_uri) {
        this.#attachSolution(claim, solutionUri);
      }
      return {
        outcome: "replayed",
        claim: this.#mapClaim(this.#requireClaim({ problemId, direction, claimTs })),
      };
    }

    const poolFunded = Number(claim.pool_funded_cents);
    const generalFunded = budget - poolFunded;
    const generalSpend = Math.min(finalSpent, generalFunded);
    const poolSpend = finalSpent - generalSpend;
    const poolResidue = poolFunded - poolSpend;
    const generalResidue = generalFunded - generalSpend;

    let generalReturn = generalResidue;
    if (poolResidue >= RESIDUE_FLOOR_CENTS) {
      const pool = this.#requirePool(problemId, direction);
      this.#setPoolBalances({
        problemId,
        direction,
        balanceCents: addCents(Number(pool.balance_cents), poolResidue),
        cumulativeDonationsCents: Number(pool.cumulative_donations_cents),
      });
    } else {
      generalReturn = addCents(generalReturn, poolResidue);
    }
    if (generalReturn > 0) {
      this.#setGeneralBalance(addCents(this.#generalBalance(), generalReturn));
    }

    const settledAt = this.#now().iso;
    this.#database.prepare(`
      UPDATE claims
      SET spent_cents = ?,
          settled = 1,
          settled_at = ?,
          solution_uri = COALESCE(?, solution_uri)
      WHERE problem_id = ? AND direction = ? AND claim_ts = ?
    `).run(
      finalSpent,
      settledAt,
      solutionUri ?? null,
      problemId,
      direction,
      claimTs,
    );
    if (solutionUri) {
      this.#attachSolution(
        this.#requireClaim({ problemId, direction, claimTs }),
        solutionUri,
      );
    }
    return {
      outcome: "settled",
      claim: this.#mapClaim(this.#requireClaim({ problemId, direction, claimTs })),
      residue: Object.freeze({
        poolCents: poolResidue >= RESIDUE_FLOOR_CENTS ? poolResidue : 0,
        generalCents: generalReturn,
      }),
    };
  }

  #attachSolution(claim, solutionUri) {
    if (claim.solution_uri && claim.solution_uri !== solutionUri) {
      throw new LedgerError(
        "solution-conflict",
        "Claim already references a different solution URI.",
      );
    }
    if (!claim.solution_uri) {
      this.#database.prepare(`
        UPDATE claims SET solution_uri = ?
        WHERE problem_id = ? AND direction = ? AND claim_ts = ?
      `).run(solutionUri, claim.problem_id, claim.direction, claim.claim_ts);
    }

    const problem = this.#requireProblem(claim.problem_id);
    const sameAsPending = (
      problem.pending_direction === claim.direction
      && Number(problem.pending_claim_ts) === Number(claim.claim_ts)
    );
    const sameAsSecondary = (
      problem.secondary_direction === claim.direction
      && Number(problem.secondary_claim_ts) === Number(claim.claim_ts)
    );
    if (sameAsPending || sameAsSecondary) return;

    if (problem.status === "Open") {
      this.#database.prepare(`
        UPDATE problems
        SET status = 'PendingReview',
            pending_direction = ?,
            pending_claim_ts = ?,
            pending_solution_uri = ?
        WHERE problem_id = ?
      `).run(claim.direction, claim.claim_ts, solutionUri, claim.problem_id);
      return;
    }
    if (problem.status === "PendingReview" && !problem.secondary_solution_uri) {
      if (problem.pending_direction === claim.direction) {
        throw new LedgerError(
          "secondary-direction-conflict",
          "Secondary solution must be from the opposite direction.",
        );
      }
      this.#database.prepare(`
        UPDATE problems
        SET secondary_direction = ?,
            secondary_claim_ts = ?,
            secondary_solution_uri = ?
        WHERE problem_id = ?
      `).run(claim.direction, claim.claim_ts, solutionUri, claim.problem_id);
    }
  }

  #claimablePoolBalance(problemId, direction) {
    const pool = this.#requirePool(problemId, direction);
    const liability = this.#refundLiabilityFor({
      kind: "pool",
      problemId,
      direction,
    });
    const claimable = addCents(Number(pool.balance_cents), -liability);
    if (claimable < 0) {
      throw new LedgerError(
        "refund-liability-unfunded",
        `Pool ${problemId}/${direction} balance is below refund liability.`,
      );
    }
    return claimable;
  }

  #claimableGeneralBalance() {
    const liability = this.#refundLiabilityFor({ kind: "general" });
    return Math.max(
      0,
      addCents(this.#generalBalance(), -liability, -this.#generalDebt()),
    );
  }

  #refundLiabilityFor(destination) {
    const statuses = new Map(this.#waterlineStatuses().map((item) => [
      item.dedupId,
      item,
    ]));
    const donations = this.#database.prepare(
      "SELECT * FROM donations ORDER BY credited_at, dedup_id",
    ).all();
    let liability = 0;
    for (const donation of donations) {
      if (donation.payment_state === "reversed") continue;
      if (!sameDestination(donation, destination)) continue;
      const status = statuses.get(donation.dedup_id);
      if (!status?.refundEligible) continue;
      const pending = this.#refundAmount(donation.dedup_id, "pending");
      liability = addCents(
        liability,
        status.effectiveNetCents,
        -pending,
      );
    }
    return liability;
  }

  #waterlineStatuses() {
    return deriveDonationWaterline({
      donations: this.#waterlineDonations(),
      fundedCents: this.#fundingTotal(),
    });
  }

  #waterlineDonations() {
    return this.#database.prepare(`
      SELECT
        d.dedup_id,
        d.credited_at,
        d.net_cents,
        d.waterline_excluded_cents + COALESCE(SUM(
          CASE
            WHEN a.reason_code = 'refund' AND a.status = 'completed'
            THEN -a.amount_cents
            ELSE 0
          END
        ), 0) AS refunded_cents
      FROM donations d
      LEFT JOIN adjustments a ON a.donation_dedup_id = d.dedup_id
      GROUP BY d.dedup_id
      ORDER BY d.credited_at, d.dedup_id
    `).all().map((row) => ({
      dedupId: row.dedup_id,
      creditedAt: row.credited_at,
      netCents: Number(row.net_cents),
      refundedCents: Number(row.refunded_cents),
    }));
  }

  #spendableCapacity() {
    return addCents(
      this.#fundingTotal(),
      -sumRows(this.#database.prepare(
        "SELECT spent_cents AS amount FROM claims WHERE settled = 1",
      ).all()),
      -this.#liveReservationTotal(),
    );
  }

  #liveReservationTotal() {
    return sumRows(this.#database.prepare(
      "SELECT budget_cents AS amount FROM claims WHERE settled = 0",
    ).all());
  }

  #fundingTotal() {
    return sumRows(this.#database.prepare(
      "SELECT amount_cents AS amount FROM funding_events",
    ).all());
  }

  #latestSettledContributionSnapshot() {
    const row = this.#database.prepare(`
      SELECT MAX(settled_contribution_cents) AS amount FROM funding_events
    `).get();
    return Number(row.amount ?? 0);
  }

  #treasuryAdjustmentTotals() {
    return {
      completedRefundCents: this.#refundAmount(undefined, "completed"),
      pendingRefundCents: this.#refundAmount(undefined, "pending"),
    };
  }

  #refundAmount(dedupId, status) {
    const rows = dedupId === undefined
      ? this.#database.prepare(`
          SELECT amount_cents AS amount
          FROM adjustments
          WHERE reason_code = 'refund' AND status = ?
        `).all(status)
      : this.#database.prepare(`
          SELECT amount_cents AS amount
          FROM adjustments
          WHERE reason_code = 'refund'
            AND status = ?
            AND donation_dedup_id = ?
        `).all(status, dedupId);
    return sumRows(rows.map((row) => ({ amount: -Number(row.amount) })));
  }

  #completedDisputeAmount(dedupId) {
    const rows = this.#database.prepare(`
      SELECT amount_cents AS amount
      FROM adjustments
      WHERE reason_code = 'dispute'
        AND status = 'completed'
        AND donation_dedup_id = ?
    `).all(dedupId);
    return sumRows(rows.map((row) => ({ amount: -Number(row.amount) })));
  }

  #destinationBalance(donation) {
    if (donation.destination_kind === "general") return this.#generalBalance();
    return Number(this.#requirePool(
      donation.problem_id,
      donation.direction,
    ).balance_cents);
  }

  #changeDestinationBalance(donation, amountCents) {
    if (donation.destination_kind === "general") {
      const next = addCents(this.#generalBalance(), amountCents);
      if (amountCents < 0 && next < 0) {
        throw new LedgerError(
          "destination-balance-insufficient",
          "General-credit destination cannot cover this refund.",
        );
      }
      this.#setGeneralBalance(next);
      return;
    }
    const pool = this.#requirePool(donation.problem_id, donation.direction);
    const next = addCents(Number(pool.balance_cents), amountCents);
    if (next < 0) {
      throw new LedgerError(
        "destination-balance-insufficient",
        "Pool destination cannot cover this refund.",
      );
    }
    this.#setPoolBalances({
      problemId: donation.problem_id,
      direction: donation.direction,
      balanceCents: next,
      cumulativeDonationsCents: Number(pool.cumulative_donations_cents),
    });
  }

  #debitDisputeDestination(donation, disputedCents) {
    const ownLiability = this.#donationRefundLiability(donation);
    let destinationDebit;
    if (donation.destination_kind === "general") {
      destinationDebit = Math.min(
        disputedCents,
        addCents(this.#claimableGeneralBalance(), ownLiability),
        this.#generalBalance(),
      );
      if (destinationDebit > 0) {
        this.#setGeneralBalance(
          addCents(this.#generalBalance(), -destinationDebit),
        );
      }
    } else {
      const pool = this.#requirePool(donation.problem_id, donation.direction);
      destinationDebit = Math.min(
        disputedCents,
        addCents(
          this.#claimablePoolBalance(donation.problem_id, donation.direction),
          ownLiability,
        ),
        Number(pool.balance_cents),
      );
      if (destinationDebit > 0) {
        this.#setPoolBalances({
          problemId: donation.problem_id,
          direction: donation.direction,
          balanceCents: addCents(
            Number(pool.balance_cents),
            -destinationDebit,
          ),
          cumulativeDonationsCents: Number(pool.cumulative_donations_cents),
        });
      }
    }
    const shortfall = disputedCents - destinationDebit;
    if (shortfall > 0) {
      this.#setGeneralDebt(addCents(this.#generalDebt(), shortfall));
    }
  }

  #donationRefundLiability(donation) {
    if (donation.payment_state === "reversed") return 0;
    const status = this.#waterlineStatuses().find(
      (item) => item.dedupId === donation.dedup_id,
    );
    if (!status?.refundEligible) return 0;
    return addCents(
      status.effectiveNetCents,
      -this.#refundAmount(donation.dedup_id, "pending"),
    );
  }

  #generalBalance() {
    const row = this.#database.prepare(
      "SELECT balance_cents FROM general_credit WHERE singleton = 1",
    ).get();
    if (!row) throw new LedgerError("schema-corrupt", "general_credit row is missing.");
    return Number(row.balance_cents);
  }

  #setGeneralBalance(value) {
    const balance = asCents(value, "generalCreditCents");
    this.#database.prepare(
      "UPDATE general_credit SET balance_cents = ? WHERE singleton = 1",
    ).run(balance);
  }

  #generalDebt() {
    const row = this.#database.prepare(
      "SELECT debt_cents FROM general_credit WHERE singleton = 1",
    ).get();
    if (!row) throw new LedgerError("schema-corrupt", "general_credit row is missing.");
    return Number(row.debt_cents);
  }

  #setGeneralDebt(value) {
    const debt = asCents(value, "generalDebtCents");
    this.#database.prepare(
      "UPDATE general_credit SET debt_cents = ? WHERE singleton = 1",
    ).run(debt);
  }

  #setPoolBalances({
    problemId,
    direction,
    balanceCents,
    cumulativeDonationsCents,
  }) {
    const balance = asCents(balanceCents, "pool.balanceCents");
    const cumulative = asCents(
      cumulativeDonationsCents,
      "pool.cumulativeDonationsCents",
    );
    this.#database.prepare(`
      UPDATE pools
      SET balance_cents = ?, cumulative_donations_cents = ?
      WHERE problem_id = ? AND direction = ?
    `).run(balance, cumulative, problemId, direction);
  }

  #requireProblem(problemId) {
    const row = this.#database.prepare(
      "SELECT * FROM problems WHERE problem_id = ?",
    ).get(problemId);
    if (!row) throw new LedgerError("problem-not-found", `Unknown problem ${problemId}.`);
    return row;
  }

  #requirePool(problemId, direction) {
    const row = this.#database.prepare(`
      SELECT * FROM pools WHERE problem_id = ? AND direction = ?
    `).get(problemId, direction);
    if (!row) {
      throw new LedgerError(
        "pool-not-found",
        `Unknown pool ${problemId}/${direction}.`,
      );
    }
    return row;
  }

  #requireDonationRow(dedupId) {
    const row = this.#database.prepare(
      "SELECT * FROM donations WHERE dedup_id = ?",
    ).get(dedupId);
    if (!row) {
      throw new LedgerError("donation-not-found", `Unknown donation ${dedupId}.`);
    }
    return row;
  }

  #requireClaim({ problemId, direction, claimTs }) {
    const row = this.#database.prepare(`
      SELECT * FROM claims
      WHERE problem_id = ? AND direction = ? AND claim_ts = ?
    `).get(problemId, direction, claimTs);
    if (!row) {
      throw new LedgerError(
        "claim-not-found",
        `Unknown claim ${problemId}/${direction}/${claimTs}.`,
      );
    }
    return row;
  }

  #requireAdjustment(externalReference) {
    const row = this.#database.prepare(
      "SELECT * FROM adjustments WHERE external_reference = ?",
    ).get(externalReference);
    if (!row) {
      throw new LedgerError(
        "adjustment-not-found",
        `Unknown adjustment ${externalReference}.`,
      );
    }
    return row;
  }

  #mapDonation(row) {
    const refundedCents = this.#refundAmount(row.dedup_id, "completed");
    const state = row.payment_state === "credited"
      ? deriveDonationRefundState({
          donationNetCents: Number(row.net_cents),
          completedRefundCents: refundedCents,
        })
      : row.payment_state;
    const processing = this.#waterlineStatuses().find(
      (item) => item.dedupId === row.dedup_id,
    );
    return Object.freeze({
      ...parseDonation({
        dedupId: row.dedup_id,
        orderId: row.order_id,
        destination: row.destination_kind === "pool"
          ? {
              kind: "pool",
              problemId: row.problem_id,
              direction: row.direction,
            }
          : { kind: "general" },
        grossCents: Number(row.gross_cents),
        feesCents: Number(row.fees_cents),
        netCents: Number(row.net_cents),
        refundedCents,
        donorTag: row.donor_tag,
        creditedAt: row.credited_at,
        state,
      }),
      intendedDestination: row.intended_problem_id
        ? Object.freeze({
            kind: "pool",
            problemId: row.intended_problem_id,
            direction: row.intended_direction,
          })
        : Object.freeze({ kind: "general" }),
      waterlineExcludedCents: Number(row.waterline_excluded_cents),
      processed: state === "credited" || state === "partially_refunded"
        ? processing?.processed === true
        : undefined,
      refundEligible: state === "credited" || state === "partially_refunded"
        ? processing?.refundEligible === true
        : false,
    });
  }

  #mapClaim(row) {
    return Object.freeze({
      problemId: row.problem_id,
      direction: row.direction,
      claimTs: Number(row.claim_ts),
      catalogRevision: Number(row.catalog_revision),
      workerId: row.worker_id,
      budgetCents: Number(row.budget_cents),
      poolFundedCents: Number(row.pool_funded_cents),
      spentCents: Number(row.spent_cents),
      leaseExpiresAt: row.lease_expires_at,
      settled: Number(row.settled) === 1,
      settledAt: row.settled_at ?? undefined,
      solutionUri: row.solution_uri ?? undefined,
    });
  }

  #mapReviewedResult(row) {
    return Object.freeze({
      problemId: row.problem_id,
      direction: row.direction,
      claimTs: Number(row.claim_ts),
      solutionUri: row.solution_uri,
      outcome: row.outcome,
      noteUri: row.note_uri,
      assumptionLabel: row.assumption_label ?? undefined,
      reviewedAt: row.reviewed_at,
    });
  }

  #assertDonationReplay(existing, proposed) {
    const intendedDestination = existing.intended_problem_id
      ? {
          kind: "pool",
          problemId: existing.intended_problem_id,
          direction: existing.intended_direction,
        }
      : existing.destination_kind === "pool"
        ? {
            kind: "pool",
            problemId: existing.problem_id,
            direction: existing.direction,
          }
        : { kind: "general" };
    if (!sameParsedDestination(intendedDestination, proposed.destination)) {
      throw new LedgerError(
        "idempotency-conflict",
        `Donation ${proposed.dedupId} replay changed destination.`,
      );
    }
    const comparable = {
      orderId: existing.order_id,
      grossCents: Number(existing.gross_cents),
      feesCents: Number(existing.fees_cents),
      netCents: Number(existing.net_cents),
      donorTag: existing.donor_tag,
      creditedAt: existing.credited_at,
    };
    for (const [key, value] of Object.entries(comparable)) {
      if (value !== proposed[key]) {
        throw new LedgerError(
          "idempotency-conflict",
          `Donation ${proposed.dedupId} replay changed ${key}.`,
        );
      }
    }
  }

  #assertReviewReplay(rows, {
    verdict,
    assumptionLabel,
    approveDirection,
    rejectAll,
  }) {
    const approved = rows.filter((row) => row.outcome !== "rejected");
    let matches = true;

    if (verdict === "rejected") {
      matches = approved.length === 0 && (rows.length < 2 || rejectAll === true);
    } else {
      matches = (
        approved.length === 1
        && approved[0].outcome === verdict
        && (
          rows.length < 2
          || (
            approveDirection !== undefined
            && approved[0].direction === approveDirection
          )
        )
        && (
          approveDirection === undefined
          || approved[0].direction === approveDirection
        )
      );
      if (verdict === "conditional") {
        matches = matches && approved[0]?.assumption_label === assumptionLabel;
      }
    }

    if (!matches) {
      throw new LedgerError(
        "idempotency-conflict",
        "Review note URI was already used with a different disposition.",
      );
    }
  }

  #nextClaimTimestamp(nowMs) {
    const row = this.#database.prepare(
      "SELECT MAX(claim_ts) AS claim_ts FROM claims",
    ).get();
    return Math.max(nowMs, Number(row.claim_ts ?? 0) + 1);
  }

  #now() {
    const value = this.#clock();
    const date = value instanceof Date ? value : new Date(value);
    const epochMilliseconds = date.getTime();
    if (!Number.isSafeInteger(epochMilliseconds) || epochMilliseconds < 1) {
      throw new TypeError("clock must return a valid post-epoch timestamp.");
    }
    return { epochMilliseconds, iso: date.toISOString() };
  }

  #transaction(action) {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #assertOpen() {
    if (this.#closed) throw new LedgerError("ledger-closed", "Ledger is closed.");
  }
}

function parseClaimKey({ problemId, direction, claimTs }) {
  const parsedClaimTs = Number(claimTs);
  if (!Number.isSafeInteger(parsedClaimTs) || parsedClaimTs < 1) {
    throw new TypeError("claimTs must be a positive safe integer.");
  }
  return {
    problemId: parseProblemId(problemId),
    direction: parseDirection(direction),
    claimTs: parsedClaimTs,
  };
}

function pendingCandidates(problem) {
  const candidates = [];
  if (problem.pending_solution_uri) {
    candidates.push({
      direction: problem.pending_direction,
      claimTs: Number(problem.pending_claim_ts),
      solutionUri: problem.pending_solution_uri,
    });
  }
  if (problem.secondary_solution_uri) {
    candidates.push({
      direction: problem.secondary_direction,
      claimTs: Number(problem.secondary_claim_ts),
      solutionUri: problem.secondary_solution_uri,
    });
  }
  return candidates;
}

function mapProblem(row) {
  return Object.freeze({
    problemId: row.problem_id,
    catalogRevision: Number(row.catalog_revision),
    slug: row.slug,
    title: row.title,
    statement: row.statement,
    status: row.status,
    pendingSolution: row.pending_solution_uri
      ? {
          direction: row.pending_direction,
          claimTs: Number(row.pending_claim_ts),
          solutionUri: row.pending_solution_uri,
        }
      : undefined,
    secondarySolution: row.secondary_solution_uri
      ? {
          direction: row.secondary_direction,
          claimTs: Number(row.secondary_claim_ts),
          solutionUri: row.secondary_solution_uri,
        }
      : undefined,
  });
}

function mapFundingEvent(row) {
  return Object.freeze({
    externalReference: row.external_reference,
    amountCents: Number(row.amount_cents),
    settledContributionCents: Number(row.settled_contribution_cents),
    fundedAt: row.funded_at,
  });
}

function mapAdjustment(row) {
  return Object.freeze({
    adjustmentId: row.adjustment_id,
    reasonCode: row.reason_code,
    amountCents: Number(row.amount_cents),
    donationDedupId: row.donation_dedup_id ?? undefined,
    externalReference: row.external_reference,
    providerReference: row.provider_reference ?? undefined,
    status: row.status,
    note: row.note ?? undefined,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  });
}

function mapClaimResponse(row) {
  return Object.freeze({
    problemId: row.problem_id,
    direction: row.direction,
    claimTs: Number(row.claim_ts),
    sequence: Number(row.sequence),
    messageId: row.message_id,
    requestId: row.request_id ?? undefined,
    modelId: row.model_id,
    stopReason: row.stop_reason ?? undefined,
    stopDetails: row.stop_details_json
      ? JSON.parse(row.stop_details_json)
      : undefined,
    containerId: row.container_id ?? undefined,
    usage: JSON.parse(row.usage_json),
    request: JSON.parse(row.request_json),
    response: JSON.parse(row.response_json),
    pricedCostCents: Number(row.priced_cost_cents),
    appliedCostCents: Number(row.applied_cost_cents),
    overageCents: Number(row.overage_cents),
    workerId: row.worker_id ?? undefined,
    requestStartedAt: row.request_started_at,
    completedAt: row.completed_at,
  });
}

function parseCheckpointResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("response must be an Anthropic message object.");
  }
  const id = requiredString(value.id, "response.id");
  const model = requiredString(value.model, "response.model");
  if (!Array.isArray(value.content)) {
    throw new TypeError("response.content must be an array.");
  }
  if (!value.usage || typeof value.usage !== "object" || Array.isArray(value.usage)) {
    throw new TypeError("response.usage must be an object.");
  }
  return structuredClone({
    ...value,
    id,
    model,
    content: value.content,
    usage: value.usage,
  });
}

function parseCheckpointRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("request must be an Anthropic Messages request object.");
  }
  if (typeof value.model !== "string" || !value.model.trim()) {
    throw new TypeError("request.model must be a nonempty string.");
  }
  if (!Array.isArray(value.messages)) {
    throw new TypeError("request.messages must be an array.");
  }
  return structuredClone(value);
}

function containerIdFromResponse(response) {
  if (typeof response.container === "string" && response.container.trim()) {
    return response.container.trim();
  }
  if (
    response.container
    && typeof response.container === "object"
    && typeof response.container.id === "string"
    && response.container.id.trim()
  ) {
    return response.container.id.trim();
  }
  return undefined;
}

function optionalNonnegativeInteger(value, label) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer.`);
  }
  return value;
}

function requiredTimestamp(value, label) {
  const text = requiredString(value, label);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${label} must be a valid timestamp.`);
  }
  return new Date(timestamp).toISOString();
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

function sameDestination(row, destination) {
  if (destination.kind === "general") return row.destination_kind === "general";
  return (
    row.destination_kind === "pool"
    && row.problem_id === destination.problemId
    && row.direction === destination.direction
  );
}

function sameParsedDestination(left, right) {
  if (left.kind !== right.kind) return false;
  return left.kind === "general" || (
    left.problemId === right.problemId
    && left.direction === right.direction
  );
}

function sumRows(rows) {
  return rows.reduce(
    (total, row) => addCents(total, Number(row.amount)),
    0,
  );
}

function positiveCents(value, label) {
  const amount = asCents(value, label);
  if (amount < 1) throw new RangeError(`${label} must be positive.`);
  return amount;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value.trim();
}

function optionalNonemptyString(value, label) {
  return value === undefined || value === null
    ? undefined
    : requiredString(value, label);
}

function parseTimestamp(value, label) {
  const timestamp = requiredString(value, label);
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${label} must be a valid timestamp.`);
  }
  return date.toISOString();
}
