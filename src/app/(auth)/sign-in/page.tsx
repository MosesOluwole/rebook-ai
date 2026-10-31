import Link from 'next/link';
import { redirect } from 'next/navigation';

import { RouteForm, SubmitButton, TextInput } from '../../_components/forms';
import { safeNextPath } from '../../_lib/safe-next';
import { currentUser } from '../../_lib/session';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly next?: string | string[];
  readonly link?: string | string[];
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** The only notices the URL may ask for, as codes; the sentences live here. */
const LINK_NOTICES: Readonly<Record<string, string>> = {
  invalid: 'This link is invalid or has expired. Request a new one.',
};

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
  const linkNotice = LINK_NOTICES[first(params.link) ?? ''];

  return (
    <main>
      <h1>Sign in</h1>
      {linkNotice !== undefined && (
        <p className="notice error" role="alert">
          {linkNotice}
        </p>
      )}

      <section className="card" aria-labelledby="password-heading">
        <h2 id="password-heading">With your password</h2>
        <RouteForm endpoint="/auth/password" omit={['password']}>
          <input type="hidden" name="next" value={next} />
          <TextInput type="email" name="email" label="Email" autoComplete="email" required />
          <TextInput
            type="password"
            name="password"
            label="Password"
            autoComplete="current-password"
            required
            minLength={8}
          />
          <div>
            <SubmitButton>Sign in</SubmitButton>
          </div>
        </RouteForm>
      </section>

      <section className="card" aria-labelledby="link-heading">
        <h2 id="link-heading">With a sign-in link</h2>
        <RouteForm endpoint="/auth/magic-link">
          <input type="hidden" name="next" value={next} />
          <TextInput type="email" name="email" label="Email" autoComplete="email" required />
          <div>
            <SubmitButton className="quiet">Email me a sign-in link</SubmitButton>
          </div>
        </RouteForm>
      </section>

      <p>
        New here? <Link href={`/sign-up?next=${encodeURIComponent(next)}`}>Create an account</Link>
      </p>
    </main>
  );
}
