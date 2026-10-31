import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getService } from '@/modules/booking';
import {
  type CustomFieldDefinition,
  getServiceCustomFieldValues,
  listCustomFieldDefinitions,
} from '@/modules/crm';
import { can } from '@/modules/tenancy';

import {
  ActionForm,
  CheckInput,
  FieldMessage,
  SelectInput,
  SubmitButton,
  TextAreaInput,
  TextInput,
} from '../../../../_components/forms';
import { isNotFound } from '../../../../_lib/form-errors';
import { getTenancy } from '../../../../_lib/tenancy';
import { loadWorkspace } from '../../_lib/workspace';
import {
  deleteServiceAction,
  publishServiceAction,
  setServiceValuesAction,
  updateServiceAction,
} from '../actions';
import { ServiceFields } from '../service-fields';

export const dynamic = 'force-dynamic';

function CustomFieldInput({
  definition,
  value,
}: {
  readonly definition: CustomFieldDefinition;
  readonly value: unknown;
}) {
  const name = `cf.${definition.key}`;
  const label = `${definition.label}${definition.required ? ' (required)' : ''}`;
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  switch (definition.fieldType) {
    case 'long_text':
      return <TextAreaInput name={name} label={label} rows={3} defaultValue={text} />;
    case 'number':
      return <TextInput name={name} label={label} inputMode="decimal" defaultValue={text} />;
    case 'date':
      return <TextInput type="date" name={name} label={label} defaultValue={text} />;
    case 'boolean':
      return (
        <SelectInput
          name={name}
          label={label}
          defaultValue={value === true ? 'true' : value === false ? 'false' : ''}
          options={[
            { value: '', label: 'Not set' },
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ]}
        />
      );
    case 'select':
      return (
        <SelectInput
          name={name}
          label={label}
          defaultValue={text}
          options={[
            { value: '', label: 'Not set' },
            ...definition.options.map((option) => ({ value: option, label: option })),
          ]}
        />
      );
    case 'multi_select': {
      const chosen = Array.isArray(value) ? (value as unknown[]) : [];
      return (
        <fieldset>
          <legend>{label}</legend>
          {definition.options.map((option) => (
            <CheckInput
              key={option}
              name={name}
              value={option}
              label={option}
              defaultChecked={chosen.includes(option)}
            />
          ))}
          <FieldMessage name={name} />
        </fieldset>
      );
    }
    case 'text':
      return <TextInput name={name} label={label} defaultValue={text} maxLength={200} />;
  }
}

export default async function ServicePage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string; readonly serviceId: string }>;
}) {
  const { slug, serviceId } = await params;
  const { ctx } = await loadWorkspace(slug);
  const isOwner = ctx.role !== null && can(ctx.role, 'services.manage');
  let loaded;
  try {
    loaded = await getTenancy().withTenant(ctx, async (tx) => ({
      service: await getService(tx, serviceId),
      definitions: await listCustomFieldDefinitions(tx, 'service'),
      values: await getServiceCustomFieldValues(tx, serviceId),
    }));
  } catch (error) {
    // Another tenant's service, a malformed id and a missing service look the same: 404.
    if (isNotFound(error)) {
      notFound();
    }
    throw error;
  }
  const { service, definitions, values } = loaded;
  const hidden = (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="id" value={service.id} />
    </>
  );

  return (
    <>
      <p>
        <Link href={`/app/${slug}/services`}>← Services</Link>
      </p>
      <h1>{service.name}</h1>
      <p>
        Status:{' '}
        <strong data-testid="service-status">
          {service.published ? 'Published' : 'Unpublished'}
        </strong>
      </p>

      {isOwner && (
        <ActionForm action={publishServiceAction} className="actions" label="Publishing">
          {hidden}
          <input type="hidden" name="published" value={service.published ? 'false' : 'true'} />
          <SubmitButton className={service.published ? 'quiet' : undefined}>
            {service.published ? 'Unpublish' : 'Publish'}
          </SubmitButton>
        </ActionForm>
      )}

      <section className="card" aria-labelledby="edit-heading">
        <h2 id="edit-heading">Details</h2>
        <ActionForm action={updateServiceAction} label="Service details">
          {hidden}
          <ServiceFields
            defaults={{ bookingMode: service.bookingMode, locationType: service.locationType }}
            service={service}
            disabled={!isOwner}
          />
          {isOwner && (
            <div>
              <SubmitButton>Save service</SubmitButton>
            </div>
          )}
        </ActionForm>
      </section>

      <section className="card" aria-labelledby="custom-heading">
        <h2 id="custom-heading">Custom fields</h2>
        {definitions.length === 0 ? (
          <p className="muted">
            No service fields defined. <Link href={`/app/${slug}/custom-fields`}>Define one</Link>.
          </p>
        ) : (
          <ActionForm action={setServiceValuesAction} label="Custom field values">
            {hidden}
            <fieldset disabled={!isOwner}>
              <legend className="muted">Values for this service</legend>
              <div className="day">
                {definitions.map((definition) => (
                  <CustomFieldInput
                    key={definition.id}
                    definition={definition}
                    value={values.get(definition.key)}
                  />
                ))}
              </div>
            </fieldset>
            {isOwner && (
              <div>
                <SubmitButton>Save custom fields</SubmitButton>
              </div>
            )}
          </ActionForm>
        )}
      </section>

      {isOwner && (
        <section className="card" aria-labelledby="delete-heading">
          <h2 id="delete-heading">Delete</h2>
          <p className="muted">
            Deleting removes the service, who may deliver it and its custom field values. Unpublish
            it instead to hide it from clients and keep everything.
          </p>
          <ActionForm action={deleteServiceAction} label="Delete service">
            {hidden}
            <div>
              <SubmitButton className="danger">Delete service</SubmitButton>
            </div>
          </ActionForm>
        </section>
      )}
    </>
  );
}
