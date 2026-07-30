# IndieMath admin runbook

All commands run on the deployment host from `/opt/indiemath/current`. The
protected service environment must provide `INDIEMATH_DB`,
`STRIPE_SECRET_KEY`, and `STRIPE_ACCOUNT_ID`.
Optional Ramp publication additionally uses `RAMP_CLIENT_ID`,
`RAMP_CLIENT_SECRET`, and `RAMP_CARD_ID`; all three must be present together.

There is no privileged web application. `sudo ./indiemath ...` is the complete
admin surface, and the wrapper loads the protected environment before dropping
to the service account. Commands print JSON unless they are delegating directly
to the Litestream restore utility.

`sudo ./setup-workers.sh` verifies the preserved pre-IndieMath carry-forward
contexts and their hashes in R2 before restarting workers. The source outputs
are not stored in the repository; a missing or altered remote context stops
setup instead of starting a worker with incomplete research history.

## Worker fleet size

The protected common environment at `/etc/indiemath/indiemath.env` contains
the single scaling control:

```sh
WORKER_COUNT=1
```

Set it to any integer from 1 through 4. Keep one distinct
`WORKER_N_ANTHROPIC_API_KEY` in `/etc/indiemath/workers.env` for every active
worker, then validate and apply the fleet:

```sh
sudo ./setup-workers.sh --check
sudo ./setup-workers.sh
```

The selected fleet is always contiguous from `worker-1` through `worker-N`.
Scaling up writes the additional root-only per-worker environments and starts
their systemd instances. Scaling down stops and disables surplus instances and
removes only their generated `/etc/indiemath/workers/worker-N.env` files; the
staged keys in `/etc/indiemath/workers.env` remain available for scaling back
up. The health monitor reads the same `WORKER_COUNT`, so inactive surplus
workers do not produce false liveness alerts.

Verify the result after changing the count:

```sh
systemctl is-active indiemath-worker@worker-{1..4}.service
systemctl is-enabled indiemath-worker@worker-{1..4}.service
```

## Catalog and Open Collective tiers

Validate and inspect a candidate revision before syncing it:

```sh
sudo ./indiemath catalog validate
sudo ./indiemath catalog diff
sudo ./indiemath catalog tiers
sudo ./indiemath catalog sync
```

`catalog diff` compares the repository catalog to the last catalog synced into
the ledger. Use `--base <path>` to compare against another catalog file. It
reports global-policy changes, added and removed IDs, changed fields, and any
canonical-statement identity change. An unsafe removal or identity change exits
nonzero. `catalog sync` remains the authoritative transactional guard and
rejects rollback, removal, or ID reuse even if diff was skipped.
`catalog tiers` prints the complete provider-neutral tier specification for
every problem/direction pair without changing the ledger or calling Open
Collective.

When the Open Collective environment is configured, `catalog sync` also syncs
the pair tiers. The explicit, safely re-runnable form is:

```sh
sudo ./indiemath open-collective tiers sync
```

Use `catalog status` and `catalog export --output <path>` to inspect or export
the exact revision stored in the ledger.

## Reviews

Every verdict requires a review note. To upload a local Markdown note and apply
the verdict as one restart-safe workflow, choose a stable UTC epoch-millisecond
identifier and reuse it if the command must be retried:

```sh
sudo ./indiemath review unconditional \
  --problem <problem-id> \
  --note-file <review.md> \
  --review-ts <epoch-ms>
```

The note is conditionally written to
`reviews/<problem-id>/<review-ts>.md`; a retry accepts the existing object only
when its bytes match. The ledger uses the resulting note URI as the review
idempotency identity. A previously uploaded R2 note may instead be supplied
with `--note-uri r2://...`; the CLI verifies that object before changing the
ledger.

Conditional results require the missing assumption to be named:

```sh
sudo ./indiemath review conditional \
  --problem <problem-id> \
  --assumption "P != NP" \
  --note-file <review.md> \
  --review-ts <epoch-ms>
```

