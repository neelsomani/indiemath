export class FakeAnthropicAdmin {
  #usage;

  constructor({ usage = [] } = {}) {
    this.#usage = usage.map((row) => structuredClone(row));
    this.calls = [];
  }

  async healthcheck() {
    return { ok: true, service: "anthropic-admin", fake: true };
  }

  async listUsage({
    apiKeyId,
    startTime,
    endTime,
    cursor,
    limit = 100,
  } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError("limit must be a positive safe integer.");
    }
    const offset = parseCursor(cursor);
    const rows = this.#usage
      .filter((row) => !apiKeyId || row.apiKeyId === apiKeyId)
      .filter((row) => !startTime || Date.parse(row.bucketStart) >= Date.parse(startTime))
      .filter((row) => !endTime || Date.parse(row.bucketStart) < Date.parse(endTime))
      .sort((left, right) => (
        left.bucketStart.localeCompare(right.bucketStart)
        || left.apiKeyId.localeCompare(right.apiKeyId)
      ));
    const page = rows.slice(offset, offset + limit);
    this.calls.push(Object.freeze({
      operation: "listUsage",
      apiKeyId,
      startTime,
      endTime,
      cursor,
      limit,
    }));
    return {
      data: structuredClone(page),
      nextCursor: offset + limit < rows.length ? String(offset + limit) : undefined,
    };
  }
}

function parseCursor(cursor) {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) throw new TypeError("Invalid fake Admin API cursor.");
  return Number(cursor);
}
