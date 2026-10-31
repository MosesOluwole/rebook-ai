import { onboardingHooks } from '@/modules/booking';
import { createTenancy, type Tenancy } from '@/modules/tenancy';
import { getEnv } from '@/shared/config/env';
import { type Clock } from '@/shared/kernel/clock';
import { createDbClient, type DbClient } from '@/shared/db/client';

/**
 * One database pool and one tenancy composition root per server process. Cached on globalThis so
 * the dev server's hot reloads do not open a new pool on every change.
 */
interface WebServices {
  readonly client: DbClient;
  readonly clock: Clock;
  readonly tenancy: Tenancy;
}

const key = Symbol.for('rebook-ai.web-services');
const holder = globalThis as unknown as { [key]?: WebServices };

export function getTenancy(): Tenancy {
  holder[key] ??= build();
  return holder[key].tenancy;
}

/** The wall clock for application code called from routes (domain code never reads it). */
export function getClock(): Clock {
  holder[key] ??= build();
  return holder[key].clock;
}

function build(): WebServices {
  const client = createDbClient(getEnv().APP_DATABASE_URL, {
    max: 10,
    applicationName: 'rebook-ai-web',
  });
  const clock: Clock = { now: () => new Date() };
  return { client, clock, tenancy: createTenancy(client.db, clock, onboardingHooks) };
}
