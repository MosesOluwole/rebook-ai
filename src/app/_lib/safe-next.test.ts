import { describe, expect, it } from 'vitest';

import { safeNextPath } from './safe-next';

describe('safeNextPath', () => {
  it.each(['/app', '/app/acme/team', '/invite/acme/abc?x=1'])(
    'keeps the relative path %s',
    (path) => {
      expect(safeNextPath(path)).toBe(path);
    },
  );

  it.each([
    undefined,
    '',
    'app',
    '//evil.example',
    '/\\evil.example',
    'https://evil.example/app',
    'javascript:alert(1)',
    '/app\n',
    `/${'a'.repeat(600)}`,
  ])('falls back to /app for %j', (value) => {
    expect(safeNextPath(value)).toBe('/app');
  });
});
