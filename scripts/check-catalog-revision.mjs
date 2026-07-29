#!/usr/bin/env node

import {
  assertCatalogRevisionAdvance,
  readCatalog,
} from "./catalog-lib.mjs";

const [basePath, candidatePath] = process.argv.slice(2);

if (!basePath || !candidatePath) {
  console.error(
    "Usage: node scripts/check-catalog-revision.mjs <base-catalog> <candidate-catalog>",
  );
  process.exit(2);
}

try {
  const base = await readCatalog(basePath);
  const candidate = await readCatalog(candidatePath);
  const result = assertCatalogRevisionAdvance(base, candidate);

  if (result.contentChanged) {
    console.log(
      `Catalog content changed and revision increased from `
      + `${result.baseRevision} to ${result.candidateRevision}.`,
    );
  } else {
    console.log(
      `Catalog content is unchanged apart from formatting or revision metadata; `
      + `revision ${result.candidateRevision} is valid.`,
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