When opposite directions both produced candidates, an approving verdict also
requires `--approve-direction prove` or `--approve-direction disprove`. A full
rejection uses:

```sh
sudo ./indiemath review rejected \
  --problem <problem-id> \
  --reject-all true \
  --note-file <review.md> \
  --review-ts <epoch-ms>
```

The ledger refuses review while any competing claim remains unsettled.
Unconditional review marks the problem solved; conditional and rejected
reviews reopen it. Re-run `sweep problem --problem <problem-id>` after an
unconditional verdict, or use `sweep all`. Both forms are idempotent and leave
received contribution liabilities at their original destinations.

## Refund lifecycle

The refund commands expose the reservation and provider lifecycle separately
so an interrupted external request can always be recovered:

```sh
sudo ./indiemath refund quote --transaction <transaction-id>
sudo ./indiemath refund begin \
  --transaction <transaction-id> \
  --ref <idempotency-reference>
sudo ./indiemath refund status --ref <idempotency-reference>
sudo ./indiemath refund retry \
  --transaction <transaction-id> \
  --ref <idempotency-reference>
```

`quote` and `begin` call the same ledger waterline derivation as the public
received/processed badge. `begin` immediately reserves and debits the quoted
amount. Reusing the same transaction and reference returns the
existing adjustment; conflicting reuse is rejected. There is no amount option:
an eligible request always reserves the contribution's entire refundable net
amount after processing fees. Partial refunds and refunds above that net amount
are rejected at the ledger boundary.

The Stripe refund sends that exact refundable net amount to the original Charge
or PaymentIntent recorded by intake; Open Collective currently exposes either
identifier in its payment-processor URL. The original processing fee is not
returned. `refund retry` sends the same reference to Stripe, then completes the
pending adjustment after provider acceptance. An ambiguous provider error leaves
the reservation pending for another retry. A definitive rejection cancels it and
restores the original destination.

Refund completion is authoritative from the ledger and Stripe response; it does
not wait for Open Collective to label the provider transaction refunded. A
refund completed before its contribution enters a paid payout is published
immediately but is excluded from settled-refund subtraction until that
contribution itself appears in settlement evidence.

If provider acceptance is known but the process died before recording it,
complete the pending row directly:

```sh
sudo ./indiemath refund complete \
  --ref <idempotency-reference> \
  --provider-ref <provider-reference>
```

Only a definitive failure may be canceled manually:

```sh
sudo ./indiemath refund cancel \
  --ref <idempotency-reference> \
  --note "<definitive failure evidence>"
```

`refund status --transaction <transaction-id>` shows the contribution and all
of its refund adjustments. Once the waterline has touched any part of a
contribution, quote and begin reject it as processed and final.

## Disputes

The supervised intake process records Open Collective and Stripe disputes.
When provider evidence must be entered manually, use one stable external
reference:

```sh
sudo ./indiemath dispute enter \
  --transaction <transaction-id> \
  --ref <provider-dispute-reference> \
  --amount-cents <amount> \
  --note "<provider status>"
```

Replaying an identical entry is a no-op. Reusing the reference for another
transaction, amount, or note is rejected. A dispute cannot race through a
pending refund reservation.

## Inspection and re-sweep

Read-only ledger inspection is available for:

```sh
sudo ./indiemath inspect pools
sudo ./indiemath inspect claims
sudo ./indiemath inspect reviews
sudo ./indiemath inspect donations
sudo ./indiemath inspect adjustments
sudo ./indiemath inspect provider-spend
sudo ./indiemath inspect capacity
sudo ./indiemath inspect all
```

Scoped filters include `--problem`, `--direction`, `--status`,
`--transaction`, `--ref`, `--worker`, `--outcome`, and `--reason` where they
apply. Unsupported filters are rejected instead of returning a misleading
empty result. `inspect capacity` includes treasury state, the sampling
snapshot, general credit/debt, and the conservation check.

Re-callable residue collection is:

```sh
sudo ./indiemath sweep problem --problem <problem-id>
sudo ./indiemath sweep all
```

