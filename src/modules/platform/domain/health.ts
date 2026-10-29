/**
 * Health report: what the /health route returns. Pure: time and build facts are passed in.
 */
export interface HealthReport {
  readonly status: 'ok';
  readonly service: 'rebook-ai';
  readonly version: string;
  readonly environment: string;
  /** ISO-8601 instant in UTC. */
  readonly time: string;
}

export interface HealthInput {
  readonly now: Date;
  readonly version: string;
  readonly environment: string;
}

export function buildHealthReport({ now, version, environment }: HealthInput): HealthReport {
  return {
    status: 'ok',
    service: 'rebook-ai',
    version,
    environment,
    time: now.toISOString(),
  };
}
