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
    yield {
      type: "transport_start",
      request_id: `req_${response.id}`,
    };
    yield {
      type: "message_start",
      message: {
        ...response,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: response.usage?.input_tokens ?? 0,
          cache_creation_input_tokens:
            response.usage?.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: response.usage?.cache_read_input_tokens ?? 0,
          output_tokens: 0,
        },
      },
    };
    for (const [index, block] of response.content.entries()) {
      const { start, deltas } = streamBlock(block);
      yield {
        type: "content_block_start",
        index,
        content_block: start,
      };
      for (const delta of deltas) {
        yield { type: "content_block_delta", index, delta };
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

function streamBlock(block) {
  const cloned = structuredClone(block);
  if (block.type === "text") {
    return {
      start: { ...cloned, text: "" },
      deltas: [{ type: "text_delta", text: block.text ?? "" }],
    };
  }
  if (block.type === "tool_use") {
    return {
      start: { ...cloned, input: {} },
      deltas: [{
        type: "input_json_delta",
        partial_json: JSON.stringify(block.input ?? {}),
      }],
    };
  }
  if (block.type === "thinking") {
    return {
      start: { ...cloned, thinking: "", signature: "" },
      deltas: [
        { type: "thinking_delta", thinking: block.thinking ?? "" },
        ...(block.signature
          ? [{ type: "signature_delta", signature: block.signature }]
          : []),
      ],
    };
  }
  if (block.type === "compaction") {
    return {
      start: {
        ...cloned,
        content: "",
        ...(Object.hasOwn(block, "encrypted_content")
          ? { encrypted_content: "" }
          : {}),
      },
      deltas: [{
        type: "compaction_delta",
        content: block.content ?? "",
        ...(typeof block.encrypted_content === "string"
          ? { encrypted_content: block.encrypted_content }
          : {}),
      }],
    };
  }
  return { start: cloned, deltas: [] };
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