## Reconciliation checks

Run Open Collective intake first, then use the read-only reconciliation check:

```sh
sudo ./indiemath open-collective intake
sudo ./indiemath open-collective reconcile \
  --since <timestamp> \
  --through <timestamp>
```

The check compares every charge-level provider transaction in the window
against the ledger transaction ID, parent order, gross, fees, net, donor tag,
and intended destination. Missing, unexpected, or mismatched rows make the
command exit nonzero without changing the ledger.

Stripe settlement reconciliation remains:

```sh
sudo ./indiemath stripe reconcile --through <timestamp>
```

Anthropic Admin API reconciliation is an optional, read-only claim audit:

```sh
sudo ./indiemath anthropic reconcile \
  --problem <problem-id> \
  --direction <prove|disprove> \
  --claim-ts <epoch-ms> \
  --api-key-id <apikey-id>
```

It compares priced ledger checkpoints with the minute-bucket Admin report and
exits nonzero when drift exceeds the configured tolerance. It is never on the
worker or settlement path.

### Periodic cumulative Anthropic spend correction

The per-response ledger amounts are deliberately conservative estimates. To
correct them to an actual finalized provider total, use a cumulative statement
or export and one exclusive UTC cutoff:

```sh
sudo ./indiemath anthropic reconcile-spend \
  --through <exclusive-RFC3339-cutoff> \
  --actual-dollars <cumulative-model-usage-dollars> \
  --ref <statement-or-export-id> \
  --note "<source and exclusions>"
sudo ./indiemath inspect provider-spend
```

`--actual-dollars` is the cumulative Anthropic model-usage spend from the
ledger's beginning through `--through`, not spend for only the latest period.
Use a cutoff for which the provider data is complete, and exclude unrelated
taxes, card prepayments, and cash-transfer timing. Each later command must use
a later cutoff and a nondecreasing cumulative actual amount.

The ledger sums applied response costs over the same request-start interval,
computes the cumulative difference, and books only the change from the prior
difference. Overestimation returns money to general credit and capacity;
underestimation debits general credit/capacity and exposes any unavailable
remainder as debt. It does not rewrite claim or problem history. Repeating the
same reference, cutoff, amount, and note is a no-op; conflicting reuse is
rejected.

### Ramp card outflow observation

Create a Ramp client-credentials application with only
`transactions:read`, identify the UUID of the dedicated Anthropic card, and
set all three values in the protected intake environment:

```dotenv
RAMP_CLIENT_ID=...
RAMP_CLIENT_SECRET=...
RAMP_CARD_ID=...
```

`RAMP_API_BASE_URL=https://api.ramp.com` and
`RAMP_SYNC_INTERVAL_SECONDS=300` may retain their defaults. Restart the intake
service after adding credentials:

```sh
sudo ./setup-intake.sh
```

The supervised intake process then polls pending and cleared USD transactions
for that card, deduplicates transactions that clear between the two API reads,
and keeps the most recent successful cumulative snapshot. Check or force
it with:

```sh
sudo ./indiemath ramp status
sudo ./indiemath ramp sync --through <RFC3339-cutoff>
```

The public site shows the cumulative pending-plus-cleared amount as **Actual Ramp spend**.
This is observational: pending transactions may change before clearing, and
Ramp auto-reloads, credits, and clearing dates need not
equal consumed Anthropic usage. A Ramp snapshot never modifies capacity or
pools. Use `anthropic reconcile-spend` with finalized model-usage data for the
periodic accounting correction.

## Operational monitoring

`sudo ./setup-intake.sh` installs and enables
`indiemath-monitor.timer`. The timer checks:

- the intake, Litestream, and configured worker services;
- Open Collective intake checkpoint lag;
- funded capacity that is unexpectedly unavailable to workers;
- the charge-level Open Collective reconciliation;
- the public R2 commit point, immutable-ledger digest, and publication lag;
- the public contribution terms.

Run the same check directly when deploying or investigating an alert:

