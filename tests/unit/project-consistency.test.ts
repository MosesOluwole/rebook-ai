import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EnvValidationError, parseEnv } from '@/shared/config/env';

/**
 * Guards the links between docs, tooling and code that a fresh clone depends on (docs/phases.md,
 * Phase 0 criteria 1, 5 and 7). CLAUDE.md says the documents win where code disagrees, so a
 * mismatch here means one side drifted and the change must update the other.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string): string => readFileSync(path.join(projectRoot, file), 'utf8');

interface PackageJson {
  readonly packageManager: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
}

const packageJson = JSON.parse(read('package.json')) as PackageJson;

/** pnpm's own subcommands: valid after `pnpm ` without being scripts in package.json. */
const PNPM_BUILTINS = new Set([
  'add',
  'approve-builds',
  'audit',
  'dlx',
  'exec',
  'install',
  'list',
  'ls',
  'outdated',
  'remove',
  'run',
  'store',
  'update',
  'why',
]);

/** Only command text: fenced blocks and backtick spans in Markdown, `run:` lines in workflows. */
function commandText(file: string): string {
  const content = read(file);
  if (file.endsWith('.yml') || file.endsWith('.yaml')) {
    return content
      .split('\n')
      .filter((line) => /^\s*(?:- )?run: /.test(line))
      .join('\n');
  }
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  // Shell comments inside fenced blocks are prose ("# ... if Node or pnpm are outside ...").
  const fenced = [...content.matchAll(fence)].map((match) =>
    (match[1] ?? '').replace(/(^|\s)#.*$/gm, '$1'),
  );
  // Remove the fenced blocks before looking for spans, or their fence markers pair up with
  // unrelated backticks and swallow prose.
  const prose = content.replace(fence, '');
  const spans = [...prose.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
  return [...fenced, ...spans].join('\n');
}

function pnpmScriptsReferencedIn(file: string): string[] {
  const names = new Set<string>();
  for (const match of commandText(file).matchAll(/\bpnpm ([a-z][a-z0-9:*/-]*)/g)) {
    // `pnpm db:start/stop` documents two scripts; `pnpm db:*` is a family, not a script.
    const name = (match[1] ?? '').split('/')[0] ?? '';
    if (name === '' || name.includes('*') || PNPM_BUILTINS.has(name)) {
      continue;
    }
    names.add(name);
  }
  return [...names].sort();
}

function pinnedVersion(name: string): string {
  const version = packageJson.dependencies[name] ?? packageJson.devDependencies[name];
  if (version === undefined) {
    throw new Error(`${name} is not a dependency in package.json`);
  }
  return version;
}

const majorMinor = (version: string): string => version.split('.').slice(0, 2).join('.');

describe('documented pnpm commands exist as package.json scripts', () => {
  it.each(['CLAUDE.md', 'README.md', 'docs/setup.md', '.github/workflows/ci.yml'])(
    '%s references only scripts that exist',
    (file) => {
      const referenced = pnpmScriptsReferencedIn(file);
      expect(referenced.length).toBeGreaterThan(0);
      const missing = referenced.filter((name) => !Object.hasOwn(packageJson.scripts, name));
      expect(missing).toEqual([]);
    },
  );

  it('every dependency in package.json is pinned to an exact version', () => {
    const loose = Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies })
      .filter(([, version]) => !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
      .map(([name, version]) => `${name}@${version}`);
    expect(loose).toEqual([]);
  });
});

describe('ADR-001 records the pinned stack (Phase 0 criterion 7)', () => {
  const adr = read('docs/adr/ADR-001-stack.md');

  it('names the Node version from .nvmrc and the pnpm version from packageManager', () => {
    expect(adr).toContain(read('.nvmrc').trim());
    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(adr).toContain(packageJson.packageManager.slice('pnpm@'.length));
  });

  it.each(['next', 'react', 'typescript', 'drizzle-orm', 'postgres', 'zod', 'vitest'])(
    'records the exact pinned version of %s',
    (name) => {
      expect(adr).toContain(pinnedVersion(name));
    },
  );

  it.each([
    '@playwright/test',
    'dependency-cruiser',
    'eslint',
    'prettier',
    'supabase',
    'typescript-eslint',
  ])('records at least the major.minor version of %s', (name) => {
    expect(adr).toContain(majorMinor(pinnedVersion(name)));
  });

  it('records the Postgres major version the local stack runs', () => {
    const major = /^major_version\s*=\s*(\d+)/m.exec(read('supabase/config.toml'))?.[1];
    expect(major).toBeDefined();
    expect(adr).toContain(`Postgres ${major ?? ''}`);
  });
});

describe('.env.example (Phase 0 criterion 1 and 4)', () => {
  const example = read('.env.example');
  const activeLines = example.split('\n').filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line));
  const exampleValues = Object.fromEntries(
    activeLines.map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );

  function requiredVariables(): string[] {
    try {
      parseEnv({});
    } catch (error) {
      if (error instanceof EnvValidationError) {
        return error.issues.map((issue) => issue.variable);
      }
      throw error;
    }
    throw new Error('parseEnv({}) should reject an empty environment');
  }

  it('declares every required variable on an active line', () => {
    const required = requiredVariables();
    expect(required).toContain('DATABASE_URL');
    for (const variable of required) {
      expect(Object.hasOwn(exampleValues, variable)).toBe(true);
    }
  });

  it('is a complete, valid local configuration once copied to .env', () => {
    expect(() => parseEnv(exampleValues)).not.toThrow();
  });

  it('holds placeholders only: the database points at the local stack, never a remote host', () => {
    const databaseUrl = exampleValues.DATABASE_URL ?? '';
    expect(['127.0.0.1', 'localhost']).toContain(new URL(databaseUrl).hostname);
  });
});

describe('CI workflow (Phase 0 criterion 5)', () => {
  const workflow = read('.github/workflows/ci.yml');
  const jobsSection = workflow.slice(workflow.indexOf('\njobs:\n'));
  const jobIds = [...jobsSection.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)]
    .map((match) => match[1])
    .filter((id): id is string => id !== undefined);

  it('runs on every pull request and on pushes to main', () => {
    expect(workflow).toMatch(/^ {2}pull_request:\s*$/m);
    expect(workflow).toMatch(/^ {2}push:\n {4}branches: \[main\]/m);
  });

  it('exposes the single status check docs/setup.md tells Moses to require', () => {
    const required = /require the `([^`]+)` check/.exec(read('docs/setup.md'))?.[1];
    expect(required).toBeDefined();
    expect(jobsSection).toContain(`name: ${required ?? ''}`);
  });

  it('gates that check on every other job', () => {
    expect(jobIds).toContain('ci-passed');
    const needs = /needs: \[([^\]]+)\]/
      .exec(jobsSection)?.[1]
      ?.split(',')
      .map((id) => id.trim())
      .sort();
    expect(needs).toEqual(jobIds.filter((id) => id !== 'ci-passed').sort());
  });

  it('runs typecheck, lint, dependency rules, formatting, unit, integration and e2e tests', () => {
    const run = pnpmScriptsReferencedIn('.github/workflows/ci.yml');
    for (const script of [
      'typecheck',
      'lint',
      'lint:deps',
      'format:check',
      'test',
      'db:migrate',
      'test:integration',
      'build',
      'test:e2e',
    ]) {
      expect(run).toContain(script);
    }
  });
});
