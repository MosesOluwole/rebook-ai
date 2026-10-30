/** A caller supplied data that failed validation at a module boundary. */
export class ValidationError extends Error {
  readonly issues: readonly string[];

  constructor(subject: string, issues: readonly string[]) {
    super(`Invalid ${subject}: ${issues.join('; ')}`);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}
