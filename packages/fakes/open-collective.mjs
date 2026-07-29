export class FakeOpenCollective {
  #tiers = new Map();
  #transactionIds = new Set();
  #transactions;

  constructor({ tiers = [], transactions = [] } = {}) {
    for (const tier of tiers) this.#tiers.set(tier.slug, structuredClone(tier));
    this.#transactions = transactions.map((transaction) => {
      const normalized = normalizeCreditTransaction(transaction);
      this.#recordTransactionId(normalized.id);
      return normalized;
    });
    this.calls = [];
  }

  async healthcheck() {
    return { ok: true, service: "open-collective", fake: true };
  }

  async upsertTier(tier) {
    const slug = requiredString(tier.slug, "tier.slug");
    const existing = this.#tiers.get(slug);
    const stored = {
      id: existing?.id ?? `tier_fake_${String(this.#tiers.size + 1).padStart(4, "0")}`,
      slug,
      name: requiredString(tier.name, "tier.name"),
      description: requiredString(tier.description, "tier.description"),
      minimumAmountCents: positiveInteger(
        tier.minimumAmountCents,
        "tier.minimumAmountCents",
      ),
    };
    this.#tiers.set(slug, stored);
    this.calls.push(Object.freeze({ operation: "upsertTier", slug }));
    return structuredClone(stored);
  }

  async listCreditTransactions({ cursor, limit = 100, since } = {}) {
    positiveInteger(limit, "limit");
    const offset = parseCursor(cursor);
    const ordered = this.#transactions
      .filter((transaction) => (
        transaction.type === "CREDIT"
        && transaction.kind === "CONTRIBUTION"
      ))
      .filter((transaction) => (
        !since || Date.parse(transaction.createdAt) >= Date.parse(since)
      ))
      .sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id)
      ));
    const page = ordered.slice(offset, offset + limit);
    this.calls.push(Object.freeze({
      operation: "listCreditTransactions",
      cursor,
      limit,
      since,
    }));
    return {
      transactions: structuredClone(page),
      nextCursor: offset + limit < ordered.length ? String(offset + limit) : undefined,
    };
  }

  seedTransaction(transaction) {
    const normalized = normalizeCreditTransaction(transaction);
    this.#recordTransactionId(normalized.id);
    this.#transactions.push(normalized);
  }

  tiers() {
    return [...this.#tiers.values()]
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .map((tier) => structuredClone(tier));
  }

  #recordTransactionId(transactionId) {
    if (this.#transactionIds.has(transactionId)) {
      throw new Error(`Duplicate fake Open Collective transaction ID: ${transactionId}.`);
    }
    this.#transactionIds.add(transactionId);
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function parseCursor(cursor) {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) throw new TypeError("Invalid fake Open Collective cursor.");
  return Number(cursor);
}

function normalizeCreditTransaction(transaction) {
  if (!transaction || typeof transaction !== "object") {
    throw new TypeError("Fake Open Collective transaction must be an object.");
  }
  const grossCents = positiveInteger(
    transaction.grossCents,
    "transaction.grossCents",
  );
  const feesCents = nonnegativeInteger(
    transaction.feesCents,
    "transaction.feesCents",
  );
  const netCents = positiveInteger(
    transaction.netCents,
    "transaction.netCents",
  );
  if (grossCents !== feesCents + netCents) {
    throw new RangeError(
      "transaction.grossCents must equal feesCents + netCents.",
    );
  }
  return {
    id: requiredString(transaction.id, "transaction.id"),
    type: requiredString(transaction.type, "transaction.type"),
    kind: requiredString(transaction.kind, "transaction.kind"),
    createdAt: requiredString(transaction.createdAt, "transaction.createdAt"),
    grossCents,
    feesCents,
    netCents,
    order: {
      id: requiredString(transaction.order?.id, "transaction.order.id"),
      tier: transaction.order?.tier
        ? { slug: requiredString(transaction.order.tier.slug, "transaction.order.tier.slug") }
        : undefined,
    },
    account: {
      name: requiredString(transaction.account?.name, "transaction.account.name"),
      isIncognito: transaction.account?.isIncognito === true,
    },
  };
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer.`);
  }
  return value;
}
