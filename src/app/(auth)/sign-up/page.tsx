import Link from 'next/link';
import { redirect } from 'next/navigation';

import { RouteForm, SubmitButton, TextInput } from '../../_components/forms';
import { safeNextPath } from '../../_lib/safe-next';
import { currentUser } from '../../_lib/session';

export const dynamic = 'force-dynamic';

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function SignUpPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly next?: string | string[] }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(first(params.next));
  if ((await currentUser()) !== null) {
    redirect(next);
  }

  return (
    <main>
      <h1>Create your account</h1>
      <p className="muted">You set up your business right after this step.</p>
      {/* With confirmations on, the route answers "check your email" as form state. */}
      <RouteForm
        endpoint="/auth/sign-up"
        omit={['password']}
        className="stack card"
        label="Create account"
      >
        <input type="hidden" name="next" value={next} />
        <TextInput type="email" name="email" label="Email" autoComplete="email" required />
        <TextInput
          type="password"
          name="password"
          label="Password"
          autoComplete="new-password"
          required
          minLength={8}
        />
        <div>
          <SubmitButton>Create account</SubmitButton>
        </div>
      </RouteForm>
      <p>
        Already have an account?{' '}
        <Link href={`/sign-in?next=${encodeURIComponent(next)}`}>Sign in</Link>
      </p>
    </main>
  );
}
