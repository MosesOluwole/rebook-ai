/**
 * Where to send the user after sign-in. Only a same-origin, absolute-path value is accepted so a
 * crafted `next` can never redirect to another site (no `//host`, no scheme, no backslashes).
 */
export const DEFAULT_NEXT = '/app';

export function safeNextPath(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_NEXT;
  }
  const candidate = value.trim();
  if (
    candidate === '' ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\') ||
    /[\u0000-\u001f]/.test(candidate) ||
    candidate.length > 512
  ) {
    return DEFAULT_NEXT;
  }
  return candidate;
}
