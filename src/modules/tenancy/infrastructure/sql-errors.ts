/**
 * Reads the SQLSTATE and constraint name out of a driver error, whether it arrives directly from
 * postgres.js or wrapped in Drizzle's query error (which keeps the original as `cause`).
 */
export const UNIQUE_VIOLATION = '23505';
export const CHECK_VIOLATION = '23514';

interface PgErrorShape {
  readonly code?: unknown;
  readonly constraint_name?: unknown;
  readonly cause?: unknown;
}

function walk(error: unknown): PgErrorShape | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const shape = current as PgErrorShape;
    if (typeof shape.code === 'string' && /^[0-9A-Z]{5}$/.test(shape.code)) {
      return shape;
    }
    current = shape.cause;
  }
  return undefined;
}

export function sqlStateOf(error: unknown): string | undefined {
  const shape = walk(error);
  return typeof shape?.code === 'string' ? shape.code : undefined;
}

export function violatedConstraintOf(error: unknown): string | undefined {
  const shape = walk(error);
  return typeof shape?.constraint_name === 'string' ? shape.constraint_name : undefined;
}

/**
 * Driver errors carry request data in several places: Drizzle's query error keeps the bound
 * parameters in its message ("params: a,b,c") and as a `params` property, and Postgres's own
 * message, detail and stack echo offending values ("invalid input syntax for type integer:
 * \"…\"", "Key (email)=(…) already exists"). Logs must never carry personal data (CLAUDE.md), so
 * the runner redacts the whole cause chain before rethrowing. Errors whose `stack` cannot be
 * rewritten (postgres.js defines it read-only) are replaced by a sanitised copy that keeps the
 * fields callers map on: SQLSTATE, constraint, table, column and schema names.
 */
const KEPT_FIELDS = [
  'code',
  'constraint_name',
  'table_name',
  'column_name',
  'schema_name',
  'severity',
  'routine',
] as const;

type ErrorShape = Error & {
  code?: unknown;
  params?: unknown;
  parameters?: unknown;
  detail?: unknown;
};

/** postgres.js errors carry a SQLSTATE; Drizzle's query error carries the bound `params`. */
function isDriverError(error: Error): boolean {
  const shape = error as ErrorShape;
  return (
    (typeof shape.code === 'string' && /^[0-9A-Z]{5}$/.test(shape.code)) ||
    shape.params !== undefined ||
    shape.parameters !== undefined
  );
}

/**
 * Drizzle's "Failed query" text quotes identifiers and uses $n placeholders, so only its params
 * line carries data. Postgres's own message quotes the offending value, so there every quoted
 * literal goes.
 */
function sanitiseMessage(error: Error): string {
  const shape = error as ErrorShape;
  const withoutParams = error.message.replace(/\nparams: [\s\S]*$/, '\nparams: [redacted]');
  return typeof shape.code === 'string'
    ? withoutParams.replace(/"[^"]*"/g, '"[redacted]"')
    : withoutParams;
}

/** Own properties that may carry request data and therefore must be editable or absent. */
const SENSITIVE_FIELDS = ['message', 'stack', 'params', 'parameters', 'args', 'detail'];

/**
 * True when every sensitive field can be rewritten in place. postgres.js defines `parameters`
 * and `args` as non-configurable, so its errors always take the copy path.
 */
function canRewrite(error: Error): boolean {
  return SENSITIVE_FIELDS.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(error, field);
    return (
      descriptor === undefined ||
      (descriptor.configurable === true &&
        (descriptor.writable === true || descriptor.set !== undefined))
    );
  });
}

function framesOf(error: Error): string[] {
  return (error.stack ?? '').split('\n').filter((line) => line.startsWith('    at '));
}

function define(target: object, property: string, value: unknown): void {
  Object.defineProperty(target, property, {
    value,
    writable: true,
    configurable: true,
    enumerable: property !== 'stack' && property !== 'cause',
  });
}

/** A stand-in for a driver error that cannot be edited: same name, redacted text, kept codes. */
function sanitisedCopy(original: Error, message: string): Error {
  const copy = new Error(message);
  copy.name = original.name;
  const source = original as unknown as Record<string, unknown>;
  for (const field of KEPT_FIELDS) {
    if (typeof source[field] === 'string') {
      define(copy, field, source[field]);
    }
  }
  define(copy, 'stack', [`${copy.name}: ${message}`, ...framesOf(original)].join('\n'));
  return copy;
}

export function redactQueryParams(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const chain: Error[] = [];
  let current: unknown = error;
  while (current instanceof Error && chain.length < 4) {
    chain.push(current);
    current = current.cause;
  }
  // Typed domain errors (ValidationError, NotFoundError, …) pass through untouched: their
  // messages are written by us and never carry request data.
  if (!chain.some(isDriverError)) {
    return error;
  }

  let rebuilt: Error | undefined;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const original = chain[index];
    if (original === undefined) {
      continue;
    }
    const message = isDriverError(original) ? sanitiseMessage(original) : original.message;
    let target: Error;
    if (canRewrite(original)) {
      target = original;
      target.message = message;
      const mutable = target as Error & { params?: unknown; detail?: unknown };
      if (mutable.params !== undefined) {
        mutable.params = '[redacted]';
      }
      if (typeof mutable.detail === 'string') {
        mutable.detail = '[redacted]';
      }
      define(target, 'stack', [`${target.name}: ${message}`, ...framesOf(original)].join('\n'));
    } else {
      target = sanitisedCopy(original, message);
    }
    if (rebuilt !== undefined) {
      define(target, 'cause', rebuilt);
    }
    rebuilt = target;
  }
  return rebuilt ?? error;
}
