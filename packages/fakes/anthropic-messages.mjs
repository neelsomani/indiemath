export class FakeAnthropicMessages {
  #responses;
  #counter = 0;

  constructor({ responses = [] } = {}) {
    this.#responses = responses.map((response) => structuredClone(response));
    this.requests = [];
  }

  async healthcheck() {
    return { ok: true, service: "anthropic-messages", fake: true };
  }

  async createMessage(request) {
    return this.#respond(request);
  }

  async *streamMessage(request) {
    const response = this.#respond(request);
    yield { type: "message_start", message: { ...response, content: [] } };
    for (const [index, block] of response.content.entries()) {
      yield { type: "content_block_start", index, content_block: structuredClone(block) };
      if (block.type === "text") {
        yield {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        };
      }
      yield { type: "content_block_stop", index };
    }
    yield {
      type: "message_delta",
      delta: { stop_reason: response.stop_reason, stop_sequence: null },
      usage: structuredClone(response.usage),
    };
    yield { type: "message_stop" };
  }

  #respond(request) {
    validateRequest(request);
    this.requests.push(structuredClone(request));
    this.#counter += 1;
    const queued = this.#responses.shift();
    return structuredClone(queued ?? {
      id: `msg_fake_${String(this.#counter).padStart(4, "0")}`,
      type: "message",
      role: "assistant",
      model: request.model,
      content: [{ type: "text", text: `Deterministic fake response ${this.#counter}.` }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 5,
      },
    });
  }
}

function validateRequest(request) {
  if (!request || typeof request !== "object") {
    throw new TypeError("Anthropic Messages request must be an object.");
  }
  if (typeof request.model !== "string" || !request.model) {
    throw new TypeError("Anthropic Messages request requires model.");
  }
  if (!Array.isArray(request.messages)) {
    throw new TypeError("Anthropic Messages request requires messages.");
  }
}
