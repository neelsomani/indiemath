# IndieMath — System Specification

A site with a curated list of open math/CS problems. People donate to a specific problem, choosing whether the model should try to prove or disprove it. Donations fund runs of the best available AI model (assumed: Claude Fable at ~$500/hour) against that problem.

Money rails: donors pay through the project's Open Collective page (Stripe underneath; cards and, where available, bank transfers) → funds settle to the operating LLC's bank account → once a day the admin stages settled money at Ramp (transfer / limit increase) and records it → a Ramp virtual card with auto-reload pays Anthropic. Settlement lag is a first-class design fact, handled by the capacity gate (§3), not hidden.

## Design principles

1. **Crash-only workers.** Workers are plain processes that may die and restart at any time. There is no graceful-shutdown path and no separate recovery path: recovery is startup. On boot, a worker reconstructs everything it needs from the ledger database.
2. **One SQLite ledger is the coordination layer.** All pools, donations, claims, leases, spend, reviews, and treasury state live in a single SQLite database (WAL mode) on the worker box. Transactions (`BEGIN IMMEDIATE`) are the only lock in the system. The ledger is continuously replicated off-box to R2 with Litestream and is restorable through a verified drill. Cloudflare is deliberately the sole off-box backup vendor; there is no second-vendor replica.
3. **R2 holds bulk artifacts and published snapshots.** Cloudflare R2 holds transcripts, solutions, review notes, the public `state.json`, the public ledger export, and the database replica. Things that are displayed or restored — never a second coordination channel. Public prefixes serve through Cloudflare's CDN with zero egress cost.
4. **Money path: donor → Open Collective (Stripe) → LLC bank → Ramp → Anthropic.** Pools are credited the moment the intake loop sees a paid Open Collective contribution credit transaction; compute launches only against funded capacity (§3). Lipschitz Strategies LLC is the entity behind the collective and the counterparty named in the contribution terms, regardless of personal-name branding on the site.
5. **Verifiability means transparency, not trustlessness.** The system publishes its ledger: every donation (display name, amount, problem, direction, timestamp, processed status), every run (budget, spend, transcript link), every review verdict — and Open Collective's own public page provides a second, independently hosted view of the money. Donors verify their own line items; the published ledger reconciles against Open Collective's records and priced API usage.

Total infrastructure: five supervised application processes on one VM (EC2 or GCP — any plain Linux box with a real disk; four workers + one intake/publisher), one Litestream daemon replicating to R2, one SQLite database, an R2 bucket behind Cloudflare's CDN, a static frontend on Cloudflare Pages, an Open Collective page on Stripe under the LLC, and a Ramp card. Zero public server endpoints: checkout is Open Collective-hosted, and the site is static files.

---

## 1. The ledger (SQLite)

One database file, WAL mode, owned by the five processes on the box. Every operation below is a single transaction; `BEGIN IMMEDIATE` serializes writers across processes, which is the entire mutual-exclusion story. Keep the schema small: every table not created is a migration not regretted.

### Tables

