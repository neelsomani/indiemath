#!/usr/bin/env node

import "#indiemath/admin-cli";
import "#indiemath/anthropic";
import "#indiemath/frontend";
import "#indiemath/intake-publisher";
import "#indiemath/ledger";
import "#indiemath/r2";
import "#indiemath/shared";
import "#indiemath/workers";
import {
  createFakeApplication,
  probeFakeApplication,
} from "#indiemath/fakes";

try {
  const application = await createFakeApplication();
  const results = await probeFakeApplication(application);
  console.log(
    `Foundation check passed: ${results.length} component instances `
    + "loaded shared schemas and passed fake dependency probes.",
  );
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}
