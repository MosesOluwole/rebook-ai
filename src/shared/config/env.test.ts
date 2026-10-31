import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from './env';

const valid = {
  NODE_ENV: 'test',
  APP_DATABASE_URL: 'postgresql://rebook_authenticator:secret@127.0.0.1:54322/postgres',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_value_for_tests',
  APP_ORIGIN: 'http://localhost:3000',
} as const;

describe('parseEnv', () => {
  it('accepts a complete environment and applies defaults', () => {
    const env = parseEnv(valid);
    expect(env.APP_DATABASE_URL).toBe(valid.APP_DATABASE_URL);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.NODE_ENV).toBe('test');
    expect(env.APP_ORIGIN).toBe('http://localhost:3000');
  });

  it('keeps the optional owner connection when present', () => {
    const owner = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
    expect(parseEnv({ ...valid, DATABASE_URL: owner }).DATABASE_URL).toBe(owner);
  });

  it('ignores unrelated variables', () => {
    const env = parseEnv({ ...valid, PATH: '/usr/bin', HOME: '/home/x' });
    expect(Object.keys(env).sort()).toEqual([
      'APP_DATABASE_URL',
      'APP_ORIGIN',
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

  it('requires APP_ORIGIN and normalises it to a serialised origin', () => {
    expect(() => parseEnv({ ...valid, APP_ORIGIN: '' })).toThrow(/APP_ORIGIN: missing/);
    expect(parseEnv({ ...valid, APP_ORIGIN: 'HTTPS://App.Example:443/' }).APP_ORIGIN).toBe(
      'https://app.example',
    );
    expect(parseEnv({ ...valid, APP_ORIGIN: 'http://127.0.0.1:3100' }).APP_ORIGIN).toBe(
      'http://127.0.0.1:3100',
    );
  });

  it('rejects an APP_ORIGIN that is not a bare http(s) origin', () => {
    for (const value of [
      'ftp://app.example',
      'https://app.example/app',
      'https://app.example/?x=1',
      'https://app.example/#top',
      'https://user:pass@app.example',
      'app.example',
    ]) {
      expect(() => parseEnv({ ...valid, APP_ORIGIN: value }), value).toThrow(/APP_ORIGIN: /);
    }
  });

  it('refuses NODE_ENV=test on Vercel, where it would trust a test client-IP header', () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: 'test', VERCEL: '1' })).toThrow(
      /NODE_ENV: 'test' is for the local e2e gate only/,
    );
    expect(parseEnv({ ...valid, NODE_ENV: 'production', VERCEL: '1' }).NODE_ENV).toBe('production');
  });

  it('no longer reads a configurable client IP header (ADR-004 §9)', () => {
    expect(parseEnv({ ...valid, CLIENT_IP_HEADER: 'x-forwarded-for' })).not.toHaveProperty(
      'CLIENT_IP_HEADER',
    );
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
      parseEnv({ NODE_ENV: 'nope', APP_ORIGIN: 'ftp://x' });
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const variables = (error as EnvValidationError).issues.map((issue) => issue.variable).sort();
      expect(variables).toEqual([
        'APP_DATABASE_URL',
        'APP_ORIGIN',
        'NODE_ENV',
        'SUPABASE_PUBLISHABLE_KEY',
        'SUPABASE_URL',
      ]);
      expect((error as Error).message).toMatch(/5 problems/);
    }
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(parseEnv(valid))).toBe(true);
  });
});
