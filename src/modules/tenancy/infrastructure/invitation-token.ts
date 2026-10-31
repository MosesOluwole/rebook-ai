import { createHash, randomBytes } from 'node:crypto';

import { INVITATION_TOKEN_BYTES } from '../domain/invitation';

export interface InvitationTokenPair {
  /** Goes into the link; shown to the owner once, never stored. */
  readonly token: string;
  /** Stored; what the link's token is compared against. */
  readonly tokenHash: string;
}

export interface InvitationTokens {
  generate(): InvitationTokenPair;
  hash(token: string): string;
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export const invitationTokens: InvitationTokens = {
  generate() {
    const token = randomBytes(INVITATION_TOKEN_BYTES).toString('base64url');
    return { token, tokenHash: hashInvitationToken(token) };
  },
  hash: hashInvitationToken,
};

/** A short random suffix for slug collisions: 4 lowercase base-36 characters. */
export function randomSlugSuffix(): string {
  return randomBytes(3).readUIntBE(0, 3).toString(36).padStart(4, '0').slice(-4);
}