- **problems** — synced from the repo catalog by the admin CLI: `problem_id` (permanent; 3–64 lowercase alphanumeric/hyphen characters), an identity hash of the normalized canonical statement, catalog metadata and revision, status ∈ {Open, PendingReview, Solved}, and for PendingReview: pending solution (direction, claim_ts, R2 URI) and optional secondary solution (direction, claim_ts, URI). Status is problem-level; both directions' logic reads it. Sync is transactional: changed content requires a strictly newer catalog revision; a previously issued ID cannot acquire a different canonical statement or disappear from the catalog; metadata-only changes are allowed.
- **Identity boundary** — problem identity is intentionally the normalized canonical statement only. Titles, slugs, sources, direction prompts, and review-policy wording are revisioned guidance and metadata, not part of the mathematical claim. Every claim records the `catalog_revision` it ran against; review adjudicates against the canonical statement and policy at that revision, recoverable from git history, rather than treating a direction prompt as the definition of proof or disproof.
- **pools** — one row per `(problem_id, direction)`, `direction ∈ {prove, disprove}`: balance (integer cents), cumulative donation total. Prove and disprove are independently fundable, claimable, and sampled; a joint lock would zero one direction's sampling probability whenever the other runs, distorting the funding-weighted selection donors were promised. Up to two workers may work the same problem simultaneously, one per direction.
- **donations** — one row per charge-level Open Collective credit transaction: `dedup_id` (the transaction ID — unique index; the intake process's idempotency), `order_id` (non-unique parent contribution/order, so recurring installments remain attributable), actual destination (a `(problem, direction)` pool, or general credit), intended problem/direction when status routing redirects a contribution to general credit, gross and net amounts, fees, `donor_tag` (the OC account's display name; guest/incognito contributions → anonymous), timestamps, and payment state ∈ {credited, disputed, reversed}. This table is the donor-facing ledger. Refund state ∈ {none, partial, full} and `refunded_amount` are derived from completed refund adjustments referencing `dedup_id`; a state flip alone cannot represent a partial refund. A donation's effective amount in the processing waterline is `net − completed refunds − pre-processing dispute exclusions`. A dispute recorded while the donation is still received removes that amount from the waterline; a chargeback after any funding coverage does not rewrite historical coverage or push the waterline onto a later donation. In FIFO credit-time order, a contribution remains **received** and refundable only while cumulative funding events have not reached any part of its effective amount; the first cent of coverage flips it to **processed** and permanently closes its ordinary refund window. A fully refunded row displays as refunded instead of received/processed.
- **claims** — one row per run: `(problem_id, direction)`, `catalog_revision`, worker_id, `claim_ts`, budget, `pool_funded` (pool-attributed portion of the budget; the rest is general-attributed — required so settlement returns residue to its sources), spent (updated transactionally after every API response, §2), `lease_expiry`, settled flag, solution URI if any. A partial unique index on unsettled claims per `(problem_id, direction)` makes double-claiming impossible at the schema level, not just the code level.
- **claim_responses** — one immutable row per completed Anthropic message: the claim key and sequence, globally unique Anthropic message ID, request ID and request-start timestamp, exact replayable request and response JSON, returned model/container/stop/context-management metadata and usage, versioned priced cost, the portion applied to the claim, and any visible overage. Inserting this row and advancing `claims.spent` happen in one transaction. Replaying the same message is a no-op only when every value agrees, so a crash after the API response cannot double-charge or lose the next-turn history.
- **reviewed_results** — one row per adjudicated solution: `(problem_id, direction, claim_ts)`, solution URI, outcome ∈ {unconditional, conditional, rejected}, review-note URI, assumption label for conditional results. Immutable history; conditional results are display and future-run context, never money state.
- **funding_events** — the treasury table: one row per real-world transfer of settled funds to Ramp (or Ramp limit increase): amount, external reference (bank/Ramp transfer ID — unique, making the record idempotent), the cumulative settled-contribution snapshot derived from payout reconciliation, and timestamp. The snapshot is an internal reconciliation result, never operator-entered. §3 defines how these gate compute.
- **general_credit** — a balance fed by sweeps of solved problems, donations to already-Solved problems, unattributable payments, and sub-floor residue; consumed by claims after pool money and by rule B′ (§4). The row also carries visible nonnegative debt for dispute/reconciliation shortfalls that could not be debited without consuming a received donation's refund liability; claimable general credit is `max(0, balance − received liabilities − debt)`.
- **adjustments** — ledger entries with a signed integer-cent amount, reason ∈ {refund, dispute, reconciliation}, optional donation `dedup_id`, unique external/idempotency reference, and status ∈ {pending, completed, canceled}. Refund and dispute rows must reference the original donation. Every adjustment is visible in the published ledger; there is no silent balance edit anywhere in the system.

Worker identity is a `WORKER_ID` (1–4) from environment config; there is no key registry — the trust boundary is "processes with access to the database," which is the box.

**Time convention.** Identity timestamps embedded in keys or compound identities (`claim_ts`, review artifact timestamps) are UTC Unix epoch milliseconds stored as safe integers. Human/API timestamps and deadlines (`credited_at`, `funded_at`, `reviewed_at`, `lease_expiry`) are canonical UTC ISO-8601 strings. Arithmetic converts ISO strings to epoch milliseconds once at the operation boundary; code never subtracts or compares the two representations implicitly.

