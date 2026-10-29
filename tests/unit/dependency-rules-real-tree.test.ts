import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Proves Phase 0 acceptance criterion 3 on the real tree, not only on the fixture: a copy of src/
 * cruised with the project's own tsconfig.json and .dependency-cruiser.cjs is clean, and turns
 * into a failing `pnpm lint:deps` run as soon as one file reaches into another module's internals.
 * The copy lives in a temporary directory, so the project tree is never touched.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..', '..');
const depcruisePackageDir = path.join(projectRoot, 'node_modules', 'dependency-cruiser');
const depcruiseBin = path.join(
  depcruisePackageDir,
  (
    JSON.parse(readFileSync(path.join(depcruisePackageDir, 'package.json'), 'utf8')) as {
      bin: { depcruise: string };
    }
  ).bin.depcruise,
);

interface Violation {
  readonly rule: { readonly name: string; readonly severity: string };
  readonly from: string;
  readonly to: string;
}

interface CruiseReport {
  readonly summary: { readonly error: number; readonly violations: readonly Violation[] };
}

function runDepcruise(cwd: string, extraArgs: readonly string[]): SpawnSyncReturns<string> {
  const result = spawnSync(
    process.execPath,
    [depcruiseBin, 'src', '--config', '.dependency-cruiser.cjs', ...extraArgs],
    { cwd, encoding: 'utf8' },
  );
  if (result.error) {
    throw result.error;
  }
  return result;
}

function cruise(cwd: string): {
  readonly exitCode: number | null;
  readonly violations: readonly { rule: string; from: string; to: string }[];
} {
  const json = runDepcruise(cwd, ['--output-type', 'json']);
  if (json.stdout === '') {
    throw new Error(`dependency-cruiser produced no report. stderr: ${json.stderr}`);
  }
  const report = JSON.parse(json.stdout) as CruiseReport;
  // The default reporter, which `pnpm lint:deps` uses, exits with the number of error violations.
  const exitCode = runDepcruise(cwd, []).status;
  return {
    exitCode,
    violations: report.summary.violations.map((violation) => ({
      rule: violation.rule.name,
      from: violation.from,
      to: violation.to,
    })),
  };
}

function writeSource(workDir: string, relativePath: string, lines: readonly string[]): void {
  const file = path.join(workDir, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
}

describe('dependency rules on a copy of the real src tree', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'rebook-depcruise-'));
    cpSync(path.join(projectRoot, 'src'), path.join(workDir, 'src'), { recursive: true });
    for (const file of ['tsconfig.json', 'package.json', '.dependency-cruiser.cjs']) {
      copyFileSync(path.join(projectRoot, file), path.join(workDir, file));
    }
    symlinkSync(path.join(projectRoot, 'node_modules'), path.join(workDir, 'node_modules'), 'dir');
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('is clean before any violation is introduced (what pnpm lint:deps checks today)', () => {
    const { exitCode, violations } = cruise(workDir);
    expect(violations).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("fails once a module imports another module's internals instead of its index.ts", () => {
    writeSource(workDir, 'src/modules/probe/application/report.ts', [
      "import { buildHealthReport } from '@/modules/platform/domain/health';",
      '',
      'export function probe(): string {',
      "  return buildHealthReport({ now: new Date(0), version: '0', environment: 'test' }).status;",
      '}',
    ]);
    writeSource(workDir, 'src/modules/probe/index.ts', [
      "export { probe } from './application/report';",
    ]);

    const { exitCode, violations } = cruise(workDir);
    expect(exitCode).not.toBe(0);
    expect(violations).toContainEqual({
      rule: 'module-internals-only-via-index',
      from: 'src/modules/probe/application/report.ts',
      to: 'src/modules/platform/domain/health.ts',
    });
  });

  it("fails once a route imports a module's application layer instead of its index.ts", () => {
    writeSource(workDir, 'src/app/probe/route.ts', [
      "import { getHealthReport } from '@/modules/platform/application/health-service';",
      '',
      'export function GET(): Response {',
      '  return Response.json(',
      "    getHealthReport({ clock: { now: () => new Date(0) }, version: '0', environment: 'test' }),",
      '  );',
      '}',
    ]);

    const { exitCode, violations } = cruise(workDir);
    expect(exitCode).not.toBe(0);
    expect(violations).toContainEqual({
      rule: 'no-module-internals-from-outside',
      from: 'src/app/probe/route.ts',
      to: 'src/modules/platform/application/health-service.ts',
    });
  });
});
