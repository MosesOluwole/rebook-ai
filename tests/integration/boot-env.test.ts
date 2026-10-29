import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Proves fail-fast start-up through a real Next.js process (docs/phases.md, Phase 0 acceptance
 * criterion 4). `next dev` with a missing, blank or malformed required variable must end with
 * exit code 1, print one readable line per problem naming the variable and where to fix it, and
 * never echo the offending value (connection strings carry credentials).
 *
 * The server boots from a throwaway copy of the app (src and configs) under .scratch/, which
 * is git-ignored and excluded from lint and typecheck. Booting from a copy means there is no
 * `.env` to re-supply a variable, nothing is written into the real `.next`, and a developer's
 * running `pnpm dev` (Next allows one dev server per directory) cannot interfere. The copy stays
 * inside the project so Node and Turbopack resolve the project's own node_modules.
 *
 * Lives in the integration project because it spawns processes and must not run in parallel
 * with other files; it needs no database. tests/unit/instrumentation-node.test.ts covers the
 * function itself.
 */

const projectRoot = process.cwd();
const nextBin = path.join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
// Observed boot-to-exit time is about one second; the deadline only bounds a regression where the
// server stays up, and sits inside the integration project's 30 s test timeout.
const BOOT_DEADLINE_MS = 20_000;

interface BootResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine a free port'));
        return;
      }
      server.close(() => {
        resolve(address.port);
      });
    });
  });
}

function bootNextDev(
  cwd: string,
  variables: Readonly<Record<string, string | undefined>>,
  port: number,
): Promise<BootResult> {
  // The child boots the way `pnpm dev` does (Vitest sets NODE_ENV=test). The variables under test
  // start from a clean slate so the outcome does not depend on the shell that runs the tests.
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development' };
  delete env.DATABASE_URL;
  delete env.NEXT_PUBLIC_APP_URL;
  for (const [name, value] of Object.entries(variables)) {
    if (value !== undefined) {
      env[name] = value;
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [nextBin, 'dev', '--port', String(port)], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(
        new Error(`next dev was still running after ${BOOT_DEADLINE_MS} ms. Output:\n${output}`),
      );
    }, BOOT_DEADLINE_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
}

describe('server start-up with an invalid environment (next dev)', () => {
  let appDir: string;

  beforeAll(() => {
    // .scratch/ is git-ignored and excluded from every tool; test-results/ would be wiped by a
    // concurrent Playwright run, which cleans its outputDir at start.
    const scratchRoot = path.join(projectRoot, '.scratch');
    mkdirSync(scratchRoot, { recursive: true });
    appDir = mkdtempSync(path.join(scratchRoot, 'boot-env-'));
    cpSync(path.join(projectRoot, 'src'), path.join(appDir, 'src'), { recursive: true });
    for (const file of ['next.config.ts', 'tsconfig.json', 'package.json']) {
      copyFileSync(path.join(projectRoot, file), path.join(appDir, file));
    }
  });

  afterAll(() => {
    rmSync(appDir, { recursive: true, force: true });
  });

  it('exits with code 1 and names the variable when DATABASE_URL is not set at all', async () => {
    const result = await bootNextDev(appDir, { DATABASE_URL: undefined }, await freePort());

    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/Invalid environment configuration \(1 problem\)/);
    expect(result.output).toMatch(/DATABASE_URL: missing\. Expected Postgres connection string/);
    expect(result.output).toMatch(/Copy \.env\.example to \.env .*docs\/setup\.md/);
  });

  it('treats a blank DATABASE_URL as missing (docs/setup.md, troubleshooting)', async () => {
    const result = await bootNextDev(appDir, { DATABASE_URL: '   ' }, await freePort());

    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/DATABASE_URL: missing\. Expected Postgres connection string/);
  });

  it('exits with code 1 for a malformed DATABASE_URL without echoing its value', async () => {
    const credential = 'synthetic-credential-0b8e';
    const host = 'db.invalid';
    const result = await bootNextDev(
      appDir,
      { DATABASE_URL: `mysql://app:${credential}@${host}:3306/rebook` },
      await freePort(),
    );

    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/Invalid environment configuration \(1 problem\)/);
    expect(result.output).toMatch(/DATABASE_URL: .*Expected Postgres connection string/);
    expect(result.output).not.toContain(credential);
    expect(result.output).not.toContain(host);
  });

  it('reports every problem at once, one line per variable', async () => {
    const result = await bootNextDev(
      appDir,
      { DATABASE_URL: '', NEXT_PUBLIC_APP_URL: 'ftp://not-a-web-origin' },
      await freePort(),
    );

    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/Invalid environment configuration \(2 problems\)/);
    expect(result.output).toMatch(/^ {2}- DATABASE_URL: missing\./m);
    expect(result.output).toMatch(/^ {2}- NEXT_PUBLIC_APP_URL: .*Expected public origin/m);
  });
});