### Operations (each one transaction)

**donate(dedup_id, order_id, destination, gross, net, donor_tag)** — performed by the intake process (§5) once per charge-level credit transaction. Inserts the donation row (unique transaction `dedup_id` makes replay harmless while the non-unique `order_id` groups recurring installments) and credits the destination: Open or PendingReview problem → its pool (a donation landing during PendingReview is ordinary pool money, disposed of by the eventual verdict; by construction it can never be the acknowledged "caused the solve" donor, since that is the last donation before the winning claim); Solved problem or no problem (unattributable) → general credit. A Solved redirect records general credit as the actual destination and retains the requested problem/direction as its intended attribution, so replay validation and the public ledger do not lose why the payment arrived. There is no status in which a settled payment has nowhere to go. Minimum enforced at checkout only ($50); the ledger accepts any positive net so a fee-shaved payment is never stranded.

**claim(problem_id, direction, run_budget, worker_id, funding_mode = pool-only)** — the heart of the system. `funding_mode ∈ {pool-only, general-only, pool-first}`; omission deliberately fails closed to `pool-only`.
1. Reject if the problem's status is not Open, if an unsettled claim exists for the pair (live lease = mutual exclusion; expired-unsettled = must be settled first, which the sampling loop's step 0 guarantees), or if `run_budget > $500` (a worker bug can never commit a large pool in one claim).
2. Capacity check: reject if `spendable_capacity < run_budget` (§3). Capacity is reserved by the claim and released at settlement.
3. Rules A/B call with `pool-only`, which rejects unless the selected pair's **claimable balance** covers the entire budget. Rule B′ calls with `general-only`. The sampling loop never calls `pool-first`; that explicit mode exists only for a deliberately mixed-funding caller and can never be reached by omitting the argument. Claimable balance is ordinary balance minus its refund liability: the effective net of every received/unprocessed donation to that destination, less its pending refund reservations. This preserves those funds for refunds until the shared waterline marks their donation processed. Record `pool_funded` = the pool-sourced portion.
4. Insert the claim: budget, `pool_funded`, `spent = 0`, `claim_ts = now`, `lease_expiry = now + 60 min + 5 min grace`.

**checkpoint_spend(claim, new_spent)** — workers update `spent` after every API response (§2). Monotonic, clamped to budget.

**settle(claim, final_spent, solution_uri?)** — used by `release`, by `resolve`, and for expired claims of dead workers (callable by any worker; with per-call checkpoints, `final_spent` for a dead claim is simply the row's own `spent` — no external reconstruction, no waiting period). Clamps `final_spent` to `[0, budget]`, marks the claim settled, releases its capacity reservation less spend, and routes residue = `budget − final_spent` back to its sources: by convention spend consumes general-attributed dollars first (attribution is bookkeeping over fungible money; this direction favors the donor earmark), so residue is pool-attributed up to `pool_funded` and general-attributed beyond. Pool-attributed residue ≥ $50 returns to the pool balance; below $50 it goes to general credit (residue floor: a sub-$50 budget can't buy a useful run, and dust on a zero-pool pair would linger indefinitely at negligible weight — disclosed in the FAQ as "tiny unusable remainders from interrupted runs support all open problems"). General-attributed residue goes to general credit always. Without source attribution, a general-funded run dying would launder $500 of general credit into its pair's sampling weight; `pool_funded` is what keeps "general credit never enters the weights" (§4) true.

**The terminal-record invariant.** The R2 solution artifact (`solutions/{problem}/{dir}/{claim_ts}.md`, written before any resolve attempt per §2) is the durable terminal record of a run. Every path that settles a claim MUST check for the artifact matching that claim's `claim_ts` and carry its URI: `resolve` for a live winner, a solution-bearing `settle` for a live loser of the resolve race or for a dead worker in either role. Every artifact therefore ends up pointed at from the ledger — as the pending solution or the secondary — and no path to review depends on the original claimant surviving. A worker cannot die, and a race cannot be lost, in a state where a solution exists but is invisible to review.

