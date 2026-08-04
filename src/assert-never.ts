/**
 * Exhaustive check utility for discriminated union switches.
 * Placed in `default:` case — if a new variant is added to the union but
 * the switch is not updated, tsc will report that `x` is not `never`.
 */
export function assertNever(x: never): never {
  throw new Error(`Unexpected discriminated union member: ${String(x)}`);
}
