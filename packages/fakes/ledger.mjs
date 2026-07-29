export class FakeLedger {
  constructor({ catalogRevision = 1 } = {}) {
    this.catalogRevision = catalogRevision;
    this.calls = [];
  }

  async healthcheck() {
    this.calls.push(Object.freeze({ operation: "healthcheck" }));
    return {
      ok: true,
      service: "ledger",
      catalogRevision: this.catalogRevision,
      fake: true,
    };
  }

  treasuryStatus() {
    return {
      settledContributionCents: 0,
      completedRefundCents: 0,
      pendingRefundCents: 0,
      fundingEventCents: 0,
      settledButUnfundedCents: 0,
      availableToFundCents: 0,
      spendableCapacityCents: 0,
      liveReservationsCents: 0,
    };
  }

  publicationSnapshot() {
    return {
      catalogRevision: this.catalogRevision,
      catalogHash: "f".repeat(64),
      catalogSyncedAt: "2026-07-28T00:00:00.000Z",
      catalog: {
        schema_version: 1,
        catalog_revision: this.catalogRevision,
        direction_contract: {
          prove: "Prove the statement.",
          disprove: "Disprove the statement.",
        },
        review_policy: {
          terminal_resolution: "Only unconditional results are terminal.",
          conditional_result: "Conditional results leave the problem open.",
        },
        problems: [{
          id: "math-001",
          slug: "the-riemann-hypothesis",
          domain: "mathematics",
          title: "The Riemann Hypothesis",
          statement: "Every non-trivial zero has real part one half.",
          directions: {
            prove: "Prove the statement.",
            disprove: "Disprove the statement.",
          },
          source: {
            kind: "fake",
            reference: "fake-catalog",
            entry: 1,
          },
        }],
      },
      treasury: this.treasuryStatus(),
      accounting: {
        donationNetCents: 0,
        adjustmentInflowsCents: 0,
        inflowsCents: 0,
        poolBalanceCents: 0,
        generalCreditCents: 0,
        generalDebtCents: 0,
        settledSpendCents: 0,
        liveReservationCents: 0,
        adjustmentOutflowsCents: 0,
        accountedCents: 0,
        balanced: true,
      },
      problems: [{
        problemId: "math-001",
        catalogRevision: this.catalogRevision,
        slug: "the-riemann-hypothesis",
        domain: "mathematics",
        title: "The Riemann Hypothesis",
        statement: "Every non-trivial zero has real part one half.",
        directions: {
          prove: "Prove the statement.",
          disprove: "Disprove the statement.",
        },
        status: "Open",
      }],
      pools: ["prove", "disprove"].map((direction) => ({
        problemId: "math-001",
        direction,
        balanceCents: 0,
        cumulativeDonationsCents: 0,
        claimableBalanceCents: 0,
      })),
      donations: [],
      claims: [],
      claimResponses: [],
      reviewedResults: [],
      fundingEvents: [],
      adjustments: [],
      openCollectiveTiers: [],
      settlementSnapshots: [],
      generalCreditCents: 0,
      generalDebtCents: 0,
      claimableGeneralCreditCents: 0,
      spendableCapacityCents: 0,
    };
  }
}
