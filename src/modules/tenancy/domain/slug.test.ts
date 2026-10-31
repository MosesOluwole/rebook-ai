import { describe, expect, it } from 'vitest';

import { isSlug, slugify, slugWithSuffix } from './slug';
import { SLUG_PATTERN } from './tenant';

describe('slugify', () => {
  it.each([
    ['Acme Events', 'acme-events'],
    ['  Bloom & Grow Midwifery  ', 'bloom-grow-midwifery'],
    ['Café Zoë', 'cafe-zoe'],
    ['UPPER_case name!!', 'upper-case-name'],
    ['---', 'business'],
    ['日本語', 'business'],
    ['a'.repeat(80), 'a'.repeat(56)],
  ])('turns %s into %s', (name, slug) => {
    expect(slugify(name)).toBe(slug);
    expect(SLUG_PATTERN.test(slugify(name))).toBe(true);
  });

  it('never ends in a hyphen after truncation', () => {
    expect(slugify(`${'a'.repeat(55)}-b`)).toBe('a'.repeat(55));
  });

  it('appends a suffix that still fits the slug rules', () => {
    expect(slugWithSuffix('acme-events', 'k7f2')).toBe('acme-events-k7f2');
    expect(isSlug(slugWithSuffix(slugify('a'.repeat(80)), 'k7f2'))).toBe(true);
    expect(() => slugWithSuffix('acme', 'K7')).toThrow(/not valid/);
  });
});
