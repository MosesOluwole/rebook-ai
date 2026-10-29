import { expect, test } from '@playwright/test';

test('GET /health reports ok and is never cached', async ({ request }) => {
  const response = await request.get('/health');

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(response.headers()['cache-control']).toContain('no-store');

  const body: unknown = await response.json();
  expect(body).toMatchObject({ status: 'ok', service: 'rebook-ai' });
  const report = body as { version: string; environment: string; time: string };
  expect(report.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(['development', 'test', 'production']).toContain(report.environment);
  expect(Number.isNaN(Date.parse(report.time))).toBe(false);
});
