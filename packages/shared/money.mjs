const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * @typedef {number} Cents
 * A signed safe integer whose unit is one cent. Fractional numbers are invalid.
 */

export function asCents(value, label = "amount", { allowNegative = false } = {}) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be an integer number of cents.`);
  }
  if (!allowNegative && value < 0) {
    throw new RangeError(`${label} cannot be negative.`);
  }
  return value;
}

export function addCents(...amounts) {
  return checkedBigIntToCents(
    amounts.reduce(
      (total, amount, index) => total + BigInt(asCents(
        amount,
        `amounts[${index}]`,
        { allowNegative: true },
      )),
      0n,
    ),
    "sum",
  );
}

export function subtractCents(minuend, subtrahend, { allowNegative = false } = {}) {
  const result = checkedBigIntToCents(
    BigInt(asCents(minuend, "minuend", { allowNegative: true }))
      - BigInt(asCents(subtrahend, "subtrahend", { allowNegative: true })),
    "difference",
  );
  return asCents(result, "difference", { allowNegative });
}

export function sumCents(amounts, options) {
  if (!Array.isArray(amounts)) throw new TypeError("amounts must be an array.");
  const result = addCents(...amounts);
  return asCents(result, "sum", options);
}

export function parseDollarAmount(value, { allowNegative = false } = {}) {
  if (typeof value !== "string") {
    throw new TypeError("Dollar amount must be provided as a decimal string.");
  }
  const match = value.trim().match(/^\$?(-)?(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) {
    throw new TypeError("Dollar amount must have at most two decimal places.");
  }
  if (match[1] && !allowNegative) throw new RangeError("Dollar amount cannot be negative.");

  const cents = (BigInt(match[2]) * 100n) + BigInt((match[3] ?? "").padEnd(2, "0") || "0");
  return checkedBigIntToCents(match[1] ? -cents : cents, "dollar amount");
}

export function formatCents(value) {
  const cents = BigInt(asCents(value, "value", { allowNegative: true }));
  const absolute = cents < 0n ? -cents : cents;
  const dollars = absolute / 100n;
  const remainder = String(absolute % 100n).padStart(2, "0");
  return `${cents < 0n ? "-" : ""}$${dollars}.${remainder}`;
}

function checkedBigIntToCents(value, label) {
  if (value > MAX_SAFE_CENTS || value < -MAX_SAFE_CENTS) {
    throw new RangeError(`${label} exceeds the safe integer cents range.`);
  }
  return Number(value);
}
