const DEFAULT_BASE_URL = "https://api.stripe.com/v1/";

export class StripeApiError extends Error {
  constructor(message, { status, code, type, definitive = false, cause } = {}) {
    super(message, { cause });
    this.name = "StripeApiError";
    this.status = status;
    this.code = code;
    this.type = type;
    this.definitive = definitive;
  }
}

export class StripeClient {
  #secretKey;
  #accountId;
  #baseUrl;
  #fetch;

  constructor({
    secretKey,
    accountId,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
  }) {
    this.#secretKey = requiredString(secretKey, "secretKey");
    this.#accountId = accountId === undefined
      ? undefined
      : stripeObjectId(accountId, "acct_", "accountId");
    this.#baseUrl = validBaseUrl(baseUrl);
    if (typeof fetchImpl !== "function") {
      throw new TypeError("fetchImpl must be a function.");
    }
    this.#fetch = fetchImpl;
  }

  async healthcheck() {
    const balance = await this.#request("GET", "balance");
    const currencies = [...new Set([
      ...(Array.isArray(balance.available) ? balance.available : []),
      ...(Array.isArray(balance.pending) ? balance.pending : []),
    ].map((item) => item?.currency).filter(Boolean))].sort();
    return Object.freeze({
      ok: true,
      service: "stripe",
      accountId: this.#accountId,
      livemode: balance.livemode === true,
      currencies: Object.freeze(currencies),
    });
  }

  async refundCharge({
    chargeId,
    amountCents,
    idempotencyReference,
  }) {
    const charge = stripeObjectId(chargeId, "ch_", "chargeId");
    const amount = positiveInteger(amountCents, "amountCents");
    const idempotencyKey = requiredString(
      idempotencyReference,
      "idempotencyReference",
    );
    const refund = await this.#request("POST", "refunds", {
      form: {
        charge,
        amount: String(amount),
      },
      idempotencyKey,
    });
    return Object.freeze({
      outcome: "refunded",
      providerReference: stripeObjectId(refund.id, "re_", "refund.id"),
      chargeId: charge,
      amountCents: positiveInteger(refund.amount, "refund.amount"),
      status: refund.status,
    });
  }

  async listDisputes({
    cursor,
    since,
    through,
    limit = 100,
  } = {}) {
    const pageSize = boundedPageSize(limit);
    const params = new URLSearchParams({ limit: String(pageSize) });
    if (cursor) params.set("starting_after", requiredString(cursor, "cursor"));
    if (since) {
      params.set(
        "created[gte]",
        String(Math.floor(Date.parse(timestamp(since, "since")) / 1_000)),
      );
    }
    if (through) {
      params.set(
        "created[lte]",
        String(Math.floor(Date.parse(timestamp(through, "through")) / 1_000)),
      );
    }
    params.append("expand[]", "data.charge");
    const page = await this.#request("GET", `disputes?${params}`);
    const disputes = page.data.map((dispute) => Object.freeze({
      id: stripeObjectId(dispute.id, "dp_", "dispute.id"),
      chargeId: stripeObjectId(
        typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id,
        "ch_",
        "dispute.charge",
      ),
      amountCents: positiveInteger(dispute.amount, "dispute.amount"),
      status: requiredString(dispute.status, "dispute.status"),
      createdAt: epochTimestamp(dispute.created, "dispute.created"),
      source: sanitizeDispute(dispute),
    }));
    return Object.freeze({
      disputes: Object.freeze(disputes),
      nextCursor: page.has_more && disputes.length
        ? disputes.at(-1).id
        : undefined,
    });
  }

  async listPaidPayoutSettlementRecords({
    cursor,
    through,
    limit = 100,
  } = {}) {
    const pageSize = boundedPageSize(limit);
    const cutoff = through === undefined ? undefined : timestamp(through, "through");
    const params = new URLSearchParams({
      limit: String(pageSize),
      status: "paid",
    });
    if (cursor) params.set("starting_after", requiredString(cursor, "cursor"));
    if (cutoff) {
      params.set(
        "arrival_date[lte]",
        String(Math.floor(Date.parse(cutoff) / 1_000)),
      );
    }
    const payoutPage = await this.#request("GET", `payouts?${params}`);
    const records = [];
    for (const payout of payoutPage.data) {
      const payoutId = stripeObjectId(payout.id, "po_", "payout.id");
      records.push(Object.freeze({
        providerReference: payoutId,
        providerKind: "stripe",
        recordKind: "payout",
        amountCents: positiveInteger(payout.amount, "payout.amount"),
        occurredAt: epochTimestamp(
          payout.arrival_date ?? payout.created,
          "payout.arrival_date",
        ),
        payoutReference: payoutId,
        chargeId: undefined,
        source: sanitizePayout(payout),
      }));
      records.push(...await this.#listPayoutBalanceTransactions(payoutId));
    }
    return Object.freeze({
      records: Object.freeze(records),
      nextCursor: payoutPage.has_more && payoutPage.data.length
        ? payoutPage.data.at(-1).id
        : undefined,
    });
  }

  async #listPayoutBalanceTransactions(payoutId) {
    const records = [];
    let cursor;
    do {
      const params = new URLSearchParams({
        payout: payoutId,
        limit: "100",
      });
      if (cursor) params.set("starting_after", cursor);
      params.append("expand[]", "data.source");
      const page = await this.#request(
        "GET",
        `balance_transactions?${params}`,
      );
      for (const transaction of page.data) {
        const normalized = normalizeBalanceTransaction(transaction, payoutId);
        if (normalized) records.push(normalized);
      }
      cursor = page.has_more && page.data.length
        ? page.data.at(-1).id
        : undefined;
    } while (cursor);
    return records;
  }

  async #request(method, pathname, { form, idempotencyKey } = {}) {
    const url = new URL(pathname, this.#baseUrl);
    let response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.#secretKey}`,
          ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        ...(form ? { body: new URLSearchParams(form) } : {}),
      });
    } catch (error) {
      throw new StripeApiError("Stripe request failed.", { cause: error });
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new StripeApiError("Stripe returned invalid JSON.", {
        status: response.status,
        cause: error,
      });
    }
    if (!response.ok) {
      const detail = payload.error;
      throw new StripeApiError(
        detail?.message || `Stripe request failed (${response.status}).`,
        {
          status: response.status,
          code: detail?.code,
          type: detail?.type,
          definitive: response.status >= 400
            && response.status < 500
            && ![408, 409, 429].includes(response.status),
        },
      );
    }
    return payload;
  }
}

