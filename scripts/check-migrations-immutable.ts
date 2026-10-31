/**
 * CI check: fails when a migration file that already exists on the base branch has been
 * modified, renamed or deleted in this branch or working tree. New migrations are the only way
 * to change the schema once a migration is on the default branch.
 *
 *   pnpm check:migrations                    # compares with origin/master
 *   pnpm check:migrations --base <git ref>   # e.g. origin/main, or a commit sha in CI
 *
 * The comparison runs from the merge base of <ref> and HEAD to the working tree, so uncommitted
 * edits are caught locally as well as committed ones in CI.
 */
import { spawnSync } from 'node:child_process';

import {
  describeChange,
  forbiddenMigrationChanges,
  MIGRATIONS_DIR,
  parseNameStatus,
} from './lib/migrations-immutable';

function git(args: readonly string[]): { readonly ok: boolean; readonly out: string } {
  const result = spawnSync('git', [...args], { encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}`.trim() };
}

function baseRefFromArgs(argv: readonly string[]): string {
  const index = argv.indexOf('--base');
  const fromArgs = index === -1 ? undefined : argv[index + 1];
  return fromArgs ?? process.env.MIGRATIONS_BASE_REF ?? 'origin/master';
}

const baseRef = baseRefFromArgs(process.argv.slice(2));
if (baseRef === '') {
  process.stderr.write('check:migrations: no base ref to compare with; pass --base <ref>\n');
  process.exit(2);
}
if (/^0+$/.test(baseRef)) {
  // GitHub sends the zero SHA as `github.event.before` on branch creation and force pushes:
  // there is no previous commit to compare with. Pull requests always have a base branch.
  process.stdout.write(
    'check:migrations: skipped, no previous commit to compare with (branch creation or force push)\n',
  );
  process.exit(0);
}

const verified = git(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
if (!verified.ok) {
  process.stderr.write(
    `check:migrations: cannot resolve base ref '${baseRef}'. Fetch it first (git fetch origin) or pass --base <ref>.\n`,
  );
  process.exit(2);
}

const mergeBase = git(['merge-base', baseRef, 'HEAD']);
if (!mergeBase.ok) {
  process.stderr.write(`check:migrations: ${mergeBase.out}\n`);
  process.exit(2);
}

// No second commit argument: diff from the merge base to the working tree (index + unstaged).
const diff = git(['diff', '--name-status', '-M', mergeBase.out, '--', MIGRATIONS_DIR]);
if (!diff.ok) {
  process.stderr.write(`check:migrations: ${diff.out}\n`);
  process.exit(2);
}

const forbidden = forbiddenMigrationChanges(parseNameStatus(diff.out));
if (forbidden.length > 0) {
  process.stderr.write(
    `check:migrations: ${forbidden.length} applied migration(s) changed since ${baseRef}. Migrations are forward-only: add a new migration instead.\n` +
      forbidden.map((change) => `  - ${describeChange(change)}`).join('\n') +
      '\n',
  );
  process.exit(1);
}

process.stdout.write(
  `check:migrations: no migration that exists on ${baseRef} was modified, renamed or deleted\n`,
);
