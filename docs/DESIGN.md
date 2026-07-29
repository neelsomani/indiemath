# IndieMath — System Specification

A site with a curated list of open math/CS problems. People donate to a specific problem, choosing whether the model should try to prove or disprove it. Donations fund runs of the best available AI model (assumed: Claude Fable at ~$500/hour) against that problem.

Money rails: donors pay through the project's Open Collective page (Stripe underneath; cards and, where available, bank transfers) → funds settle to the operating LLC's bank account → once a day the admin stages settled money at Ramp (transfer / limit increase) and records it → a Ramp virtual card with auto-reload pays Anthropic. Settlement lag is a first-class design fact, handled by the capacity gate (§3), not hidden.

## Design principles

1. **Crash-only workers.** Workers are plain processes that may die and restart at any time. There is no graceful-shutdown path and no separate recovery path: recovery is startup. On boot, a worker reconstructs everything it needs from the ledger database.
2. **One SQLite ledger is the coordination layer.** All pools, donations, claims, leases, spend, reviews, and treasury state live in a single SQLite database (WAL mode) on the worker box. Transactions (`BEGIN IMMEDIATE`) are the only lock in the system. The ledger is continuously replicated (Litestream) to R2, with a second replica in a different vendor's bucket (AWS S3 or GCS) — the database is the one artifact whose loss is unrecoverable, so no single provider incident can touch both copies.
3. **R2 holds bulk artifacts and published snapshots.** Cloudflare R2, spoken to via the standard S3-compatible API (same SDK, different endpoint): transcripts, solutions, review notes, the public `state.json`, the public ledger export, and the database replica. Things that are displayed or restored — never a second coordination channel. Public prefixes serve through Cloudflare's CDN with zero egress cost.
4. **Money path: donor → Open Collective (Stripe) → LLC bank → Ramp → Anthropic.** Pools are credited the moment the intake loop sees a paid Open Collective order; compute launches only against funded capacity (§3). The LLC is the entity behind the collective and the counterparty named in the donation terms, regardless of personal-name branding on the site.
5. **Verifiability means transparency, not trustlessness.** The system publishes its ledger: every donation (display name, amount, problem, direction, timestamp, processed status), every run (budget, spend, transcript link), every review verdict — and Open Collective's own public page provides a second, independently hosted view of the money. Donors verify their own line items; the published ledger reconciles against Open Collective's records and priced API usage.

Total infrastructure: five supervised processes on one VM (EC2 or GCP — any plain Linux box with a real disk; four workers + one intake/publisher), one SQLite database replicated to R2 (+ second-vendor replica), an R2 bucket behind Cloudflare's CDN, a static frontend on Cloudflare Pages, an Open Collective page on Stripe under the LLC, and a Ramp card. Zero public server endpoints: checkout is Open Collective-hosted, and the site is static files.

---

## 1. The ledger (SQLite)

One database file, WAL mode, owned by the five processes on the box. Every operation below is a single transaction; `BEGIN IMMEDIATE` serializes writers across processes, which is the entire mutual-exclusion story. Keep the schema small: every table not created is a migration not regretted.

### Tables

