import {
  assertPort,
  assertRuntimeConfig,
  parsePublicLedger,
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
    async loadPublicLedger(snapshot) {
      const state = snapshot ?? await this.loadSnapshot();
      const ledger = parsePublicLedger(await publicData.fetchJson(
        state.ledgerKey
          ? publicObjectUrl(config.publicDataBaseUrl, state.ledgerKey)
          : config.ledgerUrl,
      ));
      if (
        state.publicationId
        && ledger.publicationId !== state.publicationId
      ) {
        throw new Error(
          "Public state and ledger belong to different publication generations.",
        );
      }
      if (ledger.catalogRevision !== state.catalogRevision) {
        throw new Error("Public state and ledger catalog revisions disagree.");
      }
      return ledger;
    },
    async probe() {
      const [publicDataStatus, snapshot] = await Promise.all([
        publicData.healthcheck(),
        this.loadSnapshot(),
      ]);
      const ledger = await this.loadPublicLedger(snapshot);
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

function publicObjectUrl(baseUrl, objectKey) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${objectKey}`;
  return url.toString();
}
