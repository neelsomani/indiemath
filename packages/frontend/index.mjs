import {
  assertPort,
  assertRuntimeConfig,
  parsePublisherSnapshot,
} from "#indiemath/shared";

export function createFrontendRuntime({ config, publicData }) {
  assertRuntimeConfig(config, "frontend");
  assertPort(publicData, "public data", ["healthcheck", "fetchJson"]);

  return Object.freeze({
    name: "frontend",
    config,
    async loadSnapshot() {
      return parsePublisherSnapshot(await publicData.fetchJson(config.stateUrl));
    },
    async loadPublicLedger() {
      const ledger = await publicData.fetchJson(config.ledgerUrl);
      if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
        throw new TypeError("Public ledger must be an object.");
      }
      return ledger;
    },
    async probe() {
      const [publicDataStatus, snapshot, ledger] = await Promise.all([
        publicData.healthcheck(),
        this.loadSnapshot(),
        this.loadPublicLedger(),
      ]);
      return {
        ok: true,
        component: "frontend",
        dependencies: { publicData: publicDataStatus },
        catalogRevision: snapshot.catalogRevision,
        ledgerSchemaVersion: ledger.schemaVersion,
      };
    },
  });
}
