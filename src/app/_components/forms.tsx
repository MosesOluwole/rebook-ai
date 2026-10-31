'use client';

import {
  createContext,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useActionState,
  useContext,
  useId,
} from 'react';
import { useFormStatus } from 'react-dom';

import { type FormState, IDLE, submittedValues } from '../_lib/form-state-shared';

/**
 * Forms whose outcome is server-action state (CLAUDE.md, "Forms"). `ActionForm` wraps a server
 * action `(previous, formData) => FormState` in useActionState; the inputs below read the state
 * from context to show their field message and to re-fill what was submitted. Works without
 * JavaScript too: React posts the form and renders the returned state.
 *
 * Every input is keyed by the submission counter, because React resets a form after its action:
 * remounting makes `defaultValue` the submitted value (after an error) or the stored one (after
 * success, once the page's data is revalidated).
 */

export type FormAction = (previous: FormState, formData: FormData) => Promise<FormState>;

interface FormContextValue {
  readonly state: FormState;
  readonly idPrefix: string;
}

const FormContext = createContext<FormContextValue>({ state: IDLE, idPrefix: 'form' });

/** The current state of the enclosing form, for components that show action output. */
export function useFormResult(): FormState {
  return useContext(FormContext).state;
}

function Banner({ state }: { readonly state: FormState }) {
  if (state.message === undefined) {
    return null;
  }
  return state.status === 'error' ? (
    <p className="notice error" role="alert">
      {state.message}
    </p>
  ) : (
    <p className="notice" role="status">
      {state.message}
    </p>
  );
}

function Form({
  state,
  action,
  label,
  className,
  children,
}: {
  readonly state: FormState;
  readonly action: (formData: FormData) => void;
  readonly label?: string;
  readonly className: string;
  readonly children: ReactNode;
}) {
  const idPrefix = useId();
  return (
    <FormContext value={{ state, idPrefix }}>
      <form action={action} className={className} aria-label={label}>
        <Banner state={state} />
        {children}
      </form>
    </FormContext>
  );
}

/** A form backed by a server action. */
export function ActionForm({
  action,
  label,
  className = 'stack',
  children,
}: {
  readonly action: FormAction;
  /** Accessible name, for pages with several forms. */
  readonly label?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  return (
    <Form state={state} action={formAction} label={label} className={className}>
      {children}
    </Form>
  );
}

/** What an auth route handler answers to a request that accepts JSON (src/app/_lib/http.ts). */
interface RouteResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly redirect?: string;
}

/**
 * A form posted to a route handler: the four auth flows stay route handlers so a refused attempt
 * is a real 429 (ADR-004 §9). The reducer runs in the browser, posts with `Accept:
 * application/json` and turns the answer into form state; a redirect is a full navigation so the
 * new session cookies apply. The reducer is a browser function, so this form needs JavaScript
 * (React replays a submission made before hydration); the routes still answer a plain form post
 * with a redirect or a small HTML page, for clients that post to them directly.
 */
export function RouteForm({
  endpoint,
  label,
  className = 'stack',
  omit = [],
  children,
}: {
  readonly endpoint: string;
  readonly label?: string;
  readonly className?: string;
  /** Fields never re-filled (passwords). */
  readonly omit?: readonly string[];
  readonly children: ReactNode;
}) {
  const [state, formAction] = useActionState(
    async (previous: FormState, formData: FormData): Promise<FormState> => {
      const seq = previous.seq + 1;
      let result: RouteResult;
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          body: formData,
          headers: { accept: 'application/json' },
        });
        result = (await response.json()) as RouteResult;
      } catch {
        result = { ok: false, message: 'Something went wrong. Try again.' };
      }
      if (result.redirect !== undefined) {
        window.location.assign(result.redirect);
        return { status: 'ok', seq };
      }
      return {
        status: result.ok ? 'ok' : 'error',
        message: result.message,
        values: result.ok ? undefined : submittedValues(formData, omit),
        seq,
      };
    },
    IDLE,
  );
  return (
    <Form state={state} action={formAction} label={label} className={className}>
      {children}
    </Form>
  );
}

