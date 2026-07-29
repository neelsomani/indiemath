const DEFAULT_PAGE_SIZE = 100;
const OPEN_COLLECTIVE_ORIGIN = "https://opencollective.com";

export class OpenCollectiveGraphQLError extends Error {
  constructor(message, {
    operation,
    status,
    errors,
    definitive = false,
    cause,
  } = {}) {
    super(message, { cause });
    this.name = "OpenCollectiveGraphQLError";
    this.operation = operation;
    this.status = status;
    this.errors = errors;
    this.definitive = definitive;
  }
}

export function createOpenCollectiveClient(config, options) {
  if (!config || config.kind !== "graphql") {
    throw new TypeError("A production Open Collective GraphQL config is required.");
  }
  return new OpenCollectiveGraphQLClient({ ...config, ...options });
}

export class OpenCollectiveGraphQLClient {
  #endpoint;
  #collectiveSlug;
  #apiToken;
  #fetch;

  constructor({
    endpoint,
    collectiveSlug,
    apiToken,
    fetchImpl = globalThis.fetch,
  }) {
    this.#endpoint = validHttpUrl(endpoint, "endpoint");
    this.#collectiveSlug = requiredString(collectiveSlug, "collectiveSlug");
    this.#apiToken = requiredString(apiToken, "apiToken");
    if (typeof fetchImpl !== "function") {
      throw new TypeError("fetchImpl must be a function.");
    }
    this.#fetch = fetchImpl;
  }

