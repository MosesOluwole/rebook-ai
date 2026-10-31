import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Strings that must never appear in shipped application code (docs/phases.md Phase 2: the
 * Supabase admin key is never used in application code; CLAUDE.md: secrets only from validated
 * env). Matching is textual on purpose: a reference in a comment is a finding too, because the
 * next edit turns it into code. Used by `pnpm check:secrets` and tested in
 * tests/unit/scripts/forbidden-secrets.test.ts.
 */

export interface ForbiddenPattern {
  readonly name: string;
  readonly regex: RegExp;
}

export const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  { name: 'Supabase admin (RLS-bypassing) API key', regex: /service[_-]?role/i },
  { name: 'Supabase secret API key', regex: /sb_secret_/ },
  { name: 'Supabase secret key variable', regex: /SUPABASE_SECRET_KEY/ },
  { name: 'Supabase JWT signing secret', regex: /JWT_SECRET/ },
];

export interface SecretFinding {
  readonly file: string;
  readonly line: number;
  readonly pattern: string;
}

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css']);

export function scanText(text: string, file: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  text.split('\n').forEach((content, index) => {
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.regex.test(content)) {
        findings.push({ file, line: index + 1, pattern: pattern.name });
      }
    }
  });
  return findings;
}

/** Every finding under `root`, with paths relative to `root`'s parent (so `src/...`). */
export function scanDirectory(root: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const base = path.dirname(root);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (SCANNED_EXTENSIONS.has(path.extname(entry))) {
        findings.push(...scanText(readFileSync(full, 'utf8'), path.relative(base, full)));
      }
    }
  };
  walk(root);
  return findings;
}

export function formatSecretFindings(findings: readonly SecretFinding[]): string {
  return findings.map((f) => `  - ${f.file}:${f.line}: ${f.pattern}`).join('\n');
}
