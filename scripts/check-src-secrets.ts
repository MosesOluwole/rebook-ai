/**
 * CI check: fails if application code references the Supabase admin key, secret key or JWT
 * secret (docs/phases.md Phase 2). Scans `src/` by default; a directory argument scans that
 * instead (used by the tests).
 *
 *   pnpm check:secrets
 */
import path from 'node:path';

import { formatSecretFindings, scanDirectory } from './lib/forbidden-secrets';

const target = path.resolve(process.argv[2] ?? 'src');
const findings = scanDirectory(target);

if (findings.length > 0) {
  process.stderr.write(
    `check:secrets: ${findings.length} forbidden reference(s) under ${path.relative(process.cwd(), target) || '.'}\n${formatSecretFindings(findings)}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `check:secrets: no reference to the Supabase admin key, secret key or JWT secret under ${path.relative(process.cwd(), target) || '.'}\n`,
);
