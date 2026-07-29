#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
import {
  createR2Client,
  R2Client,
  R2Error,
} from "#indiemath/r2";

test("R2 client signs and round-trips worker artifacts through the production port", async () => {
  const calls = [];
  const objects = new Map();
  const fetchImpl = async (urlValue, init) => {
    const url = new URL(urlValue);
    const headers = new Headers(init.headers);
    calls.push({
      url,
      method: init.method,
      headers,
      body: init.body ? new Uint8Array(init.body) : undefined,
    });
    const key = decodeURIComponent(url.pathname.replace(/^\/stage7-bucket\/?/, ""));
    if (init.method === "PUT") {
      objects.set(key, {
        body: new Uint8Array(init.body),
        contentType: headers.get("content-type"),
        state: headers.get("x-amz-meta-state"),
      });
      return new Response(null, { status: 200, headers: { etag: "\"put-etag\"" } });
    }
    if (init.method === "GET" && url.searchParams.get("list-type") === "2") {
      return new Response(listXml([...objects]), {
        headers: { "content-type": "application/xml" },
      });
    }
    const object = objects.get(key);
    if (!object) {
      return new Response(
        "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>",
        { status: 404 },
      );
    }
    if (init.method === "HEAD") {
      return new Response(null, {
        headers: {
          "content-length": String(object.body.length),
          "content-type": object.contentType,
          "x-amz-meta-state": object.state,
          etag: "\"head-etag\"",
        },
      });
    }
    if (init.method === "GET") {
      return new Response(object.body, {
        headers: {
          "content-type": object.contentType,
          "x-amz-meta-state": object.state,
          etag: "\"get-etag\"",
        },
      });
    }
    if (init.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response("unsupported", { status: 500 });
  };
  const client = new R2Client({
    endpoint: "https://example.r2.cloudflarestorage.com",
    bucket: "stage7-bucket",
    accessKeyId: "access-test",
    secretAccessKey: "secret-test",
    fetchImpl,
    clock: () => new Date("2026-07-29T12:34:56.000Z"),
  });
  const key = "transcripts/math-001/prove/1/response-1.md";

  assert.deepEqual(await client.putObject(key, "Readable output.", {
    contentType: "text/markdown; charset=utf-8",
    metadata: { state: "completed" },
  }), { etag: "put-etag" });
  const object = await client.getObject(key);
  assert.equal(await object.text(), "Readable output.");
  assert.equal(object.metadata.state, "completed");
  assert.equal(object.etag, "get-etag");
  assert.deepEqual(await client.headObject(key), {
    contentLength: 16,
    contentType: "text/markdown; charset=utf-8",
    metadata: { state: "completed" },
    etag: "head-etag",
  });
  const listed = await client.listObjects({ prefix: "transcripts/", limit: 10 });
  assert.equal(listed.objects[0].key, key);
  assert.equal(listed.objects[0].size, 16);
  assert.equal((await client.healthcheck()).ok, true);
  await client.deleteObject(key);
  await assert.rejects(
    client.getObject(key),
    (error) => error instanceof R2Error
      && error.code === "NoSuchKey"
      && error.status === 404,
  );

  for (const call of calls) {
    assert.equal(call.headers.get("host"), "example.r2.cloudflarestorage.com");
    assert.equal(call.headers.get("x-amz-date"), "20260729T123456Z");
    assert.match(
      call.headers.get("authorization"),
      /^AWS4-HMAC-SHA256 Credential=access-test\/20260729\/auto\/s3\/aws4_request,/,
    );
    assert.match(call.headers.get("authorization"), /Signature=[a-f0-9]{64}$/);
  }
  assert.equal(
    calls[0].url.pathname,
    "/stage7-bucket/transcripts/math-001/prove/1/response-1.md",
  );
});

test("R2 factory requires parsed production R2 configuration", () => {
  assert.throws(() => createR2Client({
    config: { component: "worker", runtime: "fake", r2: { kind: "fake" } },
  }), /production configuration/);
  const client = createR2Client({
    config: {
      component: "worker",
      runtime: "production",
      r2: {
        kind: "r2",
        endpoint: "https://example.r2.cloudflarestorage.com/",
        bucket: "bucket",
        accessKeyId: "access",
        secretAccessKey: "secret",
      },
    },
    fetchImpl: async () => new Response(
      "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>",
    ),
  });
  assert.ok(client instanceof R2Client);
});

function listXml(objects) {
  return [
    "<ListBucketResult>",
    "<IsTruncated>false</IsTruncated>",
    ...objects.map(([key, object]) => [
      "<Contents>",
      `<Key>${key}</Key>`,
      "<LastModified>2026-07-29T12:34:56.000Z</LastModified>",
      "<ETag>\"listed-etag\"</ETag>",
      `<Size>${object.body.length}</Size>`,
      "</Contents>",
    ].join("")),
    "</ListBucketResult>",
  ].join("");
}