export function extractStripeChargeId(paymentProcessorUrl) {
  if (typeof paymentProcessorUrl !== "string") return undefined;
  return paymentProcessorUrl.match(/\b(ch_[A-Za-z0-9]+)\b/)?.[1];
}

function normalizeBalanceTransaction(transaction, payoutId) {
  const classification = classifyBalanceTransaction(transaction);
  if (!classification) return undefined;
  const amount = classification === "contribution"
    ? Math.abs(integer(transaction.net, "balance_transaction.net"))
    : -Math.abs(integer(transaction.amount, "balance_transaction.amount"));
  const source = transaction.source;
  const chargeId = chargeIdFromSource(source);
  return Object.freeze({
    providerReference: requiredString(transaction.id, "balance_transaction.id"),
    providerKind: "stripe",
    recordKind: classification,
    amountCents: amount,
    occurredAt: epochTimestamp(
      transaction.available_on ?? transaction.created,
      "balance_transaction.available_on",
    ),
    payoutReference: payoutId,
    chargeId,
    source: sanitizeBalanceTransaction(transaction),
  });
}

function sanitizePayout(payout) {
  return Object.freeze({
    id: payout.id,
    object: payout.object,
    amount: payout.amount,
    arrival_date: payout.arrival_date,
    created: payout.created,
    currency: payout.currency,
    status: payout.status,
    type: payout.type,
  });
}

function sanitizeBalanceTransaction(transaction) {
  const source = transaction.source;
  return Object.freeze({
    id: transaction.id,
    object: transaction.object,
    amount: transaction.amount,
    available_on: transaction.available_on,
    created: transaction.created,
    currency: transaction.currency,
    fee: transaction.fee,
    net: transaction.net,
    reporting_category: transaction.reporting_category,
    status: transaction.status,
    type: transaction.type,
    source: typeof source === "string"
      ? source
      : source
        ? Object.freeze({
            id: source.id,
            object: source.object,
            charge: typeof source.charge === "string"
              ? source.charge
              : source.charge?.id,
            source: typeof source.source === "string"
              ? source.source
              : source.source?.id,
          })
        : undefined,
  });
}

function sanitizeDispute(dispute) {
  return Object.freeze({
    id: dispute.id,
    object: dispute.object,
    amount: dispute.amount,
    charge: typeof dispute.charge === "string"
      ? dispute.charge
      : dispute.charge?.id,
    created: dispute.created,
    currency: dispute.currency,
    status: dispute.status,
  });
}

function classifyBalanceTransaction(transaction) {
  const category = transaction.reporting_category;
  const type = transaction.type;
  if (category === "charge" || ["charge", "payment"].includes(type)) {
    return "contribution";
  }
  if (
    category === "refund"
    || ["refund", "payment_refund"].includes(type)
  ) {
    return "refund";
  }
  if (
    category === "dispute"
    || ["adjustment", "dispute"].includes(type)
    && chargeIdFromSource(transaction.source)
  ) {
    return "dispute";
  }
  return undefined;
}

function chargeIdFromSource(source) {
  if (typeof source === "string") {
    return source.startsWith("ch_") ? source : undefined;
  }
  const candidates = [
    source?.charge,
    source?.source,
    source?.payment_intent?.latest_charge,
  ];
  for (const candidate of candidates) {
    const id = typeof candidate === "string" ? candidate : candidate?.id;
    if (typeof id === "string" && id.startsWith("ch_")) return id;
  }
  if (typeof source?.id === "string" && source.id.startsWith("ch_")) {
    return source.id;
  }
  return undefined;
}

function validBaseUrl(value) {
  let url;
  try {
    url = new URL(requiredString(value, "baseUrl"));
  } catch {
    throw new TypeError("baseUrl must be a valid HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("baseUrl must use HTTP or HTTPS.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function stripeObjectId(value, prefix, label) {
  const id = requiredString(value, label);
  if (!id.startsWith(prefix)) {
    throw new TypeError(`${label} must start with ${prefix}.`);
  }
  return id;
}

function timestamp(value, label) {
  const text = requiredString(value, label);
  const epoch = Date.parse(text);
  if (!Number.isFinite(epoch)) throw new TypeError(`${label} must be a timestamp.`);
  return new Date(epoch).toISOString();
}

function epochTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be epoch seconds.`);
  }
  return new Date(value * 1_000).toISOString();
}

function boundedPageSize(value) {
  const size = positiveInteger(value, "limit");
  if (size > 100) throw new RangeError("limit cannot exceed 100.");
  return size;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer.`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value.trim();
}
