import { describe, expect, it } from 'vitest';

import { NotFoundError, PermissionDeniedError, ValidationError } from '@/modules/tenancy';

import { formMessage, isNotFound, isTypedError } from './form-errors';

describe('typed error routing', () => {
  it('matches by class and by kind (a hot-reloaded module copy must still be recognised)', () => {
    expect(isNotFound(new NotFoundError())).toBe(true);
    const staleCopy = Object.assign(new Error('Not found'), {
      name: 'NotFoundError',
      kind: 'NotFoundError',
    });
    expect(isNotFound(staleCopy)).toBe(true);
    // A foreign error that only shares the name is not ours.
    expect(isNotFound(Object.assign(new Error('Not found'), { name: 'NotFoundError' }))).toBe(
      false,
    );
    expect(isNotFound(new Error('Not found'))).toBe(false);
    expect(isTypedError(new PermissionDeniedError('staff', 'flags.update'), ValidationError)).toBe(
      false,
    );
  });

  it('turns typed errors into sentences and rethrows anything else', () => {
    expect(formMessage(new ValidationError('x', ['name: too short']))).toBe(
      'Check the form: name: too short.',
    );
    expect(formMessage(new PermissionDeniedError('staff', 'flags.update'))).toBe(
      'Only an owner can do that.',
    );
    expect(formMessage(new NotFoundError())).toBe('Not found.');
    expect(() => formMessage(new TypeError('boom'))).toThrow(TypeError);
  });
});
