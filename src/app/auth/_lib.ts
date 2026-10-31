import { z } from 'zod';

/** Shared parsing for the auth form posts. Addresses are trimmed and lower-cased before validation. */
export const emailField = z.string().trim().toLowerCase().pipe(z.email().max(320));

export const credentialsSchema = z.object({
  email: emailField,
  password: z.string().min(8).max(200),
});

export const emailOnlySchema = z.object({ email: emailField });

export function formField(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === 'string' ? value : '';
}
