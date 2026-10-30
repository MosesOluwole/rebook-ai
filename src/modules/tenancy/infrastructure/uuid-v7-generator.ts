import { type Clock } from '@/shared/kernel/clock';
import { type IdGenerator } from '@/shared/kernel/ids';
import { formatUuidV7 } from '@/shared/kernel/uuid-v7';

/** UUIDv7 ids generated in the app, for rows whose id must be known before insert (tenants). */
export function createUuidV7Generator(clock: Clock): IdGenerator {
  return {
    newId: () =>
      formatUuidV7(clock.now().getTime(), globalThis.crypto.getRandomValues(new Uint8Array(10))),
  };
}
