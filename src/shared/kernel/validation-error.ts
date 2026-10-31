/**
 * A caller supplied data that failed validation at a module boundary. Shared by every module's
 * domain layer so the web layer maps one class (docs/architecture.md §3: Zod at every boundary).
 *
 * `issues` are human-readable lines (`field: message`). `fieldErrors` holds the same messages keyed
 * by field path (`price`, `days.1.ranges.0.end`), so a form can show each message next to its
 * input; `''` collects messages about the input as a whole. Messages never echo the input.
 *
 * Every typed error carries a `kind` literal (static and per instance): `instanceof` is the
 * primary check, and the web layer may also compare `kind` because the dev server's hot reload can
 * leave two copies of a class alive. A literal survives minification, which mangles class names.
 */
export class ValidationError extends Error {
  static readonly kind = 'ValidationError' as const;
  readonly kind = ValidationError.kind;

  readonly issues: readonly string[];
  readonly fieldErrors: Readonly<Record<string, readonly string[]>>;

  constructor(
    subject: string,
    issues: readonly string[],
    fieldErrors: Readonly<Record<string, readonly string[]>> = {},
  ) {
    super(`Invalid ${subject}: ${issues.join('; ')}`);
    this.name = 'ValidationError';
    this.issues = issues;
    this.fieldErrors = fieldErrors;
  }
}

/** The part of a Zod error this module reads; structural, so the kernel needs no Zod import. */
export interface IssueList {
  readonly issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[];
}

/** A ValidationError from Zod issues, keeping the field path of each message. */
export function validationErrorFrom(
  subject: string,
  error: IssueList,
  fallback: string,
): ValidationError {
  const issues: string[] = [];
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.map(String).join('.');
    issues.push(`${path || fallback}: ${issue.message}`);
    (fieldErrors[path] ??= []).push(issue.message);
  }
  return new ValidationError(subject, issues, fieldErrors);
}
