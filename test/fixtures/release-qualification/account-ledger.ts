/** Add safe integer-cent values and reject invalid inputs or overflow. */
export function addCents(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    throw new RangeError("Ledger inputs must be safe integer cents");
  }
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError("Ledger overflow");
  return result;
}

/** Negate an integer-cent amount through the validated ledger operation. */
export function negateCents(value: number): number {
  return addCents(0, -value);
}
