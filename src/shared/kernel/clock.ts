/**
 * Time source port.
 *
 * Domain code never reads the wall clock: it receives instants as values. Application code
 * receives a Clock so tests can inject a fixed time (docs/architecture.md §6, DST rules).
 */
export interface Clock {
  now(): Date;
}
