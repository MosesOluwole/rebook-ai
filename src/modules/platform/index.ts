/**
 * Platform module: cross-cutting operational concerns (health today; metrics and runbook hooks
 * later). This file is the module's only public surface and its composition root.
 */
import { getEnv } from '@/shared/config/env';

import { getHealthReport as reportHealth } from './application/health-service';
import { type HealthReport } from './domain/health';
import { buildInfo } from './infrastructure/build-info';
import { systemClock } from './infrastructure/system-clock';

export type { HealthReport } from './domain/health';

export function getHealthReport(): HealthReport {
  return reportHealth({
    clock: systemClock,
    version: buildInfo.version,
    environment: getEnv().NODE_ENV,
  });
}
