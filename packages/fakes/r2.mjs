import { createHash } from "node:crypto";

export class FakeR2 {
  #objects = new Map();

  constructor({ bucket = "indiemath-fake" } = {}) {
    this.bucket = bucket;
    this.calls = [];
  }

  async healthcheck() {
    return { ok: true, service: "r2", bucket: this.bucket, fake: true };
  }

  async putObject(key, body, options = {}) {
    const bytes = toBytes(body);
    const stored = {
      body: bytes,
      contentType: options.contentType ?? "application/octet-stream",
      metadata: Object.freeze({ ...(options.metadata ?? {}) }),
      etag: createHash("sha256").update(bytes).digest("hex"),
    };
    this.#objects.set(parseKey(key), stored);
    this.calls.push(Object.freeze({ operation: "putObject", key, byteLength: bytes.length }));
    return { etag: stored.etag };
  }

  async getObject(key) {
    const parsedKey = parseKey(key);
    this.calls.push(Object.freeze({ operation: "getObject", key: parsedKey }));
    const stored = this.#objects.get(parsedKey);
    if (!stored) throw new FakeR2NotFoundError(parsedKey);
    const body = new Uint8Array(stored.body);
    return {
      body,
      contentType: stored.contentType,
      metadata: { ...stored.metadata },
      etag: stored.etag,
      text: async () => new TextDecoder().decode(body),
    };
  }

  async headObject(key) {
    const parsedKey = parseKey(key);
    this.calls.push(Object.freeze({ operation: "headObject", key: parsedKey }));
    const stored = this.#objects.get(parsedKey);
    if (!stored) throw new FakeR2NotFoundError(parsedKey);
    return {
      contentLength: stored.body.length,
      contentType: stored.contentType,
      metadata: { ...stored.metadata },
      etag: stored.etag,
    };
  }

  async deleteObject(key) {
    const parsedKey = parseKey(key);
    this.calls.push(Object.freeze({ operation: "deleteObject", key: parsedKey }));
    this.#objects.delete(parsedKey);
  }

  async listObjects({ prefix = "", cursor, limit = 1000 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError("limit must be a positive safe integer.");
    }
    const offset = parseCursor(cursor);
    const keys = [...this.#objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
    const page = keys.slice(offset, offset + limit);
    this.calls.push(Object.freeze({ operation: "listObjects", prefix, cursor, limit }));
    return {
      objects: page.map((key) => {
        const object = this.#objects.get(key);
        return Object.freeze({
          key,
          size: object.body.length,
          etag: object.etag,
        });
      }),
      nextCursor: offset + limit < keys.length ? String(offset + limit) : undefined,
    };
  }
}

export class FakeR2NotFoundError extends Error {
  constructor(key) {
    super(`Fake R2 object not found: ${key}.`);
    this.name = "FakeR2NotFoundError";
    this.code = "NoSuchKey";
  }
}

function toBytes(body) {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return new Uint8Array(body);
  throw new TypeError("Fake R2 body must be a string or Uint8Array.");
}

function parseKey(key) {
  if (
    typeof key !== "string"
    || !key
    || key.startsWith("/")
    || key.includes("\\")
    || key.split("/").includes("..")
  ) {
    throw new TypeError("R2 key must be a safe nonempty object key.");
  }
  return key;
}

function parseCursor(cursor) {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) throw new TypeError("Invalid fake R2 cursor.");
  return Number(cursor);
}
