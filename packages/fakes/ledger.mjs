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
}
