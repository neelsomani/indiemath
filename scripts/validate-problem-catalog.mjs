#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCatalog, validateCatalog } from "./catalog-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(rootDir, "problems", "catalog.json");
const catalog = validateCatalog(await readCatalog(catalogPath));

console.log(
  `Valid catalog revision ${catalog.catalog_revision}: `
  + `${catalog.problems.length} entries.`,
);
