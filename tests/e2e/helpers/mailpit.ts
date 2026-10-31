import { type APIRequestContext, expect } from '@playwright/test';

/**
 * Reads emails from the local Supabase mail catcher (Mailpit, `pnpm db:status` → MAILPIT_URL).
 * Polls with a deadline; never sleeps blindly.
 */
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324';

interface MailpitSummary {
  readonly ID: string;
  readonly Created: string;
  readonly Subject: string;
  readonly To: readonly { readonly Address: string }[];
}

interface MailpitMessage {
  readonly ID: string;
  readonly Subject: string;
  readonly HTML: string;
  readonly Text: string;
}

export async function waitForEmail(
  request: APIRequestContext,
  to: string,
  subjectIncludes: string,
  notBefore: number,
  timeoutMs = 20_000,
): Promise<MailpitMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const search = await request.get(`${MAILPIT_URL}/api/v1/search`, {
      params: { query: `to:${to}`, limit: 20 },
    });
    expect(search.ok(), `Mailpit search failed: ${search.status()}`).toBe(true);
    const { messages } = (await search.json()) as { messages: MailpitSummary[] };
    const match = messages.find(
      (message) =>
        message.Subject.includes(subjectIncludes) &&
        new Date(message.Created).getTime() >= notBefore - 5_000 &&
        message.To.some((recipient) => recipient.Address.toLowerCase() === to.toLowerCase()),
    );
    if (match !== undefined) {
      const full = await request.get(`${MAILPIT_URL}/api/v1/message/${match.ID}`);
      expect(full.ok()).toBe(true);
      return (await full.json()) as MailpitMessage;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `No email to ${to} with subject containing "${subjectIncludes}" within ${timeoutMs} ms`,
  );
}

/**
 * The first link in the message that points at our confirm route. Supabase builds it from the
 * configured site URL (http://localhost:3000); when the server under test listens elsewhere (a
 * production-mode run on another port), the origin is swapped for `baseURL` and the path, token
 * hash and type are kept exactly as emailed.
 */
export function confirmLinkIn(message: MailpitMessage, baseURL?: string): string {
  const match = /href="([^"]*\/auth\/confirm\?[^"]*)"/.exec(message.HTML);
  if (match?.[1] === undefined) {
    throw new Error(`No /auth/confirm link in email "${message.Subject}"`);
  }
  const link = new URL(match[1].replace(/&amp;/g, '&'));
  if (baseURL !== undefined) {
    const target = new URL(baseURL);
    link.protocol = target.protocol;
    link.host = target.host;
  }
  return link.toString();
}
