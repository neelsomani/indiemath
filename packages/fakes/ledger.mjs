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
}
