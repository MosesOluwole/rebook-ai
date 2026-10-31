import { revalidatePath } from 'next/cache';

import { ValidationError } from '@/modules/tenancy';

import { formMessage, isTypedError } from './form-errors';
import { type FormState, submittedValues } from './form-state-shared';

/** Server-side helpers for actions: success and failure states, and the common action body. */
export { type FormState, IDLE, submittedValues } from './form-state-shared';

/** The state for a successful submission: a message, nothing to re-fill. */
export function succeeded(
  previous: FormState,
  message: string,
  data?: FormState['data'],
): FormState {
  return { status: 'ok', message, data, seq: previous.seq + 1 };
}

/**
 * The state for a failed submission. Typed errors become a sentence (and, for a ValidationError,
 * one message per field); anything unexpected is rethrown by `formMessage`, so it surfaces as an
 * error instead of a friendly message. The submitted values come back for re-filling.
 */
export function failed(
  previous: FormState,
  formData: FormData,
  error: unknown,
  omit: readonly string[] = [],
): FormState {
  const values = submittedValues(formData, omit);
  if (isTypedError(error, ValidationError) && Object.keys(error.fieldErrors).length > 0) {
    const fieldErrors: Record<string, string> = {};
    for (const [field, messages] of Object.entries(error.fieldErrors)) {
      if (messages[0] !== undefined) {
        fieldErrors[field] = messages[0];
      }
    }
    const formLevel = fieldErrors[''];
    return {
      status: 'error',
      message:
        formLevel === undefined ? 'Check the highlighted fields.' : `Check the form: ${formLevel}.`,
      fieldErrors,
      values,
      seq: previous.seq + 1,
    };
  }
  return { status: 'error', message: formMessage(error), values, seq: previous.seq + 1 };
}

export interface RunOptions {
  /** Fields never echoed back (passwords). */
  readonly omit?: readonly string[];
  /** Paths whose server-rendered data the action changed. */
  readonly revalidate?: readonly string[];
}

/**
 * The body of every back-office action: run the command, refresh the pages it changed, and turn
 * the outcome into form state. Authorisation (`authoriseAction`) and redirects happen outside,
 * so their control-flow errors are never caught here.
 */
export async function runForm(
  previous: FormState,
  formData: FormData,
  work: () => Promise<string | { readonly message: string; readonly data?: FormState['data'] }>,
  options: RunOptions = {},
): Promise<FormState> {
  try {
    const outcome = await work();
    for (const path of options.revalidate ?? []) {
      revalidatePath(path);
    }
    return typeof outcome === 'string'
      ? succeeded(previous, outcome)
      : succeeded(previous, outcome.message, outcome.data);
  } catch (error) {
    return failed(previous, formData, error, options.omit);
  }
}
