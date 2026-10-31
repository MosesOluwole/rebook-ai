import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Test-engineer addition (Phase 3 decisions, item 4; CLAUDE.md "Forms"): a URL may carry only
 * navigation (`next`, a location id) or the allow-listed code `link=invalid`, never a message or
 * anything typed. This scans every source file under src/app and src/proxy.ts for a query-string
 * parameter written into a URL (`?name=` or `&name=`) or a programmatic one
 * (`searchParams.set/append`, `URLSearchParams`), and fails on any name outside the allow-list,
 * and on any `link=` value other than `invalid`.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');
const ALLOWED = new Set(['next', 'location', 'link']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

const files = [...sourceFiles(join(ROOT, 'src', 'app')), join(ROOT, 'src', 'proxy.ts')];

describe('URL parameters written by src/app and the proxy', () => {
  it('scans a meaningful set of files', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('only ever names next, location or link', () => {
    const offending: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/[?&]([a-zA-Z_][a-zA-Z0-9_]*)=/g)) {
        const name = match[1] ?? '';
        if (!ALLOWED.has(name)) {
          offending.push(`${relative(ROOT, file)}: ${name}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });

  it('carries link= only with the allow-listed code', () => {
    const offending: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/[?&]link=([^`'"&\s]*)/g)) {
        if (match[1] !== 'invalid') {
          offending.push(`${relative(ROOT, file)}: link=${match[1] ?? ''}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });

  it('never builds query strings programmatically', () => {
    const offending = files
      .filter((file) =>
        /searchParams\.(set|append)\(|new URLSearchParams\(/.test(readFileSync(file, 'utf8')),
      )
      .map((file) => relative(ROOT, file));
    expect(offending).toEqual([]);
  });
});
