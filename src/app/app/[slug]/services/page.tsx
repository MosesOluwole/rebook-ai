import Link from 'next/link';

import { listServices, newServiceDefaults } from '@/modules/booking';
import { can } from '@/modules/tenancy';

import { ActionForm, SubmitButton } from '../../../_components/forms';
import { getTenancy } from '../../../_lib/tenancy';
import { loadWorkspace } from '../_lib/workspace';
import { createServiceAction } from './actions';
import { BOOKING_MODE_LABELS, ServiceFields } from './service-fields';

export const dynamic = 'force-dynamic';

export default async function ServicesPage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string }>;
}) {
  const { slug } = await params;
  const { ctx } = await loadWorkspace(slug);
  const isOwner = ctx.role !== null && can(ctx.role, 'services.manage');
  const { services, defaults } = await getTenancy().withTenant(ctx, async (tx) => ({
    services: await listServices(tx),
    defaults: await newServiceDefaults(tx),
  }));

  return (
    <>
      <h1>Services</h1>

      <section className="card" aria-labelledby="services-heading">
        <h2 id="services-heading">Your services</h2>
        {services.length === 0 ? (
          <p className="muted">No services yet.</p>
        ) : (
          <ul className="plain">
            {services.map((service) => (
              <li key={service.id}>
                <Link href={`/app/${slug}/services/${service.id}`}>{service.name}</Link>{' '}
                <span className="muted">
                  · {service.durationMinutes} min · {service.price} {service.currency} ·{' '}
                  {BOOKING_MODE_LABELS[service.bookingMode]} ·{' '}
                  <span data-testid={`published-${service.id}`}>
                    {service.published ? 'published' : 'unpublished'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isOwner ? (
        <section className="card" aria-labelledby="new-service-heading">
          <h2 id="new-service-heading">New service</h2>
          <ActionForm action={createServiceAction} label="New service">
            <input type="hidden" name="slug" value={slug} />
            <ServiceFields defaults={defaults} disabled={false} />
            <div>
              <SubmitButton>Create service</SubmitButton>
            </div>
          </ActionForm>
        </section>
      ) : (
        <p className="muted">Only an owner can add or change services.</p>
      )}
    </>
  );
}