- **problems** — synced from the repo catalog by the admin CLI: `problem_id` (permanent; 3–64 lowercase alphanumeric/hyphen characters), an identity hash of the normalized canonical statement, catalog metadata and revision, status ∈ {Open, PendingReview, Solved}, and for PendingReview: pending solution (direction, claim_ts, R2 URI) and optional secondary solution (direction, claim_ts, URI). Status is problem-level; both directions' logic reads it. Sync is transactional: changed content requires a strictly newer catalog revision; a previously issued ID cannot acquire a different canonical statement or disappear from the catalog; metadata-only changes are allowed.
- **Identity boundary** — problem identity is intentionally the normalized canonical statement only. Titles, slugs, sources, direction prompts, and review-policy wording are revisioned guidance and metadata, not part of the mathematical claim. Every claim records the `catalog_revision` it ran against; review adjudicates against the canonical statement and policy at that revision, recoverable from git history, rather than treating a direction prompt as the definition of proof or disproof.
- **pools** — one row per `(problem_id, direction)`, `direction ∈ {prove, disprove}`: balance (integer cents), cumulative donation total. Prove and disprove are independently fundable, claimable, and sampled; a joint lock would zero one direction's sampling probability whenever the other runs, distorting the funding-weighted selection donors were promised. Up to two workers may work the same problem simultaneously, one per direction.
- **donations** — one row per payment: `dedup_id` (the Open Collective order ID — unique index; the intake process's idempotency), destination (a `(problem, direction)` pool, or general credit), gross and net amounts, fees, `donor_tag` (the OC account's display name; guest/incognito contributions → anonymous), timestamps, and state ∈ {credited, disputed, reversed}. This table is the donor-facing ledger. A donation's public **processed** status is derived, never stored: it displays as processed once cumulative funded capacity (§3) covers cumulative net donations through it, FIFO by credit time — one daily treasury command flips every badge it covers.
- **claims** — one row per run: `(problem_id, direction)`, `catalog_revision`, worker_id, `claim_ts`, budget, `pool_funded` (pool-attributed portion of the budget; the rest is general-attributed — required so settlement returns residue to its sources), spent (updated transactionally after every API response, §2), `lease_expiry`, settled flag, solution URI if any. A partial unique index on unsettled claims per `(problem_id, direction)` makes double-claiming impossible at the schema level, not just the code level.
- **reviewed_results** — one row per adjudicated solution: `(problem_id, direction, claim_ts)`, solution URI, outcome ∈ {unconditional, conditional, rejected}, review-note URI, assumption label for conditional results. Immutable history; conditional results are display and future-run context, never money state.
- **funding_events** — the treasury table: one row per real-world transfer of settled funds to Ramp (or Ramp limit increase): amount, external reference (bank/Ramp transfer ID — unique, making the record idempotent), timestamp. §3 defines how these gate compute.
- **general_credit** — a balance fed by sweeps of solved problems, donations to already-Solved problems, unattributable payments, and sub-floor residue; consumed by claims after pool money and by rule B′ (§4). One row.
- **adjustments** — admin ledger entries with a reason code: dispute reversals, reconciliation corrections. Every adjustment is visible in the published ledger; there is no silent balance edit anywhere in the system.

Worker identity is a `WORKER_ID` (1–4) from environment config; there is no key registry — the trust boundary is "processes with access to the database," which is the box.

### Operations (each one transaction)

**donate(dedup_id, destination, gross, net, donor_tag)** — performed by the intake process (§5). Inserts the donation row (unique `dedup_id` makes replay a harmless constraint error) and credits the destination: Open or PendingReview problem → its pool (a donation landing during PendingReview is ordinary pool money, disposed of by the eventual verdict; by construction it can never be the acknowledged "caused the solve" donor, since that is the last donation before the winning claim); Solved problem or no problem (unattributable) → general credit, tagged accordingly. There is no status in which a settled payment has nowhere to go. Minimum enforced at checkout only ($50); the ledger accepts any positive net so a fee-shaved payment is never stranded.

**claim(problem_id, direction, run_budget, worker_id)** — the heart of the system.
1. Reject if the problem's status is not Open, if an unsettled claim exists for the pair (live lease = mutual exclusion; expired-unsettled = must be settled first, which the sampling loop's step 0 guarantees), or if `run_budget > $500` (a worker bug can never commit a large pool in one claim).
2. Capacity check: reject if `spendable_capacity < run_budget` (§3). Capacity is reserved by the claim and released at settlement.
3. Fund `run_budget` pool-first: take up to the pair's pool balance, then general credit for any remainder (rule B′ claims are general-only). Record `pool_funded` = the pool-sourced portion.
4. Insert the claim: budget, `pool_funded`, `spent = 0`, `claim_ts = now`, `lease_expiry = now + 60 min + 5 min grace`.

