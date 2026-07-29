import {
  createHash,
  createHmac,
} from "node:crypto";

const SERVICE = "s3";
const REGION = "auto";
const EMPTY_SHA256 = sha256(new Uint8Array());

export class R2Client {
  #endpoint;
  #bucket;
  #accessKeyId;
  #secretAccessKey;
  #fetch;
  #clock;

  constructor({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    fetchImpl = globalThis.fetch,
    clock = () => new Date(),
  } = {}) {
    this.#endpoint = parseEndpoint(endpoint);
    this.#bucket = requiredString(bucket, "bucket");
    this.#accessKeyId = requiredString(accessKeyId, "accessKeyId");
    this.#secretAccessKey = requiredString(secretAccessKey, "secretAccessKey");
    if (typeof fetchImpl !== "function") {
      throw new TypeError("fetchImpl must be a function.");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function.");
    this.#fetch = fetchImpl;
    this.#clock = clock;
  }

  async healthcheck() {
    await this.listObjects({ limit: 1 });
    return Object.freeze({
      ok: true,
      service: "r2",
      bucket: this.#bucket,
      fake: false,
    });
  }

  async putObject(key, body, {
    contentType = "application/octet-stream",
    cacheControl,
    metadata = {},
    ifNoneMatch = false,
  } = {}) {
    if (typeof ifNoneMatch !== "boolean") {
      throw new TypeError("ifNoneMatch must be a boolean.");
    }
    const bytes = toBytes(body);
    const response = await this.#request("PUT", parseKey(key), {
      body: bytes,
      headers: {
        "content-type": requiredString(contentType, "contentType"),
        ...(cacheControl
          ? { "cache-control": requiredString(cacheControl, "cacheControl") }
          : {}),
        ...(ifNoneMatch ? { "if-none-match": "*" } : {}),
        ...metadataHeaders(metadata),
      },
    });
    return Object.freeze({
      etag: normalizeEtag(response.headers.get("etag")),
    });
  }

  async getObject(key) {
    const response = await this.#request("GET", parseKey(key));
    const body = new Uint8Array(await response.arrayBuffer());
    return Object.freeze({
      body,
      contentType: response.headers.get("content-type")
        ?? "application/octet-stream",
      metadata: Object.freeze(readMetadata(response.headers)),
      etag: normalizeEtag(response.headers.get("etag")),
      text: async () => new TextDecoder().decode(body),
    });
  }

  async headObject(key) {
    const response = await this.#request("HEAD", parseKey(key));
    return Object.freeze({
      contentLength: parseContentLength(response.headers.get("content-length")),
      contentType: response.headers.get("content-type")
        ?? "application/octet-stream",
      metadata: Object.freeze(readMetadata(response.headers)),
      etag: normalizeEtag(response.headers.get("etag")),
    });
  }

  async deleteObject(key) {
    await this.#request("DELETE", parseKey(key));
  }

  async listObjects({
    prefix = "",
    cursor,
    limit = 1_000,
  } = {}) {
    if (typeof prefix !== "string") throw new TypeError("prefix must be a string.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("limit must be a safe integer between 1 and 1000.");
    }
    if (cursor !== undefined && (typeof cursor !== "string" || !cursor)) {
      throw new TypeError("cursor must be a nonempty string when supplied.");
    }
    const response = await this.#request("GET", undefined, {
      query: {
        "list-type": "2",
        "max-keys": String(limit),
        ...(prefix ? { prefix } : {}),
        ...(cursor ? { "continuation-token": cursor } : {}),
      },
    });
    const xml = await response.text();
    return Object.freeze({
      objects: Object.freeze(parseListedObjects(xml)),
      nextCursor: xmlValue(xml, "IsTruncated") === "true"
        ? requiredXmlValue(xml, "NextContinuationToken")
        : undefined,
    });
  }

  async #request(method, key, {
    body = new Uint8Array(),
    headers = {},
    query = {},
  } = {}) {
    const payload = toBytes(body);
    const payloadHash = payload.length ? sha256(payload) : EMPTY_SHA256;
    const now = parseClockDate(this.#clock());
    const amzDate = formatAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const url = objectUrl(this.#endpoint, this.#bucket, key, query);
    const requestHeaders = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...normalizeHeaders(headers),
    };
    const signedHeaders = Object.keys(requestHeaders).sort();
    const canonicalHeaders = signedHeaders.map((name) => (
      `${name}:${canonicalHeaderValue(requestHeaders[name])}\n`
    )).join("");
    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQuery(query),
      canonicalHeaders,
      signedHeaders.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256(canonicalRequest),
    ].join("\n");
    const signature = hmacHex(
      signatureKey(this.#secretAccessKey, dateStamp),
      stringToSign,
    );
    requestHeaders.authorization = [
      `AWS4-HMAC-SHA256 Credential=${this.#accessKeyId}/${scope},`,
      `SignedHeaders=${signedHeaders.join(";")},`,
      `Signature=${signature}`,
    ].join(" ");

    let response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: requestHeaders,
        ...(method === "PUT" ? { body: payload } : {}),
      });
    } catch (error) {
      throw new R2Error(
        "R2NetworkError",
        `R2 ${method} request failed: ${error.message}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      const details = method === "HEAD" ? "" : await response.text();
      throw r2ResponseError({ method, key, response, details });
    }
    return response;
  }
}

export class R2Error extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "R2Error";
    this.code = code;
    this.status = options.status;
    this.requestId = options.requestId;
  }
}

export function createR2Client({ config, fetchImpl, clock } = {}) {
  if (!config || config.r2?.kind !== "r2") {
    throw new TypeError("A parsed production configuration with R2 settings is required.");
  }
  return new R2Client({
    ...config.r2,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(clock ? { clock } : {}),
  });
}

function objectUrl(endpoint, bucket, key, query) {
  const url = new URL(endpoint);
  const path = [bucket, ...(key ? key.split("/") : [])]
    .map(awsEncode)
    .join("/");
  url.pathname = `/${path}`;
  const search = canonicalQuery(query);
  url.search = search ? `?${search}` : "";
  return url;
}

function canonicalQuery(query) {
  return Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => [awsEncode(name), awsEncode(String(value))])
    .sort(([leftName, leftValue], [rightName, rightValue]) => (
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    ))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new TypeError("headers must be an object.");
  }
  const normalized = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(lower)) {
      throw new TypeError(`Invalid R2 header name: ${name}.`);
    }
    normalized[lower] = String(value);
  }
  return normalized;
}

function metadataHeaders(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("metadata must be an object.");
  }
  return Object.fromEntries(Object.entries(metadata).map(([name, value]) => {
    const normalized = name
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
      throw new TypeError(`Invalid R2 metadata name: ${name}.`);
    }
    return [`x-amz-meta-${normalized}`, String(value)];
  }));
}

function readMetadata(headers) {
  const metadata = {};
  for (const [name, value] of headers) {
    if (!name.startsWith("x-amz-meta-")) continue;
    const key = name.slice("x-amz-meta-".length).replace(
      /-([a-z0-9])/g,
      (_, character) => character.toUpperCase(),
    );
    metadata[key] = value;
  }
  return metadata;
}

function signatureKey(secret, dateStamp) {
  const dateKey = hmac(`AWS4${secret}`, dateStamp);
  const regionKey = hmac(dateKey, REGION);
  const serviceKey = hmac(regionKey, SERVICE);
  return hmac(serviceKey, "aws4_request");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key, value) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalHeaderValue(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

function formatAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function parseEndpoint(value) {
  let url;
  try {
    url = new URL(requiredString(value, "endpoint"));
  } catch (error) {
    throw new TypeError(`endpoint must be a valid URL: ${error.message}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("endpoint must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("endpoint cannot contain credentials, a query, or a fragment.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new TypeError("endpoint must be the account endpoint without a bucket path.");
  }
  url.pathname = "/";
  return url;
}

function parseClockDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("clock must return a valid Date-compatible value.");
  }
  return date;
}

