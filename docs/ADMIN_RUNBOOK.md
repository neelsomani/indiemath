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
