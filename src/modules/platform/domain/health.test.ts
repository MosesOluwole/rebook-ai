import { describe, expect, it } from 'vitest';

import { buildHealthReport } from './health';

describe('buildHealthReport', () => {
  it('reports ok with the injected time as a UTC instant', () => {
    const report = buildHealthReport({
      now: new Date('2026-10-29T09:30:00+01:00'),
      version: '0.0.0',
      environment: 'test',
    });

    expect(report).toEqual({
      status: 'ok',
      service: 'rebook-ai',
      version: '0.0.0',
      environment: 'test',
      time: '2026-10-29T08:30:00.000Z',
    });
  });
});
