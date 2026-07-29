#!/usr/bin/env node

import {
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, "dist");
const clientDir = path.join(outputDir, "client");
const serverDir = path.join(outputDir, "server");
const requiredFiles = [
  "index.html",
  "ledger.html",
  "terms.html",
  "_headers",
  "robots.txt",
  "sitemap.xml",
  "favicon.ico",
  "favicon.png",
  "apple-touch-icon.png",
];

await rm(outputDir, { recursive: true, force: true });
await mkdir(clientDir, { recursive: true });
await mkdir(serverDir, { recursive: true });

for (const file of requiredFiles) {
  await cp(path.join(rootDir, file), path.join(clientDir, file));
}
await cp(path.join(rootDir, "assets"), path.join(clientDir, "assets"), {
  recursive: true,
});
const publicResearchSeedDirectory = path.join(
  clientDir,
  "seed",
  "fable-math",
);
await mkdir(publicResearchSeedDirectory, { recursive: true });
await cp(
  path.join(rootDir, "seed", "fable-math", "manifest.json"),
  path.join(publicResearchSeedDirectory, "manifest.json"),
);
await cp(
  path.join(rootDir, "seed", "fable-math", "contexts"),
  path.join(publicResearchSeedDirectory, "contexts"),
  { recursive: true },
);
await copyOptional("og.png");

const workerSource = await readFile(
  path.join(rootDir, "site-worker.mjs"),
  "utf8",
);
await writeFile(path.join(serverDir, "index.js"), workerSource, "utf8");

const html = await readFile(path.join(clientDir, "index.html"), "utf8");
for (const required of [
  "assets/site.css",
  "assets/site.js",
  "ledger.html",
  "terms.html",
  "https://opencollective.com/indiemath",
]) {
  if (!html.includes(required)) {
    throw new Error(`Built homepage is missing ${required}.`);
  }
}
const siteScript = await readFile(
  path.join(clientDir, "assets", "site.js"),
  "utf8",
);
if (!siteScript.includes("seed/fable-math/manifest.json")) {
  throw new Error("Built frontend is missing the research manifest.");
}
const fableManifest = JSON.parse(await readFile(
  path.join(clientDir, "seed", "fable-math", "manifest.json"),
  "utf8",
));
for (const response of fableManifest.responses) {
  await readFile(
    path.join(
      clientDir,
      "seed",
      "fable-math",
      response.contextArtifact,
    ),
    "utf8",
  );
}

console.log(`Built static site in ${outputDir}.`);

async function copyOptional(file) {
  try {
    await cp(path.join(rootDir, file), path.join(clientDir, file));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