```sh
sudo ./indiemath monitor check
systemctl status indiemath-monitor.timer
journalctl -u indiemath-monitor.service
```

The latest structured result is stored at
`/var/lib/indiemath/monitor-status.json`. A failed check exits nonzero, is
recorded by systemd, and appears in the journal. The monitor derives its
expected worker services from `WORKER_COUNT`.

## Launch verification

The launch gate combines current operational health with exact references to
the controlled production-path records. Start from the committed schema:

```sh
sudo install -o indiemath -g indiemath -m 0600 \
  ops/launch-evidence.example.json \
  /var/lib/indiemath/launch-evidence.json
```

Perform controlled card and ACH contributions, wait for settlement, stage the
funds, and run claims covering pool-only and general-only funding plus
unconditional, conditional, and rejected review outcomes. Replace every
placeholder in the protected evidence file with the resulting Open Collective
transaction IDs, funding reference, and claim keys.

Save the priced Admin API report for every controlled claim:

```sh
sudo ./indiemath anthropic reconcile \
  --problem <problem-id> \
  --direction <prove|disprove> \
  --claim-ts <epoch-ms> \
  --api-key-id <apikey-id> \
  > /var/lib/indiemath/launch-anthropic-<claim-ts>.json
```

List those report paths in `anthropicReportPaths`. Each report must be within
tolerance and identify its target claim. Perform the R2 replica drill into a
new path and retain the verified result:

```sh
sudo ./indiemath backup restore \
  --output /var/lib/indiemath/launch-restore.sqlite
```

Record that absolute path and the drill timestamp under `litestreamRestore`.
The verifier reopens the restored database and independently runs integrity,
foreign-key, schema, hash, and money-conservation checks; a prose assertion is
not sufficient.

Run the complete gate:

```sh
sudo ./indiemath launch verify
```

It exits nonzero until operational monitoring is green, both payment rails
exist in the ledger, the controlled funding reference exists, every required
funding source and review outcome is tied to a settled solution-bearing claim,
every claim has an in-tolerance Admin API report, and the retained R2 restore
passes verification.

## Backup and restore

Continuous Litestream replication to the private R2 bucket is the off-box
backup. A consistent local snapshot can also be created and verified without
stopping the ledger:

```sh
sudo ./indiemath backup create --output <new-backup.sqlite>
sudo ./indiemath backup verify --file <backup.sqlite>
```

Creation uses SQLite's online `VACUUM INTO`, verifies integrity, foreign keys,
schema version, and money conservation, then publishes the destination
atomically. An existing valid destination is reported as existing and is never
overwritten.

Restore an R2 replica into a new path only:

```sh
sudo ./indiemath backup restore --output <new-ledger.sqlite>
sudo ./indiemath backup restore \
  --output <new-ledger.sqlite> \
  --timestamp <RFC3339>
```

For an R2 restore, the root wrapper loads the setup-generated
`/etc/indiemath/litestream.env` only for that command before dropping to the
service account; replica credentials are not exposed to ordinary admin
commands.

For a local snapshot, add `--source <backup.sqlite>`. Restore never overwrites
the live database or an existing output. Every restored database passes the
same integrity, foreign-key, schema, catalog, and conservation verifier before
it is accepted. Promoting a verified restore into the live path remains an
explicit maintenance operation performed with the services stopped.

## Refunds before treasury funding

Use this order every time funds are staged for compute:

1. Review the refund inbox.
2. Retry every pending Stripe request with its original transaction ID and
   idempotency reference using `stripe refund`. The command completes the
   existing ledger adjustment after provider acceptance and cancels it only
   after a definitive rejection.
3. Run `sudo ./indiemath treasury status`.
4. Confirm `pendingRefundCents` is zero and use no more than
   `availableToFundCents` for the real bank-to-Ramp transfer or Ramp limit
   increase.
5. After the real transfer succeeds, record that exact amount once:

   ```sh
   sudo ./indiemath treasury fund 500.00 --ref <bank-or-ramp-reference>
   ```