**resolve(claim, final_spent, solution_uri)** — valid only for the claim's own worker while its lease is live and the problem is Open. Performs `settle`, sets status = PendingReview with the solution reference. While PendingReview, `claim` is rejected for both directions — out of the sampling distribution until a human rules — but donations still land per `donate`'s routing. If the opposite direction has a live run at resolve time it is not forcibly killed; its worker notices the status at its next checkpoint and settles (waste bounded by one run, and the solution is unverified at this point anyway). A worker whose `resolve` fails because status left Open (the opposite direction resolved minutes earlier — real race) falls back to a solution-bearing `settle`; the URI is recorded as the **secondary solution**, never dropped.

**review(problem_id, verdict, note_uri, assumption_label?, approve_direction?, reject_all?)** — admin CLI only. `verdict ∈ {unconditional, conditional, rejected}`. **Unsettled-competitor gate:** review rejects with `competing-claim-unsettled` while any claim for the problem remains unsettled, whether or not that claim has produced a secondary artifact yet. The gate is problem-wide and cannot be bypassed by choosing a candidate; it ensures an opposite-direction worker has either attached its terminal solution as the secondary candidate or settled without one before any verdict can close or reopen the problem. The canonical catalog statement is unconditional unless it names an assumption itself; an assumption-dependent complexity bound or construction is not an unconditional resolution merely because its assumption is conventional. When a secondary solution exists (competing opposite-direction solutions — at least one is necessarily wrong), the operation requires explicit disposition of both: unconditional approval must carry `approve_direction`; full rejection must carry `reject_all`; a conditional review must record or reject each candidate explicitly, or it errors.
- Unconditional → reviewed_result recorded, status = Solved (either direction's unconditional solve settles the problem entirely), funds handled per §5, frontend flips to verified with the donor acknowledgment.
- Conditional → `assumption_label` and note required, naming every assumption absent from the canonical statement. Reviewed_result recorded, status returns to Open, pools untouched, sampling resumes, no acknowledgment, no sweep. Displayed as "Resolved under assumption: X; unconditional problem remains open." Workers include the result in future context.
- Rejected → status returns to Open; note (covering both solutions under `reject_all`) is prepended to future runs so the model doesn't resubmit a refuted argument.

**sweep(problem_id)** — valid only when status is Solved; moves both pools' claimable balances to general credit but leaves received/unprocessed refund liabilities at their original destination. Re-callable; the sampling loop sweeps Solved-with-claimable-residue automatically (a late settlement returning residue, or a later funding event closing a retained donation's refund window, is collected within one loop iteration), so nothing depends on anyone remembering and a received donation never becomes unrefundable merely because its problem was solved.

**treasury_fund(amount, external_ref)** — admin CLI records a real transfer of settled funds to Ramp (idempotent by ref) and rejects an amount above `available_to_fund` (§3). The operator supplies only the transferred amount and its bank/Ramp reference. Before calling the ledger operation, the CLI refreshes payout reconciliation and derives cumulative `settled_contribution_cents` from matched Stripe payout records (independent collective) or host payout records (fiscally hosted); there is no flag, prompt, or positional argument through which the operator can type that total. The ledger receives and records the derived snapshot internally. If reconciliation is unavailable, incomplete, or would move the cumulative snapshot backward, the command refuses to record the funding event. Its transaction and `begin_refund` serialize; a funding event that lands first may close the donation's refund window, while a refund reservation that lands first is withheld from `available_to_fund`.

**begin_refund(dedup_id, requested_amount, idempotency_ref)** — admin CLI only. In one `BEGIN IMMEDIATE` transaction, calls the same FIFO-waterline derivation used for the public badge and rejects the donation outright if it is processed; partial coverage of the marginal donation counts as processed. For a still-received donation, it sums pending and completed refund adjustments, computes `remaining_donation = net − completed_refunds − pending_refunds`, and then computes `refundable = min(requested_amount, remaining_donation, current_destination_balance)`. Rejects a zero result. Inserts a pending negative refund adjustment referencing the donation and immediately debits/reserves that amount. Claims and sweeps independently protect the remaining received-donation liability, so neither can make the badge and refund answer disagree. Replaying the same `idempotency_ref` returns the existing request.

