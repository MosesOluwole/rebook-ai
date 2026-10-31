import Link from 'next/link';
import { redirect } from 'next/navigation';

import { safeNextPath } from '../../_lib/safe-next';
import { currentUser } from '../../_lib/session';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly next?: string | string[];
  readonly error?: string | string[];
  readonly 'check-email'?: string | string[];
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function SignUpPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const next = safeNextPath(first(params.next));
  const checkEmail = first(params['check-email']) === '1';
  if (!checkEmail && (await currentUser()) !== null) {
    redirect(next);
  }
  const error = first(params.error);

  if (checkEmail) {
    return (
      <main>
        <h1>Check your email</h1>
        <p className="notice" role="status">
          We sent you a confirmation link. Follow it to finish creating your account; you will then
          set up your business.
        </p>
        <p>
          <Link href="/sign-in">Back to sign in</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Create your account</h1>
      <p className="muted">You set up your business right after this step.</p>
      {error !== undefined && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <form className="stack card" action="/auth/sign-up" method="post">
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
            autoComplete="new-password"
            required
            minLength={8}
          />
        </label>
        <button type="submit">Create account</button>
      </form>
      <p>
        Already have an account?{' '}
        <Link href={`/sign-in?next=${encodeURIComponent(next)}`}>Sign in</Link>
      </p>
    </main>
  );
}
