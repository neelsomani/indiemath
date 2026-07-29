import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_PATH,
} from "./constants.mjs";
import { AnthropicApiError } from "./errors.mjs";
import { anthropicBetaHeader } from "./protocol.mjs";
import { parseAnthropicEventStream } from "./stream.mjs";

export class AnthropicMessagesClient {
  #apiKey;
  #baseUrl;
  #fetch;

  constructor({
    apiKey,
    baseUrl = "https://api.anthropic.com",
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.#apiKey = requiredString(apiKey, "apiKey");
    this.#baseUrl = normalizeBaseUrl(baseUrl);
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
    this.#fetch = fetchImpl;
  }

  async healthcheck() {
    return {
      ok: true,
      service: "anthropic-messages",
      configured: true,
      baseUrl: this.#baseUrl,
    };
  }

  async createMessage(request, { signal } = {}) {
    const response = await this.#post({ ...request, stream: false }, signal);
    const body = await response.json();
    return Object.freeze({
      ...body,
      request_id: requestId(response.headers),
    });
  }

  async *streamMessage(request, { signal } = {}) {
    const response = await this.#post({ ...request, stream: true }, signal);
    if (!response.body) throw new TypeError("Anthropic returned an empty event stream.");
    yield {
      type: "transport_start",
      request_id: requestId(response.headers),
    };
    yield* parseAnthropicEventStream(response.body);
  }

  async #post(body, signal) {
    const response = await this.#fetch(
      `${this.#baseUrl}${ANTHROPIC_MESSAGES_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": ANTHROPIC_API_VERSION,
          "anthropic-beta": anthropicBetaHeader(),
          "user-agent": "indiemath/0.0.0",
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!response.ok) {
      throw new AnthropicApiError({
        status: response.status,
        body: await response.text(),
        headers: response.headers,
        operation: "Messages API",
      });
    }
    return response;
  }
}

function requestId(headers) {
  return headers.get("request-id")
    ?? headers.get("anthropic-request-id")
    ?? undefined;
}

function normalizeBaseUrl(value) {
  const url = new URL(requiredString(value, "baseUrl"));
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("baseUrl must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value.trim();
}
