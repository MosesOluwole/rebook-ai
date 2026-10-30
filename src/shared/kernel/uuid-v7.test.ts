import { describe, expect, it } from 'vitest';

import { formatUuidV7, isUuidV7, uuidV7Timestamp } from './uuid-v7';

const random = Uint8Array.from([0xff, 0xab, 0xff, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);

describe('formatUuidV7', () => {
  it('lays out timestamp, version and variant per RFC 9562', () => {
    const uuid = formatUuidV7(0x017f22e279b0, random);
    expect(uuid).toBe('017f22e2-79b0-7fab-bf01-020304050607');
    expect(isUuidV7(uuid)).toBe(true);
    expect(uuidV7Timestamp(uuid)).toBe(0x017f22e279b0);
  });

  it('sorts lexicographically by creation time', () => {
    const base = Date.UTC(2026, 9, 29, 12, 0, 0);
    const ids = [5, 1, 4, 2, 3].map((offset) => formatUuidV7(base + offset, random));
    const byTime = [...ids].sort((a, b) => uuidV7Timestamp(a) - uuidV7Timestamp(b));
    expect([...ids].sort()).toEqual(byTime);
  });

  it('rejects timestamps outside 48 bits and short random input', () => {
    expect(() => formatUuidV7(-1, random)).toThrow(RangeError);
    expect(() => formatUuidV7(2 ** 48, random)).toThrow(RangeError);
    expect(() => formatUuidV7(1.5, random)).toThrow(RangeError);
    expect(() => formatUuidV7(1, new Uint8Array(9))).toThrow(RangeError);
  });

  it('recognises only version 7 with the RFC variant', () => {
    expect(isUuidV7('017f22e2-79b0-4fab-bf01-020304050607')).toBe(false);
    expect(isUuidV7('017f22e2-79b0-7fab-cf01-020304050607')).toBe(false);
    expect(() => uuidV7Timestamp('not-a-uuid')).toThrow(RangeError);
  });
});
