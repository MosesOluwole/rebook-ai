import { z } from 'zod';

import { validationErrorFrom } from '@/shared/kernel/validation-error';

import { amountSchema, currencySchema } from './money';
import { optionalWholeNumber, wholeNumber } from './numbers';

/**
 * A bookable service (docs/architecture.md §1 and §5, docs/phases.md Phase 3). Every service
 * carries a booking mode from day one: `timed` services are booked on a slot grid (Phase 4),
 * `request` services are enquiries a business accepts or declines (Phase 7).
 */
export const BOOKING_MODES = ['timed', 'request'] as const;
export type BookingMode = (typeof BOOKING_MODES)[number];

export const LOCATION_TYPES = ['clinic', 'client_home', 'video', 'venue'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const MIN_DURATION_MINUTES = 5;
export const MAX_DURATION_MINUTES = 24 * 60;
/** Buffers over 4 hours are refused (docs/phases.md Phase 3). */
export const MAX_BUFFER_MINUTES = 4 * 60;
/** Three years: long enough for an anniversary nudge (365 days) with room to spare. */
export const MAX_REPEAT_INTERVAL_DAYS = 3 * 365;

/** The business types this module gives defaults for; mirrors tenancy's BUSINESS_TYPES. */
export type ServiceBusinessType = 'event_planner' | 'midwife' | 'other_timed';

export interface ServiceDefaults {
  readonly bookingMode: BookingMode;
  readonly locationType: LocationType;
}

/**
 * Event planners take enquiries for a venue; midwives and other timed businesses take timed
 * appointments, at a clinic until the business says otherwise (docs/phases.md Phase 3).
 */
export function serviceDefaultsFor(businessType: ServiceBusinessType): ServiceDefaults {
  switch (businessType) {
    case 'event_planner':
      return { bookingMode: 'request', locationType: 'venue' };
    case 'midwife':
    case 'other_timed':
      return { bookingMode: 'timed', locationType: 'clinic' };
  }
}

const formBoolean = z
  .union([z.boolean(), z.literal('true'), z.literal('false'), z.literal('on'), z.literal('')])
  .transform((value) => value === true || value === 'true' || value === 'on');

export const serviceInputSchema = z.strictObject({
  name: z.string().trim().min(1, 'required').max(120, 'at most 120 characters'),
  bookingMode: z.enum(BOOKING_MODES, 'timed or request').optional(),
  durationMinutes: wholeNumber(MIN_DURATION_MINUTES, MAX_DURATION_MINUTES, 'minutes'),
  bufferBeforeMinutes: wholeNumber(0, MAX_BUFFER_MINUTES, 'minutes'),
  bufferAfterMinutes: wholeNumber(0, MAX_BUFFER_MINUTES, 'minutes'),
  price: amountSchema,
  currency: currencySchema,
  locationType: z.enum(LOCATION_TYPES, 'clinic, client home, video or venue').optional(),
  repeatIntervalDays: optionalWholeNumber(1, MAX_REPEAT_INTERVAL_DAYS, 'days'),
  published: formBoolean.optional(),
});

export interface ServiceInput {
  readonly name: string;
  readonly bookingMode: BookingMode;
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  /** Canonical decimal string, e.g. "45.00". */
  readonly price: string;
  readonly currency: string;
  readonly locationType: LocationType;
  readonly repeatIntervalDays: number | null;
  readonly published: boolean;
}

/**
 * Validates a service at the module boundary. Mode, location type and the published flag fall
 * back to `defaults` when the caller leaves them out: the business type's defaults for a new
 * service (which starts unpublished), the stored values for an edit.
 */
export function parseServiceInput(
  input: unknown,
  defaults: ServiceDefaults & { readonly published?: boolean },
): ServiceInput {
  const result = serviceInputSchema.safeParse(input);
  if (!result.success) {
    throw validationErrorFrom('service', result.error, 'service');
  }
  const data = result.data;
  return {
    name: data.name,
    bookingMode: data.bookingMode ?? defaults.bookingMode,
    durationMinutes: data.durationMinutes,
    bufferBeforeMinutes: data.bufferBeforeMinutes,
    bufferAfterMinutes: data.bufferAfterMinutes,
    price: data.price,
    currency: data.currency,
    locationType: data.locationType ?? defaults.locationType,
    repeatIntervalDays: data.repeatIntervalDays,
    published: data.published ?? defaults.published ?? false,
  };
}
