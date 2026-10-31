import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  forbiddenMigrationChanges,
  parseNameStatus,
} from '../../../scripts/lib/migrations-immutable';

/**
 * Phase 2 acceptance criterion: "modifying an existing migration fails CI". The library is tested
 * on git's own output format, and the CLI is run against a throwaway git repository with a base
 * branch that already holds one migration.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const script = path.join(projectRoot, 'scripts', 'check-migrations-immutable.ts');

describe('forbiddenMigrationChanges', () => {
  it('parses name-status lines including renames', () => {
    expect(
      parseNameStatus(
        'M\tsupabase/migrations/1_a.sql\nR100\tsupabase/migrations/2_b.sql\tsupabase/migrations/3_b.sql\nA\tsupabase/migrations/4_c.sql\n',
      ),
    ).toEqual([
      { status: 'M', path: 'supabase/migrations/1_a.sql' },
      {
        status: 'R',
        path: 'supabase/migrations/2_b.sql',
        newPath: 'supabase/migrations/3_b.sql',
      },
      { status: 'A', path: 'supabase/migrations/4_c.sql' },
    ]);
  });

  it('allows additions and anything under meta/, forbids edits, deletions and renames', () => {
    const changes = parseNameStatus(
      [
        'A\tsupabase/migrations/5_new.sql',
        'M\tsupabase/migrations/meta/_journal.json',
        'A\tsupabase/migrations/meta/5_snapshot.json',
        'M\tsupabase/migrations/1_a.sql',
        'D\tsupabase/migrations/2_b.sql',
        'R090\tsupabase/migrations/3_c.sql\tsupabase/migrations/3_d.sql',
        'M\tsupabase/seed.sql',
      ].join('\n'),
    );
    expect(forbiddenMigrationChanges(changes).map((change) => change.path)).toEqual([
      'supabase/migrations/1_a.sql',
      'supabase/migrations/2_b.sql',
      'supabase/migrations/3_c.sql',
    ]);
  });
});

describe('pnpm check:migrations against a real git repository', () => {
  let repo: string;

  function git(...args: string[]): void {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
  }

  function run(...args: string[]) {
    const result = spawnSync(process.execPath, [tsxCli, script, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, MIGRATIONS_BASE_REF: undefined },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  beforeEach(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'rebook-migrations-'));
    git('init', '-q', '-b', 'master');
    git('config', 'user.email', 'ci@example.invalid');
    git('config', 'user.name', 'CI');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(path.join(repo, 'supabase', 'migrations', 'meta'), { recursive: true });
    writeFileSync(path.join(repo, 'supabase', 'migrations', '0001_first.sql'), 'select 1;\n');
    writeFileSync(path.join(repo, 'supabase', 'migrations', 'meta', '_journal.json'), '{}\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first migration');
    git('checkout', '-q', '-b', 'feature');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('passes when the branch only adds a migration and updates the journal', () => {
    writeFileSync(path.join(repo, 'supabase', 'migrations', '0002_second.sql'), 'select 2;\n');
    writeFileSync(path.join(repo, 'supabase', 'migrations', 'meta', '_journal.json'), '{"n":2}\n');
    git('add', '.');
    git('commit', '-q', '-m', 'second migration');

    const result = run('--base', 'master');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/no migration that exists on master was modified/);
  });

  it('fails when a migration that exists on the base branch is modified, even uncommitted', () => {
    writeFileSync(
      path.join(repo, 'supabase', 'migrations', '0001_first.sql'),
      'select 1; -- edited\n',
    );

    const result = run('--base', 'master');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/supabase\/migrations\/0001_first\.sql was modified/);
    expect(result.stderr).toMatch(/add a new migration instead/);
  });

  it('fails when an applied migration is deleted or renamed', () => {
    renameSync(
      path.join(repo, 'supabase', 'migrations', '0001_first.sql'),
      path.join(repo, 'supabase', 'migrations', '0001_renamed.sql'),
    );
    git('add', '-A');
    git('commit', '-q', '-m', 'rename');
    const renamed = run('--base', 'master');
    expect(renamed.status).toBe(1);
    expect(renamed.stderr).toMatch(
      /0001_first\.sql was renamed to supabase\/migrations\/0001_renamed\.sql/,
    );

    rmSync(path.join(repo, 'supabase', 'migrations', '0001_renamed.sql'));
    git('add', '-A');
    git('commit', '-q', '-m', 'delete');
    const deleted = run('--base', 'master');
    expect(deleted.status).toBe(1);
    expect(deleted.stderr).toMatch(/was deleted/);
  });

  it('skips with a notice when the base is the zero SHA GitHub sends for branch creation', () => {
    const result = run('--base', '0000000000000000000000000000000000000000');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/skipped, no previous commit to compare with/);
  });

  it('exits 2 with an explanation when the base ref cannot be resolved', () => {
    const result = run('--base', 'origin/nowhere');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/cannot resolve base ref 'origin\/nowhere'/);
  });
});
