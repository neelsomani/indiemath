#!/usr/bin/env node

import { openLedger } from "#indiemath/ledger";
import {
  parseWorkerConfig,
  redactConfig,
} from "#indiemath/shared";
import {
  createProductionWorkerRuntime,
  runWorkerLoop,
} from "#indiemath/workers";

const config = parseWorkerConfig(process.env);
if (config.runtime !== "production") {
  throw new TypeError("The supervised worker entrypoint requires production runtime.");
}
const ledger = await openLedger({ databasePath: config.databasePath });
const worker = createProductionWorkerRuntime({ config, ledger });

try {
  const probe = await worker.probe();
  console.log(JSON.stringify({
    event: "worker-started",
    workerId: worker.workerId,
    config: redactConfig({
      runtime: config.runtime,
      databasePath: config.databasePath,
      catalogPath: config.catalogPath,
      pricingTablePath: config.pricingTablePath,
      r2: {
        kind: config.r2.kind,
        bucket: config.r2.bucket,
        endpoint: config.r2.endpoint,
      },
      anthropicApiKeyId: config.anthropic.apiKeyId,
    }),
    dependencies: probe.dependencies,
  }));
  await runWorkerLoop({
    worker,
    ledger,
    onState(state) {
      console.log(JSON.stringify(summarizeState(state)));
    },
  });
} finally {
  ledger.close();
}

function summarizeState(state) {
  const result = state.result ?? {};
  const claim = state.claim ?? result.claim ?? result.decision;
  return {
    event: state.event,
    workerId: state.workerId,
    outcome: result.outcome,
    reason: result.reason,
    rule: result.decision?.rule,
    problemId: claim?.problemId,
    direction: claim?.direction,
    claimTs: claim?.claimTs,
    budgetCents: claim?.budgetCents ?? result.decision?.runBudgetCents,
    spentCents: result.claim?.spentCents,
    solutionUri: result.solutionUri,
    spendableCapacityCents:
      result.snapshot?.spendableCapacityCents
      ?? result.spendableCapacityCents,
    claimFailureCodes: result.claimFailures?.map((failure) => failure.code),
  };
}
