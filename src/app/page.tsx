import Link from 'next/link';

import { currentUser } from './_lib/session';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await currentUser();
  return (
    <main>
      <h1>Rebook AI</h1>
      <p>Bookings, enquiries and rebooking for any business that takes bookings.</p>
      <p className="switcher">
        {user === null ? (
          <>
            <Link className="button" href="/sign-up">
              Create an account
            </Link>
            <Link className="button quiet" href="/sign-in">
              Sign in
            </Link>
          </>
        ) : (
          <Link className="button" href="/app">
            Go to your workspace
          </Link>
        )}
      </p>
      <p>
        <Link href="/health">Health check</Link>
      </p>
    </main>
  );
}
