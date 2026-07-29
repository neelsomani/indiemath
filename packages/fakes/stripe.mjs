export class FakeStripe {
  #refunds = new Map();
  #disputes;
  #settlementRecords;

  constructor({
    accountId = "acct_fake_indiemath",
    disputes = [],
    settlementRecords = [],
  } = {}) {
    this.accountId = accountId;
    this.#disputes = structuredClone(disputes);
    this.#settlementRecords = structuredClone(settlementRecords);
    this.calls = [];
  }

  async healthcheck() {
    return {
      ok: true,
      service: "stripe",
      accountId: this.accountId,
      country: "US",
      defaultCurrency: "usd",
      fake: true,
    };
  }

  async refundCharge({ chargeId, amountCents, idempotencyReference }) {
    const existing = this.#refunds.get(idempotencyReference);
    if (existing) {
      if (existing.chargeId !== chargeId || existing.amountCents !== amountCents) {
        throw new Error("Fake Stripe idempotency conflict.");
      }
      this.calls.push({
        operation: "refundCharge",
        idempotencyReference,
        duplicate: true,
      });
      return structuredClone({ outcome: "duplicate", ...existing });
    }
    const refund = {
      providerReference: `re_fake_${String(this.#refunds.size + 1).padStart(4, "0")}`,
      chargeId,
      amountCents,
      status: "succeeded",
    };
    this.#refunds.set(idempotencyReference, refund);
    this.calls.push({
      operation: "refundCharge",
      idempotencyReference,
      duplicate: false,
    });
    return structuredClone({ outcome: "refunded", ...refund });
  }

  async listDisputes({ cursor, since, through, limit = 100 } = {}) {
    const offset = parseCursor(cursor);
    const ordered = this.#disputes
      .filter((item) => !since || Date.parse(item.createdAt) >= Date.parse(since))
      .filter((item) => !through || Date.parse(item.createdAt) <= Date.parse(through))
      .sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
      ));
    const page = ordered.slice(offset, offset + limit);
    return {
      disputes: structuredClone(page),
      nextCursor: offset + limit < ordered.length ? String(offset + limit) : undefined,
    };
  }

  async listPaidPayoutSettlementRecords({ cursor, through, limit = 100 } = {}) {
    const offset = parseCursor(cursor);
    const ordered = this.#settlementRecords
      .filter((item) => !through || Date.parse(item.occurredAt) <= Date.parse(through))
      .sort((left, right) => (
        left.occurredAt.localeCompare(right.occurredAt)
        || left.providerReference.localeCompare(right.providerReference)
      ));
    const page = ordered.slice(offset, offset + limit);
    return {
      records: structuredClone(page),
      nextCursor: offset + limit < ordered.length ? String(offset + limit) : undefined,
    };
  }
}

function parseCursor(value) {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new TypeError("Fake Stripe cursor must be an unsigned integer.");
  }
  return Number(value);
}
