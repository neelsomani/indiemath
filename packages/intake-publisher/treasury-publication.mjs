import {
  assertPort,
  deriveTreasuryPublication,
} from "#indiemath/shared";

export function readTreasuryPublication(ledger) {
  assertPort(ledger, "ledger", ["treasuryStatus"]);
  return deriveTreasuryPublication(ledger.treasuryStatus());
}
