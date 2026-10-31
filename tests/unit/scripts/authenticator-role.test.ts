import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AUTHENTICATOR_ROLE,
  parseAuthenticatorUsername,
} from '../../../scripts/lib/authenticator-role';

/**
 * Phase 3, Phase 2 follow-up 2: `pnpm db:roles` accepts `rebook_authenticator` (direct
 * connection, local stack) or `rebook_authenticator.<project-ref>` (Supabase's transaction
 * pooler), compares only the role part, and refuses anything else.
 */

describe('parseAuthenticatorUsername', () => {
  it('accepts the bare role', () => {
    expect(parseAuthenticatorUsername('rebook_authenticator')).toEqual({
      ok: true,
      role: AUTHENTICATOR_ROLE,
      projectRef: null,
    });
  });

  it('accepts the pooler form and keeps the project ref apart', () => {
    expect(parseAuthenticatorUsername('rebook_authenticator.abcdefghij0123456789')).toEqual({
      ok: true,
      role: AUTHENTICATOR_ROLE,
      projectRef: 'abcdefghij0123456789',
    });
  });

  it.each([
    'postgres',
    'postgres.abcdefghij0123456789',
    'rebook_app',
    'rebook_app.abcdefghij0123456789',
    'rebook_authenticator_x',
    'rebook_authenticatorx.ref',
    'REBOOK_AUTHENTICATOR',
    'xrebook_authenticator',
    '',
  ])('refuses %j: the role part is not rebook_authenticator', (username) => {
    const result = parseAuthenticatorUsername(username);
    expect(result.ok).toBe(false);
  });

  it.each([
    'rebook_authenticator.',
    'rebook_authenticator.ABCDEF',
    'rebook_authenticator.ref.extra',
    'rebook_authenticator.ref-with-dash',
  ])('refuses %j: the project ref is empty or malformed', (username) => {
    const result = parseAuthenticatorUsername(username);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/project ref/);
  });
});

describe('pnpm db:roles refuses another role before touching the database', () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  it.each(['postgres', 'postgres.abcdefghij0123456789'])('exits 1 for %s', (username) => {
    // An unroutable owner URL: the refusal must come before any connection is attempted.
    const result = spawnSync(process.execPath, [tsxCli, 'scripts/db-roles.ts'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        APP_DATABASE_URL: `postgresql://${username}:secret@127.0.0.1:9/postgres`,
        DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:9/postgres',
        SUPABASE_URL: 'http://127.0.0.1:9',
        SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_value_for_tests',
        APP_ORIGIN: 'http://localhost:3000',
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'must connect as rebook_authenticator or rebook_authenticator.<project-ref>',
    );
  });
});
