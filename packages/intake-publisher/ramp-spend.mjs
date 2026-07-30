import {
  buildRampSpendSnapshot,
  collectRampCardTransactions,
} from "#indiemath/ramp";
import { assertPort } from "#indiemath/shared";

export async function syncRampSpendOnce({
  ledger,
  ramp,
  cardId,
  through = new Date(),
  signal,
} = {}) {
  assertPort(ledger, "ledger", ["recordRampSpendSnapshot"]);
  assertPort(ramp, "ramp", ["listCardTransactions"]);
  const cutoff = timestamp(through, "through");
  const transactions = await collectRampCardTransactions(ramp, {
    cardId,
    through: cutoff,
    signal,
  });
  const snapshot = buildRampSpendSnapshot({
    cardId,
    through: cutoff,
    transactions,
  });
  return ledger.recordRampSpendSnapshot(snapshot);
}

export class RampSpendSyncController {
  #ledger;
  #ramp;
  #cardId;
  #clock;
  #intervalMilliseconds;
  #wake;

  constructor({
    ledger,
    ramp,
    cardId,
    clock = () => new Date(),
    intervalSeconds = 300,
  } = {}) {
    assertPort(ledger, "ledger", ["recordRampSpendSnapshot"]);
    assertPort(ramp, "ramp", ["listCardTransactions"]);
    this.#cardId = requiredString(cardId, "cardId");
    if (typeof clock !== "function") throw new TypeError("clock must be a function.");
    if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1) {
      throw new TypeError("intervalSeconds must be a positive safe integer.");
    }
    this.#ledger = ledger;
    this.#ramp = ramp;
    this.#clock = clock;
    this.#intervalMilliseconds = intervalSeconds * 1_000;
  }

  poke() {
    this.#wake?.();
  }

  syncNow({ signal } = {}) {
    return syncRampSpendOnce({
      ledger: this.#ledger,
      ramp: this.#ramp,
      cardId: this.#cardId,
      through: this.#clock(),
      signal,
    });
  }

  async run({ signal, onSync, onError } = {}) {
    while (!signal?.aborted) {
      try {
        await onSync?.(await this.syncNow({ signal }));
      } catch (error) {
        if (signal?.aborted) return;
        await onError?.(error);
      }
      await this.#wait(signal);
    }
  }

  async #wait(signal) {
    if (signal?.aborted) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        this.#wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, this.#intervalMilliseconds);
      signal?.addEventListener("abort", finish, { once: true });
      this.#wake = finish;
    });
  }
}

function timestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${label} must be a timestamp.`);
  }
  return date.toISOString();
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value.trim();
}