**checkpoint_spend(claim, new_spent)** — workers update `spent` after every API response (§2). Monotonic, clamped to budget.

**settle(claim, final_spent, solution_uri?)** — used by `release`, by `resolve`, and for expired claims of dead workers (callable by any worker; with per-call checkpoints, `final_spent` for a dead claim is simply the row's own `spent` — no external reconstruction, no waiting period). Clamps `final_spent` to `[0, budget]`, marks the claim settled, releases its capacity reservation less spend, and routes residue = `budget − final_spent` back to its sources: by convention spend consumes general-attributed dollars first (attribution is bookkeeping over fungible money; this direction favors the donor earmark), so residue is pool-attributed up to `pool_funded` and general-attributed beyond. Pool-attributed residue ≥ $50 returns to the pool balance; below $50 it goes to general credit (residue floor: a sub-$50 budget can't buy a useful run, and dust on a zero-pool pair would linger indefinitely at negligible weight — disclosed in the FAQ as "tiny unusable remainders from interrupted runs support all open problems"). General-attributed residue goes to general credit always. Without source attribution, a general-funded run dying would launder $500 of general credit into its pair's sampling weight; `pool_funded` is what keeps "general credit never enters the weights" (§4) true.

**The terminal-record invariant.** The R2 solution artifact (`solutions/{problem}/{dir}/{claim_ts}.md`, written before any resolve attempt per §2) is the durable terminal record of a run. Every path that settles a claim MUST check for the artifact matching that claim's `claim_ts` and carry its URI: `resolve` for a live winner, a solution-bearing `settle` for a live loser of the resolve race or for a dead worker in either role. Every artifact therefore ends up pointed at from the ledger — as the pending solution or the secondary — and no path to review depends on the original claimant surviving. A worker cannot die, and a race cannot be lost, in a state where a solution exists but is invisible to review.

**resolve(claim, final_spent, solution_uri)** — valid only for the claim's own worker while its lease is live and the problem is Open. Performs `settle`, sets status = PendingReview with the solution reference. While PendingReview, `claim` is rejected for both directions — out of the sampling distribution until a human rules — but donations still land per `donate`'s routing. If the opposite direction has a live run at resolve time it is not forcibly killed; its worker notices the status at its next checkpoint and settles (waste bounded by one run, and the solution is unverified at this point anyway). A worker whose `resolve` fails because status left Open (the opposite direction resolved minutes earlier — real race) falls back to a solution-bearing `settle`; the URI is recorded as the **secondary solution**, never dropped.