  async healthcheck() {
    const data = await this.#request("Healthcheck", `
      query Healthcheck($slug: String!) {
        account(slug: $slug) {
          id
          slug
          name
          type
          currency
        }
        me {
          id
        }
      }
    `, { slug: this.#collectiveSlug });
    if (!data.account) {
      throw new OpenCollectiveGraphQLError(
        `Open Collective account ${this.#collectiveSlug} was not found.`,
        { operation: "Healthcheck" },
      );
    }
    return Object.freeze({
      ok: true,
      service: "open-collective",
      accountId: data.account.id,
      collectiveSlug: data.account.slug,
      accountType: data.account.type,
      currency: data.account.currency,
      authenticated: Boolean(data.me?.id),
    });
  }

  async listTiers({ cursor, limit = DEFAULT_PAGE_SIZE } = {}) {
    const pageSize = positiveInteger(limit, "limit");
    const offset = parseOffsetCursor(cursor);
    const data = await this.#request("ListTiers", `
      query ListTiers($slug: String!, $limit: Int!, $offset: Int!) {
        account(slug: $slug) {
          id
          currency
          ... on Organization {
            tiers(limit: $limit, offset: $offset, onlyValid: true) {
              totalCount
              nodes {
                id
                legacyId
                slug
                name
                description
                type
                amountType
                frequency
                minimumAmount {
                  valueInCents
                  currency
                }
                useStandalonePage
              }
            }
          }
          ... on Collective {
            tiers(limit: $limit, offset: $offset, onlyValid: true) {
              totalCount
              nodes {
                id
                legacyId
                slug
                name
                description
                type
                amountType
                frequency
                minimumAmount {
                  valueInCents
                  currency
                }
                useStandalonePage
              }
            }
          }
        }
      }
    `, {
      slug: this.#collectiveSlug,
      limit: pageSize,
      offset,
    });
    if (!data.account?.tiers) {
      throw new OpenCollectiveGraphQLError(
        `Account ${this.#collectiveSlug} does not expose contribution tiers.`,
        { operation: "ListTiers" },
      );
    }
    const totalCount = nonnegativeInteger(
      data.account.tiers.totalCount,
      "tiers.totalCount",
    );
    const tiers = data.account.tiers.nodes.map((tier) => normalizeTier(
      tier,
      this.#collectiveSlug,
    ));
    return Object.freeze({
      tiers: Object.freeze(tiers),
      nextCursor: offset + tiers.length < totalCount
        ? String(offset + tiers.length)
        : undefined,
    });
  }

  async listAllTiers() {
    const tiers = [];
    let cursor;
    do {
      const page = await this.listTiers({ cursor });
      tiers.push(...page.tiers);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return Object.freeze(tiers);
  }

  async upsertTier(specification) {
    const spec = normalizeTierSpecification(specification);
    let existing;
    if (spec.providerTierId) {
      existing = { id: spec.providerTierId };
    } else {
      const tiers = await this.listAllTiers();
      existing = tiers.find((tier) => (
        tier.description.includes(spec.identityMarker)
        || tier.slug === spec.slug
      ));
    }

    const tierInput = {
      ...(existing ? { id: existing.id } : {}),
      name: spec.name,
      description: spec.description,
      button: "Contribute",
      type: "DONATION",
      amountType: "FLEXIBLE",
      frequency: "FLEXIBLE",
      minimumAmount: {
        valueInCents: spec.minimumAmountCents,
        currency: "USD",
      },
      useStandalonePage: true,
    };
    const operation = existing ? "EditTier" : "CreateTier";
    const data = existing
      ? await this.#request(operation, `
          mutation EditTier($tier: TierUpdateInput!) {
            editTier(tier: $tier) {
              id
              legacyId
              slug
              name
              description
              type
              amountType
              frequency
              minimumAmount {
                valueInCents
                currency
              }
              useStandalonePage
            }
          }
        `, { tier: tierInput })
      : await this.#request(operation, `
          mutation CreateTier(
            $account: AccountReferenceInput!
            $tier: TierCreateInput!
          ) {
            createTier(account: $account, tier: $tier) {
              id
              legacyId
              slug
              name
              description
              type
              amountType
              frequency
              minimumAmount {
                valueInCents
                currency
              }
              useStandalonePage
            }
          }
        `, {
          account: { slug: this.#collectiveSlug },
          tier: tierInput,
        });
    const tier = normalizeTier(
      existing ? data.editTier : data.createTier,
      this.#collectiveSlug,
    );
    assertTierIdentityInSlug(tier.slug, spec.problemId, spec.direction);
    return Object.freeze({
      ...tier,
      outcome: existing ? "updated" : "created",
    });
  }

  async upsertTiers(specifications, { batchSize = 20 } = {}) {
    if (!Array.isArray(specifications)) {
      throw new TypeError("specifications must be an array.");
    }
    const size = positiveInteger(batchSize, "batchSize");
    if (size > 25) throw new RangeError("batchSize cannot exceed 25.");
    const specs = specifications.map(normalizeTierSpecification);
    const remoteTiers = await this.listAllTiers();
    const prepared = specs.map((spec, index) => {
      const existing = spec.providerTierId
        ? remoteTiers.find((tier) => tier.id === spec.providerTierId)
        : remoteTiers.find((tier) => (
            tier.description.includes(spec.identityMarker)
            || tier.slug === spec.slug
          ));
      return { spec, existing, index };
    });
    const results = Array(specs.length);
    const mutations = [];
    for (const item of prepared) {
      if (item.existing && tierMatchesSpecification(item.existing, item.spec)) {
        results[item.index] = Object.freeze({
          ...item.existing,
          outcome: "unchanged",
        });
      } else {
        mutations.push(item);
      }
    }
    for (let offset = 0; offset < mutations.length; offset += size) {
      const batch = mutations.slice(offset, offset + size);
      const batchResults = await this.#upsertTierBatch(batch);
      for (const [index, result] of batchResults.entries()) {
        results[batch[index].index] = result;
      }
    }
    return Object.freeze(results);
  }

  async listCreditTransactions({
    cursor,
    limit = DEFAULT_PAGE_SIZE,
    since,
  } = {}) {
    const pageSize = positiveInteger(limit, "limit");
    const offset = parseOffsetCursor(cursor);
    const dateFrom = since === undefined ? undefined : timestamp(since, "since");
    // Offset pagination is insert-safe only while CREATED_AT stays ascending:
    // concurrent transactions append after the current offset instead of shifting it.
    const data = await this.#request("ListCreditTransactions", `
      query ListCreditTransactions(
        $account: AccountReferenceInput!
        $limit: Int!
        $offset: Int!
        $dateFrom: DateTime
      ) {
        transactions(
          account: [$account]
          limit: $limit
          offset: $offset
          type: CREDIT
          kind: [CONTRIBUTION]
          dateFrom: $dateFrom
          includeHost: false
          includeRegularTransactions: true
          includeIncognitoTransactions: true
          orderBy: { field: CREATED_AT, direction: ASC }
        ) {
          totalCount
          nodes {
            id
            type
            kind
            createdAt
            clearedAt
            paymentProcessorUrl
            isRefunded
            isDisputed
            amount {
              valueInCents
              currency
            }
            netAmount(
              fetchHostFee: true
              fetchPaymentProcessorFee: true
              fetchTax: true
            ) {
              valueInCents
              currency
            }
            platformFee {
              valueInCents
              currency
            }
            hostFee(fetchHostFee: true) {
              valueInCents
              currency
            }
            paymentProcessorFee(fetchPaymentProcessorFee: true) {
              valueInCents
              currency
            }
            order {
              id
              tier {
                id
                slug
              }
            }
            fromAccount {
              id
              name
              slug
              isIncognito
            }
            oppositeAccount {
              id
              name
              slug
              isIncognito
            }
          }
        }
      }
    `, {
      account: { slug: this.#collectiveSlug },
      limit: pageSize,
      offset,
      dateFrom,
    });
    const totalCount = nonnegativeInteger(
      data.transactions.totalCount,
      "transactions.totalCount",
    );
    const transactions = data.transactions.nodes
      .map(normalizeCreditTransaction)
      .sort(compareTransactions);
    return Object.freeze({
      transactions: Object.freeze(transactions),
      nextCursor: offset + transactions.length < totalCount
        ? String(offset + transactions.length)
        : undefined,
    });
  }

  async getTransaction(transactionId) {
    const id = requiredString(transactionId, "transactionId");
    const data = await this.#request("GetTransaction", `
      query GetTransaction($transaction: TransactionReferenceInput!) {
        transaction(transaction: $transaction) {
          id
          type
          kind
          createdAt
          isRefunded
          isRefund
          isDisputed
          refundTransaction {
            id
          }
        }
      }
    `, { transaction: { id } });
    return data.transaction ? Object.freeze(data.transaction) : undefined;
  }

  async refundTransaction({
    transactionId,
    cancelRecurringContribution = false,
    message,
  }) {
    const id = requiredString(transactionId, "transactionId");
    const current = await this.getTransaction(id);
    if (!current) {
      throw new OpenCollectiveGraphQLError(
        `Open Collective transaction ${id} was not found.`,
        { operation: "RefundTransaction" },
      );
    }
    if (current.isRefunded) {
      return Object.freeze({
        outcome: "duplicate",
        providerReference: current.refundTransaction?.id ?? `oc-refund:${id}`,
      });
    }
    const data = await this.#request("RefundTransaction", `
      mutation RefundTransaction(
        $transaction: TransactionReferenceInput!
        $cancelRecurringContribution: Boolean!
        $message: String
      ) {
        refundTransaction(
          transaction: $transaction
          cancelRecurringContribution: $cancelRecurringContribution
          messageForContributor: $message
        ) {
          id
        }
      }
    `, {
      transaction: { id },
      cancelRecurringContribution: cancelRecurringContribution === true,
      message: optionalString(message),
    });
    return Object.freeze({
      outcome: "refunded",
      providerReference: requiredString(
        data.refundTransaction?.id,
        "refundTransaction.id",
      ),
    });
  }

  async #request(operation, query, variables) {
    let response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Personal-Token": this.#apiToken,
        },
        body: JSON.stringify({ operationName: operation, query, variables }),
      });
    } catch (error) {
      throw new OpenCollectiveGraphQLError(
        `Open Collective ${operation} request failed.`,
        { operation, cause: error },
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new OpenCollectiveGraphQLError(
        `Open Collective ${operation} returned invalid JSON.`,
        { operation, status: response.status, cause: error },
      );
    }
    if (!response.ok || payload.errors?.length) {
      const definitive = (
        response.status >= 400
        && response.status < 500
        && ![408, 409, 429].includes(response.status)
      ) || payload.errors?.some((error) => [
        "BAD_USER_INPUT",
        "FORBIDDEN",
        "GRAPHQL_VALIDATION_FAILED",
        "NOT_FOUND",
        "UNAUTHENTICATED",
      ].includes(error.extensions?.code));
      throw new OpenCollectiveGraphQLError(
        `Open Collective ${operation} failed${response.ok ? "" : ` (${response.status})`}.`,
        {
          operation,
          status: response.status,
          errors: payload.errors,
          definitive,
        },
      );
    }
    if (!payload.data) {
      throw new OpenCollectiveGraphQLError(
        `Open Collective ${operation} returned no data.`,
        { operation, status: response.status },
      );
    }
    return payload.data;
  }

  async #upsertTierBatch(items) {
    if (!items.length) return [];
    const hasCreate = items.some((item) => !item.existing);
    const definitions = hasCreate ? ["$account: AccountReferenceInput!"] : [];
    const fields = [];
    const variables = hasCreate
      ? { account: { slug: this.#collectiveSlug } }
      : {};
    for (const [index, item] of items.entries()) {
      const variable = `tier${index}`;
      const alias = `result${index}`;
      definitions.push(
        `$${variable}: ${item.existing ? "TierUpdateInput" : "TierCreateInput"}!`,
      );
      variables[variable] = tierMutationInput(item.spec, item.existing?.id);
      fields.push(item.existing
        ? `${alias}: editTier(tier: $${variable}) { ${TIER_RESPONSE_FIELDS} }`
        : `${alias}: createTier(account: $account, tier: $${variable}) { `
          + `${TIER_RESPONSE_FIELDS} }`);
    }
    const data = await this.#request(
      "UpsertTierBatch",
      `mutation UpsertTierBatch(${definitions.join(", ")}) {
        ${fields.join("\n")}
      }`,
      variables,
    );
    return items.map((item, index) => {
      const tier = normalizeTier(data[`result${index}`], this.#collectiveSlug);
      assertTierIdentityInSlug(
        tier.slug,
        item.spec.problemId,
        item.spec.direction,
      );
      return Object.freeze({
        ...tier,
        outcome: item.existing ? "updated" : "created",
      });
    });
  }
}

export function openCollectiveCheckoutUrl({
  collectiveSlug,
  tierSlug,
  legacyId,
}) {
  const collective = encodeURIComponent(requiredString(
    collectiveSlug,
    "collectiveSlug",
  ));
  const slug = encodeURIComponent(requiredString(tierSlug, "tierSlug"));
  const suffix = legacyId === undefined || legacyId === null
    ? slug
    : `${slug}-${positiveInteger(legacyId, "legacyId")}`;
  return `${OPEN_COLLECTIVE_ORIGIN}/${collective}/contribute/${suffix}/checkout`;
}

function normalizeTierSpecification(specification) {
  if (!specification || typeof specification !== "object") {
    throw new TypeError("tier specification must be an object.");
  }
  const problemId = requiredString(specification.problemId, "tier.problemId");
  const direction = directionValue(specification.direction, "tier.direction");
  const identityMarker = requiredString(
    specification.identityMarker,
    "tier.identityMarker",
  );
  return Object.freeze({
    problemId,
    direction,
    slug: requiredString(specification.slug, "tier.slug"),
    name: requiredString(specification.name, "tier.name"),
    description: requiredString(specification.description, "tier.description"),
    identityMarker,
    minimumAmountCents: positiveInteger(
      specification.minimumAmountCents,
      "tier.minimumAmountCents",
    ),
    providerTierId: specification.providerTierId === undefined
      ? undefined
      : requiredString(specification.providerTierId, "tier.providerTierId"),
  });
}

const TIER_RESPONSE_FIELDS = `
  id
  legacyId
  slug
  name
  description
  type
  amountType
  frequency
  minimumAmount {
    valueInCents
    currency
  }
  useStandalonePage
`;

function tierMutationInput(spec, providerTierId) {
  return {
    ...(providerTierId ? { id: providerTierId } : {}),
    name: spec.name,
    description: spec.description,
    button: "Contribute",
    type: "DONATION",
    amountType: "FLEXIBLE",
    frequency: "FLEXIBLE",
    minimumAmount: {
      valueInCents: spec.minimumAmountCents,
      currency: "USD",
    },
    useStandalonePage: true,
  };
}

function tierMatchesSpecification(tier, spec) {
  return (
    tier.name === spec.name
    && tier.description === spec.description
    && tier.type === "DONATION"
    && tier.amountType === "FLEXIBLE"
    && tier.frequency === "FLEXIBLE"
    && tier.minimumAmountCents === spec.minimumAmountCents
    && tier.currency === "USD"
    && tier.useStandalonePage === true
  );
}

function normalizeTier(tier, collectiveSlug) {
  if (!tier || typeof tier !== "object") {
    throw new TypeError("Open Collective tier response must be an object.");
  }
  const legacyId = tier.legacyId === null || tier.legacyId === undefined
    ? undefined
    : positiveInteger(tier.legacyId, "tier.legacyId");
  const slug = requiredString(tier.slug, "tier.slug");
  const minimumAmountCents = tier.minimumAmount
    ? integerCents(
        tier.minimumAmount.valueInCents,
        "tier.minimumAmount.valueInCents",
        { positive: true },
      )
    : 0;
  return Object.freeze({
    id: requiredString(tier.id, "tier.id"),
    legacyId,
    slug,
    name: requiredString(tier.name, "tier.name"),
    description: tier.description ?? "",
    type: requiredString(tier.type, "tier.type"),
    amountType: requiredString(tier.amountType, "tier.amountType"),
    frequency: requiredString(tier.frequency, "tier.frequency"),
    minimumAmountCents,
    currency: tier.minimumAmount?.currency
      ? requiredString(tier.minimumAmount.currency, "tier.minimumAmount.currency")
      : "USD",
    useStandalonePage: tier.useStandalonePage === true,
    checkoutUrl: openCollectiveCheckoutUrl({
      collectiveSlug,
      tierSlug: slug,
      legacyId,
    }),
  });
}

function normalizeCreditTransaction(transaction) {
  if (!transaction || typeof transaction !== "object") {
    throw new TypeError("Open Collective transaction must be an object.");
  }
  const id = requiredString(transaction.id, "transaction.id");
  const type = requiredString(transaction.type, "transaction.type");
  const kind = requiredString(transaction.kind, "transaction.kind");
  if (type !== "CREDIT" || kind !== "CONTRIBUTION") {
    throw new TypeError(`Transaction ${id} is not a contribution credit.`);
  }
  const grossCents = integerCents(
    transaction.amount?.valueInCents,
    "transaction.amount.valueInCents",
    { positive: true },
  );
  const netCents = integerCents(
    transaction.netAmount?.valueInCents,
    "transaction.netAmount.valueInCents",
    { positive: true },
  );
  const feesCents = grossCents - netCents;
  if (!Number.isSafeInteger(feesCents) || feesCents < 0) {
    throw new RangeError(
      `Transaction ${id} net amount cannot exceed its gross amount.`,
    );
  }
  const donor = transaction.fromAccount ?? transaction.oppositeAccount;
  const isIncognito = donor?.isIncognito === true;
  const donorName = isIncognito
    ? "anonymous"
    : optionalString(donor?.name) ?? "Guest";
  return Object.freeze({
    id,
    type,
    kind,
    createdAt: timestamp(transaction.createdAt, "transaction.createdAt"),
    clearedAt: transaction.clearedAt
      ? timestamp(transaction.clearedAt, "transaction.clearedAt")
      : undefined,
    paymentProcessorUrl: optionalString(transaction.paymentProcessorUrl),
    grossCents,
    feesCents,
    netCents,
    order: Object.freeze({
      id: optionalString(transaction.order?.id) ?? `unattributed:${id}`,
      tier: transaction.order?.tier
        ? Object.freeze({
            id: requiredString(transaction.order.tier.id, "transaction.order.tier.id"),
            slug: requiredString(
              transaction.order.tier.slug,
              "transaction.order.tier.slug",
            ),
          })
        : undefined,
    }),
    account: Object.freeze({
      name: donorName,
      isIncognito,
    }),
    isRefunded: transaction.isRefunded === true,
    isDisputed: transaction.isDisputed === true,
  });
}

function assertTierIdentityInSlug(slug, problemId, direction) {
  const normalized = slug.toLowerCase();
  if (
    !normalized.includes(problemId.toLowerCase())
    || !normalized.includes(direction.toLowerCase())
  ) {
    throw new OpenCollectiveGraphQLError(
      `Open Collective generated slug ${slug} without ${problemId}/${direction}.`,
      { operation: "UpsertTier" },
    );
  }
}

function compareTransactions(left, right) {
  return left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

function validHttpUrl(value, label) {
  let url;
  try {
    url = new URL(requiredString(value, label));
  } catch {
    throw new TypeError(`${label} must be a valid HTTP(S) URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError(`${label} must use HTTP or HTTPS.`);
  }
  return url.toString();
}

function parseOffsetCursor(cursor) {
  if (cursor === undefined) return 0;
  if (typeof cursor !== "string" || !/^\d+$/.test(cursor)) {
    throw new TypeError("cursor must be an unsigned decimal offset.");
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new RangeError("cursor is too large.");
  return offset;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value.trim();
}

function optionalString(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError("Expected a string.");
  return value.trim() || undefined;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer.`);
  }
  return value;
}

function integerCents(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new TypeError(`${label} must be ${positive ? "positive " : ""}integer cents.`);
  }
  return value;
}

function directionValue(value, label) {
  if (!["prove", "disprove"].includes(value)) {
    throw new TypeError(`${label} must be prove or disprove.`);
  }
  return value;
}

function timestamp(value, label) {
  const text = requiredString(value, label);
  const epoch = Date.parse(text);
  if (!Number.isFinite(epoch)) throw new TypeError(`${label} must be an ISO timestamp.`);
  return new Date(epoch).toISOString();
}
