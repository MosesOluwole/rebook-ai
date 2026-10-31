import { SLUG_PATTERN } from './tenant';

/** Leaves room for a `-xxxx` collision suffix inside the 63-character slug limit. */
const BASE_MAX_LENGTH = 56;
const FALLBACK = 'business';

/**
 * A URL slug derived from a business name: ASCII letters and digits, hyphen-separated, diacritics
 * stripped (`Café Zoë` → `cafe-zoe`). Names with nothing usable become `business`.
 */
export function slugify(name: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = ascii.slice(0, BASE_MAX_LENGTH).replace(/-+$/g, '');
  return base === '' ? FALLBACK : base;
}

/** `base-suffix`, used when `base` is already taken. */
export function slugWithSuffix(base: string, suffix: string): string {
  const slug = `${base}-${suffix}`;
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(`derived slug '${slug}' is not valid`);
  }
  return slug;
}

export function isSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}
