import {
  publicLedgerKey,
  publicStateKey,
} from "../shared/artifact-keys.mjs";

export class FakePublicData {
  constructor({ r2, origin = "https://public.fake.invalid/" }) {
    this.r2 = r2;
    this.origin = new URL(origin);
  }

  async healthcheck() {
    return { ok: true, service: "public-data", fake: true };
  }

  async fetchJson(url) {
    const parsed = new URL(url);
    if (parsed.origin !== this.origin.origin) {
      throw new Error(`Unexpected fake public-data origin: ${parsed.origin}.`);
    }
    const key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    const knownKey = key === publicStateKey()
      || key === publicLedgerKey()
      || /^public\/publications\/[a-f0-9]{64}\/(?:state|ledger)\.json$/.test(key);
    if (!knownKey) {
      throw new Error(`Unknown fake public-data path: ${parsed.pathname}.`);
    }
    const object = await this.r2.getObject(key);
    return JSON.parse(await object.text());
  }
}
