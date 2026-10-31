/**
 * The SQLSTATE of a database error, whether it comes straight from postgres.js or wrapped in
 * Drizzle's query error (which keeps the original as `cause`).
 */
export function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export const PERMISSION_DENIED = '42501';
export const FOREIGN_KEY_VIOLATION = '23503';
export const UNIQUE_VIOLATION = '23505';
export const CHECK_VIOLATION = '23514';
export const EXCLUSION_VIOLATION = '23P01';

export async function expectSqlState(promise: Promise<unknown>, expected: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) {
    throw new Error(`expected SQLSTATE ${expected} but the statement succeeded`);
  }
  const actual = sqlState(caught);
  if (actual !== expected) {
    throw new Error(
      `expected SQLSTATE ${expected} but got ${actual ?? 'none'}: ${describeErrorChain(caught)}`,
    );
  }
}

/** Every message in the cause chain, so a wrapped driver error is still readable. */
function describeErrorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    messages.push(
      current instanceof Error
        ? `${current.name}: ${current.message}`
        : typeof current === 'string'
          ? current
          : 'non-error value',
    );
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return messages.join(' <- ');
}