function parseKey(key) {
  if (
    typeof key !== "string"
    || !key
    || key.startsWith("/")
    || key.endsWith("/")
    || key.includes("\\")
    || key.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError("R2 key must be a safe nonempty object key.");
  }
  return key;
}

function toBytes(body) {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return new Uint8Array(body);
  if (body === undefined) return new Uint8Array();
  throw new TypeError("R2 body must be a string or Uint8Array.");
}

function parseListedObjects(xml) {
  return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((match) => {
    const contents = match[1];
    return Object.freeze({
      key: requiredXmlValue(contents, "Key"),
      size: parseNonnegativeInteger(requiredXmlValue(contents, "Size"), "R2 object size"),
      etag: normalizeEtag(xmlValue(contents, "ETag")),
      lastModified: xmlValue(contents, "LastModified"),
    });
  });
}

function xmlValue(xml, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decodeXml(match[1]) : undefined;
}

function requiredXmlValue(xml, name) {
  const value = xmlValue(xml, name);
  if (value === undefined) throw new R2Error("InvalidResponse", `R2 XML omitted ${name}.`);
  return value;
}

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function r2ResponseError({ method, key, response, details }) {
  const parsedCode = xmlValue(details, "Code");
  const code = response.status === 404
    ? "NoSuchKey"
    : parsedCode ?? `HTTP${response.status}`;
  const message = xmlValue(details, "Message")
    ?? details.slice(0, 500)
    ?? response.statusText;
  return new R2Error(
    code,
    `R2 ${method} ${key ?? "<bucket>"} failed with HTTP ${response.status}: ${message}`,
    {
      status: response.status,
      requestId: response.headers.get("cf-ray")
        ?? response.headers.get("x-amz-request-id")
        ?? undefined,
    },
  );
}

function normalizeEtag(value) {
  return typeof value === "string" ? value.replace(/^"|"$/g, "") : undefined;
}

function parseContentLength(value) {
  return parseNonnegativeInteger(value ?? "0", "content-length");
}

function parseNonnegativeInteger(value, label) {
  if (!/^\d+$/.test(String(value))) {
    throw new R2Error("InvalidResponse", `${label} must be a nonnegative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new R2Error("InvalidResponse", `${label} exceeds the safe integer range.`);
  }
  return parsed;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  return value.trim();
}
