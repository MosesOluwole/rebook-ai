/**
 * Form outcomes travel as server-action state (React's useActionState), never in the URL: the
 * message, one message per field path and the submitted values come back in the action's response
 * so inputs are re-filled, and nothing a person typed ends up in a URL, a log or the history
 * (CLAUDE.md, "Forms"). Pure, so client components import it too; the server-only helpers are in
 * form-state.ts.
 */
export interface FormState {
  readonly status: 'idle' | 'ok' | 'error';
  readonly message?: string;
  /** First message per field path (`price`, `days.1.ranges.0.end`); '' for the form as a whole. */
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /** What was submitted, to re-fill inputs after an error. Secrets (passwords) are never included. */
  readonly values?: Readonly<Record<string, string | readonly string[]>>;
  /** Extra output an action hands to its form (an invite link). */
  readonly data?: Readonly<Record<string, string>>;
  /** Increments on every submission, so re-filled inputs remount with the returned values. */
  readonly seq: number;
}

export const IDLE: FormState = { status: 'idle', seq: 0 };

/** Every field of a submission except React's own `$ACTION…` fields and the omitted ones. */
export function submittedValues(
  formData: FormData,
  omit: readonly string[] = [],
): Record<string, string | readonly string[]> {
  const values: Record<string, string | string[]> = {};
  for (const [name, value] of formData.entries()) {
    if (typeof value !== 'string' || name.startsWith('$ACTION') || omit.includes(name)) {
      continue;
    }
    const existing = values[name];
    if (existing === undefined) {
      values[name] = value;
    } else {
      values[name] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    }
  }
  return values;
}
