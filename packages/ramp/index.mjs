import { createHash } from "node:crypto";
import {
  addCents,
  parseDollarAmount,
} from "#indiemath/shared";

const TRANSACTIONS_SCOPE = "transactions:read";
const SPEND_TRANSACTION_STATES = Object.freeze(["PENDING", "CLEARED"]);
const SPEND_TRANSACTION_STATE_SET = new Set(SPEND_TRANSACTION_STATES);

export class RampClient {
  #clientId;
  #clientSecret;
  #baseUrl;
  #fetch;
  #clock;
  #accessToken;
  #accessTokenExpiresAt = 0;

  constructor({
    clientId,
    clientSecret,
    baseUrl = "https://api.ramp.com",
    fetchImpl = globalThis.fetch,
    clock = () => new Date(),
  } = {}) {
    this.#clientId = requiredString(clientId, "clientId");
    this.#clientSecret = requiredString(clientSecret, "clientSecret");
    this.#baseUrl = normalizeBaseUrl(baseUrl);
    if (typeof fetchImpl !== "function") {
      throw new TypeError("fetchImpl must be a function.");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function.");
    this.#fetch = fetchImpl;
    this.#clock = clock;
  }

  async healthcheck({ signal } = {}) {
    await this.#getAccessToken(signal);
    return Object.freeze({
      ok: true,
      service: "ramp",
      baseUrl: this.#baseUrl,
      scope: TRANSACTIONS_SCOPE,
    });
  }

  async listCardTransactions({
    cardId,
    through,
    state,
    cursor,
    pageSize = 100,
    signal,
  } = {}) {
    const card = requiredString(cardId, "cardId");
    const cutoff = timestamp(through, "through");
    const transactionState = requiredString(state, "state");
    if (!SPEND_TRANSACTION_STATE_SET.has(transactionState)) {
      throw new TypeError(
        `state must be one of ${SPEND_TRANSACTION_STATES.join(", ")}.`,
      );
    }
    const limit = integerInRange(pageSize, 1, 100, "pageSize");
    const url = new URL(`${this.#baseUrl}/developer/v1/transactions`);
    url.searchParams.set("card_id", card);
    url.searchParams.set("state", transactionState);
    url.searchParams.set("to_date", cutoff);
    url.searchParams.set("order_by_date_asc", "true");
    url.searchParams.set("page_size", String(limit));
    if (cursor) url.searchParams.set("start", requiredString(cursor, "cursor"));

    const response = await this.#fetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${await this.#getAccessToken(signal)}`,
        "user-agent": "indiemath/0.0.0",
      },
      signal,
    });
    if (!response.ok) {
      throw new RampApiError({
        status: response.status,
        operation: `list ${transactionState.toLowerCase()} card transactions`,
        body: await response.text(),
      });
    }
    const payload = await response.json();
    if (!Array.isArray(payload?.data)) {
      throw new TypeError("Ramp transaction response is missing data.");
    }
    const transactions = payload.data.map((value, index) => (
      normalizeTransaction(value, card, `transactions[${index}]`)
    ));
    const nextCursor = payload.page?.next === null
      || payload.page?.next === undefined
      ? undefined
      : requiredString(payload.page.next, "Ramp page.next");
    return Object.freeze({
      data: Object.freeze(transactions),
      nextCursor,
    });
  }

  async #getAccessToken(signal) {
    const now = this.#nowMilliseconds();
    if (
      this.#accessToken
      && now < this.#accessTokenExpiresAt - 30_000
    ) {
      return this.#accessToken;
    }
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      scope: TRANSACTIONS_SCOPE,
    });
    const credentials = Buffer.from(
      `${this.#clientId}:${this.#clientSecret}`,
      "utf8",
    ).toString("base64");
    const response = await this.#fetch(
      `${this.#baseUrl}/developer/v1/token`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Basic ${credentials}`,
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "indiemath/0.0.0",
        },
        body,
        signal,
      },
    );
    if (!response.ok) {
      throw new RampApiError({
        status: response.status,
        operation: "create access token",
        body: await response.text(),
      });
    }
    const payload = await response.json();
    this.#accessToken = requiredString(
      payload.access_token,
      "Ramp access_token",
    );
    const expiresIn = Number(payload.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new TypeError("Ramp expires_in must be positive.");
    }
    this.#accessTokenExpiresAt = now + Math.floor(expiresIn * 1_000);
    return this.#accessToken;
  }

  #nowMilliseconds() {
    const value = this.#clock();
    const milliseconds = (
      value instanceof Date ? value : new Date(value)
    ).getTime();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
      throw new TypeError("clock must return a valid post-epoch timestamp.");
    }
    return milliseconds;
  }
}

export class RampApiError extends Error {
  constructor({ status, operation, body }) {
    super(`Ramp ${operation} failed with HTTP ${status}: ${safeBody(body)}`);
    this.name = "RampApiError";
    this.status = status;
    this.operation = operation;
  }
}

export async function collectRampCardTransactions(
  client,
  request,
) {
  if (!client || typeof client.listCardTransactions !== "function") {
    throw new TypeError("client must provide listCardTransactions.");
  }
  const transactionsById = new Map();
  for (const state of SPEND_TRANSACTION_STATES) {
    const seenStateIds = new Set();
    const seenCursors = new Set();
    let cursor;
    do {
      const page = await client.listCardTransactions({
        ...request,
        state,
        cursor,
      });
      for (const transaction of page.data) {
        if (seenStateIds.has(transaction.id)) {
          throw new TypeError(`Ramp transaction ${transaction.id} was repeated.`);
        }
        seenStateIds.add(transaction.id);
        const existing = transactionsById.get(transaction.id);
        if (!existing || transaction.state === "CLEARED") {
          transactionsById.set(transaction.id, transaction);
        }
      }
      cursor = page.nextCursor;
      if (cursor && seenCursors.has(cursor)) {
        throw new TypeError("Ramp pagination repeated the same cursor.");
      }
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
  }
  return Object.freeze([...transactionsById.values()]);
}

export function buildRampSpendSnapshot({
  cardId,
  through,
  transactions,
} = {}) {
  const card = requiredString(cardId, "cardId");
  const cutoff = timestamp(through, "through");
  if (!Array.isArray(transactions)) {
    throw new TypeError("transactions must be an array.");
  }
  const normalized = transactions.map((transaction, index) => (
    normalizeTransaction(transaction, card, `transactions[${index}]`)
  )).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(normalized.map((transaction) => transaction.id)).size
    !== normalized.length) {
    throw new TypeError("transactions contains duplicate Ramp IDs.");
  }
  const actualSpendCents = normalized.reduce(
    (total, transaction) => addCents(total, transaction.amountCents),
    0,
  );
  if (actualSpendCents < 0) {
    throw new RangeError("Ramp pending and cleared card spend cannot be negative.");
  }
  const source = normalized.map((transaction) => Object.freeze({
    id: transaction.id,
    amountCents: transaction.amountCents,
  }));
  return Object.freeze({
    cardFingerprint: sha256(card),
    cutoffAt: cutoff,
    actualSpendCents,
    sourceTransactionCount: source.length,
    sourceHash: sha256(JSON.stringify(source)),
  });
}

function normalizeTransaction(value, cardId, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const id = requiredString(value.id, `${label}.id`);
  const card = requiredString(value.card_id ?? value.cardId, `${label}.card_id`);
  if (card !== cardId) throw new TypeError(`${label} belongs to another card.`);
  if (!SPEND_TRANSACTION_STATE_SET.has(value.state)) {
    throw new TypeError(
      `${label}.state must be one of ${SPEND_TRANSACTION_STATES.join(", ")}.`,
    );
  }
  const currency = requiredString(
    value.currency_code ?? value.currencyCode,
    `${label}.currency_code`,
  );
  if (currency !== "USD") {
    throw new TypeError(`${label} must use the Ramp card's USD amount.`);
  }
  const rawAmount = value.amountCents === undefined
    ? value.amount
    : undefined;
  const amountCents = value.amountCents === undefined
    ? parseDollarAmount(String(rawAmount), { allowNegative: true })
    : cents(value.amountCents, `${label}.amountCents`);
  return Object.freeze({
    id,
    cardId: card,
    state: value.state,
    currencyCode: "USD",
    amountCents,
  });
}

function cents(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be integer cents.`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeBaseUrl(value) {
  const url = new URL(requiredString(value, "baseUrl"));
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("baseUrl must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}

function timestamp(value, label) {
  const text = requiredString(value, label);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be a timestamp.`);
  return new Date(parsed).toISOString();
}

function integerInRange(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value.trim();
}

function safeBody(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, 500) : "empty response";
}