The admin then requests the matching Open Collective/Stripe refund using the same idempotency reference. **complete_refund(idempotency_ref, provider_ref)** marks the adjustment completed and records the provider reference; the donation's public `refunded_amount` and none/partial/full refund state are derived from completed adjustments. If the external refund definitively fails, **cancel_refund(idempotency_ref, note)** marks the adjustment canceled and restores the reserved amount to its original destination in one transaction. A process dying after the provider accepts the refund retries the provider request with the same key and then completes the existing ledger row, so neither money nor history is duplicated.

**dispute(dedup_id)** — marks a donation disputed/reversed and debits its destination via an `adjustments` row. It may debit that donation's own received liability but cannot consume another received donation's protected balance; any remaining shortfall — money already burned or otherwise unavailable — becomes visible general-credit debt so the books still balance. A dispute before processing excludes its amount from the FIFO waterline. A dispute after processing preserves the historical coverage boundary, so a later received contribution cannot become final without a new funding event. This is distinct from a customer-requested refund and remains adjustment-backed and auditable.

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
- **Anthropic request contract.** Messages use `model: claude-fable-5`, `anthropic-version: 2023-06-01`, beta headers `task-budgets-2026-03-13` and `compact-2026-01-12`, `code_execution_20260521`, `web_fetch_20260318`, and the `compact_20260112` context-management strategy. Web fetch is included with code execution because this request shape makes code execution free of an additional container charge and web fetch itself has no surcharge; both still contribute ordinary input/output tokens. The versioned pricing table and these identifiers are reviewed together.
- **Compaction and advisory budget.** The complete assistant content, including every compaction block's visible and encrypted fields, is replayed unchanged. The API discards history before the compaction block on the next request. A server-generated compaction block and `task_budget.remaining` are mutually exclusive: the block preserves the server-side countdown, while `remaining` is only for a client-side rewrite that replaces history. The production runner therefore replays the block and does not send `remaining`. Billed usage comes from the sum of `usage.iterations` whenever present because top-level token counts omit compaction iterations.
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

**Admin API as audit, not settlement.** The reconciliation command queries `/v1/organizations/usage_report/messages` with the shared Admin key, filters by the worker's `api_key_id`, groups by API key/model/context window in one-minute buckets, follows `next_page`, and prices the reconstructed usage with the same checked-in table and margin. The API cannot split two sequential claims sharing a boundary minute, so the ledger side deliberately includes every response started by that worker inside the same rounded window and reports all contributing claim keys; it never attributes an indivisible minute bucket to only one claim. The result is compared with immutable `claim_responses` and alerts on drift beyond the configured tolerance. This is why one-key-per-worker is retained: the audit needs the attribution. Nothing in the live system waits on the Admin API. Code execution does not appear in this usage report; the live request contract deliberately makes its additional charge zero, while any future request-profile change must add Cost API reconciliation before it ships.

### The capacity gate — how settlement lag is handled

Reality: a donation is spendable compute only after the payment settles through Open Collective/Stripe to the LLC bank and the admin stages funds at Ramp — in practice a daily cycle. The gate makes that lag explicit without per-donation ceremony:

```
spendable_capacity = Σ funding_events − Σ settled claim spend − Σ live claim budgets
settled_but_unfunded = Σ settled contribution credits − Σ completed refunds − Σ funding_events
available_to_fund = settled_but_unfunded − Σ pending refund reservations
```

- Donations credit pools immediately: weights, display, and the donor's line item are live within a minute of the intake loop seeing the contribution credit transaction. What lags is runs, not recognition.
- `claim` requires and reserves capacity for its full budget, and may debit only claimable pool/general balances; `settle` releases the unspent part. The claimable-balance rule protects every received donation while the capacity gate prevents workers from committing Anthropic to more than the money actually staged at Ramp.
- The admin's daily order is: handle the refund inbox and finish or cancel pending provider refunds; let `indiemath treasury status` refresh payout reconciliation and derive settled contributions; move no more than its `available_to_fund` to Ramp (or raise the Ramp limit); run `indiemath treasury fund <amount> --ref <transfer-ref>`. The fund command refreshes the same reconciliation again before recording the event; it never asks the admin for `settled_contribution_cents`. One command per real-world transfer, idempotent by reference. **Deliberately not per-donation:** the public badge and refund gate both use the same FIFO waterline over effective donation amounts. Any positive coverage, including a partially covered marginal donation, changes its badge from received to processed and makes the remaining amount final.
- The treasury panel (admin CLI `indiemath treasury status`, mirrored in the publisher output) shows settled-but-unfunded after completed refunds, pending refund reservations, available-to-fund, funded capacity remaining, and live reservations. Settlement comes from Stripe payout records for an independent collective or host payout records if fiscally hosted. Completed refunds reduce settled-but-unfunded; pending refunds reduce only available-to-fund until completed or canceled. These amounts are checked invariants, not values floored at zero.
- Donor-facing copy, verbatim on the site: "Your contribution is credited immediately and processed within 1–2 business days after receipt (Monday through Friday). While it says received, it has not been staged for compute and may be refunded on request. Once it says processed, it is committed and final."

