import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanDirectory, scanText } from '../../../scripts/lib/forbidden-secrets';

/** Phase 2 acceptance criterion: CI fails if the admin key is referenced anywhere under src/. */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const script = path.join(projectRoot, 'scripts', 'check-src-secrets.ts');

function run(dir: string) {
  const result = spawnSync(process.execPath, [tsxCli, script, dir], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('scanText', () => {
  it.each([
    ['process.env.SUPABASE_SERVICE_ROLE_KEY', 'Supabase admin (RLS-bypassing) API key'],
    ["createClient(url, 'sb_secret_abc')", 'Supabase secret API key'],
    ['// uses the service-role key for admin invites', 'Supabase admin (RLS-bypassing) API key'],
    ['const key = env.SUPABASE_SECRET_KEY', 'Supabase secret key variable'],
    ['verify(token, process.env.JWT_SECRET)', 'Supabase JWT signing secret'],
  ])('flags %s', (line, pattern) => {
    expect(scanText(line, 'x.ts')).toEqual([{ file: 'x.ts', line: 1, pattern }]);
  });

  it('ignores the publishable key, the anon key name and ordinary words', () => {
    expect(
      scanText(
        "const key = env.SUPABASE_PUBLISHABLE_KEY; // sb_publishable_...; role: 'owner'; services",
        'x.ts',
      ),
    ).toEqual([]);
  });
});

describe('pnpm check:secrets', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'rebook-secrets-'));
    mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 and names the file and line when a forbidden reference exists', () => {
    writeFileSync(path.join(dir, 'src', 'nested', 'ok.ts'), 'export const a = 1;\n');
    writeFileSync(
      path.join(dir, 'src', 'nested', 'bad.ts'),
      'const x = 1;\nconst admin = process.env.SUPABASE_SERVICE_ROLE_KEY;\n',
    );
    const result = run(path.join(dir, 'src'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/src\/nested\/bad\.ts:2: Supabase admin/);
    expect(result.stderr).not.toMatch(/ok\.ts/);
  });

  it('exits 0 on a clean tree', () => {
    writeFileSync(path.join(dir, 'src', 'nested', 'ok.ts'), 'export const a = 1;\n');
    const result = run(path.join(dir, 'src'));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/no reference to the Supabase admin key/);
  });

  it('passes on the real src/ tree', () => {
    expect(scanDirectory(path.join(projectRoot, 'src'))).toEqual([]);
  });
});
