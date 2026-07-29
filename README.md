# IndieMath

IndieMath lets people fund public AI research attempts on open mathematics and
computer science problems. Contributors choose a canonical statement and direct
their contribution toward an attempt to prove or disprove it. The project
publishes contributions, compute runs, model artifacts, and human reviews so
the complete path remains auditable.

The website is intentionally catalog-driven. Problem names, statements,
statuses, balances, contribution links, and results are read from the public ledger
publisher; the frontend does not maintain a second problem list.

## Repository map

- `problems/catalog.json` — admin-maintained canonical problem metadata.
- `packages/ledger/` — the SQLite accounting and state machine.
- `packages/workers/` and `packages/anthropic/` — selection, recovery, and
  Anthropic Messages integration.
- `packages/intake-publisher/` — Open Collective intake and atomic public-data
  publication.
- `index.html`, `ledger.html`, and `assets/` — the static public frontend.
- `seed/fable-math/` — prior FableMath work and compact carry-forward context
  used to resume research and presented through the same transcript UI as
  IndieMath runs; the static build includes the manifest and carry-forward
  transcripts, not the final-only source artifacts.
- `scripts/indiemath.mjs` — privileged administration commands.
- `docs/DESIGN.md` and `docs/ADMIN_RUNBOOK.md` — system contract and operating
  procedures.

## Local development

Node 22.13 or newer is required.

```sh
npm install
npm run dev
```

The local URL printed by the server renders the same public state and ledger as
the production site. The data endpoint is declared once in each page's
`indiemath-public-data` meta tag.

Run the repository checks and build the static deployment output with:

```sh
npm run validate
npm run check
npm test
npm run build
```

Copy `.env.example` to `.env` only for local commands that need external
services. Never commit the resulting file or provider credentials.

## Contribution lifecycle

A contribution is credited immediately and normally processed within 1–2
business days after receipt, Monday through Friday. While its public badge says
**received**, it has not been staged for compute and may be refunded on request.
Once it says **processed**, it is committed and final. See
[Terms & Conditions](terms.html) for the governing policy.

## License

Except where otherwise noted, website content is dedicated to the public domain
under CC0 1.0 Universal. Repository source code is licensed under the terms in
[`LICENSE`](LICENSE).
