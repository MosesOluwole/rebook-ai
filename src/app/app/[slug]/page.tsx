import { isHealthBusiness, terminologyFor } from '@/modules/tenancy';

import { loadWorkspace } from './_lib/workspace';

export const dynamic = 'force-dynamic';

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

export default async function DashboardPage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string }>;
}) {
  const { slug } = await params;
  const { ctx, tenant } = await loadWorkspace(slug);
  const words = terminologyFor(tenant.businessType);

  return (
    <>
      <h1>{tenant.name}</h1>
      <p className="muted">
        {words.label} · {tenant.timeZone} · you are an {ctx.role}
      </p>
      <section className="card" aria-labelledby="today">
        <h2 id="today">{capitalise(words.bookings)}</h2>
        <p>No {words.bookings} yet. Services and schedules arrive in the next phase.</p>
      </section>
      <section className="card" aria-labelledby="people">
        <h2 id="people">{capitalise(words.clients)}</h2>
        <p>You have no {words.clients} yet.</p>
      </section>
      {isHealthBusiness(tenant.businessType) && (
        <p className="notice">
          This is a health business: messages to {words.clients} stay neutral and no clinical
          details are ever stored.
        </p>
      )}
    </>
  );
}
