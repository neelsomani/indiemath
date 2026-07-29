# IndieMath admin runbook

All commands run on the deployment host from `/opt/indiemath/current`. The
protected service environment must provide `INDIEMATH_DB`,
`STRIPE_SECRET_KEY`, and `STRIPE_ACCOUNT_ID`.

## Refunds before treasury funding

Use this order every time funds are staged for compute:

1. Review the refund inbox.
2. Retry every pending provider request with its original transaction ID,
   amount, and idempotency reference using `open-collective refund` or
   `stripe refund`. Those commands complete the existing ledger adjustment
   after provider acceptance and cancel it only after a definitive rejection.
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

## Reading treasury status

`sudo ./indiemath treasury status` reports:

- reconciled settled contributions;
- completed and pending refunds;
- recorded funding events;
- settled but not yet funded money;
- money currently available to fund;
- remaining compute capacity;
- live claim reservations; and
- whether runs are paused pending settlement.

The publisher uses the same derived treasury object. Neither the public pause
state nor donation processing badges are stored as mutable flags.

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
