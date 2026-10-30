import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/** The `rebook` schema must stay out of the Supabase Data API (docs/phases.md Phase 1). */
describe('supabase/config.toml', () => {
  const config = readFileSync(path.join(process.cwd(), 'supabase', 'config.toml'), 'utf8');
  const apiSection = /^\[api\]\n([\s\S]*?)^\[/m.exec(config)?.[1] ?? '';

  it('does not expose the rebook schema through the Data API', () => {
    const schemas = /^schemas\s*=\s*\[([^\]]*)\]/m.exec(apiSection)?.[1] ?? '';
    const exposed = schemas
      .split(',')
      .map((value) => value.trim().replace(/^"|"$/g, ''))
      .filter((value) => value !== '');
    expect(exposed).not.toContain('rebook');
    expect(exposed.length).toBeGreaterThan(0);
  });

  it('keeps automatic exposure of new tables off', () => {
    expect(apiSection).toMatch(/^auto_expose_new_tables\s*=\s*false/m);
  });
});
