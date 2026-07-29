import { createAdminRuntime } from "#indiemath/admin-cli";
import { createAnthropicClients } from "#indiemath/anthropic";
import { createFrontendRuntime } from "#indiemath/frontend";
import { createIntakePublisherRuntime } from "#indiemath/intake-publisher";
import { createLedgerRuntime } from "#indiemath/ledger";
import {
  parseAdminConfig,
  parseFrontendConfig,
  parseIntakePublisherConfig,
  parseLedgerConfig,
  parseWorkerConfig,
  validateWorkerFleet,
  WORKER_IDS,
} from "#indiemath/shared";
import { createWorkerRuntime } from "#indiemath/workers";
import { FakeAnthropicAdmin } from "./anthropic-admin.mjs";
import { FakeAnthropicMessages } from "./anthropic-messages.mjs";
import { FakeLedger } from "./ledger.mjs";
import { FakeOpenCollective } from "./open-collective.mjs";
import { FakePublicData } from "./public-data.mjs";
import { FakeR2 } from "./r2.mjs";

const FAKE_ROOT = "/tmp/indiemath-foundation-fake";
const FAKE_PUBLIC_ORIGIN = "https://public.fake.invalid/";

export async function createFakeApplication() {
  const r2 = new FakeR2();
  const ledger = new FakeLedger({ catalogRevision: 1 });
  const openCollective = new FakeOpenCollective();
  const anthropicAdmin = new FakeAnthropicAdmin();
  const publicData = new FakePublicData({ r2, origin: FAKE_PUBLIC_ORIGIN });

  const workerConfigs = validateWorkerFleet(WORKER_IDS.map((workerId) => (
    parseWorkerConfig(fakeWorkerEnvironment(workerId))
  )));
  const workerMessages = workerConfigs.map(() => new FakeAnthropicMessages());
  const workers = workerConfigs.map((config, index) => {
    const clients = createAnthropicClients({
      messages: workerMessages[index],
      admin: anthropicAdmin,
    });
    return createWorkerRuntime({
      config,
      ledger,
      r2,
      anthropicMessages: clients.messages,
    });
  });

  const ledgerRuntime = createLedgerRuntime({
    config: parseLedgerConfig(commonEnvironment()),
    ledger,
  });
  const intakePublisher = createIntakePublisherRuntime({
    config: parseIntakePublisherConfig({
      ...commonEnvironment(),
      OPEN_COLLECTIVE_SLUG: "indiemath-fake",
    }),
    ledger,
    r2,
    openCollective,
  });
  await intakePublisher.publishNow();
  const admin = createAdminRuntime({
    config: parseAdminConfig({
      ...commonEnvironment(),
      INDIEMATH_CATALOG: `${FAKE_ROOT}/catalog.json`,
      OPEN_COLLECTIVE_SLUG: "indiemath-fake",
    }),
    ledger,
    r2,
    openCollective,
    anthropicAdmin,
  });
  const frontend = createFrontendRuntime({
    config: parseFrontendConfig({
      INDIEMATH_RUNTIME: "fake",
      PUBLIC_DATA_BASE_URL: FAKE_PUBLIC_ORIGIN,
    }),
    publicData,
  });

  return Object.freeze({
    services: Object.freeze({
      ledger,
      r2,
      openCollective,
      anthropicAdmin,
      workerMessages: Object.freeze(workerMessages),
      publicData,
    }),
    components: Object.freeze({
      ledger: ledgerRuntime,
      workers: Object.freeze(workers),
      intakePublisher,
      admin,
      frontend,
    }),
  });
}

export async function probeFakeApplication(application) {
  const results = await Promise.all([
    application.components.ledger.probe(),
    ...application.components.workers.map((worker) => worker.probe()),
    application.components.intakePublisher.probe(),
    application.components.admin.probe(),
    application.components.frontend.probe(),
  ]);
  if (results.some((result) => result.ok !== true)) {
    throw new Error("A fake application component failed its probe.");
  }
  return Object.freeze(results);
}

function commonEnvironment() {
  return {
    INDIEMATH_RUNTIME: "fake",
    INDIEMATH_DB: `${FAKE_ROOT}/ledger.sqlite`,
    R2_BUCKET: "indiemath-fake",
  };
}

function fakeWorkerEnvironment(workerId) {
  return {
    ...commonEnvironment(),
    WORKER_ID: workerId,
    INDIEMATH_CATALOG: `${FAKE_ROOT}/catalog.json`,
    INDIEMATH_PRICING_TABLE: `${FAKE_ROOT}/pricing.json`,
  };
}
