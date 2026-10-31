import { describe, expect, it, vi } from 'vitest';

/**
 * Phase 3 decisions, item 4: form outcomes are server-action state. Field messages and submitted
 * values come back in the action's response (never a URL); secrets are never echoed back; an
 * unexpected error is rethrown rather than turned into a friendly message.
 */
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { ValidationError } = await import('@/modules/tenancy');
const { failed, IDLE, runForm, submittedValues } = await import('@/app/_lib/form-state');

function form(entries: readonly (readonly [string, string])[]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) {
    data.append(name, value);
  }
  return data;
}

describe('submittedValues', () => {
  it('keeps every field, collects repeated names, and drops React fields and omitted secrets', () => {
    expect(
      submittedValues(
        form([
          ['email', 'person@example.invalid'],
          ['password', 'secret-value'],
          ['serviceIds', 'a'],
          ['serviceIds', 'b'],
          ['$ACTION_ID_abc', ''],
        ]),
        ['password'],
      ),
    ).toEqual({ email: 'person@example.invalid', serviceIds: ['a', 'b'] });
  });
});

describe('failed', () => {
  it('turns a ValidationError into a summary, one message per field, and the submitted values', () => {
    const state = failed(
      IDLE,
      form([
        ['price', '10.999'],
        ['currency', 'XYZ'],
      ]),
      new ValidationError('service', ['price: at most 2 decimal places'], {
        price: ['at most 2 decimal places', 'second message is dropped'],
        currency: ['an ISO 4217 currency code in current use, such as GBP or EUR'],
      }),
    );
    expect(state).toEqual({
      status: 'error',
      message: 'Check the highlighted fields.',
      fieldErrors: {
        price: 'at most 2 decimal places',
        currency: 'an ISO 4217 currency code in current use, such as GBP or EUR',
      },
      values: { price: '10.999', currency: 'XYZ' },
      seq: 1,
    });
  });

  it('reports a form-level message when the error is about the whole input', () => {
    const state = failed(
      { status: 'error', seq: 4 },
      form([]),
      new ValidationError('working hours', ['days: overlaps'], { '': ['overlaps elsewhere'] }),
    );
    expect(state.message).toBe('Check the form: overlaps elsewhere.');
    expect(state.seq).toBe(5);
  });

  it('rethrows an error that is not one of ours', () => {
    expect(() => failed(IDLE, form([]), new Error('database is down'))).toThrow('database is down');
  });
});

describe('runForm', () => {
  it('returns the success message and data, and never echoes values on success', async () => {
    const state = await runForm(IDLE, form([['email', 'person@example.invalid']]), () =>
      Promise.resolve({ message: 'Invite link created.', data: { link: 'https://x/y' } }),
    );
    expect(state).toEqual({
      status: 'ok',
      message: 'Invite link created.',
      data: { link: 'https://x/y' },
      seq: 1,
    });
  });
});
