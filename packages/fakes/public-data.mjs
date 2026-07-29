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
    const key = parsed.pathname.endsWith("/state.json")
      ? publicStateKey()
      : parsed.pathname.endsWith("/ledger.json")
        ? publicLedgerKey()
        : undefined;
    if (!key) throw new Error(`Unknown fake public-data path: ${parsed.pathname}.`);
    const object = await this.r2.getObject(key);
    return JSON.parse(await object.text());
  }
}
