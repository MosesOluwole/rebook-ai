import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPE_LABELS,
  CUSTOM_FIELD_TYPES,
  isFreeTextType,
  listCustomFieldDefinitions,
} from '@/modules/crm';
import { can, isHealthBusiness, terminologyFor } from '@/modules/tenancy';

import {
  ActionForm,
  CheckInput,
  FieldMessage,
  SelectInput,
  SubmitButton,
  TextAreaInput,
  TextInput,
} from '../../../_components/forms';
import { getTenancy } from '../../../_lib/tenancy';
import { loadWorkspace } from '../_lib/workspace';
import { createCustomFieldAction, deleteCustomFieldAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function CustomFieldsPage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string }>;
}) {
  const { slug } = await params;
  const { ctx, tenant } = await loadWorkspace(slug);
  const isOwner = ctx.role !== null && can(ctx.role, 'custom_fields.manage');
  const canOverride = ctx.role !== null && can(ctx.role, 'custom_fields.health_override');
  const health = isHealthBusiness(tenant.businessType);
  const words = terminologyFor(tenant.businessType);
  const definitions = await getTenancy().withTenant(ctx, (tx) => listCustomFieldDefinitions(tx));
  const entityLabel = (entity: string) => (entity === 'client' ? words.clients : 'services');
  // Health businesses keep no client-scoped fields (data minimisation, ADR-005 §6).
  const entities = CUSTOM_FIELD_ENTITIES.filter((entity) => !health || entity !== 'client');

  return (
    <>
      <h1>Custom fields</h1>
      {health && (
        <p className="warning" role="note">
          Health business: custom fields are for services only, and must not hold clinical
          information. Free-text fields are off unless an owner enables one with the override, and
          that decision is recorded in the audit log.
        </p>
      )}

      <section className="card" aria-labelledby="fields-heading">
        <h2 id="fields-heading">Fields</h2>
        {definitions.length === 0 ? (
          <p className="muted">No custom fields yet.</p>
        ) : (
          <ul className="plain">
            {definitions.map((definition) => (
              <li key={definition.id}>
                <strong>{definition.label}</strong>{' '}
                <span className="muted">
                  · {entityLabel(definition.entity)} ·{' '}
                  {CUSTOM_FIELD_TYPE_LABELS[definition.fieldType]}
                  {definition.required ? ' · required' : ''}
                  {definition.options.length > 0 ? ` · ${definition.options.join(', ')}` : ''}
                </span>
                {definition.healthFreeTextOverride && (
                  <p className="warning">
                    Free text enabled by override: make sure nobody records clinical detail in it.
                  </p>
                )}
                {isOwner && (
                  <ActionForm action={deleteCustomFieldAction} label={`Delete ${definition.label}`}>
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="id" value={definition.id} />
                    <div>
                      <SubmitButton className="danger">Delete {definition.label}</SubmitButton>
                    </div>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {isOwner ? (
        <section className="card" aria-labelledby="new-field-heading">
          <h2 id="new-field-heading">New field</h2>
          <ActionForm action={createCustomFieldAction} label="New field">
            <input type="hidden" name="slug" value={slug} />
            <SelectInput
              name="entity"
              label="For"
              defaultValue="service"
              options={entities.map((entity) => ({ value: entity, label: entityLabel(entity) }))}
            />
            <TextInput name="label" label="Label" required maxLength={80} />
            <TextInput
              name="key"
              label="Key (lowercase, used in exports)"
              required
              maxLength={40}
              pattern="[a-z][a-z0-9_]*"
              placeholder="guest_count"
            />
            <SelectInput
              name="fieldType"
              label="Type"
              defaultValue="number"
              options={CUSTOM_FIELD_TYPES.map((type) => ({
                value: type,
                label: `${CUSTOM_FIELD_TYPE_LABELS[type]}${health && isFreeTextType(type) ? ' (needs override)' : ''}`,
              }))}
            />
            <TextAreaInput
              name="options"
              label="Options (list types only, one per line)"
              rows={3}
            />
            <fieldset>
              <legend className="muted">Rules</legend>
              <CheckInput name="required" label="Required" />
              {health && canOverride && (
                <CheckInput
                  name="healthFreeTextOverride"
                  label="Override: allow this free-text field. I understand it must not hold clinical information. (Audited.)"
                />
              )}
              <FieldMessage name="healthFreeTextOverride" />
            </fieldset>
            <div>
              <SubmitButton>Add field</SubmitButton>
            </div>
          </ActionForm>
        </section>
      ) : (
        <p className="muted">Only an owner can define custom fields.</p>
      )}
    </>
  );
}