### Ramp / Anthropic mechanics

Anthropic's auto-reload charges the Ramp card as credits deplete; size the reload increment so charges are infrequent relative to burn (~$8/min at full tilt) and confirm Ramp's per-transaction and daily limits clear it. Capacity should be funded ahead of the reload cadence so a mid-run charge never bounces; the safety margin plus the capacity gate make "card declined mid-run" a treasury-ops failure, visible in the panel, rather than a silent one.

---

## 4. Problem selection (sampling loop)

Run by any worker with no live claim. No lock is acquired — every step is one ledger transaction:

```
0. Settle & sweep: settle any expired unsettled claim (final_spent = the
   row's own spent; carry the R2 solution artifact's URI if one matches
   its claim_ts — terminal-record invariant). Sweep any Solved problem
   with nonzero claimable pool balance, retaining received-donation
   refund liability. Races between workers are harmless: the loser's
   transaction no-ops. After this step the ledger is truthful.
1. Read pool balances and claimable balances, claimable general credit,
   claims, statuses, spendable_capacity — one transaction's snapshot.
2. Eligible pairs: status Open, no unsettled claim for the pair. The
   opposite direction running does NOT exclude a pair. For each:
   weightable = total pool balance (including protected received money);
   runnable = claimable pool balance. (General credit never enters the
   weights or supplements Rules A/B; it selects work only through
   uniform rule B′.)
3. Let cap = spendable_capacity.
   If cap < $50: treasury-blocked. Sleep 15 min, surface the state to
   the publisher ("runs paused pending treasury transfer"), goto 0.
   A. Let A500 = pairs with runnable ≥ $500.
      If A500 is nonempty and cap ≥ $500:
        sample only from A500, with
        weight(p) = weightable_p;
        run_budget = $500
   B. Otherwise let B50 = pairs with runnable ≥ $50.
      If B50 is nonempty:
        sample only from B50, with weight(p) = weightable_p;
        run_budget = min(runnable, cap, 500)
   B′. Else if claimable general credit ≥ $50: sample uniformly over
        eligible pairs; run_budget = min(500, claimable general credit, cap)
   C. Else: sleep 15 minutes, goto 0. (Sub-$50 pools aren't stuck —
        visible in the UI, runnable with the next donation.)
4. claim(problem, dir, run_budget,
         funding_mode = general-only for B′, pool-only for A/B).
   Success → run (§2). Failure (raced, drained, capacity taken) →
   drop the pair locally, goto 3.
```

Rules A and B sample in exact proportion to each candidate's donated balance; there is no weighting floor or bucket. They never ask `claim` for more than the selected pair's own claimable pool balance. Protected received money may increase weight inside the applicable candidate set, but cannot make an underfunded pair eligible or pull general credit into a pool-weighted selection. General credit selects work only through uniform rule B′.

The $50 minimum run size shares the §1 residue-floor constant: a smaller budget is eaten by context loading.

---

## 5. Donations (Open Collective on Stripe)

The donation UI is the project's Open Collective page: the site's problem cards link straight into the right contribution flow. Payment rails are OC's Stripe underneath — invisible plumbing.

