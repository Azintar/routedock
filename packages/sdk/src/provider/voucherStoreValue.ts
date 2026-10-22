/**
 * Shape of the cumulative voucher entries mppx stores per channel.
 *
 * Kept in its own dependency-free module: `hono.ts` needs the type guard on the
 * DELETE close path, and importing it from `MppSessionHandler.ts` would pull
 * that module's Express/mppx runtime imports into every Worker bundle — and
 * into tests that mock those modules without providing their full surface.
 */

/** Expected payload shape for voucher cumulative amount entries. */
export interface VoucherStoreValue {
  amount: string
  [key: string]: unknown
}

/** Validates that a stored store value is an object containing a numeric string amount. */
export function isVoucherStoreValue(value: unknown): value is VoucherStoreValue {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.amount === 'string' && /^\d+$/.test(candidate.amount)
}
