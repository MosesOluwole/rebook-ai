import { describe, expect, it, vi } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('APP_DATABASE_URL', 'postgresql://rebook_authenticator:secret@127.0.0.1:54322/postgres');
vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_synthetic_value_for_tests');
vi.stubEnv('APP_ORIGIN', 'https://app.example');

const { appUrl } = await import('./app-url');

describe('appUrl', () => {
  it('builds every outbound link on APP_ORIGIN', () => {
    expect(appUrl('/invite/bloom/abc_DEF-123')).toBe(
      'https://app.example/invite/bloom/abc_DEF-123',
    );
    expect(appUrl('/sign-in?next=%2Fapp')).toBe('https://app.example/sign-in?next=%2Fapp');
  });

  it('refuses a path that would leave the app origin', () => {
    expect(() => appUrl('//evil.example/invite')).toThrow(/relative to the app origin/);
    expect(() => appUrl('https://evil.example/invite')).toThrow(/relative to the app origin/);
  });
});
