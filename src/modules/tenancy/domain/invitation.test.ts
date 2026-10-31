import { describe, expect, it } from 'vitest';

import { ValidationError } from './errors';
import { judgeInvitation, parseInviteInput } from './invitation';

const now = new Date('2026-11-01T10:00:00Z');
const user = {
  id: '019a2c3e-6c6d-7a2b-8f3e-1a2b3c4d5e6f',
  email: 'pat@example.com',
  emailVerified: true,
};
const open = {
  email: 'pat@example.com',
  expiresAt: new Date('2026-11-08T10:00:00Z'),
  acceptedAt: null,
  acceptedBy: null,
  revokedAt: null,
};

describe('judgeInvitation', () => {
  it('accepts an open invitation for the verified matching address', () => {
    expect(judgeInvitation(open, user, now)).toBe('acceptable');
  });

  it('matches the address case-insensitively', () => {
    expect(judgeInvitation(open, { ...user, email: 'Pat@Example.com ' }, now)).toBe('acceptable');
  });

  it.each([
    ['revoked', { ...open, revokedAt: new Date('2026-10-31T00:00:00Z') }],
    ['expired', { ...open, expiresAt: now }],
    [
      'accepted by someone else',
      { ...open, acceptedAt: now, acceptedBy: '019a2c3e-0000-7000-8000-000000000001' },
    ],
    ['addressed to someone else', { ...open, email: 'other@example.com' }],
  ])('rejects a %s invitation with the same verdict', (_label, invitation) => {
    expect(judgeInvitation(invitation, user, now)).toBe('rejected');
  });

  it('treats a repeat by the same user as already accepted (idempotent)', () => {
    expect(judgeInvitation({ ...open, acceptedAt: now, acceptedBy: user.id }, user, now)).toBe(
      'already_accepted_by_user',
    );
  });

  it('asks for verification when the matching address is not verified', () => {
    expect(judgeInvitation(open, { ...user, emailVerified: false }, now)).toBe(
      'email_not_verified',
    );
  });

  it('rejection wins over verification: a stranger is never told to verify', () => {
    expect(
      judgeInvitation(
        { ...open, email: 'other@example.com' },
        { ...user, emailVerified: false },
        now,
      ),
    ).toBe('rejected');
  });
});

describe('parseInviteInput', () => {
  it('lower-cases the address and requires a known role', () => {
    expect(parseInviteInput({ email: ' Pat@Example.COM ', role: 'staff' })).toEqual({
      email: 'pat@example.com',
      role: 'staff',
    });
    expect(() => parseInviteInput({ email: 'not-an-email', role: 'staff' })).toThrow(
      ValidationError,
    );
    expect(() => parseInviteInput({ email: 'pat@example.com', role: 'admin' })).toThrow(
      ValidationError,
    );
    expect(() => parseInviteInput({ email: 'pat@example.com', role: 'staff', note: 'x' })).toThrow(
      ValidationError,
    );
  });
});
