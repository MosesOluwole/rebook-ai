'use server';

import { redirect } from 'next/navigation';

import {
  createService,
  deleteService,
  setServicePublished,
  updateService,
} from '@/modules/booking';
import { listCustomFieldDefinitions, setServiceCustomFieldValues } from '@/modules/crm';

import { readString } from '../../../_lib/form-errors';
import { failed, type FormState, runForm } from '../../../_lib/form-state';
import { getTenancy } from '../../../_lib/tenancy';
import { authoriseAction } from '../_lib/workspace';

/** Fields of the service form. Mode and location type are optional: blank keeps the default. */
const SERVICE_FIELDS = [
  'name',
  'durationMinutes',
  'bufferBeforeMinutes',
  'bufferAfterMinutes',
  'price',
  'currency',
  'repeatIntervalDays',
] as const;

function serviceInput(formData: FormData): Record<string, string | undefined> {
  const input: Record<string, string | undefined> = {};
  for (const field of SERVICE_FIELDS) {
    input[field] = readString(formData, field);
  }
  for (const optional of ['bookingMode', 'locationType']) {
    const value = readString(formData, optional);
    input[optional] = value === '' ? undefined : value;
  }
  return input;
}

const servicePaths = (slug: string, id: string) => [
  `/app/${slug}/services`,
  `/app/${slug}/services/${id}`,
];

export async function createServiceAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const slug = readString(formData, 'slug');
  const ctx = await authoriseAction(slug);
  let id: string;
  try {
    const service = await getTenancy().withTenant(ctx, (tx) =>
      createService(tx, serviceInput(formData)),
    );
    id = service.id;
  } catch (error) {
    return failed(previous, formData, error);
  }
  redirect(`/app/${slug}/services/${id}`);
}

export async function updateServiceAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const slug = readString(formData, 'slug');
  const id = readString(formData, 'id');
  const ctx = await authoriseAction(slug);
  return runForm(
    previous,
    formData,
    async () => {
      await getTenancy().withTenant(ctx, (tx) => updateService(tx, id, serviceInput(formData)));
      return 'Service saved.';
    },
    { revalidate: servicePaths(slug, id) },
  );
}

export async function publishServiceAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const slug = readString(formData, 'slug');
  const id = readString(formData, 'id');
  const published = readString(formData, 'published') === 'true';
  const ctx = await authoriseAction(slug);
  return runForm(
    previous,
    formData,
    async () => {
      await getTenancy().withTenant(ctx, (tx) => setServicePublished(tx, id, published));
      return published ? 'Service published.' : 'Service unpublished: hidden from public pages.';
    },
    { revalidate: servicePaths(slug, id) },
  );
}

export async function deleteServiceAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const slug = readString(formData, 'slug');
  const id = readString(formData, 'id');
  const ctx = await authoriseAction(slug);
  try {
    await getTenancy().withTenant(ctx, (tx) => deleteService(tx, id));
  } catch (error) {
    return failed(previous, formData, error);
  }
  redirect(`/app/${slug}/services`);
}

/**
 * The service's custom field values. Every service definition is read from the form by key; a
 * multi-select posts several values under one name, everything else one value. Field messages
 * are keyed `cf.<key>`, the input names.
 */
export async function setServiceValuesAction(
  previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const slug = readString(formData, 'slug');
  const id = readString(formData, 'id');
  const ctx = await authoriseAction(slug);
  const state = await runForm(
    previous,
    formData,
    async () => {
      await getTenancy().withTenant(ctx, async (tx) => {
        const definitions = await listCustomFieldDefinitions(tx, 'service');
        const input: Record<string, unknown> = {};
        for (const definition of definitions) {
          const name = `cf.${definition.key}`;
          input[definition.key] =
            definition.fieldType === 'multi_select'
              ? formData.getAll(name).filter((value) => typeof value === 'string')
              : readString(formData, name);
        }
        return setServiceCustomFieldValues(tx, id, input);
      });
      return 'Custom fields saved.';
    },
    { revalidate: servicePaths(slug, id) },
  );
  if (state.fieldErrors === undefined) {
    return state;
  }
  const fieldErrors: Record<string, string> = {};
  for (const [key, message] of Object.entries(state.fieldErrors)) {
    fieldErrors[key === '' ? '' : `cf.${key}`] = message;
  }
  return { ...state, fieldErrors };
}
