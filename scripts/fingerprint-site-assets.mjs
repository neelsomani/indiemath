#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EDGE_CACHE_REVISION = "1";

export async function fingerprintSiteAssets(
  siteDir,
  { check = false } = {},
) {
  const assetsDir = path.join(siteDir, "assets");
  const siteDataPath = path.join(assetsDir, "site-data.js");
  const siteScriptPath = path.join(assetsDir, "site.js");
  const siteStylesPath = path.join(assetsDir, "site.css");
  const changedFiles = [];

  const siteData = await readFile(siteDataPath);
  const siteDataVersion = contentVersion(siteData);
  const siteDataName = `site-data.${siteDataVersion}.js`;
  const originalSiteScript = await readFile(siteScriptPath, "utf8");
  const canonicalSiteScript = replaceExactlyOnce(
    originalSiteScript,
    /from "\.\/site-data(?:\.[a-f0-9]{8})?\.js(?:\?v=[a-f0-9]{8})?";/,
    `from "./site-data.js?v=${siteDataVersion}";`,
    "site-data module reference",
  );
  if (canonicalSiteScript !== originalSiteScript) {
    changedFiles.push(siteScriptPath);
    if (!check) {
      await writeFile(siteScriptPath, canonicalSiteScript, "utf8");
    }
  }

  const versionedSiteScript = replaceExactlyOnce(
    canonicalSiteScript,
    /from "\.\/site-data\.js(?:\?v=[a-f0-9]{8})?";/,
    `from "./${siteDataName}";`,
    "site-data module reference",
  );
  const siteScriptVersion = contentVersion(versionedSiteScript);
  const siteScriptName = `site.${siteScriptVersion}.js`;
  const siteStyles = await readFile(siteStylesPath);
  const siteStylesVersion = contentVersion(siteStyles);
  const siteStylesName = `site.${siteStylesVersion}.css`;

  const generatedAssets = new Map([
    [siteDataName, siteData],
    [siteScriptName, versionedSiteScript],
    [siteStylesName, siteStyles],
  ]);
  const existingGeneratedAssets = (await readdir(assetsDir))
    .filter((name) => (
      /^site-data\.[a-f0-9]{8}\.js$/.test(name)
      || /^site\.[a-f0-9]{8}\.(?:js|css)$/.test(name)
    ));
  for (const name of existingGeneratedAssets) {
    if (generatedAssets.has(name)) continue;
    const file = path.join(assetsDir, name);
    changedFiles.push(file);
    if (!check) await rm(file);
  }
  for (const [name, content] of generatedAssets) {
    const file = path.join(assetsDir, name);
    if (await fileContentMatches(file, content)) continue;
    changedFiles.push(file);
    if (!check) await writeFile(file, content);
  }

  for (const page of ["index.html", "ledger.html"]) {
    const pagePath = path.join(siteDir, page);
    const originalHtml = await readFile(pagePath, "utf8");
    let html = replaceExactlyOnce(
      originalHtml,
      /href="assets\/site(?:\.[a-f0-9]{8})?\.css(?:\?(?:v=[a-f0-9]{8}|r=\d+))?"/,
      `href="assets/${siteStylesName}?r=${EDGE_CACHE_REVISION}"`,
      `${page} stylesheet reference`,
    );
    html = replaceExactlyOnce(
      html,
      /src="assets\/site(?:\.[a-f0-9]{8})?\.js(?:\?(?:v=[a-f0-9]{8}|r=\d+))?"/,
      `src="assets/${siteScriptName}?r=${EDGE_CACHE_REVISION}"`,
      `${page} script reference`,
    );
    if (html !== originalHtml) {
      changedFiles.push(pagePath);
      if (!check) await writeFile(pagePath, html, "utf8");
    }
  }

  if (check && changedFiles.length > 0) {
    const relativeFiles = changedFiles
      .map((file) => path.relative(siteDir, file))
      .join(", ");
    throw new Error(
      `Stale frontend asset fingerprints in ${relativeFiles}. Run npm run fingerprint.`,
    );
  }

  return {
    changedFiles,
    siteDataName,
    siteDataVersion,
    siteScriptName,
    siteScriptVersion,
    siteStylesName,
    siteStylesVersion,
  };
}

function contentVersion(content) {
  return createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, 8);
}

async function fileContentMatches(file, expected) {
  try {
    const actual = await readFile(file);
    return actual.equals(Buffer.from(expected));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function replaceExactlyOnce(text, pattern, replacement, label) {
  const matches = text.match(new RegExp(pattern.source, "g"));
  if (matches?.length !== 1) {
    throw new Error(`Expected exactly one ${label}.`);
  }
  return text.replace(pattern, replacement);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const check = process.argv.includes("--check");
  const result = await fingerprintSiteAssets(rootDir, { check });
  if (check) {
    console.log("Frontend asset fingerprints are current.");
  } else if (result.changedFiles.length === 0) {
    console.log("Frontend asset fingerprints were already current.");
  } else {
    console.log(
      `Updated frontend asset fingerprints in ${result.changedFiles.length} files.`,
    );
  }
}
