import { z } from 'zod';

/**
 * Money is a decimal string plus an ISO 4217 currency, stored as `numeric(12,2)` and `char(3)`
 * (docs/architecture.md §5). It is never a float: amounts stay strings from the form to the
 * database, and this module only checks and canonicalises them.
 */

/** numeric(12,2): at most 10 digits before the point and 2 after. */
const AMOUNT = /^(\d{1,10})(?:\.(\d{1,2}))?$/;

/**
 * Currencies in current use, as the runtime's ICU knows them (Node 24.22.2, ICU 78.3: 162 codes).
 * Historic codes (DEM), precious metals (XAU) and anything made up (XYZ) are not in the list.
 */
const CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

export function isIsoCurrency(code: string): boolean {
  return CURRENCIES.has(code);
}

export const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((code) => /^[A-Z]{3}$/.test(code) && isIsoCurrency(code), {
    message: 'an ISO 4217 currency code in current use, such as GBP or EUR',
  });

/** "45", "45.5", "045.50" → "45.00", "45.50", "45.50". Never parsed into a binary float. */
export const amountSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (value.startsWith('-')) {
      ctx.addIssue({ code: 'custom', message: 'must not be negative' });
      return z.NEVER;
    }
    if (/^\d+\.\d{3,}$/.test(value)) {
      ctx.addIssue({ code: 'custom', message: 'at most 2 decimal places' });
      return z.NEVER;
    }
    const match = AMOUNT.exec(value);
    if (match === null) {
      ctx.addIssue({
        code: 'custom',
        message: /^\d{11,}/.test(value) ? 'at most 9999999999.99' : 'an amount such as 45 or 45.50',
      });
      return z.NEVER;
    }
    const whole = (match[1] ?? '0').replace(/^0+(?=\d)/, '');
    const fraction = (match[2] ?? '').padEnd(2, '0');
    return `${whole}.${fraction}`;
  });

export interface Money {
  /** Canonical decimal string with exactly two fraction digits, e.g. "45.50". */
  readonly amount: string;
  readonly currency: string;
}