**review(problem_id, verdict, note_uri, assumption_label?, approve_direction?, reject_all?)** — admin CLI only. `verdict ∈ {unconditional, conditional, rejected}`. The canonical catalog statement is unconditional unless it names an assumption itself; an assumption-dependent complexity bound or construction is not an unconditional resolution merely because its assumption is conventional. When a secondary solution exists (competing opposite-direction solutions — at least one is necessarily wrong), the operation requires explicit disposition of both: unconditional approval must carry `approve_direction`; full rejection must carry `reject_all`; a conditional review must record or reject each candidate explicitly, or it errors.
- Unconditional → reviewed_result recorded, status = Solved (either direction's unconditional solve settles the problem entirely), funds handled per §5, frontend flips to verified with the donor acknowledgment.
- Conditional → `assumption_label` and note required, naming every assumption absent from the canonical statement. Reviewed_result recorded, status returns to Open, pools untouched, sampling resumes, no acknowledgment, no sweep. Displayed as "Resolved under assumption: X; unconditional problem remains open." Workers include the result in future context.
- Rejected → status returns to Open; note (covering both solutions under `reject_all`) is prepended to future runs so the model doesn't resubmit a refuted argument.

**sweep(problem_id)** — valid only when status is Solved; moves both pools' balances to general credit. Re-callable; the sampling loop sweeps Solved-with-residue automatically (a late settlement returning residue to a swept pool is collected within one loop iteration), so nothing depends on anyone remembering.

**treasury_fund(amount, external_ref)** — admin CLI records a real transfer of settled funds to Ramp (idempotent by ref). §3.

**dispute(dedup_id)** — marks a donation disputed/reversed and debits its destination via an `adjustments` row (pool floored at zero; any shortfall — money already burned — is recorded against general credit so the books still balance and the loss is visible). Donation terms state donations are final; this path exists because card networks exist, not because refunds are offered.

---

## 2. Workers

Exactly four processes, `worker-1..4`, kept alive by any standard supervisor (systemd with `Restart=always` is sufficient). Each worker's configuration/secrets: its `WORKER_ID`, its own Anthropic API key (one key per worker — kept for the reconciliation audit, §3), R2 credentials, the database path, and the repo's catalog + pricing table. Workers hold no state outside the ledger; disk is scratch space.

### Startup / recovery sequence

```
1. SELECT my unsettled claim, if any.
2. None, or lease expired → enter the sampling loop (§4); its step 0
   settles any expired claim (mine included) from the row's own spent.
3. Unsettled claim with live lease:
   a. Check R2 for a completed solution artifact for THIS claim
      (solutions/{problem}/{dir}/{claim_ts}.md). Present → the model
      solved it and I died before resolve landed: do not resume; post
      resolve with the row's spent; if status has left Open, post a
      solution-bearing settle (secondary) instead. Stop.
   b. No artifact, but lease_expiry − now − buffer too short for useful
      work → settle(spent from the row) immediately; enter sampling.
   c. Otherwise resume: budget − spent from the row, hard stop at
      lease_expiry − buffer, transcript-so-far from R2 as context.
```

No sleeps, no external reconstruction: the row's `spent` is authoritative to within one in-flight API call, and the budget headroom (§3) absorbs exactly that.

### The run itself

- Start/resume a Fable agent session with the directive (prove/disprove), both directions' compacted context plus any review rejection notes and conditional reviewed results from the ledger, and a `submit_solution` tool — call it if and only if you believe you have a complete, rigorous proof/disproof, with the full argument. The model's only terminal signal.
- Stream outputs to R2 continuously (`transcripts/{problem_id}/{direction}/{claim_ts}/...`); compact periodically via the SDK's context-management tooling, rewriting `compacted.md`.
- **Budget enforcement.** After every API response, price the `usage` fields with the versioned pricing table and `checkpoint_spend` in the ledger — the transactional write is the crash-recovery mechanism, so it is not optional or batched. Stop when spent ≥ budget less one request's worth of headroom, when the hard stop hits, or when `submit_solution` fires.
- **Hard stop.** No API call may be issued or awaited past `lease_expiry − buffer` (buffer ≥ max single-request duration + settlement time; the 5-min lease grace covers it). Absolute; backoff timers are clamped to it. Without it, rate-limit backoff could push a live run past expiry while another worker claims the pair — breaking mutual exclusion and spend attribution at once.
- **Status check.** At each compaction interval and after any long backoff, re-read the problem's status; if it left Open, settle and stop.
- **Rate limits / errors.** Exponential backoff with jitter on 429/5xx, respecting `retry-after`, clamped to the hard stop. Stalled wall clock burns the lease, not budget; unspent budget returns to the pool at settlement — nothing is lost.
- **On end.** `submit_solution` → write the artifact to R2 FIRST, then `resolve` (ordering is a requirement: the artifact is the terminal marker recovery checks, so a crash between the two leads a restarted worker to resolve, not to resume a solved run); on a lost race, solution-bearing `settle`. Budget/hard stop → `settle`. A failed operation (someone settled me already) is logged loudly and treated as convergence, never a crash-loop; the artifact is safe in R2 regardless.

### Model-solved caveat

`submit_solution` means the model believes it solved it. That belief only moves the problem to PendingReview, out of sampling, until the admin's `review` verdict. The frontend shows "claimed solved — under review," presents the problem as settled only after an unconditional verdict, and labels assumption-dependent results without implying the unconditional problem is solved.

---

## 3. Budget accounting and the capacity gate

### Spend is actuals, checkpointed

The claim row's `spent`, updated transactionally per API response and priced by the versioned pricing table (with a 2–3% safety margin so conversion drift never overspends real dollars), is the single source of truth — live, at settlement, and in recovery. Maximum accounting loss at any crash: one in-flight request, bounded by its `max_tokens`, absorbed by the headroom rule in §2.

**Admin API as audit, not settlement.** A periodic reconciliation job (daily is plenty) compares each worker key's Admin API usage report against the ledger's per-claim spend and alerts on drift beyond the margin. This is why one-key-per-worker is retained: the audit needs the attribution. Nothing in the live system waits on the Admin API.

### The capacity gate — how settlement lag is handled

Reality: a donation is spendable compute only after the payment settles through Open Collective/Stripe to the LLC bank and the admin stages funds at Ramp — in practice a daily cycle. The gate makes that lag explicit without per-donation ceremony:

```
spendable_capacity = Σ funding_events − Σ settled claim spend − Σ live claim budgets
```

- Donations credit pools immediately: weights, display, and the donor's line item are live within a minute of the intake loop seeing the paid order. What lags is runs, not recognition.
- `claim` requires and reserves capacity for its full budget; `settle` releases the unspent part. Workers can never commit Anthropic to more than the money actually staged at Ramp.
- The admin's entire treasury workflow is once daily: see settled funds at the bank, move them to Ramp (or raise the Ramp limit), run `indiemath treasury fund <amount> --ref <transfer-ref>`. One command per real-world transfer, idempotent by reference. **Deliberately not per-donation:** at tens of thousands of donations, marking individual payments "processed" is untenable busywork and false precision; money in the bank is fungible, and the meaningful event is the transfer. The per-donation "processed" badge donors see is *derived* from this command by FIFO waterline (§1 donations table): the daily entry flips every badge it covers.
- The treasury panel (admin CLI `indiemath treasury status`, mirrored in the publisher output) shows three numbers: settled-but-unfunded (from reconciling bank-side settlement against funding events — Stripe payout records for an independent collective, host payout records if fiscally hosted), funded capacity remaining, live reservations. When capacity is the binding constraint, the sampling loop idles in a named state and the panel shows exactly how much to move.
- Donor-facing copy, verbatim on the site: "Your donation is credited immediately; compute runs launch as funds settle — typically 1–2 business days."

### Ramp / Anthropic mechanics

Anthropic's auto-reload charges the Ramp card as credits deplete; size the reload increment so charges are infrequent relative to burn (~$8/min at full tilt) and confirm Ramp's per-transaction and daily limits clear it. Capacity should be funded ahead of the reload cadence so a mid-run charge never bounces; the safety margin plus the capacity gate make "card declined mid-run" a treasury-ops failure, visible in the panel, rather than a silent one.

---

## 4. Problem selection (sampling loop)

Run by any worker with no live claim. No lock is acquired — every step is one ledger transaction:

```
0. Settle & sweep: settle any expired unsettled claim (final_spent = the
   row's own spent; carry the R2 solution artifact's URI if one matches
   its claim_ts — terminal-record invariant). Sweep any Solved problem
   with a nonzero pool. Races between workers are harmless: the loser's
   transaction no-ops. After this step the ledger is truthful.
1. Read pools, general credit, claims, statuses, spendable_capacity —
   one transaction's snapshot.
2. Eligible pairs: status Open, no unsettled claim for the pair. The
   opposite direction running does NOT exclude a pair. For each:
   available = pool balance. (General credit never enters the weights —
   it substitutes inside claims and rule B′ — so it cannot distort the
   funding-weighted distribution.)
3. Let cap = spendable_capacity.
   If cap < $50: treasury-blocked. Sleep 15 min, surface the state to
   the publisher ("runs paused pending treasury transfer"), goto 0.
   A. If any available ≥ $500 and cap ≥ $500:
        weight(p) = floor(available_p / 500) × 500; sample;
        run_budget = $500
   B. Else if any available ≥ $50:
        weight(p) = available_p over qualifying pairs; sample;
        run_budget = min(available, cap, 500)
   B′. Else if general credit ≥ $50: sample uniformly over eligible
        pairs; run_budget = min(500, general credit, cap)
   C. Else: sleep 15 minutes, goto 0. (Sub-$50 pools aren't stuck —
        visible in the UI, runnable with the next donation.)
4. claim(problem, dir, run_budget). Success → run (§2). Failure (raced,
   drained, capacity taken) → drop the pair locally, goto 3.
```

The $50 minimum run size shares the §1 residue-floor constant: a smaller budget is eaten by context loading.

---

## 5. Donations (Open Collective on Stripe)

The donation UI is the project's Open Collective page: the site's problem cards link straight into the right contribution flow. Payment rails are OC's Stripe underneath — invisible plumbing.

- **Attribution: one OC contribution tier per (problem, direction),** generated and kept in sync by the admin CLI through the Open Collective GraphQL API at catalog-sync time (~2 tiers per problem), each carrying the problem/direction in its slug and description and the $50 minimum. Every OC order references the tier it came through, which is what makes attribution queryable. Each problem card on the site links to its two tiers' checkout URLs. **This tier→order mapping is the design's load-bearing assumption — verify it end-to-end in a test collective before launch** (order API exposes tier, pagination works, guest/incognito display names behave as expected). Orders that don't map to a tier — someone donating to the collective generically, or to a since-removed tier — route to general credit, tagged unattributed; donations are never stranded.
- **The intake process** (half of the fifth supervised process; the other half is the publisher, §7) is a reconciliation loop: poll the OC GraphQL API for paid orders since the last cursor, map tier → (problem, direction), take the donor's display name from the OC account (incognito → anonymous), and `donate` each with `dedup_id` = the OC order ID — the unique index makes replay harmless. OC webhooks, if configured, are a latency optimization only; the poll is authoritative. Kill and restart the loop anywhere and it re-derives the un-ingested set. Status routing as ever: PendingReview → pool; Solved → general credit (§1 `donate`).
- **Fees and net crediting.** The fee stack is OC platform/host fees (depends on whether the collective is independent or fiscally hosted) plus Stripe processing. Pools are credited **net**, stated plainly on each tier: "$5,000 ≈ $X of compute." Confirm the exact stack for your collective's configuration before writing the tier copy (§8).
- **Independent vs. hosted — affects the treasury leg, not this section.** As an Independent Collective on the LLC's own Stripe, payouts settle to the LLC bank on Stripe's normal schedule and §3's daily flow applies as written. If the collective later moves under a fiscal host, money sits at the host and reaches Ramp via host expense/payout mechanics instead — the capacity gate and daily `treasury fund` command are unchanged, but the settled-but-unfunded figure's source changes. Decide before launch; the ledger doesn't care.
- **Disputes/chargebacks.** Donation terms (published before the first donation — the document every dispute resolves against) state donations are final and fund attempts, not outcomes. A lost dispute, surfacing via OC/Stripe, flows through `dispute()` (§1): destination debited, shortfall visible, ledger honest.
- **Funds on an unconditional solve.** Remaining pool money sweeps to general credit, consumed by future claims after pool money and via rule B′ — effectively funding all open problems. Stated at donation time: "if this problem is solved unconditionally, remaining funds support the other open problems." Conditional results leave pools untouched. Refunds-on-solve are a v2-if-demanded feature; build only if donors ask.

---

## 6. Model outputs (R2)

- Layout: `transcripts/{problem_id}/{direction}/{claim_ts}/raw-{seq}.jsonl`; `transcripts/{problem_id}/{direction}/compacted.md`; `solutions/{problem_id}/{direction}/{claim_ts}.md` — keyed per direction and per claim so an opposite-direction solve or a rejected-then-retried attempt can never clobber an artifact a pending review or rejection note references; `reviews/{problem_id}/{ts}.md`; `public/state.json` and `public/ledger.json` (the published ledger export); `db-replica/` (Litestream).
- Cross-direction context: feed the model both directions' `compacted.md` — a failed proof maps terrain for a disproof and vice versa; it's all public anyway.
- Workers write; the frontend reads via CDN.

---

## 7. Frontend and admin

A static page whose only data source is R2/CDN. The publisher half of the fifth process reads the ledger and writes `state.json` every 30–60 seconds — pools, live claims with burn-down straight from `spent` (no Admin API on this path anymore), statuses, pending and reviewed results with assumption labels, donor lists, treasury status ("runs paused pending settlement" when capacity-blocked), and a Solved-with-residue flag — plus `ledger.json`, the full public donation/run/review ledger that is the system's verifiability story (§ principle 5). Published atomically so browsers never see a partial snapshot.

- **Ordering.** Running problems first; then by total pool size.
- **Funding progress.** Per (problem, direction): "$X raised — Y% toward its next hour," with the global settling notice when relevant: "new donations become runnable as funds settle (1–2 business days)."
- **Donations list.** Each problem page shows its recent donations from `state.json` — display name, amount, direction, and the derived processed badge ("received" → "processed") — with a link to the project's Open Collective page as the independently hosted second view of the same money. Browsers never call the OC API directly: the intake loop is the single ingestion path, so the site, the ledger export, and the badges can't disagree.
- **Transcripts.** Linked per problem, viewable live.
- **Review states.** PendingReview: "claimed solved — under review," solution readable, explicitly unverified; competing secondary solutions shown together, labeled as mutually contradictory. Unconditional solve: verified display + donor acknowledgment — the last donation into the winning pool before the winning claim, by display name, straight from the published ledger. Conditional: "Resolved under assumption: X; unconditional problem remains open," still fundable, no acknowledgment. Rejected: back in the list, note linked.
- **Ledger page.** Renders `ledger.json`: every donation line item, every run with budget/spend/transcript, every verdict. A donor finds their own row; anyone reconciles totals.
- **Admin surface.** Entirely the CLI on the box — catalog sync, review verdicts, treasury funding, inspections, dispute entries. No admin web backend, no auth system; the trust boundary is shell access. The "dashboard" the treasury workflow needs is `indiemath treasury status` plus the publisher's mirror of it.

---

## 8. Pre-build checklist (open questions)

1. **Open Collective + Stripe:** decide independent-vs-hosted before launch (it changes the treasury leg, §5); complete the collective's setup under the LLC with full Stripe business verification; proactively brief Stripe risk on expected volume, average donation size, product, and launch date (a fresh connected account taking a sudden spike of large payments is a textbook automatic-hold trigger); verify in a test collective the tier→order attribution round-trip, API pagination/cursoring, guest and incognito display-name behavior, and webhook availability; confirm the exact fee stack for net-crediting copy; confirm which payment rails OC's checkout offers your donors (card vs. bank transfer) and payout timing to the bank.
2. **Ramp:** confirm the mechanics and latency of staging funds / raising the card limit; per-transaction and daily card limits vs. the Anthropic auto-reload increment; whether limit changes are same-day.
3. **Anthropic:** org-tier spend and rate limits vs. the theoretical burn ceiling (4 workers × $500/hr ≈ $48K/day) — raise limits before donations outrun burn capacity; auto-reload maximum increment; Agents SDK compaction/context-management API names and limits for hour-long runs.
4. **Legal/ops:** donation-terms page (final, funds attempts not outcomes, surplus-on-solve policy, dispute stance) live before the first donation; an accountant pass on donation-revenue vs. compute-expense timing across tax years for the LLC; Litestream restore drill actually performed once before launch.
