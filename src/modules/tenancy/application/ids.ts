import { NotFoundError } from '../domain/errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids arrive from URLs and forms. One that is not a UUID cannot name a row, so it is the same
 * NotFoundError as an id from another tenant, raised before Postgres sees it (which would fail
 * the cast with 22P02 and surface as a 500).
 */
export function requireId(value: string): string {
  if (!UUID.test(value)) {
    throw new NotFoundError();
  }
  return value;
}
