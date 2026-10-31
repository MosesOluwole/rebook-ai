import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from './env';

const valid = {
  NODE_ENV: 'test',
  APP_DATABASE_URL: 'postgresql://rebook_authenticator:secret@127.0.0.1:54322/postgres',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_value_for_tests',
  CLIENT_IP_HEADER: 'x-forwarded-for',
} as const;

describe('parseEnv', () => {
  it('accepts a complete environment and applies defaults', () => {
    const env = parseEnv(valid);
    expect(env.APP_DATABASE_URL).toBe(valid.APP_DATABASE_URL);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.NODE_ENV).toBe('test');
    expect(env.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3000');
  });

  it('keeps the optional owner connection when present', () => {
    const owner = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
    expect(parseEnv({ ...valid, DATABASE_URL: owner }).DATABASE_URL).toBe(owner);
  });

  it('ignores unrelated variables', () => {
    const env = parseEnv({ ...valid, PATH: '/usr/bin', HOME: '/home/x' });
    expect(Object.keys(env).sort()).toEqual([
      'APP_DATABASE_URL',
      'CLIENT_IP_HEADER',
      'NEXT_PUBLIC_APP_URL',
      'NODE_ENV',
      'SUPABASE_PUBLISHABLE_KEY',
      'SUPABASE_URL',
    ]);
  });

  it('fails fast with a readable message when a required variable is missing', () => {
    const { APP_DATABASE_URL: _omitted, ...rest } = valid;
    const attempt = () => parseEnv(rest);
    expect(attempt).toThrow(EnvValidationError);
    expect(attempt).toThrow(/APP_DATABASE_URL: missing/);
    expect(attempt).toThrow(/Postgres connection string/);
    expect(attempt).toThrow(/\.env\.example/);
  });

  it('treats a blank value as missing', () => {
    expect(() => parseEnv({ ...valid, APP_DATABASE_URL: '   ' })).toThrow(
      /APP_DATABASE_URL: missing/,
    );
  });

  it('rejects connection strings that are not Postgres URLs', () => {
    expect(() => parseEnv({ ...valid, APP_DATABASE_URL: 'mysql://root@localhost/db' })).toThrow(
      /APP_DATABASE_URL: /,
    );
    expect(() => parseEnv({ ...valid, APP_DATABASE_URL: 'not a url' })).toThrow(
      /APP_DATABASE_URL: /,
    );
    expect(() => parseEnv({ ...valid, DATABASE_URL: 'mysql://root@localhost/db' })).toThrow(
      /DATABASE_URL: /,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: 'staging' })).toThrow(/NODE_ENV: /);
  });

  it('lower-cases the client IP header name and rejects anything that is not a header name', () => {
    expect(parseEnv({ ...valid, CLIENT_IP_HEADER: ' X-Real-IP ' }).CLIENT_IP_HEADER).toBe(
      'x-real-ip',
    );
    expect(() => parseEnv({ ...valid, CLIENT_IP_HEADER: 'x forwarded for' })).toThrow(
      /CLIENT_IP_HEADER: .*header name/,
    );
    expect(() => parseEnv({ ...valid, CLIENT_IP_HEADER: '' })).toThrow(/CLIENT_IP_HEADER: missing/);
  });

  it('requires the Supabase Auth URL and publishable key and validates their shape', () => {
    expect(() => parseEnv({ ...valid, SUPABASE_URL: '' })).toThrow(/SUPABASE_URL: missing/);
    expect(() => parseEnv({ ...valid, SUPABASE_URL: 'ftp://x' })).toThrow(
      /SUPABASE_URL: .*API gateway/,
    );
    expect(() => parseEnv({ ...valid, SUPABASE_PUBLISHABLE_KEY: 'short' })).toThrow(
      /SUPABASE_PUBLISHABLE_KEY: .*publishable or anon key/,
    );
  });

  it('reports every problem at once', () => {
    try {
      parseEnv({ NODE_ENV: 'nope', NEXT_PUBLIC_APP_URL: 'ftp://x' });
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const variables = (error as EnvValidationError).issues.map((issue) => issue.variable).sort();
      expect(variables).toEqual([
        'APP_DATABASE_URL',
        'CLIENT_IP_HEADER',
        'NEXT_PUBLIC_APP_URL',
        'NODE_ENV',
        'SUPABASE_PUBLISHABLE_KEY',
        'SUPABASE_URL',
      ]);
      expect((error as Error).message).toMatch(/6 problems/);
    }
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(parseEnv(valid))).toBe(true);
  });
});
