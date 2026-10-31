/**
 * Applied migrations are immutable (CLAUDE.md, docs/adr/ADR-001): once a file under
 * supabase/migrations exists on the default branch, a later change must be a new migration, never
 * an edit, rename or deletion of that file. Drizzle Kit's journal and snapshots under meta/ do
 * change with every new migration and are exempt. Used by `pnpm check:migrations` and tested in
 * tests/unit/scripts/migrations-immutable.test.ts.
 */

export const MIGRATIONS_DIR = 'supabase/migrations/';

export interface MigrationChange {
  /** git's one-letter status: A added, M modified, D deleted, R renamed, C copied, T type change. */
  readonly status: string;
  /** Path of the file as it exists on the base branch (the old name for a rename). */
  readonly path: string;
  /** For renames and copies, the new path. */
  readonly newPath?: string;
}

/** Parses `git diff --name-status` output. Renames come as `R100<TAB>old<TAB>new`. */
export function parseNameStatus(output: string): MigrationChange[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .map((line) => {
      const [rawStatus = '', first = '', second] = line.split('\t');
      const status = rawStatus.charAt(0);
      return second === undefined
        ? { status, path: first }
        : { status, path: first, newPath: second };
    });
}

function isImmutableMigrationFile(path: string): boolean {
  return (
    path.startsWith(MIGRATIONS_DIR) &&
    !path.startsWith(`${MIGRATIONS_DIR}meta/`) &&
    path.endsWith('.sql')
  );
}

/** Changes that touch a migration file the base branch already has. Additions are fine. */
export function forbiddenMigrationChanges(changes: readonly MigrationChange[]): MigrationChange[] {
  return changes.filter((change) => change.status !== 'A' && isImmutableMigrationFile(change.path));
}

export function describeChange(change: MigrationChange): string {
  switch (change.status) {
    case 'M':
      return `${change.path} was modified`;
    case 'D':
      return `${change.path} was deleted`;
    case 'R':
      return `${change.path} was renamed to ${change.newPath ?? '?'}`;
    case 'C':
      return `${change.path} was copied to ${change.newPath ?? '?'}`;
    default:
      return `${change.path} was changed (${change.status})`;
  }
}