- **Attribution: one OC contribution tier per (problem, direction),** generated and kept in sync by the admin CLI through the Open Collective GraphQL API at catalog-sync time (~2 tiers per problem), each carrying the problem/direction in its slug and description and the $50 minimum. Every contribution order references the tier it came through, and every charge-level credit transaction references its parent order; that transaction→order→tier chain makes both one-time and recurring charges attributable. Each problem card on the site links to its two tiers' checkout URLs. **This chain is the design's load-bearing assumption — verify it end-to-end in a test collective before launch** (transaction pagination works, each recurring installment has a distinct transaction ID, the order/tier relation is exposed, and guest/incognito display names behave as expected). Transactions whose parent order does not map to a tier — generic contributions or a since-removed tier — route to general credit, tagged unattributed; contributions are never stranded.
- **The intake process** (half of the fifth supervised process; the other half is the publisher, §7) is a reconciliation loop: poll OC GraphQL credit transactions since the last cursor, retain contribution credits, follow each transaction's parent order to the tier, take the donor's display name from the OC account (incognito → anonymous), and call `donate` with `dedup_id` = the credit transaction ID and `order_id` = the non-unique parent order ID. A recurring contribution therefore produces one donation row per installment instead of silently dropping every charge after month one. The transaction-ID unique index makes poll replay harmless. OC webhooks, if configured, are a latency optimization only; the poll is authoritative. Kill and restart the loop anywhere and it re-derives the un-ingested set. Status routing as ever: PendingReview → pool; Solved → general credit (§1 `donate`).
- **Fees and net crediting.** The fee stack is OC platform/host fees (depends on whether the collective is independent or fiscally hosted) plus Stripe processing. Pools are credited **net**, stated plainly on each tier: "$5,000 ≈ $X of compute." Confirm the exact stack for your collective's configuration before writing the tier copy (§8).
- **Independent vs. hosted — affects the treasury leg, not this section.** As an Independent Collective on the LLC's own Stripe, payouts settle to the LLC bank on Stripe's normal schedule and §3's daily flow applies as written. If the collective later moves under a fiscal host, money sits at the host and reaches Ramp via host expense/payout mechanics instead — the capacity gate and daily `treasury fund` command are unchanged, but the settled-but-unfunded figure's source changes. Decide before launch; the ledger doesn't care.
- **Refunds and disputes.** The customer-facing terms govern, with one mechanically enforced boundary: a contribution displaying **received** may be refunded through the `begin_refund` → provider refund → `complete_refund` flow in §1; once the treasury command makes it **processed**, it is final and `begin_refund` rejects it even if some pool balance remains. A failed provider request is canceled and restores the reservation. A chargeback is separate and flows through `dispute()`: destination debited, shortfall visible, ledger honest.
- **Funds on an unconditional solve.** Remaining claimable pool money sweeps to general credit, consumed by future claims after pool money and via rule B′ — effectively funding all open problems. Received/unprocessed money stays protected at its original pool until it is refunded or becomes processed, at which point the re-callable sweep collects it. Stated at contribution time: "if this problem is solved unconditionally, remaining funds support the other open problems." Conditional results leave pools untouched.

---

## 6. Model outputs (R2)

- Layout: `transcripts/{problem_id}/{direction}/{claim_ts}/raw-{seq}.jsonl`; `transcripts/{problem_id}/{direction}/compacted.md`; `solutions/{problem_id}/{direction}/{claim_ts}.md` — keyed per direction and per claim so an opposite-direction solve or a rejected-then-retried attempt can never clobber an artifact a pending review or rejection note references; `reviews/{problem_id}/{ts}.md`; `public/state.json` and `public/ledger.json` (the published ledger export); `db-replica/` (Litestream).
- Cross-direction context: feed the model both directions' `compacted.md` — a failed proof maps terrain for a disproof and vice versa; it's all public anyway.
- Workers write; the frontend reads via CDN.

---

## 7. Frontend and admin

A static page whose only data source is R2/CDN. The publisher half of the fifth process reads the ledger and writes `state.json` every 30–60 seconds — pools, live claims with burn-down straight from `spent` (no Admin API on this path anymore), statuses, pending and reviewed results with assumption labels, donor lists, treasury status ("runs paused pending settlement" when capacity-blocked), and a Solved-with-residue flag — plus `ledger.json`, the full public donation/run/review ledger that is the system's verifiability story (§ principle 5). Published atomically so browsers never see a partial snapshot.