The status and fund commands both refresh Stripe paid-payout reconciliation.
There is no command-line input for settled contribution totals. If Stripe
cannot prove a monotonic settlement snapshot or a completed refund has not
appeared in payout records, the command stops without recording a funding
event.

`--ref` is the real bank or Ramp operation identifier and is the idempotency
key. Re-running the same amount and reference is a no-op; reusing a reference
with different values is rejected.

Recording a funding event advances the shared FIFO processing waterline. Any
donation touched by that waterline changes from received/refundable to
processed/final. For that reason, never stage funds or run `treasury fund`
before handling refund requests.

### Deliberate owner prefunding before payout settlement

To process received contributions before Stripe reports a paid payout, first
move actual owner/LLC cash to Ramp. Then record that exact transfer with its
real Ramp or bank operation reference:

```sh
sudo ./indiemath treasury fund 3237.01 \
  --ref <real-ramp-or-bank-reference> \
  --owner-prefunded
```

This is not a generic settlement override. The command still refreshes Stripe,
refuses to run while any refund is pending, and rejects an amount beyond the
remaining received contribution principal. It advances the ordinary FIFO
waterline, so choose an amount that ends exactly at the intended contribution
boundary. The contribution then becomes processed/final and the staged cash is
available to workers.

Treasury status reports the amount as `outstandingOwnerAdvanceCents`. Later
Stripe settlement automatically reduces that balance before exposing any new
`availableToFundCents`; do not record the same cash transfer again when the
payout settles. There is no `--force` flag and no way to type a fake settled
contribution total.

## Reading treasury status

`sudo ./indiemath treasury status` reports:

- reconciled settled contributions;
- completed and pending refunds;
- recorded funding events;
- settled but not yet funded money;
- owner cash advanced before contribution settlement;
- money currently available to fund;
- remaining compute capacity;
- live claim reservations; and
- whether runs are paused pending settlement.

The publisher uses the same derived treasury object. Neither the public pause
state nor donation processing badges are stored as mutable flags.

## Pausing for the Anthropic monthly plan limit

When Anthropic reports that the monthly plan limit has been reached, set
`INDIEMATH_RUNS_PAUSED_REASON=anthropic-monthly-plan-limit` in
`/etc/indiemath/indiemath.env`, then run `sudo ./setup-intake.sh` and
`sudo ./setup-workers.sh`. Workers remain healthy but idle, and the public site
states the reason for the pause. Remove that setting and rerun both setup
scripts after the plan limit resets.

Claims that fail before producing any response, spend, or solution remain in
the private ledger for audit but are not presented as public research runs.

## Public ledger publication

`indiemath-intake.service` runs both the Open Collective poller and the public
ledger publisher. It reads one coherent ledger snapshot, publishes immutable
state and ledger objects, updates the fixed `public/ledger.json` mirror, and
replaces `public/state.json` last as the commit point. The state document names
the exact immutable ledger key and digest that the browser must load. The
artifact bucket's Cloudflare settings must carry the exact policy in
`ops/r2-public-cors.json`; bucket administration deliberately remains outside
the server's object-write credential.

Apply that policy once in Cloudflare: open the public artifact bucket, choose
Settings, add a CORS policy, paste the complete contents of
`ops/r2-public-cors.json`, and save. Verify a browser-style request returns the
wildcard origin:

```sh
curl --head \
  --header 'Origin: https://example.com' \
  "${PUBLIC_DATA_BASE_URL%/}/public/state.json"
```

Inspect the most recent publication without exposing the protected service
environment:

```sh
sudo systemctl status indiemath-intake.service
sudo journalctl -u indiemath-intake.service -n 50 --no-pager
curl --fail --silent --show-error \
  "${PUBLIC_DATA_BASE_URL%/}/public/state.json"
```

A successful service log includes `public-ledger-published` with the
publication ID, catalog revision, counts, unprocessed cents, and object keys.
The public documents contain direct checkout URLs from the synced Open
Collective tiers; the browser never constructs those URLs or receives R2,
Open Collective, Stripe, or Anthropic credentials.
