import { canonicalTimeZone } from '@/modules/tenancy';

let cached: readonly string[] | undefined;

/** Every zone the rule can store, in its stored spelling, for `<select>` options. */
export function timeZoneOptions(): readonly string[] {
  cached ??= [
    ...new Set(
      ['UTC', ...Intl.supportedValuesOf('timeZone')]
        .map(canonicalTimeZone)
        .filter((zone): zone is string => zone !== null),
    ),
  ].sort((a, b) => a.localeCompare(b));
  return cached;
}