- **Ordering.** Running problems first; then by total pool size.
- **Funding progress.** Per (problem, direction): "$X raised — Y% toward its next hour," with the global settling notice when relevant: "new donations are processed within 1–2 business days after receipt (Monday through Friday) and become runnable once processed."
- **Donations list.** Each problem page shows its recent donations from `state.json` — display name, amount, direction, and the shared waterline badge: "received" means fully uncovered and ordinarily refundable; "processed" means funding has reached some part of it and it is final; fully refunded donations say "refunded." The refund CLI calls this exact derivation rather than reimplementing the rule. The page also links to the project's Open Collective page as the independently hosted second view of the same money. Browsers never call the OC API directly: the intake loop is the single ingestion path, so the site, ledger export, badge, and refund decision cannot disagree.
- **Transcripts.** Linked per problem, viewable live.
- **Review states.** PendingReview: "claimed solved — under review," solution readable, explicitly unverified; competing secondary solutions shown together, labeled as mutually contradictory. Unconditional solve: verified display + donor acknowledgment — the last donation into the winning pool before the winning claim, by display name, straight from the published ledger. Conditional: "Resolved under assumption: X; unconditional problem remains open," still fundable, no acknowledgment. Rejected: back in the list, note linked.
- **Ledger page.** Renders `ledger.json`: every donation line item, every run with budget/spend/transcript, every verdict. A donor finds their own row; anyone reconciles totals.
- **Business and contribution terms.** The public footer links to a standalone, unauthenticated `terms.html` page and opens the same document in a modal when JavaScript is available. It names IndieMath and Lipschitz Strategies LLC as its operator and counterparty, accurately describes the AI research-attempt service, gives the customer-service email, and states the contribution application, surplus-on-solve, refund eligibility and process, disputes, recurring cancellation, legal/export restrictions, promotions, public-data handling, and project-wind-down policy. The standalone URL remains crawlable and usable if the modal or JavaScript fails.
- **Admin surface.** Entirely the CLI on the box — catalog sync, review verdicts, treasury funding, refund reservation/completion/cancellation, inspections, and dispute entries. No admin web backend, no auth system; the trust boundary is shell access. The "dashboard" the treasury workflow needs is `indiemath treasury status` plus the publisher's mirror of it.

---

## 8. Pre-build checklist (open questions)

1. **Open Collective + Stripe:** the Stripe website-verification form is submitted and in review after Stripe reported that the supplied website could not be reached. Keep the submitted URL public, working without a password or regional block, and complete the review before the stated August 11, 2026 payout-pause deadline and August 25, 2026 payment-pause deadline. The site must continue to show the IndieMath business name, an accurate service description aligned with the Stripe account, customer-service contact details, and the published refund/dispute, cancellation, legal/export, promotion, and contribution terms. Also decide independent-vs-hosted before launch (it changes the treasury leg, §5); complete the collective's setup under the LLC with full Stripe business verification; proactively brief Stripe risk on expected volume, average contribution size, product, and launch date (a fresh connected account taking a sudden spike of large payments is a textbook automatic-hold trigger); verify in a test collective the transaction→order→tier attribution round-trip, credit-transaction pagination/cursoring, distinct transaction IDs for recurring installments, guest and incognito display-name behavior, and webhook availability; confirm the exact fee stack for net-crediting copy; confirm which payment rails OC's checkout offers your contributors (card vs. bank transfer) and payout timing to the bank.
2. **Ramp:** confirm the mechanics and latency of staging funds / raising the card limit; per-transaction and daily card limits vs. the Anthropic auto-reload increment; whether limit changes are same-day.
3. **Anthropic:** org-tier spend and rate limits vs. the theoretical burn ceiling (4 workers × $500/hr ≈ $48K/day) — raise limits before donations outrun burn capacity; auto-reload maximum increment; Agents SDK compaction/context-management API names and limits for hour-long runs.
4. **Legal/ops:** confirm that the published terms match the operating entity and payment-platform configuration; obtain an accountant pass on donation-revenue vs. compute-expense timing across tax years for the LLC; perform the Litestream restore drill once before launch.
