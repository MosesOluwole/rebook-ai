'use server';

import { createCustomFieldDefinition, deleteCustomFieldDefinition } from '@/modules/crm';

import { readString } from '../../../_lib/form-errors';
import { type FormState, runForm } from '../../../_lib/form-state';
import { getTenancy } from '../../../_lib/tenancy';
import { authoriseAction } from '../_lib/workspace';

export async function createCustomFieldAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const slug = readString(formData, 'slug');
  const ctx = await authoriseAction(slug);
  return runForm(
    previous,
    formData,
    async () => {
      // Options are typed one per line; blank lines are ignored.
      const options = readString(formData, 'options')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '');
      await getTenancy().withTenant(ctx, (tx) =>
        createCustomFieldDefinition(tx, {
          entity: readString(formData, 'entity'),
          key: readString(formData, 'key'),
          label: readString(formData, 'label'),
          fieldType: readString(formData, 'fieldType'),
          options,
          required: readString(formData, 'required'),
          healthFreeTextOverride: readString(formData, 'healthFreeTextOverride'),
        }),
      );
      return 'Custom field added.';
    },
    { revalidate: [`/app/${slug}/custom-fields`] },
  );
}

export async function deleteCustomFieldAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const slug = readString(formData, 'slug');
  const ctx = await authoriseAction(slug);
  return runForm(
    previous,
    formData,
    async () => {
      await getTenancy().withTenant(ctx, (tx) =>
        deleteCustomFieldDefinition(tx, readString(formData, 'id')),
      );
      return 'Custom field deleted with its values.';
    },
    { revalidate: [`/app/${slug}/custom-fields`] },
  );
}
