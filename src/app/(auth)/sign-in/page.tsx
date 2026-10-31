import Link from 'next/link';
import { redirect } from 'next/navigation';

import { safeNextPath } from '../../_lib/safe-next';
import { currentUser } from '../../_lib/session';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly next?: string | string[];
  readonly error?: string | string[];
  readonly sent?: string | string[];
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function SignInPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const next = safeNextPath(first(params.next));
  if ((await currentUser()) !== null) {
    redirect(next);
  }
  const error = first(params.error);
  const sent = first(params.sent) === '1';

  return (
    <main>
      <h1>Sign in</h1>
      {error !== undefined && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {sent && (
        <p className="notice" role="status">
          Check your email for a sign-in link. It works once and expires in an hour.
        </p>
      )}

      <section className="card" aria-labelledby="password-heading">
        <h2 id="password-heading">With your password</h2>
        <form className="stack" action="/auth/password" method="post">
          <input type="hidden" name="next" value={next} />
          <label>
            Email
            <input type="email" name="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              minLength={8}
            />
          </label>
          <button type="submit">Sign in</button>
        </form>
      </section>

      <section className="card" aria-labelledby="link-heading">
        <h2 id="link-heading">With a sign-in link</h2>
        <form className="stack" action="/auth/magic-link" method="post">
          <input type="hidden" name="next" value={next} />
          <label>
            Email
            <input type="email" name="email" autoComplete="email" required />
          </label>
          <button type="submit" className="quiet">
            Email me a sign-in link
          </button>
        </form>
      </section>

      <p>
        New here? <Link href={`/sign-up?next=${encodeURIComponent(next)}`}>Create an account</Link>
      </p>
    </main>
  );
}
