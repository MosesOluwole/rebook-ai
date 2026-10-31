import { z } from 'zod';

/**
 * A whole number within [min, max], from a number or from a form string. Forms post strings, so
 * "30" is accepted; "", "1.5", "-5" and "abc" each get a message rather than being coerced (Zod's
 * coerce would turn "" into 0 and accept "1.5").
 */
export function wholeNumber(min: number, max: number, unit: string) {
  const range = `between ${String(min)} and ${String(max)} ${unit}`;
  return z
    .union([
      z.number(),
      z
        .string()
        .trim()
        .transform((value, ctx) => {
          if (!/^-?\d+$/.test(value)) {
            ctx.addIssue({ code: 'custom', message: `a whole number ${range}` });
            return z.NEVER;
          }
          return Number(value);
        }),
    ])
    .pipe(
      z
        .number()
        .int(`a whole number ${range}`)
        .min(min, min === 0 ? 'must not be negative' : `must be ${range}`)
        .max(max, `must be ${range}`),
    );
}

/** An optional whole number: blank or absent means null. */
export function optionalWholeNumber(min: number, max: number, unit: string) {
  return z
    .union([z.null(), z.literal(''), wholeNumber(min, max, unit)])
    .optional()
    .transform((value) => (value === '' || value === undefined ? null : value));
}