function useField(name: string) {
  const { state, idPrefix } = useContext(FormContext);
  const error = state.fieldErrors?.[name];
  const submitted = state.status === 'error' ? state.values?.[name] : undefined;
  const errorId = `${idPrefix}-${name}-error`;
  const aria =
    error === undefined ? {} : { 'aria-invalid': true as const, 'aria-describedby': errorId };
  return { error, errorId, submitted, seq: state.seq, aria, hasValues: state.values !== undefined };
}

/**
 * A field's message and its ARIA wiring, for inputs that keep their own (controlled) value, such
 * as the weekly hours editor.
 */
export function useFieldError(name: string) {
  const { error, errorId, aria } = useField(name);
  return { aria, message: <ErrorText error={error} id={errorId} /> };
}

/**
 * A field's message. Rendered inside the field's <label>, so it is hidden from the accessible
 * name; screen readers get it as the description through aria-describedby (which reads hidden
 * nodes).
 */
function ErrorText({ error, id }: { readonly error: string | undefined; readonly id: string }) {
  if (error === undefined) {
    return null;
  }
  return (
    <span className="field-error" id={id} aria-hidden="true">
      {error}
    </span>
  );
}

/** A message for a field path that has no single input (e.g. the form as a whole, `''`). */
export function FieldMessage({ name }: { readonly name: string }) {
  const { error, errorId } = useField(name);
  return <ErrorText error={error} id={errorId} />;
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'name' | 'defaultValue'> & {
  readonly name: string;
  readonly label: ReactNode;
  readonly defaultValue?: string | number | null;
};

export function TextInput({ name, label, defaultValue, type = 'text', ...rest }: InputProps) {
  const { error, errorId, submitted, seq, aria } = useField(name);
  const value = typeof submitted === 'string' ? submitted : (defaultValue ?? undefined);
  return (
    <label>
      {label}
      <input
        key={seq}
        type={type}
        name={name}
        defaultValue={value === undefined ? undefined : String(value)}
        {...aria}
        {...rest}
      />
      <ErrorText error={error} id={errorId} />
    </label>
  );
}

type TextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'name' | 'defaultValue'> & {
  readonly name: string;
  readonly label: ReactNode;
  readonly defaultValue?: string;
};

export function TextAreaInput({ name, label, defaultValue, ...rest }: TextAreaProps) {
  const { error, errorId, submitted, seq, aria } = useField(name);
  return (
    <label>
      {label}
      <textarea
        key={seq}
        name={name}
        defaultValue={typeof submitted === 'string' ? submitted : defaultValue}
        {...aria}
        {...rest}
      />
      <ErrorText error={error} id={errorId} />
    </label>
  );
}

export interface Option {
  readonly value: string;
  readonly label: string;
}

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'name' | 'defaultValue'> & {
  readonly name: string;
  readonly label: ReactNode;
  readonly options: readonly Option[];
  readonly defaultValue?: string;
};

export function SelectInput({ name, label, options, defaultValue, ...rest }: SelectProps) {
  const { error, errorId, submitted, seq, aria } = useField(name);
  return (
    <label>
      {label}
      <select
        key={seq}
        name={name}
        defaultValue={typeof submitted === 'string' ? submitted : defaultValue}
        {...aria}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ErrorText error={error} id={errorId} />
    </label>
  );
}

type CheckProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'name' | 'type' | 'value'> & {
  readonly name: string;
  readonly label: ReactNode;
  readonly value?: string;
  readonly type?: 'checkbox' | 'radio';
};

/**
 * A checkbox or radio. After an error it is checked exactly when the submission included it
 * (unchecked boxes are absent from a submission, so absence means "was unchecked").
 */
export function CheckInput({
  name,
  label,
  value = 'on',
  type = 'checkbox',
  defaultChecked,
  ...rest
}: CheckProps) {
  const { submitted, seq, hasValues, aria } = useField(name);
  const wasSubmitted = Array.isArray(submitted) ? submitted.includes(value) : submitted === value;
  return (
    <label>
      <input
        key={seq}
        type={type}
        name={name}
        value={value}
        defaultChecked={hasValues ? wasSubmitted : defaultChecked}
        {...aria}
        {...rest}
      />{' '}
      <span>{label}</span>
    </label>
  );
}

export function SubmitButton({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-disabled={pending}>
      {children}
    </button>
  );
}
