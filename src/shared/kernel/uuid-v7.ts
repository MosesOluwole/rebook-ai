/**
 * UUID version 7 (RFC 9562): 48-bit Unix millisecond timestamp, 4-bit version, 74 random bits
 * with the RFC variant. Pure: time and randomness are passed in, so it is testable and the
 * database default `rebook.uuid_generate_v7()` can be checked against the same layout.
 */

const MAX_UNIX_MILLIS = 2 ** 48 - 1;
const RANDOM_BYTES_NEEDED = 10;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function byteAt(bytes: Uint8Array, index: number): number {
  const value = bytes[index];
  if (value === undefined) {
    throw new RangeError(`formatUuidV7 needs ${RANDOM_BYTES_NEEDED} random bytes`);
  }
  return value;
}

export function formatUuidV7(unixMillis: number, random: Uint8Array): string {
  if (!Number.isInteger(unixMillis) || unixMillis < 0 || unixMillis > MAX_UNIX_MILLIS) {
    throw new RangeError('formatUuidV7 needs a Unix millisecond timestamp that fits in 48 bits');
  }
  if (random.length < RANDOM_BYTES_NEEDED) {
    throw new RangeError(`formatUuidV7 needs ${RANDOM_BYTES_NEEDED} random bytes`);
  }

  const bytes = new Uint8Array(16);
  let remaining = unixMillis;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  bytes[6] = 0x70 | (byteAt(random, 0) & 0x0f); // version 7 + 4 random bits
  bytes[7] = byteAt(random, 1);
  bytes[8] = 0x80 | (byteAt(random, 2) & 0x3f); // RFC variant (10xx) + 6 random bits
  for (let index = 3; index < RANDOM_BYTES_NEEDED; index += 1) {
    bytes[6 + index] = byteAt(random, index);
  }

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuidV7(value: string): boolean {
  return UUID_V7_PATTERN.test(value);
}

/** The millisecond timestamp embedded in a UUIDv7. */
export function uuidV7Timestamp(uuid: string): number {
  if (!isUuidV7(uuid)) {
    throw new RangeError('not a UUIDv7');
  }
  return Number.parseInt(uuid.slice(0, 8) + uuid.slice(9, 13), 16);
}
