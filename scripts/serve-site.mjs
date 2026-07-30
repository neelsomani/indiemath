#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = "127.0.0.1";
const port = parsePort(process.env.PORT ?? "4173");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".png", "image/png"],
  [".txt", "text/plain; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
]);
const publicRoots = new Set([
  "_headers",
  "apple-touch-icon.png",
  "assets",
  "favicon.ico",
  "favicon.png",
  "index.html",
  "ledger.html",
  "og.png",
  "robots.txt",
  "sitemap.xml",
  "terms.html",
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    const pathname = decodeURIComponent(url.pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const segments = relative.split("/");
    if (
      !publicRoots.has(segments[0])
      || segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      return sendNotFound(response);
    }
    const resolved = path.resolve(rootDir, ...segments);
    if (!resolved.startsWith(`${rootDir}${path.sep}`)) return sendNotFound(response);
    const info = await stat(resolved).catch(() => undefined);
    if (!info?.isFile()) return sendNotFound(response);
    response.writeHead(200, {
      "content-type": contentTypes.get(path.extname(resolved)) ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    createReadStream(resolved).pipe(response);
  } catch {
    sendNotFound(response);
  }
});

server.listen(port, host, () => {
  console.log(`Local URL: http://${host}:${port}`);
});

function sendNotFound(response) {
  response.writeHead(404, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end("Not found\n");
}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError("PORT must be an integer from 1 to 65535.");
  }
  return parsed;
}
