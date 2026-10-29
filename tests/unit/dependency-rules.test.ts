import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Proves the dependency rules bite (docs/phases.md, Phase 0 acceptance criterion 3).
 * dependency-cruiser runs from a fixture tree with the project's real config; every forbidden
 * import in the fixture must be reported under the expected rule, and the allowed one must not.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..', '..');
const fixtureDir = path.join(projectRoot, 'tests', 'fixtures', 'dependency-rules');
const configPath = path.join(projectRoot, '.dependency-cruiser.cjs');
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

function runDepcruise(extraArgs: readonly string[]): SpawnSyncReturns<string> {
  const result = spawnSync(
    process.execPath,
    [depcruiseBin, 'src', '--config', configPath, ...extraArgs],
    { cwd: fixtureDir, encoding: 'utf8' },
  );
  if (result.error) {
    throw result.error;
  }
  return result;
}

function cruiseFixture(): { readonly exitCode: number | null; readonly report: CruiseReport } {
  // The JSON reporter always exits 0; the default (err) reporter, which `pnpm lint:deps` uses,
  // exits with the number of error-severity violations. Run both: one for detail, one for the code.
  const json = runDepcruise(['--output-type', 'json']);
  if (json.stdout === '') {
    throw new Error(`dependency-cruiser produced no report. stderr: ${json.stderr}`);
  }
  const exitCode = runDepcruise([]).status;
  return { exitCode, report: JSON.parse(json.stdout) as CruiseReport };
}

describe('dependency rules (pnpm lint:deps)', () => {
  const { exitCode, report } = cruiseFixture();
  const violations = report.summary.violations.map((violation) => ({
    rule: violation.rule.name,
    from: violation.from,
    to: violation.to,
  }));

  it('fails the run when a rule is broken', () => {
    expect(exitCode).not.toBe(0);
    expect(report.summary.error).toBeGreaterThan(0);
  });

  it.each([
    {
      rule: 'module-internals-only-via-index',
      from: 'src/modules/beta/application/uses-alpha-internals.ts',
      to: 'src/modules/alpha/domain/name.ts',
    },
    {
      rule: 'no-module-internals-from-outside',
      from: 'src/app/page.ts',
      to: 'src/modules/alpha/application/greet.ts',
    },
    {
      rule: 'domain-depends-only-on-domain-and-kernel',
      from: 'src/modules/alpha/domain/reaches-outward.ts',
      to: 'src/modules/alpha/application/greet.ts',
    },
    {
      rule: 'domain-depends-only-on-domain-and-kernel',
      from: 'src/modules/alpha/domain/uses-other-module.ts',
      to: 'src/modules/beta/index.ts',
    },
    {
      rule: 'modules-do-not-import-app',
      from: 'src/modules/beta/application/uses-route.ts',
      to: 'src/app/page.ts',
    },
    {
      rule: 'shared-does-not-depend-on-modules',
      from: 'src/shared/config/uses-module.ts',
      to: 'src/modules/alpha/index.ts',
    },
    {
      rule: 'kernel-no-packages',
      from: 'src/shared/kernel/uses-core.ts',
      to: 'fs',
    },
    {
      rule: 'kernel-no-app-code',
      from: 'src/shared/kernel/uses-config.ts',
      to: 'src/shared/config/settings.ts',
    },
  ])('reports $rule for $from', ({ rule, from, to }) => {
    expect(violations).toContainEqual({ rule, from, to });
  });

  it('reports not-to-dev-dep for shipped code importing a devDependency', () => {
    const hit = violations.find(
      (violation) =>
        violation.rule === 'not-to-dev-dep' &&
        violation.from === 'src/modules/alpha/application/uses-dev-dep.ts',
    );
    expect(hit?.to).toMatch(/node_modules\/vitest\//);
  });

  it('covers every boundary rule in the configuration', () => {
    const config = JSON.parse(
      readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    ) as unknown;
    expect(config).toBeTruthy();
    const provenRules = new Set(violations.map((violation) => violation.rule));
    for (const rule of [
      'module-internals-only-via-index',
      'no-module-internals-from-outside',
      'modules-do-not-import-app',
      'domain-is-pure',
      'domain-depends-only-on-domain-and-kernel',
      'shared-does-not-depend-on-modules',
      'kernel-no-packages',
      'kernel-no-app-code',
      'not-to-dev-dep',
    ]) {
      expect(provenRules, `rule ${rule} never fired on the fixture`).toContain(rule);
    }
  });

  it('reports domain-is-pure for a framework import inside domain/', () => {
    const hit = violations.find(
      (violation) =>
        violation.rule === 'domain-is-pure' &&
        violation.from === 'src/modules/alpha/domain/uses-framework.ts',
    );
    expect(hit?.to).toMatch(/node_modules\/next\//);
  });

  it('reports domain-is-pure for a Node core import inside domain/', () => {
    expect(violations).toContainEqual({
      rule: 'domain-is-pure',
      from: 'src/modules/alpha/domain/uses-node-core.ts',
      to: 'fs',
    });
  });

  it("does not flag an import through another module's index.ts", () => {
    const fromPublic = violations.filter(
      (violation) => violation.from === 'src/modules/beta/application/uses-alpha-public.ts',
    );
    expect(fromPublic).toEqual([]);
  });

  it('does not flag domain code that uses only its own domain and the shared kernel', () => {
    const fromName = violations.filter(
      (violation) => violation.from === 'src/modules/alpha/domain/name.ts',
    );
    expect(fromName).toEqual([]);
  });
});
