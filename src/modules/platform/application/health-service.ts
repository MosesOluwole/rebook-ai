import { type Clock } from '@/shared/kernel/clock';

import { buildHealthReport, type HealthReport } from '../domain/health';

export interface HealthServiceDeps {
  readonly clock: Clock;
  readonly version: string;
  readonly environment: string;
}

/** Application-layer use case: gathers what the domain needs and asks it for the report. */
export function getHealthReport(deps: HealthServiceDeps): HealthReport {
  return buildHealthReport({
    now: deps.clock.now(),
    version: deps.version,
    environment: deps.environment,
  });
}
