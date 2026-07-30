#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRampSpendSnapshot,
  collectRampCardTransactions,
  RampClient,
} from "#indiemath/ramp";
import { syncRampSpendOnce } from "#indiemath/intake-publisher";

const cardId = "card-anthropic";
const through = "2026-07-29T12:00:00.000Z";

test("Ramp client uses least-privilege OAuth and paginates pending and cleared card transactions",
  async () => {
    const calls = [];
    const fetchImpl = async (input, options = {}) => {
      const url = new URL(input);
      calls.push({ url, options });
      if (url.pathname === "/developer/v1/token") {
        return Response.json({
          access_token: "ramp-access-token",
          expires_in: 3_600,
        });
      }
      assert.equal(options.headers.authorization, "Bearer ramp-access-token");
      const state = url.searchParams.get("state");
      if (state === "PENDING" && !url.searchParams.has("start")) {
        return Response.json({
          data: [
            transaction("txn-pending", "4.00", "PENDING"),
            transaction("txn-transition", "6.00", "PENDING"),
          ],
          page: { next: "pending-cursor-2" },
        });
      }
      if (state === "PENDING") {
        assert.equal(url.searchParams.get("start"), "pending-cursor-2");
        return Response.json({
          data: [transaction("txn-pending-credit", "-1.00", "PENDING")],
          page: { next: null },
        });
      }
      if (!url.searchParams.has("start")) {
        return Response.json({
          data: [
            transaction("txn-1", "12.34"),
            transaction("txn-transition", "6.00"),
          ],
          page: { next: "cleared-cursor-2" },
        });
      }
      assert.equal(url.searchParams.get("start"), "cleared-cursor-2");
      return Response.json({
        data: [transaction("txn-2", "5.00")],
        page: { next: null },
      });
    };
    const client = new RampClient({
      clientId: "ramp-client",
      clientSecret: "ramp-secret",
      baseUrl: "https://api.ramp.example",
      fetchImpl,
      clock: () => new Date("2026-07-29T11:00:00.000Z"),
    });

    const health = await client.healthcheck();
    assert.equal(health.scope, "transactions:read");
    const transactions = await collectRampCardTransactions(client, {
      cardId,
      through,
      pageSize: 100,
    });
    assert.deepEqual(
      transactions
        .map(({ id, state, amountCents }) => ({ id, state, amountCents }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      [
        { id: "txn-1", state: "CLEARED", amountCents: 1_234 },
        { id: "txn-2", state: "CLEARED", amountCents: 500 },
        { id: "txn-pending", state: "PENDING", amountCents: 400 },
        { id: "txn-pending-credit", state: "PENDING", amountCents: -100 },
        { id: "txn-transition", state: "CLEARED", amountCents: 600 },
      ],
    );

    const tokenCalls = calls.filter(
      ({ url }) => url.pathname === "/developer/v1/token",
    );
    assert.equal(tokenCalls.length, 1);
    assert.equal(tokenCalls[0].options.method, "POST");
    assert.equal(
      tokenCalls[0].options.headers.authorization,
      `Basic ${Buffer.from("ramp-client:ramp-secret").toString("base64")}`,
    );
    assert.equal(
      new URLSearchParams(tokenCalls[0].options.body).get("scope"),
      "transactions:read",
    );
    const transactionCalls = calls.filter(
      ({ url }) => url.pathname === "/developer/v1/transactions",
    );
    assert.equal(transactionCalls.length, 4);
    assert.deepEqual(
      new Set(transactionCalls.map(({ url }) => url.searchParams.get("state"))),
      new Set(["PENDING", "CLEARED"]),
    );
    for (const { url } of transactionCalls) {
      assert.equal(url.searchParams.get("card_id"), cardId);
      assert.equal(url.searchParams.get("to_date"), through);
      assert.equal(url.searchParams.get("order_by_date_asc"), "true");
    }
  });

test("Ramp snapshots are deterministic and exclude malformed transaction sets", () => {
  const snapshot = buildRampSpendSnapshot({
    cardId,
    through,
    transactions: [
      transaction("txn-2", "5.00"),
      transaction("txn-1", "12.34", "PENDING"),
      transaction("txn-3", "-1.00"),
    ],
  });
  assert.equal(snapshot.actualSpendCents, 1_634);
  assert.equal(snapshot.sourceTransactionCount, 3);
  assert.match(snapshot.cardFingerprint, /^[a-f0-9]{64}$/);
  assert.match(snapshot.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(buildRampSpendSnapshot({
    cardId,
    through,
    transactions: [
      transaction("txn-3", "-1.00"),
      transaction("txn-1", "12.34", "PENDING"),
      transaction("txn-2", "5.00"),
    ],
  }).sourceHash, snapshot.sourceHash);

  assert.throws(() => buildRampSpendSnapshot({
    cardId,
    through,
    transactions: [
      transaction("txn-1", "1.00"),
      transaction("txn-1", "1.00"),
    ],
  }), /duplicate Ramp IDs/);
  assert.throws(() => buildRampSpendSnapshot({
    cardId,
    through,
    transactions: [{
      ...transaction("txn-other-card", "1.00"),
      card_id: "another-card",
    }],
  }), /another card/);
  assert.throws(() => buildRampSpendSnapshot({
    cardId,
    through,
    transactions: [{
      ...transaction("txn-declined", "1.00"),
      state: "DECLINED",
    }],
  }), /must be one of PENDING, CLEARED/);
  assert.throws(() => buildRampSpendSnapshot({
    cardId,
    through,
    transactions: [{
      ...transaction("txn-eur", "1.00"),
      currency_code: "EUR",
    }],
  }), /must use the Ramp card's USD amount/);
});

test("Ramp collection rejects unstable pagination and a failed sync preserves the last record",
  async () => {
    const repeatedCursorClient = {
      async listCardTransactions() {
        return { data: [], nextCursor: "same-cursor" };
      },
    };
    await assert.rejects(
      collectRampCardTransactions(repeatedCursorClient, {
        cardId,
        through,
      }),
      /repeated the same cursor/,
    );

    const records = [];
    const ledger = {
      recordRampSpendSnapshot(snapshot) {
        records.push(snapshot);
        return { outcome: "recorded", snapshot };
      },
    };
    const goodRamp = {
      async listCardTransactions({ state, cursor }) {
        assert.equal(cursor, undefined);
        return {
          data: state === "CLEARED"
            ? [normalizedTransaction("txn-good", 2_500)]
            : [],
          nextCursor: undefined,
        };
      },
    };
    await syncRampSpendOnce({
      ledger,
      ramp: goodRamp,
      cardId,
      through,
    });
    assert.equal(records.length, 1);
    assert.equal(records[0].actualSpendCents, 2_500);

    await assert.rejects(syncRampSpendOnce({
      ledger,
      ramp: {
        async listCardTransactions() {
          throw new Error("temporary Ramp outage");
        },
      },
      cardId,
      through: "2026-07-29T12:05:00.000Z",
    }), /temporary Ramp outage/);
    assert.equal(records.length, 1);
    assert.equal(records[0].actualSpendCents, 2_500);
  });

function transaction(id, amount, state = "CLEARED") {
  return {
    id,
    card_id: cardId,
    state,
    currency_code: "USD",
    amount,
  };
}

function normalizedTransaction(id, amountCents) {
  return {
    id,
    cardId,
    state: "CLEARED",
    currencyCode: "USD",
    amountCents,
  };
}
