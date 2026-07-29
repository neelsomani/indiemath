import {
  AnthropicProtocolError,
  AnthropicStreamError,
} from "./errors.mjs";

export async function* parseSseEvents(body) {
  if (!body || typeof body[Symbol.asyncIterator] !== "function") {
    throw new TypeError("SSE body must be an async iterable.");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = findFrameBoundary(buffer))) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const parsed = parseFrame(frame);
      if (parsed) yield parsed;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseFrame(buffer);
    if (parsed) yield parsed;
  }
}

export async function* parseAnthropicEventStream(body) {
  for await (const frame of parseSseEvents(body)) {
    if (!frame.data || frame.data === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(frame.data);
    } catch (error) {
      throw new AnthropicProtocolError(
        `Anthropic SSE contained invalid JSON: ${frame.data.slice(0, 300)}`,
        { cause: error },
      );
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new AnthropicProtocolError("Anthropic SSE event must be a JSON object.");
    }
    yield event;
  }
}

export async function collectMessageStream(events, {
  onEvent = () => {},
  onText = () => {},
} = {}) {
  const message = { content: [], usage: {} };
  const active = new Set();
  let started = false;
  let stopped = false;

  for await (const event of events) {
    await onEvent(event);
    if (stopped && event.type !== "ping") {
      throw new AnthropicProtocolError(`${event.type} arrived after message_stop.`);
    }
    switch (event.type) {
      case "transport_start":
        message.request_id = event.request_id ?? message.request_id;
        break;
      case "message_start":
        if (started || stopped) {
          throw new AnthropicProtocolError("Duplicate or late message_start event.");
        }
        if (!event.message || typeof event.message !== "object") {
          throw new AnthropicProtocolError("message_start is missing its message.");
        }
        Object.assign(message, structuredClone(event.message), { content: [] });
        started = true;
        break;
      case "content_block_start": {
        requireStarted(started, event.type);
        const index = parseIndex(event.index);
        if (active.has(index) || message.content[index] !== undefined) {
          throw new AnthropicProtocolError(`Content block ${index} started twice.`);
        }
        if (!event.content_block || typeof event.content_block !== "object") {
          throw new AnthropicProtocolError(`Content block ${index} has no block data.`);
        }
        const block = structuredClone(event.content_block);
        if (block.type === "tool_use" && isEmptyObject(block.input)) {
          block.__inputJson = "";
        }
        message.content[index] = block;
        active.add(index);
        break;
      }
      case "content_block_delta": {
        requireStarted(started, event.type);
        const index = parseIndex(event.index);
        if (!active.has(index)) {
          throw new AnthropicProtocolError(`Delta received for inactive block ${index}.`);
        }
        applyDelta(message.content[index], event.delta, onText);
        break;
      }
      case "content_block_stop": {
        requireStarted(started, event.type);
        const index = parseIndex(event.index);
        if (!active.delete(index)) {
          throw new AnthropicProtocolError(`Stop received for inactive block ${index}.`);
        }
        finalizeBlock(message.content[index], index);
        break;
      }
      case "message_delta":
        requireStarted(started, event.type);
        Object.assign(message, structuredClone(event.delta ?? {}));
        if (event.context_management !== undefined) {
          message.context_management = structuredClone(event.context_management);
        }
        message.usage = {
          ...message.usage,
          ...structuredClone(event.usage ?? {}),
        };
        break;
      case "message_stop":
        requireStarted(started, event.type);
        if (active.size) {
          throw new AnthropicProtocolError(
            `message_stop arrived with ${active.size} open content block(s).`,
          );
        }
        stopped = true;
        break;
      case "error":
        throw new AnthropicStreamError(event.error);
      case "ping":
        break;
      default:
        // Forward-compatible: unknown event types are exposed through onEvent.
        break;
    }
  }

  if (!started) throw new AnthropicProtocolError("Stream ended before message_start.");
  if (!stopped) throw new AnthropicProtocolError("Stream ended before message_stop.");
  message.content = message.content.filter(Boolean).map(cleanBlock);
  return Object.freeze(message);
}

export function extractText(blocks = []) {
  return blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

function applyDelta(block, delta, onText) {
  if (!delta || typeof delta !== "object") {
    throw new AnthropicProtocolError("content_block_delta is missing its delta.");
  }
  switch (delta.type) {
    case "text_delta":
      block.text = `${block.text ?? ""}${delta.text ?? ""}`;
      onText(delta.text ?? "");
      break;
    case "input_json_delta":
      block.__inputJson = `${block.__inputJson ?? ""}${delta.partial_json ?? ""}`;
      break;
    case "thinking_delta":
      block.thinking = `${block.thinking ?? ""}${delta.thinking ?? ""}`;
      break;
    case "signature_delta":
      block.signature = `${block.signature ?? ""}${delta.signature ?? ""}`;
      break;
    case "citations_delta":
      block.citations = [...(block.citations ?? []), structuredClone(delta.citation)];
      break;
    case "compaction_delta":
      block.content = `${block.content ?? ""}${delta.content ?? ""}`;
      if (typeof delta.encrypted_content === "string") {
        block.encrypted_content =
          `${block.encrypted_content ?? ""}${delta.encrypted_content}`;
      }
      break;
    default:
      // The raw event remains available through onEvent. Do not add private
      // fields to the content block because the block is replayed to Anthropic.
      break;
  }
}

function finalizeBlock(block, index) {
  if (block?.__inputJson === undefined) return;
  if (!block.__inputJson) {
    delete block.__inputJson;
    return;
  }
  try {
    block.input = JSON.parse(block.__inputJson);
  } catch (error) {
    throw new AnthropicProtocolError(
      `Tool input for content block ${index} ended as invalid JSON.`,
      { cause: error },
    );
  }
  delete block.__inputJson;
}

function cleanBlock(block) {
  const clean = structuredClone(block);
  delete clean.__inputJson;
  return clean;
}

function findFrameBoundary(buffer) {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function parseFrame(frame) {
  let event;
  const data = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (!data.length) return undefined;
  return Object.freeze({ event, data: data.join("\n") });
}

function parseIndex(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AnthropicProtocolError("Content block index must be nonnegative.");
  }
  return value;
}

function requireStarted(started, eventType) {
  if (!started) {
    throw new AnthropicProtocolError(`${eventType} arrived before message_start.`);
  }
}

function isEmptyObject(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 0;
}
