import { describe, expect, it } from 'vitest';

import { RateLimitedError } from '@/modules/platform';
import {
  AlreadyMemberError,
  BusinessTypeChangeError,
  DuplicateInvitationError,
} from '@/modules/tenancy';

import { formMessage, isTypedError } from '@/app/_lib/form-errors';

/** Phase 2 follow-ups 2, 3 and 5: how the new typed errors reach a form, and which do not. */
describe('formMessage for the follow-up errors', () => {
  it('gives the settings form a clear sentence for a refused business type change', () => {
    expect(formMessage(new BusinessTypeChangeError())).toBe(
      'A midwife business cannot be changed to another business type: its patients are protected by the health rules',
    );
  });

  it('tells the owner an invitation is already open, and the member that they already belong', () => {
    expect(formMessage(new DuplicateInvitationError())).toBe(
      'An invitation for this email address is already open; revoke it to send a new one',
    );
    expect(formMessage(new AlreadyMemberError())).toBe('You are already a member of this business');
  });

  it('matches hot-reloaded copies by kind, not by name', () => {
    const copy = Object.assign(new Error('x'), { name: 'Other', kind: 'BusinessTypeChangeError' });
    expect(isTypedError(copy, BusinessTypeChangeError)).toBe(true);
    const impostor = Object.assign(new Error('x'), { name: 'BusinessTypeChangeError' });
    expect(isTypedError(impostor, BusinessTypeChangeError)).toBe(false);
  });

  it('does not turn a rate limit refusal into a form message: that is a 429, handled by the route', () => {
    expect(() => formMessage(new RateLimitedError('sign_in', 60))).toThrow(RateLimitedError);
  });
});
