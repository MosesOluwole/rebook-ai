import { createHash } from 'node:crypto';

/** SHA-256 of a rate-limit subject, so the counters table holds no address of any kind. */
export function hashRateLimitKey(subject: string): string {
  return createHash('sha256').update(`rebook-rate-limit:${subject}`, 'utf8').digest('hex');
}
